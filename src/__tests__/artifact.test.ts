import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const require = createRequire(__filename);
const { readArtifact } = require('../artifact.js');
const { onHostDeploy } = require('../on-host/operator.js');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'install-artifact.sh');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-artifact-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const packageRoot = (version = '0.33.0') => {
  const root = fs.mkdtempSync(path.join(tmp, 'pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@andrewpopov/deploy-kit', version }));
  return root;
};

// A tarball shaped like `npm pack`'s: everything under package/.
function makeTarball(version = '0.33.0', body = 'one') {
  const src = fs.mkdtempSync(path.join(tmp, 'src-'));
  fs.mkdirSync(path.join(src, 'package', 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package', 'package.json'), JSON.stringify({ name: '@andrewpopov/deploy-kit', version }));
  fs.writeFileSync(path.join(src, 'package', 'src', 'cli.js'), `//${body}`);
  const tgz = path.join(tmp, `deploy-kit-${version}-${body}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', src, 'package']);
  return tgz;
}

// The injected install: unpack the tarball into $FAKE_ROOT (what `npm i -g` would do into the global root).
function fakeInstaller(root: string) {
  const installer = path.join(tmp, 'fake-install.sh');
  fs.writeFileSync(installer, `#!/bin/sh\nset -e\nmkdir -p "${root}"\ntar -xzf "$1" -C "${root}" --strip-components=1\necho "$1" >> "${tmp}/installs.log"\n`, { mode: 0o755 });
  return installer;
}

const runScript = (args: string[], env: Record<string, string>) => spawnSync('sh', [SCRIPT, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env },
});

describe('scripts/install-artifact.sh', () => {
  it('hashes the tarball, installs it through the injected command, and writes ARTIFACT.json into the package root', () => {
    const tgz = makeTarball();
    const root = path.join(tmp, 'global', '@andrewpopov', 'deploy-kit');
    const run = runScript([tgz], {
      DEPLOY_KIT_INSTALL_CMD: `sh ${fakeInstaller(root)}`, DEPLOY_KIT_PACKAGE_ROOT: root, DEPLOY_KIT_NOW: '2026-10-23T10:00:00Z',
    });
    expect(run.status, run.stderr).toBe(0);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'ARTIFACT.json'), 'utf8'))).toEqual({
      name: '@andrewpopov/deploy-kit', version: '0.33.0', sha256, installedAt: '2026-10-23T10:00:00Z',
    });
    expect(fs.readFileSync(path.join(tmp, 'installs.log'), 'utf8').trim()).toBe(tgz);
    // readArtifact reads back exactly what the script wrote
    expect(readArtifact({ root })).toEqual({
      name: '@andrewpopov/deploy-kit', version: '0.33.0', sha256, installedAt: '2026-10-23T10:00:00Z', source: 'pinned', verified: true,
    });
  });

  it('keeps the installed tarball as ARTIFACT.tgz, byte for byte', () => {
    const tgz = makeTarball();
    const root = path.join(tmp, 'global', 'kit');
    const run = runScript([tgz], { DEPLOY_KIT_INSTALL_CMD: `sh ${fakeInstaller(root)}`, DEPLOY_KIT_PACKAGE_ROOT: root });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'ARTIFACT.tgz')).equals(fs.readFileSync(tgz))).toBe(true);
  });

  it('two different tarballs of the same version have different identities', () => {
    const shaOf = (body: string) => {
      const root = path.join(tmp, `root-${body}`);
      const run = runScript([makeTarball('0.33.0', body)], { DEPLOY_KIT_INSTALL_CMD: `sh ${fakeInstaller(root)}`, DEPLOY_KIT_PACKAGE_ROOT: root });
      expect(run.status, run.stderr).toBe(0);
      return readArtifact({ root }).sha256;
    };
    expect(shaOf('one')).not.toBe(shaOf('two'));
  });

  it('writes nothing and fails when the install command fails', () => {
    const root = path.join(tmp, 'never');
    const run = runScript([makeTarball()], { DEPLOY_KIT_INSTALL_CMD: 'false', DEPLOY_KIT_PACKAGE_ROOT: root });
    expect(run.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, 'ARTIFACT.json'))).toBe(false);
  });

  it('fails, writing nothing, when the installed package is not the tarball\'s version', () => {
    const root = packageRoot('0.32.0'); // the "install" left an older kit behind
    const run = runScript([makeTarball('0.33.0')], { DEPLOY_KIT_INSTALL_CMD: 'true', DEPLOY_KIT_PACKAGE_ROOT: root });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("holds version '0.32.0' after the install, expected 0.33.0");
    expect(fs.existsSync(path.join(root, 'ARTIFACT.json'))).toBe(false);
  });

  it('needs exactly one existing tarball', () => {
    expect(runScript([], {}).status).toBe(2);
    expect(runScript([path.join(tmp, 'missing.tgz')], { DEPLOY_KIT_INSTALL_CMD: 'false' }).status).toBe(1);
  });
});

