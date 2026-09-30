import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const { hostRun } = require('../on-host/host-run.js');

const RUN_ID = '20260930T120000Z-0123456789ab-deadbeef';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const INV = 'a'.repeat(32);

let parent: string;
let runDir: string;
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

function baseMeta(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID, sha: SHA, options: { skipBuild: true, verifyPins: false },
    operatorVersion: '0.28.0', operatorConfigSha256: 'b'.repeat(64), operatorGitHead: 'c'.repeat(40), createdAt: '2026-09-30T12:00:00Z',
    capture: { path: '/usr/bin', umask: '0022', oomScoreAdj: 100, shell: '/bin/bash', env: {} }, ...over,
  };
}
const baseConfig = (over: Record<string, unknown> = {}) => ({
  mode: 'local', layout: { type: 'releases' }, lock: true, stepTimeoutSeconds: 60, localShell: '/bin/bash', appNames: ['x'], ...over,
});

function writeManifest() {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else files.push(path.relative(runDir, f));
  } };
  walk(path.join(runDir, 'kit'));
  files.push('config.json', 'meta.json');
  fs.writeFileSync(path.join(runDir, 'manifest.sha256'), files.map((f) => `${sha(fs.readFileSync(path.join(runDir, f)))}  ${f}`).join('\n') + '\n');
}
function stage(meta: unknown = baseMeta(), config: unknown = baseConfig()) {
  fs.mkdirSync(path.join(runDir, 'kit', 'src'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'kit', 'package.json'), '{}');
  fs.writeFileSync(path.join(runDir, 'kit', 'src', 'cli.js'), '//');
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config));
  writeManifest();
}

const logs = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn(), step: vi.fn() };
function go(over: Record<string, unknown> = {}) {
  const deployRelease = vi.fn();
  const code = hostRun(runDir, {
    deployRelease, env: { INVOCATION_ID: INV, HOME: '/h', USER: 'u', PM2_HOME: '/pm2' }, log: logs,
    readOomScoreAdj: () => '100\n', readFile: () => '42', run: () => '42', now: () => new Date('2026-09-30T12:05:00Z'), ...over,
  });
  return { code, deployRelease };
}
const errors = () => logs.error.mock.calls.map((c) => String(c[0])).join('\n');
const has = (n: string) => fs.existsSync(path.join(runDir, n));

