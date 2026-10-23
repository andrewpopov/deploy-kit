import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const release = require('../release.js');
const { validateDeployResult } = require('../deploy-result.js');
const { validateTerminal } = require('../on-host/status.js');
const { resultOf, needsResolution } = require('../on-host/accept.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CURRENT = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS = 'releases/00000000bbbb-20260708T090000Z';
const BACKUP = '/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg';

// A trimmed copy of release.test.ts's content-aware fake execFileSync: enough answers for the release pipeline.
function makeRuntime(over: any = {}) {
  const cfg = { runningSha: SHA, stateContent: '', fail: [] as string[], ...over };
  const calls: string[] = [];
  let stopped = false;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cfg.fail.some((f: string) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      throw err;
    }
    if (/pm2 stop /.test(cmd)) { stopped = true; return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped = false; return ''; }
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return cfg.stateContent;
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse HEAD')) return SHA;
    if (cmd.includes('rev-parse')) return SHA;
    if (cmd.includes('readlink -f')) return '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z';
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: stopped ? 'stopped' : 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return CURRENT;
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return PREVIOUS;
    if (cmd.includes('ls -1')) return 'a1b2c3d4e5f6-20260710T090000Z\n00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z';
    if (cmd.includes('get-running-sha')) return cfg.runningSha;
    if (cmd.includes('run-backup')) return BACKUP;
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls };
}

const config = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: ['app'],
  branch: 'master',
  autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs',
  health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore' },
  layout: { type: 'releases', keepReleases: 4, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha' },
  ...over,
});
// No backup/migrate/restore hooks: a code-only deploy (migrated stays false).
const codeOnly = (over: any = {}) => config({ hooks: { install: 'npm ci', build: 'npm run build', backup: null, migrate: null, restore: null }, ...over });

const ctx = (runtime: any) => ({ runtime, sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z') });
const deploy = (cfg: any, runtimeOver: any = {}) => release.deployRelease(cfg, {}, ctx(makeRuntime(runtimeOver).runtime));

function failedResult(run: () => unknown) {
  let thrown: any;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown, 'the pipeline was expected to throw').toBeDefined();
  expect(validateDeployResult(thrown.deployResult)).toBeNull();
  return thrown.deployResult;
}

const postCheck = (onFailure: string) => ({ postDeployChecks: [{ name: 'public-smoke', command: 'run-smoke', onFailure }] });

describe('DeployResult: forward deploy', () => {
  it('deployed: a success returns the result beside the legacy fields', () => {
    const result = deploy(config());
    expect(validateDeployResult(result)).toBeNull();
    expect(result).toMatchObject({
      status: 'deployed', stage: 'done', liveBefore: '00000000aaaa', liveAfter: 'a1b2c3d4e5f6', migrated: true,
      backupId: BACKUP, effectsClean: null, recovery: { action: 'none', verified: false }, error: null, healthy: true,
    });
  });

  it('activation health fail with flip-back verified: failed-recovered, code-only', () => {
    const result = failedResult(() => deploy(codeOnly(), { runningSha: 'deadbeefdeadbeef' }));
    expect(result).toMatchObject({
      status: 'failed-recovered', stage: 'verify', migrated: false, liveBefore: '00000000aaaa', liveAfter: '00000000aaaa',
      recovery: { action: 'flip-back', verified: true },
    });
    expect(result.error).toMatch(/verification failed/);
  });

  it('flip-back unverified: the previous release does not come back healthy -> failed-unrecovered', () => {
    const result = failedResult(() => deploy(codeOnly(), { fail: ['curl'] }));
    expect(result).toMatchObject({ status: 'failed-unrecovered', stage: 'verify', recovery: { action: 'flip-back', verified: false }, liveAfter: null });
  });

  it('a migrated failure recovers with restore+flip-back, verified', () => {
    const result = failedResult(() => deploy(config(), { runningSha: 'deadbeefdeadbeef' }));
    expect(result).toMatchObject({
      status: 'failed-recovered', stage: 'verify', migrated: true, backupId: BACKUP, liveAfter: '00000000aaaa',
      recovery: { action: 'restore+flip-back', verified: true },
    });
  });

  it('restore failed: failed-unrecovered, restore+flip-back unverified', () => {
    const result = failedResult(() => deploy(config(), { fail: ['run-migrate', 'run-restore'] }));
    expect(result).toMatchObject({
      status: 'failed-unrecovered', stage: 'migrated', migrated: true, recovery: { action: 'restore+flip-back', verified: false },
    });
    expect(result.error).toMatch(/MANUAL RECOVERY REQUIRED/);
  });

  it('a failing symlink flip-back: failed-unrecovered and the live release is unknown', () => {
    const result = failedResult(() => deploy(config(), { runningSha: 'deadbeefdeadbeef', fail: [`ln -s ${CURRENT} /srv/app/.dk-swap.$$.current`] }));
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'restore+flip-back', verified: false }, liveAfter: null });
  });

  it('MANUAL RECOVERY REQUIRED from an interrupted journal: failed-unrecovered, action manual', () => {
    const stateContent = JSON.stringify({ phase: 'migrated', releaseId: 'a1b2c3d4e5f6-20260710T010000Z', backupId: 'b1', migrated: true });
    const result = failedResult(() => deploy(config(), { stateContent }));
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'manual', verified: false } });
    expect(result.error).toMatch(/^MANUAL RECOVERY REQUIRED/);
  });

  it('a build failure before the disruptive window: failed, candidate quarantined', () => {
    const result = failedResult(() => deploy(config(), { fail: ['npm run build'] }));
    expect(result).toMatchObject({ status: 'failed', stage: 'build', migrated: false, liveAfter: '00000000aaaa', recovery: { action: 'quarantine', verified: false } });
  });

  it('a failure before a candidate exists: failed, no recovery', () => {
    const result = failedResult(() => deploy(config(), { fail: ['mv --version'] }));
    expect(result).toMatchObject({ status: 'failed', recovery: { action: 'none', verified: false } });
  });

  it('writers stopped, nothing migrated: resume-previous, verified', () => {
    const result = failedResult(() => deploy(config(), { fail: ['run-backup'] }));
    expect(result).toMatchObject({ status: 'failed-recovered', stage: 'stopped', migrated: false, recovery: { action: 'resume-previous', verified: true } });
  });
});