describe('readArtifact', () => {
  it('is unpinned, with a null sha256, when there is no ARTIFACT.json', () => {
    expect(readArtifact({ root: packageRoot() })).toEqual({ version: '0.33.0', sha256: null, source: 'unpinned' });
  });

  it('reads the installed ARTIFACT.json, unverified when there is no tarball to hash', () => {
    const root = packageRoot();
    fs.writeFileSync(path.join(root, 'ARTIFACT.json'), JSON.stringify({ name: 'n', version: '0.33.0', sha256: 'a'.repeat(64), installedAt: 'x' }));
    expect(readArtifact({ root })).toEqual({
      name: 'n', version: '0.33.0', sha256: 'a'.repeat(64), installedAt: 'x', source: 'pinned', verified: false, problem: 'ARTIFACT.tgz is missing',
    });
  });

  describe('tarball verification', () => {
    const install = () => {
      const root = path.join(tmp, 'global', 'kit');
      const run = runScript([makeTarball()], { DEPLOY_KIT_INSTALL_CMD: `sh ${fakeInstaller(root)}`, DEPLOY_KIT_PACKAGE_ROOT: root });
      expect(run.status, run.stderr).toBe(0);
      return root;
    };

    it('a matching tarball verifies', () => {
      const artifact = readArtifact({ root: install() });
      expect(artifact).toMatchObject({ source: 'pinned', verified: true });
      expect(artifact).not.toHaveProperty('problem');
    });

    it('an altered tarball fails with a hash mismatch', () => {
      const root = install();
      fs.appendFileSync(path.join(root, 'ARTIFACT.tgz'), 'tampered');
      expect(readArtifact({ root })).toMatchObject({ verified: false, problem: expect.stringMatching(/sha256 .* does not match/) });
    });

    it('a missing tarball fails', () => {
      const root = install();
      fs.rmSync(path.join(root, 'ARTIFACT.tgz'));
      expect(readArtifact({ root })).toMatchObject({ verified: false, problem: 'ARTIFACT.tgz is missing' });
    });
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '[]'],
    ['a short sha256', JSON.stringify({ name: 'n', version: '0.33.0', sha256: 'abc', installedAt: 'x' })],
    ['a missing installedAt', JSON.stringify({ name: 'n', version: '0.33.0', sha256: 'a'.repeat(64) })],
    ['another version than the package beside it', JSON.stringify({ name: 'n', version: '0.32.0', sha256: 'a'.repeat(64), installedAt: 'x' })],
  ])('throws for ARTIFACT.json that is %s, never downgrading it to unpinned', (_name, body) => {
    const root = packageRoot();
    fs.writeFileSync(path.join(root, 'ARTIFACT.json'), body);
    expect(() => readArtifact({ root })).toThrow(/ARTIFACT\.json/);
  });

  it('defaults to this package', () => {
    expect(readArtifact().version).toBe(require('../../package.json').version);
  });
});