beforeEach(() => {
  vi.clearAllMocks();
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-hostrun-'));
  runDir = path.join(parent, RUN_ID);
  fs.mkdirSync(runDir, { mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
});
afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

describe('host-run', () => {
  it('happy path: enforced values win, non-allowlisted options are dropped, outcome written', () => {
    stage(baseMeta({ options: { skipBuild: true, verifyPins: false, autoCut: true, stealLock: true, sha: 'f'.repeat(40), branch: 'evil', dryRun: true } }));
    const { code, deployRelease } = go();
    expect(code).toBe(0);
    expect(deployRelease).toHaveBeenCalledTimes(1);
    const [cfg, opts] = deployRelease.mock.calls[0];
    expect(cfg.mode).toBe('local');
    expect(opts).toEqual({ skipBuild: true, verifyPins: false, sha: SHA, autoCut: false, stealLock: false });
    const outcome = JSON.parse(fs.readFileSync(path.join(runDir, 'outcome.json'), 'utf8'));
    expect(outcome).toMatchObject({ runId: RUN_ID, ok: true, finishedAt: '2026-09-30T12:05:00.000Z' });
    expect(fs.readFileSync(path.join(runDir, 'started'), 'utf8')).toBe(INV);
  });

  it('a failing deploy writes ok:false with the message and returns 1', () => {
    stage();
    const { code } = go({ deployRelease: () => { throw new Error('step exploded'); } });
    expect(code).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'outcome.json'), 'utf8'))).toMatchObject({ ok: false, error: 'step exploded' });
  });

  it('refuses a replay and leaves existing records untouched', () => {
    stage();
    expect(go().code).toBe(0);
    fs.writeFileSync(path.join(runDir, 'result.json'), 'EVIDENCE');
    const before = fs.readFileSync(path.join(runDir, 'outcome.json'), 'utf8');
    const second = go();
    expect(second.code).toBe(1);
    expect(second.deployRelease).not.toHaveBeenCalled();
    expect(errors()).toContain('ONHOST_REPLAY');
    expect(fs.readFileSync(path.join(runDir, 'outcome.json'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')).toBe('EVIDENCE');
  });

  it.each([['missing', undefined], ['short', 'abc'], ['uppercase', 'A'.repeat(32)], ['with suffix', `${INV}0`]])(
    'INVOCATION_ID %s is refused before started is created', (_n, value) => {
      stage();
      const { code, deployRelease } = go({ env: { INVOCATION_ID: value } });
      expect(code).toBe(1);
      expect(errors()).toContain('ONHOST_INVOCATION_ID');
      expect(has('started')).toBe(false);
      expect(deployRelease).not.toHaveBeenCalled();
    });

  it('refuses a runDir with the wrong mode', () => {
    stage();
    fs.chmodSync(runDir, 0o755);
    expect(go().code).toBe(1);
    expect(errors()).toContain('ONHOST_RUNDIR');
    expect(has('started')).toBe(false);
  });
  it('refuses a runDir owned by another uid', () => {
    stage();
    expect(go({ uid: process.getuid!() + 1 }).code).toBe(1);
    expect(errors()).toContain('ONHOST_RUNDIR');
  });
  it('refuses a symlinked runDir', () => {
    stage();
    const link = path.join(parent, 'link');
    fs.symlinkSync(runDir, link);
    const deployRelease = vi.fn();
    const code = hostRun(link, { deployRelease, env: { INVOCATION_ID: INV }, log: logs, readOomScoreAdj: () => '0' });
    expect(code).toBe(1);
    expect(errors()).toContain('symlink');
    expect(deployRelease).not.toHaveBeenCalled();
  });

  it('refuses a tampered kit file', () => {
    stage();
    fs.writeFileSync(path.join(runDir, 'kit', 'src', 'cli.js'), '// tampered');
    const { code, deployRelease } = go();
    expect(code).toBe(1);
    expect(errors()).toContain('ONHOST_MANIFEST');
    expect(deployRelease).not.toHaveBeenCalled();
  });
  it('refuses a tampered config.json', () => {
    stage();
    fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(baseConfig({ lock: false })));
    expect(go().code).toBe(1);
    expect(errors()).toContain('ONHOST_MANIFEST');
  });
  it('refuses an extra unlisted file under kit/', () => {
    stage();
    fs.writeFileSync(path.join(runDir, 'kit', 'src', 'extra.js'), 'evil');
    const { code, deployRelease } = go();
    expect(code).toBe(1);
    expect(errors()).toContain('extra.js');
    expect(deployRelease).not.toHaveBeenCalled();
  });
  it('refuses a symlink under kit/ even when listed', () => {
    stage();
    fs.symlinkSync('/etc/passwd', path.join(runDir, 'kit', 'link'));
    expect(go().code).toBe(1);
    expect(errors()).toContain('ONHOST_MANIFEST');
  });

  it('refuses invalid meta (runId mismatch, bad sha)', () => {
    stage(baseMeta({ runId: 'other' }));
    expect(go().code).toBe(1);
    expect(errors()).toContain('ONHOST_META');
    fs.rmSync(path.join(runDir, 'started'));
    stage(baseMeta({ sha: 'abc' }));
    vi.clearAllMocks();
    expect(go().code).toBe(1);
    expect(errors()).toContain('ONHOST_META');
  });
  it.each([
    ['ssh mode', { mode: 'ssh' }], ['host present', { host: 'u@h' }], ['no lock', { lock: false }],
    ['no timeout', { stepTimeoutSeconds: null }], ['relative localShell', { localShell: 'bash' }], ['no layout', { layout: null }],
  ])('refuses invalid config: %s', (_n, over) => {
    stage(baseMeta(), baseConfig(over));
    const { code, deployRelease } = go();
    expect(code).toBe(1);
    expect(errors()).toContain('ONHOST_CONFIG');
    expect(deployRelease).not.toHaveBeenCalled();
  });

  it('OOM parity: refuses a higher unit score, naming the fix', () => {
    stage();
    const { code, deployRelease } = go({ readOomScoreAdj: () => '200\n' });
    expect(code).toBe(1);
    expect(errors()).toContain('ONHOST_OOM_SCORE');
    expect(errors()).toContain('DefaultOOMScoreAdjust=100');
    expect(deployRelease).not.toHaveBeenCalled();
  });
  it('OOM parity: equal or lower is fine; an unreadable file refuses', () => {
    stage();
    expect(go({ readOomScoreAdj: () => '-900' }).code).toBe(0);
    fs.rmSync(path.join(runDir, 'started'));
    fs.rmSync(path.join(runDir, 'outcome.json'));
    expect(go({ readOomScoreAdj: () => { throw new Error('ENOENT'); } }).code).toBe(1);
    expect(errors()).toContain('ONHOST_OOM_SCORE');
  });

  it('PM2 warning: mismatch warns without failing; match is silent', () => {
    stage();
    const { code } = go({ readFile: () => '111', run: () => '222\n' });
    expect(code).toBe(0);
    expect(logs.warning.mock.calls.join()).toContain('PM2_DAEMON_NOT_SYSTEM_SERVICE');
    vi.clearAllMocks();
    fs.rmSync(path.join(runDir, 'started'));
    expect(go({ readFile: () => '222', run: () => '222' }).code).toBe(0);
    expect(logs.warning).not.toHaveBeenCalled();
  });
  it('PM2 warning: a failing probe warns, never fails', () => {
    stage();
    expect(go({ run: () => { throw new Error('no systemctl'); } }).code).toBe(0);
    expect(logs.warning.mock.calls.join()).toContain('PM2_DAEMON_NOT_SYSTEM_SERVICE');
  });
  it('no PM2 check after a failed deploy', () => {
    stage();
    const run = vi.fn();
    go({ deployRelease: () => { throw new Error('x'); }, run });
    expect(run).not.toHaveBeenCalled();
  });
});