describe('DeployResult: post-check policies', () => {
  it('remain-active: failed-recovered with the candidate live', () => {
    const result = failedResult(() => deploy(config(postCheck('remain-active')), { fail: ['run-smoke'] }));
    expect(result).toMatchObject({
      status: 'failed-recovered', stage: 'post-deploy-failed', liveAfter: 'a1b2c3d4e5f6', recovery: { action: 'remain-active', verified: true },
    });
  });

  it('manual: failed-unrecovered, an operator decides', () => {
    const result = failedResult(() => deploy(config(postCheck('manual')), { fail: ['run-smoke'] }));
    expect(result).toMatchObject({ status: 'failed-unrecovered', liveAfter: 'a1b2c3d4e5f6', recovery: { action: 'manual', verified: false } });
  });

  it('rollback: restore+flip-back verified', () => {
    const result = failedResult(() => deploy(config(postCheck('rollback')), { fail: ['run-smoke'] }));
    expect(result).toMatchObject({
      status: 'failed-recovered', stage: 'post-deploy-failed', liveAfter: '00000000aaaa', recovery: { action: 'restore+flip-back', verified: true },
    });
  });

  it('rollback whose pointer cannot be restored: failed-unrecovered', () => {
    const result = failedResult(() => deploy(config(postCheck('rollback')), { fail: ['run-smoke', `ln -s ${CURRENT} /srv/app/.dk-swap.$$.current`] }));
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'restore+flip-back', verified: false } });
  });
});

describe('DeployResult: rollbackRelease', () => {
  it('rollbackRelease success: deployed means the rollback completed', () => {
    const result = release.rollbackRelease(config(), {}, ctx(makeRuntime().runtime));
    expect(validateDeployResult(result)).toBeNull();
    expect(result).toMatchObject({ status: 'deployed', stage: 'done', liveBefore: '00000000aaaa', liveAfter: '00000000bbbb', healthy: true });
  });

  it('a failed rollback that restores the original release is failed-recovered', () => {
    const rbConfig = config({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    const result = failedResult(() => release.rollbackRelease(rbConfig, {}, ctx(makeRuntime({ fail: ['check-port'] }).runtime)));
    expect(result).toMatchObject({ status: 'failed-recovered', stage: 'rollback', liveBefore: '00000000aaaa', liveAfter: '00000000aaaa', recovery: { action: 'flip-back', verified: true } });
  });

  it('a failed rollback whose restore fails is failed-unrecovered', () => {
    const rbConfig = config({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    const result = failedResult(() => release.rollbackRelease(rbConfig, {}, ctx(makeRuntime({ fail: ['check-port', 'curl'] }).runtime)));
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'manual', verified: false } });
  });
});

describe('DeployResult: terminal.json', () => {
  const terminal = (result: unknown) => ({ runId: 'r', kind: 'deploy', result, finishedAt: '2026-07-10T09:00:00Z' });

  it('validateTerminal accepts a real result and rejects a malformed one', () => {
    const real = failedResult(() => deploy(codeOnly(), { runningSha: 'deadbeefdeadbeef' }));
    expect(validateTerminal(terminal(real), 'r')).toBeNull();
    expect(validateTerminal(terminal({ status: 'deployed', error: null }), 'r')).toMatch(/^result: /);
    expect(validateTerminal(terminal({ ...real, status: 'exploded' }), 'r')).toMatch(/status/);
    expect(validateTerminal(terminal({ ...real, recovery: { action: 'flip-back' } }), 'r')).toMatch(/recovery\.verified/);
  });

  it('the unresolved marker follows the status and the recovery verification', () => {
    const base = deploy(config());
    expect(needsResolution(resultOf(base))).toBe(false);
    const recovered = failedResult(() => deploy(codeOnly(), { runningSha: 'deadbeefdeadbeef' }));
    expect(needsResolution(recovered)).toBe(false);
    expect(needsResolution({ ...recovered, recovery: { ...recovered.recovery, verified: false } })).toBe(true);
    expect(needsResolution({ ...recovered, status: 'failed-unrecovered' })).toBe(true);
    expect(needsResolution({ ...recovered, status: 'aborted-clean', effectsClean: true })).toBe(false);
    expect(needsResolution({ ...recovered, status: 'aborted-clean', effectsClean: null })).toBe(true);
  });

  it('a throw without a result becomes a plain failed result; the returned legacy fields are dropped', () => {
    expect(resultOf(undefined, new Error('boom'))).toMatchObject({ status: 'failed', error: 'boom', recovery: { action: 'none', verified: false } });
    expect(Object.keys(resultOf(deploy(config())))).not.toContain('steps');
  });
});
