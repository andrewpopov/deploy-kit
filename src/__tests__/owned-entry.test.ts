// BRAIN-636 review finding 2: an onHost.required app deploys and rolls back only as an accepted request, under
// owned locks. Every way in without them is refused, naming the command that is allowed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };
const kit = require('../index.js');
const release = require('../release.js');
const deployMod = require('../deploy.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

let out = '';
const spies = () => ['error', 'info', 'success', 'warning', 'step', 'header', 'divider'].map((m) =>
  vi.spyOn(log, m).mockImplementation((msg: string) => { out += `${msg}\n`; }));
afterEach(() => { vi.restoreAllMocks(); out = ''; });

function inProject(config: Record<string, unknown>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-owned-entry-'));
  fs.writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify({
    host: 'dkapp@host', projectDir: '/srv/app', appNames: ['app'], layout: { type: 'releases' }, ...config,
  }));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('the CLI', () => {
  it.each([['deploy'], ['rollback']])('%s without --on-host is refused for an onHost.required app, naming the on-host command', (command) => {
    spies();
    inProject({ onHost: { required: true } }, (cwd) => {
      expect(cli.run([command], { cwd })).toBe(1);
    });
    expect(out).toContain(`deploy-kit ${command} --on-host`);
  });

  it.each([
    ['deploy', '--no-lock'], ['deploy', '--steal-lock'], ['rollback', '--no-lock'], ['rollback', '--steal-lock'],
  ])('%s %s is refused for an onHost.required app', (command, flag) => {
    spies();
    inProject({ onHost: { required: true } }, (cwd) => {
      expect(cli.run([command, flag], { cwd })).toBe(1);
      expect(cli.run([command, '--on-host', flag], { cwd })).toBe(1);
    });
    expect(out).toMatch(/--steal-lock and --no-lock are refused|deploy-kit \w+ --on-host/);
  });

  it.each([['deploy'], ['rollback']])('%s --dry-run plans an onHost.required app without locks, ssh or a target command, while the real run is still refused', (command) => {
    spies();
    const execFileSync = vi.spyOn(require('child_process'), 'execFileSync');
    inProject({ onHost: { required: true }, ecosystemFile: 'ecosystem.config.cjs' }, (cwd) => {
      expect(cli.run([command, '--dry-run'], { cwd })).toBe(0);
      expect(out).toContain('[dry-run]');
      expect(execFileSync).not.toHaveBeenCalled();
      out = '';
      expect(cli.run([command], { cwd })).toBe(1);
      expect(out).toContain(`deploy-kit ${command} --on-host`);
    });
  });

  it('an app that did not opt in is not affected by the check', () => {
    spies();
    inProject({}, (cwd) => {
      // the plain rollback proceeds to the pipeline (and fails there, on the unreachable host, not at the entry check)
      expect(cli.run(['rollback', '--dry-run'], { cwd })).not.toBeUndefined();
    });
    expect(out).not.toContain('onHost.required');
  });
});

describe('the pipeline entry points', () => {
  const cfg = (over: Record<string, unknown> = {}) => mergeConfig(DEFAULT_CONFIG, {
    host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], branch: 'master', autoCut: false, onHost: { required: true },
    layout: { type: 'releases', keepReleases: 4, sharedPaths: [] }, ...over,
  });
  // A runtime that fails the test if the pipeline reaches the target at all.
  const untouched = () => {
    const execFileSync = vi.fn(() => { throw new Error('the pipeline must refuse before touching the target'); });
    return { runtime: { execFileSync }, execFileSync };
  };

  it.each([
    ['deployRelease', 'deploy', (c: any, o: any, x: any) => release.deployRelease(c, o, x)],
    ['rollbackRelease', 'rollback', (c: any, o: any, x: any) => release.rollbackRelease(c, o, x)],
    ['recoverRelease', 'recover', (c: any, o: any, x: any) => release.recoverRelease(c, o, x)],
    ['deploy()', 'deploy', (c: any, o: any, x: any) => deployMod.deploy(c, o, x)],
    ['rollback()', 'rollback', (c: any, o: any, x: any) => deployMod.rollback(c, o, x)],
  ])('%s without owned locks is refused before any step, naming `%s --on-host`', (_name, command, call) => {
    const fake = untouched();
    expect(() => call(cfg(), {}, { runtime: fake.runtime })).toThrow(new RegExp(`deploy-kit ${command} --on-host`));
    expect(fake.execFileSync).not.toHaveBeenCalled();
  });

  it('a legacy-layout deploy() and rollback() of an opted-in app are refused too', () => {
    const fake = untouched();
    const legacy = cfg({ layout: { type: 'legacy' } });
    expect(() => deployMod.deploy(legacy, {}, { runtime: fake.runtime })).toThrow(/legacy layout.*layout migrate --to releases/);
    expect(() => deployMod.rollback(legacy, {}, { runtime: fake.runtime })).toThrow(/legacy layout.*layout migrate --to releases/);
    expect(fake.execFileSync).not.toHaveBeenCalled();
  });

  it.each([['legacy layout', { layout: { type: 'legacy' } }], ['no layout', { layout: null }]])(
    'a forged handle does not open the legacy deploy() and rollback() of an opted-in app (%s, host lock configured)', (_name, over) => {
      const fake = untouched();
      const config = cfg({ hostLock: '/var/lock/host.lock', ...over });
      const ctx = { runtime: fake.runtime, ownedLocks: {} };
      expect(() => deployMod.deploy(config, {}, ctx)).toThrow(/layout migrate --to releases/);
      expect(() => deployMod.rollback(config, {}, ctx)).toThrow(/layout migrate --to releases/);
      expect(fake.execFileSync).not.toHaveBeenCalled();
    });

  it.each([
    ['deployRelease', (c: any, x: any) => release.deployRelease(c, {}, x)],
    ['rollbackRelease', (c: any, x: any) => release.rollbackRelease(c, {}, x)],
    ['recoverRelease', (c: any, x: any) => release.recoverRelease(c, {}, x)],
    ['deploy()', (c: any, x: any) => deployMod.deploy(c, {}, x)],
    ['rollback()', (c: any, x: any) => deployMod.rollback(c, {}, x)],
  ])('%s rejects a forged handle `{}` at the entry, before any step', (_name, call) => {
    const fake = untouched();
    expect(() => call(cfg({ hostLock: '/var/lock/host.lock' }), { runtime: fake.runtime, ownedLocks: {} })).toThrow(/owned lock handle rejected/);
    expect(fake.execFileSync).not.toHaveBeenCalled();
  });

  it('a hand-built dryRun runtime does not stand in for the planner: it is still refused', () => {
    const fake = untouched();
    expect(() => deployMod.deploy(cfg(), {}, { runtime: { ...fake.runtime, dryRun: true } })).toThrow(/deploy --on-host/);
    expect(fake.execFileSync).not.toHaveBeenCalled();
  });

  it('--steal-lock and a disabled lock are refused even with a handle', () => {
    const fake = untouched();
    const handle = {} as object; // never validated: the entry check refuses first
    expect(() => release.deployRelease(cfg(), { stealLock: true }, { runtime: fake.runtime, ownedLocks: handle })).toThrow(/never runs with --steal-lock or --no-lock/);
    expect(() => release.rollbackRelease(cfg({ lock: false }), {}, { runtime: fake.runtime, ownedLocks: handle })).toThrow(/never runs with --steal-lock or --no-lock/);
    expect(fake.execFileSync).not.toHaveBeenCalled();
  });

  it('a forged handle is rejected where the pipeline adopts it, before any step', () => {
    const fake = untouched();
    expect(() => release.deployRelease(cfg(), {}, { runtime: fake.runtime, ownedLocks: { appPath: '/x', pid: process.pid, released: false } }))
      .toThrow(/owned lock handle rejected/);
  });

  it('an app that did not opt in keeps taking its own lock', () => {
    const plain = mergeConfig(cfg(), { onHost: undefined });
    const fake = untouched();
    // it gets past the entry check and fails later, inside the pipeline, on the throwing runtime
    expect(() => release.rollbackRelease(plain, {}, { runtime: fake.runtime })).toThrow(/pipeline must refuse|lock/i);
    expect(fake.execFileSync).toHaveBeenCalled();
  });
});
