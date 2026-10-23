import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js');
const release = require('../release.js');
const { validateDeployResult } = require('../deploy-result.js');
const { mergeConfig, DEFAULT_CONFIG, validateConfig } = kit;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CURRENT = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS = 'releases/00000000bbbb-20260708T090000Z';
const BACKUP = '/var/lib/app/backups/app-20260710T090000Z.db.gpg';

type Probe = { output: string; fail?: boolean };
function makeRuntime(opts: { probe: Probe; fail?: string[] }) {
  const calls: string[] = [];
  let stopped = false;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cmd.includes('check-pending')) {
      if (opts.probe.fail) throw Object.assign(new Error('probe failed'), { stdout: opts.probe.output });
      return opts.probe.output;
    }
    if ((opts.fail || []).some((f) => cmd.includes(f))) throw Object.assign(new Error(`fake failure: ${cmd}`), { stdout: '' });
    if (/pm2 stop /.test(cmd)) { stopped = true; return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped = false; return ''; }
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return '';
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse')) return SHA;
    if (cmd.includes('readlink -f')) return '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z';
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: stopped ? 'stopped' : 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return CURRENT;
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return PREVIOUS;
    if (cmd.includes('ls -1')) return 'a1b2c3d4e5f6-20260710T090000Z\n00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z';
    if (cmd.includes('get-running-sha')) return SHA;
    if (cmd.includes('run-backup')) return BACKUP;
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls };
}

const config = (hooks: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: {
    install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore',
    pendingMigrations: 'check-pending', migrationsExclusive: true, ...hooks,
  },
  layout: {
    type: 'releases', keepReleases: 4, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha',
    effects: CANDIDATE, disruptiveGate: { checks: [{ name: 'idle', command: 'check-idle' }] },
  },
  ...over,
});

function run(cfg: any, probe: Probe, fail: string[] = [], notAfter?: number) {
  const fake = makeRuntime({ probe, fail });
  const steps: { step: string; class: string }[] = [];
  const ctx = { runtime: fake.runtime, sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z'), ...(notAfter != null ? { notAfter } : {}), onStep: (e: { step: string; class: string }) => steps.push(e) };
  let result: any;
  let thrown: any;
  try { result = release.deployRelease(cfg, {}, ctx); } catch (error) { thrown = error; }
  return { steps, names: steps.map((s) => s.step), calls: fake.calls, result, thrown, failure: thrown?.deployResult };
}
const stopped = (calls: string[]) => calls.some((cmd) => /pm2 stop /.test(cmd));
const CANDIDATE = { install: 'candidate', generate: 'candidate', build: 'candidate' };
const FULL = ['stop-writers', 'backup', 'migrate'];

describe('probe first: exact zero', () => {
  it('skips stop, backup and migrate; migrated is false; the gate runs before previous-pointer', () => {
    const out = run(config(), { output: '0\n' });
    expect(out.thrown).toBeUndefined();
    for (const step of FULL) expect(out.names).not.toContain(step);
    expect(stopped(out.calls)).toBe(false);
    expect(out.calls.some((cmd) => cmd.includes('run-backup') || cmd.includes('run-migrate'))).toBe(false);
    expect(out.result).toMatchObject({ status: 'deployed', migrated: false, migrationsPending: 0 });
    expect(out.result.steps).toContain('migrate-skipped');
    const last = out.names.lastIndexOf('disruptive-gate');
    expect(out.names[last + 1]).toBe('previous-pointer');
    expect(out.names.indexOf('pending-migrations-probe')).toBeLessThan(out.names.indexOf('disruptive-gate'));
    expect(out.names).not.toContain('pending-migrations');
    expect(out.steps.find((s) => s.step === 'pending-migrations-probe')!.class).toBe('read-only');
  });

  it('a failure after the flip recovers code-only: flip-back, no restore', () => {
    const cfg = config({}, { postDeployChecks: [{ name: 'smoke', command: 'run-smoke', onFailure: 'rollback' }] });
    const out = run(cfg, { output: '0\n' }, ['run-smoke']);
    expect(validateDeployResult(out.failure)).toBeNull();
    expect(out.failure).toMatchObject({ status: 'failed-recovered', migrated: false, recovery: { action: 'flip-back', verified: true } });
    expect(out.calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(stopped(out.calls)).toBe(false);
  });
});

describe('probe first: unknown or pending takes the full path, probing once', () => {
  const probes = (calls: string[]) => calls.filter((cmd) => cmd.includes('check-pending')).length;
  it.each([
    ['a failed probe that prints 0', { output: '0\n', fail: true }],
    ['unparseable output', { output: 'all good\n' }],
    ['a count of 3', { output: '3\n' }],
  ])('%s', (_name, probe) => {
    const out = run(config(), probe);
    expect(out.thrown).toBeUndefined();
    expect(out.names.filter((n) => FULL.includes(n))).toEqual(FULL);
    expect(out.names).not.toContain('pending-migrations');
    expect(probes(out.calls)).toBe(1);
    expect(out.result.migrated).toBe(true);
    expect(out.names.indexOf('pending-migrations-probe')).toBeLessThan(out.names.indexOf('stop-writers'));
  });
});

describe('probe first: the probe is read-only', () => {
  it('a failing gate after the probe is aborted-clean: the probe ran, nothing live did', () => {
    const out = run(config(), { output: '0\n' }, ['check-idle'], Date.parse('2026-07-10T09:00:00Z') / 1000);
    expect(out.names).toContain('pending-migrations-probe');
    expect(out.names).not.toContain('previous-pointer');
    expect(out.failure).toMatchObject({ status: 'aborted-clean', effectsClean: true });
    expect(stopped(out.calls)).toBe(false);
  });
});

describe('migrationsExclusive off keeps today\'s order', () => {
  it('stop, backup, then the live probe, then migrate', () => {
    const out = run(config({ migrationsExclusive: false }), { output: '0\n' });
    expect(out.thrown).toBeUndefined();
    const core = out.names.filter((n) => ['stop-writers', 'backup', 'pending-migrations', 'pending-migrations-probe', 'migrate', 'previous-pointer'].includes(n));
    expect(core).toEqual(['stop-writers', 'backup', 'pending-migrations', 'previous-pointer']);
    expect(out.steps.find((s) => s.step === 'pending-migrations')!.class).toBe('live');
    expect(stopped(out.calls)).toBe(true);
  });
  it('is absent from the probe-less default and validated as a boolean', () => {
    expect(DEFAULT_CONFIG.hooks.migrationsExclusive).toBe(false);
    expect(validateConfig({ hooks: { migrationsExclusive: true } })).toEqual([]);
    expect(validateConfig({ hooks: { migrationsExclusive: 'yes' as unknown as boolean } }).join('\n')).toMatch(/migrationsExclusive/);
  });
  it('without pendingMigrations it is inert', () => {
    const out = run(config({ pendingMigrations: null }), { output: '0\n' });
    expect(out.names).toContain('stop-writers');
    expect(out.names).toContain('migrate');
    expect(out.names).not.toContain('pending-migrations-probe');
  });
});
