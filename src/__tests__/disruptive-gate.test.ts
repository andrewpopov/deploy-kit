import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { makeTarget, requestMeta, runIdN, OTHER_REQUEST_ID, Target } from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const kit = require('../index.js');
const release = require('../release.js');
const lock = require('../lock.js');
const { validateDeployResult } = require('../deploy-result.js');
const { mergeConfig, DEFAULT_CONFIG, validateConfig } = kit;

const BUILT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CURRENT = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS = 'releases/00000000bbbb-20260708T090000Z';
const BACKUP = '/var/lib/app/backups/app-20260710T090000Z.db.gpg';

// The content-aware fake of deploy-result.test.ts, plus a hook that fires when a command runs (a simulated production mutation).
function makeRuntime(over: { runningSha?: string; fail?: string[]; failWhen?: (cmd: string) => boolean; onCommand?: (cmd: string) => void } = {}) {
  const cfg = { runningSha: BUILT_SHA, fail: [] as string[], ...over };
  const calls: string[] = [];
  let stopped = false;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    cfg.onCommand?.(cmd);
    if (cfg.failWhen?.(cmd)) throw Object.assign(new Error(`busy: ${cmd}`), { stdout: '' });
    if (cfg.fail.some((f) => cmd.includes(f))) throw Object.assign(new Error(`fake failure: ${cmd}`), { stdout: '' });
    if (/pm2 stop /.test(cmd)) { stopped = true; return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped = false; return ''; }
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return '';
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse')) return BUILT_SHA;
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

const config = (over: Record<string, unknown> = {}, effects?: Record<string, string>) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore' },
  layout: {
    type: 'releases', keepReleases: 4, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha', ...(effects ? { effects } : {}),
  },
  ...over,
});
const codeOnly = (over: Record<string, unknown> = {}, effects?: Record<string, string>) => config({
  dbBoundApps: [],
  hooks: { install: 'npm ci', build: 'npm run build', backup: null, migrate: null, restore: null }, ...over,
}, effects);


const GATE = { checks: [{ name: 'feeders-idle', command: 'check-feeders-idle' }], pollSeconds: 60, maxWaitSeconds: 900 };
const withGate = (cfg: any, gate: Record<string, unknown> = GATE) => ({ ...cfg, layout: { ...cfg.layout, disruptiveGate: gate } });
const isGateCheck = (cmd: string) => cmd.includes('check-feeders-idle');

type Step = { step: string; class: string; callsBefore: number };
// A virtual clock that the fake sleep advances, so a 15 minute wait costs nothing.
function run(cfg: any, opts: { busyPolls?: number; alwaysBusy?: boolean; notAfter?: number } = {}) {
  let clock = Date.parse('2026-07-10T09:00:00Z');
  let polls = 0;
  const fake = makeRuntime({
    failWhen: (cmd) => {
      if (!isGateCheck(cmd)) return false;
      polls += 1;
      return opts.alwaysBusy || polls <= (opts.busyPolls ?? 0);
    },
  });
  const steps: Step[] = [];
  const sleeps: number[] = [];
  const ctx = {
    runtime: fake.runtime, now: () => clock, sleep: (s: number) => { sleeps.push(s); clock += s * 1000; },
    ...(opts.notAfter != null ? { notAfter: opts.notAfter } : {}),
    onStep: (entry: { step: string; class: string }) => steps.push({ ...entry, callsBefore: fake.calls.length }),
  };
  let result: any;
  let thrown: any;
  try { result = release.deployRelease(cfg, {}, ctx); } catch (error) { thrown = error; }
  return { steps, calls: fake.calls, sleeps, polls: () => polls, elapsed: () => (clock - Date.parse('2026-07-10T09:00:00Z')) / 1000, result, thrown, failure: thrown?.deployResult };
}
const names = (steps: Step[]) => steps.map((s) => `${s.step}:${s.class}`);
// The ledger entry after which the first live step follows: the gate must be the last thing before it.
const stepAfterGate = (steps: Step[]) => {
  const last = steps.map((s) => s.step).lastIndexOf('disruptive-gate');
  return steps[last + 1].step;
};
const gateEntries = (steps: Step[]) => steps.filter((s) => s.step === 'disruptive-gate');
const CAND = { install: 'candidate', generate: 'candidate', build: 'candidate' };