describe('the operator puts the artifact identity in the bundle meta', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex');
  const PREFLIGHT = Object.entries({
    DK_USER: 'dkapp', DK_UID: '1000', DK_LINGER: 'yes', DK_USER_MANAGER: 'yes', DK_NODE: '/usr/bin/node', DK_NODE_MAJOR: '24', DK_ACTIVE_UNITS: '0',
    DK_SHELL: '/bin/bash', DK_GID: '1000', DK_GROUPS: '1000', DK_GROUP_NAMES: 'dkapp', DK_MANAGER_GROUPS: '1000', DK_UMASK: '0027', DK_OOM: '100',
    DK_PATH: '/usr/bin', DK_HOME: '/srv/dkapp', DK_LOGNAME: 'dkapp', ENV_LANG: 'C.UTF-8', ENVABSENT_PM2_HOME: '1', DK_END: '1',
  }).map(([k, v]) => `${k}=${hex(v)}`).join('\n') + '\n';
  const config = { host: 'dkapp@host', mode: 'ssh', projectDir: '/srv/app', appNames: ['app'], layout: { type: 'releases' }, lock: true, stepTimeoutSeconds: 120 };
  const request = { kind: 'deploy', request: 'req-1', epoch: '0', notAfter: '1790000000', expectReservation: '{"state":"none","runId":null,"gen":0}' };

  // Runs the operator against a scripted host, capturing the meta.json inside the uploaded tarball.
  function uploadedMeta(options: Record<string, unknown>, readArtifactSeam: unknown) {
    let tarball: Buffer | undefined;
    const execFile = vi.fn((_file: string, args: string[], opts: { input?: Buffer }) => {
      const command = args[args.length - 1];
      if (command === 'sh -se') return PREFLIGHT;
      if (command.includes('tar -x')) tarball = opts.input;
      return '';
    });
    const code = onHostDeploy(config, { sha: SHA, autoCut: false, ...options }, {
      runtime: { execFileSync: execFile }, log: { info() {}, warning() {}, error() {}, success() {} }, receiptsPath: path.join(tmp, 'receipts.jsonl'),
      tmpRoot: tmp, gitHead: () => 'c'.repeat(40), attach: () => 0, readArtifact: readArtifactSeam,
    });
    if (!tarball) return { code, meta: undefined };
    const out = fs.mkdtempSync(path.join(tmp, 'untar-'));
    execFileSync('tar', ['-x', '-C', out], { input: tarball });
    return { code, meta: JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')) };
  }

  it('a pinned kit: meta.kitArtifact is {version, sha256}, exactly what readArtifact returned (not a digest of the files)', () => {
    const { code, meta } = uploadedMeta(request, () => ({ name: 'n', version: '0.33.0', sha256: 'e'.repeat(64), installedAt: 'x', source: 'pinned' }));
    expect(code).toBe(0);
    expect(meta.kitArtifact).toEqual({ version: '0.33.0', sha256: 'e'.repeat(64) });
  });

  it('an unpinned kit is recorded as such, for the controller\'s check to refuse', () => {
    const { meta } = uploadedMeta(request, () => ({ version: '0.33.0', sha256: null, source: 'unpinned' }));
    expect(meta.kitArtifact).toEqual({ version: '0.33.0', sha256: null, source: 'unpinned' });
  });

  it('the real readArtifact is the default', () => {
    const { meta } = uploadedMeta(request, undefined);
    expect(meta.kitArtifact).toMatchObject({ version: require('../../package.json').version });
  });

  it('a pre-request deploy carries no kitArtifact', () => {
    const { meta } = uploadedMeta({}, () => { throw new Error('must not be read'); });
    expect(meta).not.toHaveProperty('kitArtifact');
  });

  it('an unreadable ARTIFACT.json stops the operator before anything is uploaded', () => {
    const { code, meta } = uploadedMeta(request, () => { throw new Error('ARTIFACT.json in /x: not valid JSON'); });
    expect(code).toBe(1);
    expect(meta).toBeUndefined();
  });
});