describe('layout.disruptiveGate config validation', () => {
  const check = (gate: unknown) => validateConfig({ layout: { type: 'releases', disruptiveGate: gate } }, 'cfg');
  it('accepts a gate with checks and optional timings', () => {
    expect(check(GATE)).toEqual([]);
    expect(check({ checks: GATE.checks })).toEqual([]);
  });
  it.each([
    ['no checks', { pollSeconds: 5 }, /disruptiveGate\.checks" must be a non-empty array/],
    ['an empty check list', { checks: [] }, /disruptiveGate\.checks" must be a non-empty array/],
    ['a check without a command', { checks: [{ name: 'x' }] }, /command must be a non-empty string/],
    ['a bad pollSeconds', { ...GATE, pollSeconds: 0 }, /pollSeconds" must be a positive number/],
    ['a bad maxWaitSeconds', { ...GATE, maxWaitSeconds: 'soon' }, /maxWaitSeconds" must be a positive number/],
    ['an unknown key', { ...GATE, retries: 3 }, /retries/],
    ['a non-object', ['x'], /must be an object/],
  ])('refuses %s', (_name, gate, message) => {
    expect(check(gate).join('\n')).toMatch(message);
  });
});

describe('the gate runs right before the first live step, whatever it is', () => {
  it('an undeclared install hook (live): the gate runs before install', () => {
    const out = run(withGate(codeOnly()));
    expect(out.thrown).toBeUndefined();
    expect(stepAfterGate(out.steps)).toBe('install');
    const order = out.steps.map((s) => s.step);
    expect(order.indexOf('disruptive-gate')).toBeGreaterThan(order.indexOf('shared-links'));
    const npmCi = out.calls.findIndex((cmd) => cmd.includes('npm ci'));
    const gateCheck = out.calls.findIndex(isGateCheck);
    expect(gateCheck).toBeGreaterThanOrEqual(0);
    expect(gateCheck).toBeLessThan(npmCi);
  });

  it('install, generate and build declared candidate, no migration: the gate runs before previous-pointer', () => {
    const out = run(withGate(codeOnly({}, CAND)));
    expect(out.thrown).toBeUndefined();
    expect(stepAfterGate(out.steps)).toBe('previous-pointer');
    const mv = out.calls.findIndex((cmd) => cmd.includes('mv -Tf'));
    expect(out.calls.findIndex(isGateCheck)).toBeLessThan(mv);
    expect(names(out.steps).filter((n) => n.endsWith(':live'))[0]).toBe('previous-pointer:live');
  });

  it('when migrating: before stop-writers', () => {
    const out = run(withGate(config({}, CAND)));
    expect(out.thrown).toBeUndefined();
    expect(stepAfterGate(out.steps)).toBe('stop-writers');
    const stop = out.calls.findIndex((cmd) => /pm2 stop /.test(cmd));
    expect(out.calls.findIndex(isGateCheck)).toBeLessThan(stop);
  });

  it('records each poll and its outcome as a read-only disruptive-gate entry', () => {
    const out = run(withGate(codeOnly({}, CAND)), { busyPolls: 1 });
    const entries = gateEntries(out.steps);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.class === 'read-only')).toBe(true);
  });
});

describe('waiting', () => {
  it('busy, then ok within the wait: proceeds and deploys', () => {
    const out = run(withGate(codeOnly({}, CAND)), { busyPolls: 3 });
    expect(out.thrown).toBeUndefined();
    expect(out.result.status).toBe('deployed');
    expect(out.sleeps.filter((s) => s === 60)).toEqual([60, 60, 60]);
    expect(out.polls()).toBe(4);
  });

  it('busy past the wait: aborted-clean, effectsClean true, stage disruptive-gate, candidate quarantined, nothing live ran', () => {
    const out = run(withGate(codeOnly({}, CAND)), { alwaysBusy: true });
    expect(validateDeployResult(out.failure)).toBeNull();
    expect(out.failure).toMatchObject({
      status: 'aborted-clean', stage: 'disruptive-gate', effectsClean: true, recovery: { action: 'quarantine' },
    });
    expect(out.failure.error).toMatch(/Disruptive gate failed: feeders-idle/);
    expect(out.elapsed()).toBe(900);
    expect(names(out.steps).some((n) => n.endsWith(':live'))).toBe(false);
    expect(out.calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    expect(out.calls.some((cmd) => cmd.includes('worktree remove'))).toBe(true);
  });

  it('busy past notAfter: stops at notAfter, not at maxWaitSeconds', () => {
    const start = Date.parse('2026-07-10T09:00:00Z') / 1000;
    const out = run(withGate(codeOnly({}, CAND)), { alwaysBusy: true, notAfter: start + 130 });
    expect(out.failure).toMatchObject({ status: 'aborted-clean', stage: 'disruptive-gate', effectsClean: true });
    expect(out.elapsed()).toBe(130);
  });

  it('an undeclared live hook ahead of the gate point still gets the gate first: a busy gate means install never ran', () => {
    const out = run(withGate(codeOnly()), { alwaysBusy: true });
    expect(out.failure).toMatchObject({ status: 'aborted-clean', stage: 'disruptive-gate', effectsClean: true });
    expect(out.calls.some((cmd) => cmd.includes('npm ci'))).toBe(false);
  });
});

describe('once, and only before the first live step', () => {
  it('runs exactly once per run, passing the first time', () => {
    const out = run(withGate(config({}, CAND)));
    expect(out.polls()).toBe(1);
    expect(out.steps.filter((s) => s.step === 'disruptive-gate').length).toBe(2); // one poll, one outcome
  });

  it('never runs after a live step has started: every gate entry precedes the first live step', () => {
    const out = run(withGate(config()));
    const firstLive = out.steps.findIndex((s) => s.class === 'live');
    const lastGate = out.steps.map((s) => s.step).lastIndexOf('disruptive-gate');
    expect(firstLive).toBeGreaterThan(lastGate);
    expect(out.polls()).toBe(1);
  });
});

describe('no gate configured', () => {
  it('has no disruptive-gate entries and no extra commands', () => {
    const out = run(codeOnly({}, CAND));
    expect(out.thrown).toBeUndefined();
    expect(gateEntries(out.steps)).toEqual([]);
    expect(out.polls()).toBe(0);
    expect(names(out.steps)).toEqual([
      'preflight:read-only', 'fetch:staging', 'worktree-add:candidate', 'shared-links:candidate', 'install:candidate', 'verify-pins:read-only',
      'build:candidate', 'previous-pointer:live', 'current-pointer:live', 'pm2-restart:live', 'prune:live',
    ]);
  });
});

const describeWithFlock = hasFlock ? describe : describe.skip;

describeWithFlock('host-run: a refused gate is a clean abort, not an unresolved app', () => {
  let t: Target;
  beforeEach(() => { t = makeTarget(); });
  afterEach(() => t.cleanup());
  const unresolvedFile = () => `deploy-kit-${lock.lockId(t.config)}.unresolved.json`;

  function realPipeline(pipelineConfig: any, runtimeOver: Parameters<typeof makeRuntime>[0] = {}) {
    return (_cfg: unknown, _opts: unknown, ctx: any) => {
      const fake = makeRuntime(runtimeOver);
      let clock = Date.parse('2026-07-10T09:00:00Z');
      return release.deployRelease(pipelineConfig, {}, {
        ...ctx, runtime: { execFileSync: (file: string, args: string[], o: any) => (/pwd -P/.test(args[args.length - 1] || '') ? t.runtime.execFileSync(file, args, o) : fake.runtime.execFileSync(file, args)) },
        sleep: (s: number) => { clock += s * 1000; }, now: () => clock,
      });
    };
  }
  const forApp = () => withGate(codeOnly({
    projectDir: t.config.projectDir, host: null, mode: 'local', onHost: { required: true }, hostLock: t.config.hostLock,
  }, CAND));

  it('busy past the wait: aborted-clean, effectsClean true, no unresolved marker, and a different request can then proceed', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const first = t.go(runId, { pipeline: realPipeline(forApp(), { failWhen: isGateCheck }) });
    expect(first.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toMatchObject({ status: 'aborted-clean', stage: 'disruptive-gate', effectsClean: true });
    expect(t.readJson(`runs/${runId}/terminal.json`).effects.map((e: Step) => e.step)).toContain('disruptive-gate');
    expect(t.has(unresolvedFile())).toBe(false);

    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID }));
    const second = t.go(runIdN(2), { pipeline: realPipeline(forApp()) });
    expect(second.code).toBe(0);
    expect(second.deployRelease).toHaveBeenCalled();
    expect(t.has(`runs/${runIdN(2)}/refused.json`)).toBe(false);
  });

  it('the controller\'s notAfter reaches the pipeline as ctx.notAfter', () => {
    const runId = runIdN(1);
    t.stage(runId);
    let seen: unknown;
    t.go(runId, { pipeline: (_c: unknown, _o: unknown, ctx: any) => { seen = ctx.notAfter; return undefined; } });
    expect(seen).toBe((requestMeta() as any).notAfter);
  });
});
