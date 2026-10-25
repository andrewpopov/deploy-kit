import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import {
  makeTarget, requestMeta, runIdN, REQUEST_ID, OTHER_REQUEST_ID, LIVE_SHA, SHA, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const kit = require('../index.js');
const release = require('../release.js');
const lock = require('../lock.js');
const { validateDeployResult } = require('../deploy-result.js');
const { stepClass, BUILT_IN_STEPS, USER_HOOK_STEPS, isClean } = require('../effects.js');
const { mergeConfig, DEFAULT_CONFIG, validateConfig } = kit;

const BUILT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CURRENT = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS = 'releases/00000000bbbb-20260708T090000Z';
const BACKUP = '/var/lib/app/backups/app-20260710T090000Z.db.gpg';

// The content-aware fake of deploy-result.test.ts, plus a hook that fires when a command runs (a simulated production mutation).
function makeRuntime(over: { runningSha?: string; fail?: string[]; onCommand?: (cmd: string) => void } = {}) {
  const cfg = { runningSha: BUILT_SHA, fail: [] as string[], ...over };
  const calls: string[] = [];
  let stopped = false;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    cfg.onCommand?.(cmd);
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

type Step = { step: string; class: string };
function run(cfg: any, runtimeOver: Parameters<typeof makeRuntime>[0] = {}) {
  const fake = makeRuntime(runtimeOver);
  const steps: Array<Step & { callsBefore: number }> = [];
  const ctx = {
    runtime: fake.runtime, sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z'),
    onStep: (entry: Step) => steps.push({ ...entry, callsBefore: fake.calls.length }),
  };
  let result: any;
  let thrown: any;
  try { result = release.deployRelease(cfg, {}, ctx); } catch (error) { thrown = error; }
  return { steps, calls: fake.calls, result, thrown, failure: thrown?.deployResult };
}
const names = (steps: Step[]) => steps.map((s) => `${s.step}:${s.class}`);

describe('effects table', () => {
  it('classes a built-in step in code, a user hook as live unless layout.effects declares it, and refuses an unknown step', () => {
    expect(stepClass({}, 'staging-fetch')).toBe('staging');
    expect(stepClass({}, 'worktree-add')).toBe('candidate');
    expect(stepClass({}, 'preDeployChecks')).toBe('read-only');
    expect(stepClass({}, 'stop-writers')).toBe('live');
    expect(stepClass({ layout: { effects: { build: 'candidate' } } }, 'build')).toBe('candidate');
    expect(stepClass({ layout: { effects: { build: 'candidate' } } }, 'install')).toBe('live');
    expect(stepClass({ layout: {} }, 'install')).toBe('live');
    expect(() => stepClass({}, 'made-up')).toThrow(/unknown pipeline step/);
  });

  it('keeps built-in and declarable names apart, and only staging/candidate/read-only are clean', () => {
    expect(USER_HOOK_STEPS.filter((s: string) => s in BUILT_IN_STEPS)).toEqual([]);
    expect(isClean(['staging', 'candidate', 'read-only'])).toBe(true);
    expect(isClean(['candidate', 'live'])).toBe(false);
  });
});

describe('layout.effects config validation', () => {
  const check = (effects: unknown) => validateConfig({ layout: { type: 'releases', effects } }, 'cfg');
  it('accepts declarable steps with a declarable class', () => {
    expect(check({ install: 'candidate', generate: 'candidate', build: 'candidate', releaseChecks: 'read-only', preMigrationChecks: 'read-only' })).toEqual([]);
    expect(check({ build: 'live' })).toEqual([]);
  });
  it.each([
    ['an unknown step name', { bild: 'candidate' }, /layout\.effects\.bild" is not a declarable step/],
    ['a built-in step (fixed in code)', { 'stop-writers': 'read-only' }, /layout\.effects\.stop-writers" is not a declarable step/],
    ['the staging class (built-in only)', { build: 'staging' }, /layout\.effects\.build" must be one of candidate, read-only, live/],
    ['an unknown class', { build: 'harmless' }, /must be one of candidate, read-only, live/],
    ['a non-object', ['build'], /must be an object/],
  ])('refuses %s', (_name, effects, message) => {
    expect(check(effects).join('\n')).toMatch(message);
  });
});

describe('the ledger inside deployRelease', () => {
  it('reports each step, with its class, BEFORE the step runs', () => {
    const out = run(codeOnly({}, { install: 'candidate', build: 'candidate' }));
    expect(out.thrown).toBeUndefined();
    expect(names(out.steps)).toEqual([
      'preflight:read-only', 'fetch:staging', 'worktree-add:candidate', 'shared-links:candidate', 'install:candidate', 'verify-pins:read-only', 'build:candidate',
      'previous-pointer:live', 'current-pointer:live', 'pm2-restart:live', 'prune:live',
    ]);
    const before = (step: string, command: string) => {
      const entry = out.steps.find((s) => s.step === step)!;
      const ran = out.calls.findIndex((cmd) => cmd.includes(command));
      expect(ran, `${command} ran`).toBeGreaterThanOrEqual(0);
      expect(entry.callsBefore, `${step} reported before ${command}`).toBeLessThanOrEqual(ran);
    };
    before('worktree-add', 'worktree add');
    before('install', 'npm ci');
    before('build', 'npm run build');
    before('previous-pointer', 'mv -Tf');
    before('pm2-restart', 'pm2 startOrRestart');
    expect(out.result.effectsClean).toBeNull();
  });

  it('reports the migrating path: stop, backup and migrate are live', () => {
    const out = run(config());
    expect(names(out.steps)).toEqual(expect.arrayContaining(['stop-writers:live', 'backup:live', 'migrate:live']));
    const order = out.steps.map((s) => s.step);
    expect(order.indexOf('stop-writers')).toBeLessThan(order.indexOf('backup'));
    expect(order.indexOf('backup')).toBeLessThan(order.indexOf('migrate'));
  });

  it('classes preDeployChecks read-only, ahead of everything else', () => {
    const out = run(codeOnly({ preDeployChecks: [{ name: 'disk', command: 'check-disk' }] }));
    expect(names(out.steps).slice(0, 3)).toEqual(['preflight:read-only', 'preDeployChecks:read-only', 'fetch:staging']);
  });

  it('an undeclared hook counts as live', () => {
    const out = run(codeOnly(), { fail: ['npm ci'] });
    expect(names(out.steps)).toContain('install:live');
    expect(out.failure).toMatchObject({ status: 'failed', effectsClean: false });
  });

  it('a declared candidate build failure is a clean abort: aborted-clean, effectsClean true, candidate quarantined', () => {
    const out = run(codeOnly({}, { install: 'candidate', build: 'candidate' }), { fail: ['npm run build'] });
    expect(validateDeployResult(out.failure)).toBeNull();
    expect(out.failure).toMatchObject({
      status: 'aborted-clean', stage: 'build', effectsClean: true, migrated: false, recovery: { action: 'quarantine', verified: false },
    });
    expect(out.calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    expect(out.calls.some((cmd) => cmd.includes('worktree remove'))).toBe(true);
  });

  it('a preDeployChecks failure inside the pipeline is a clean abort (they are read-only)', () => {
    const out = run(codeOnly({ preDeployChecks: [{ name: 'disk', command: 'check-disk' }] }), { fail: ['check-disk'] });
    expect(out.failure).toMatchObject({ status: 'aborted-clean', stage: 'preflight', effectsClean: true, recovery: { action: 'none' } });
    expect(out.failure.error).toMatch(/Pre-deploy check failed: disk/);
  });

  it('an executed live step forces effectsClean false and never aborted-clean, whatever else is declared', () => {
    const out = run(config({}, { install: 'candidate', build: 'candidate' }), { fail: ['run-backup'] });
    expect(names(out.steps)).toContain('stop-writers:live');
    expect(out.failure).toMatchObject({ status: 'failed-recovered', effectsClean: false, recovery: { action: 'resume-previous', verified: true } });
  });

  it('a failure after the writer stop that recovery cannot verify is failed-unrecovered, effectsClean false', () => {
    const out = run(config({}, { install: 'candidate', build: 'candidate' }), { fail: ['run-migrate', 'run-restore'] });
    expect(out.failure).toMatchObject({ status: 'failed-unrecovered', effectsClean: false });
  });

  it('a verified flip-back keeps failed-recovered with effectsClean false', () => {
    const out = run(codeOnly({}, { install: 'candidate', build: 'candidate' }), { runningSha: 'deadbeefdeadbeef' });
    expect(out.failure).toMatchObject({ status: 'failed-recovered', effectsClean: false, recovery: { action: 'flip-back', verified: true } });
  });

  it('protected mode never claims aborted-clean, and reports effectsClean false', () => {
    const protectedConfig = codeOnly({ transitionAuthority: { command: 'authority', scope: 'host-a' } });
    const out = run(protectedConfig, { fail: ['mv --version'] });
    expect(out.failure.status).toBe('failed');
    expect(out.failure.effectsClean).toBe(false);
  });

  it('an unprotected twin of the protected failure above IS a clean abort (the protected refusal is the only difference)', () => {
    const out = run(codeOnly(), { fail: ['mv --version'] });
    expect(out.failure).toMatchObject({ status: 'aborted-clean', effectsClean: true });
  });
});

// BRAIN-636 review findings 7 and the unused `recoverInterrupted`: the pipeline tells its caller which release it is about
// to create, before any step touches it, and honours a caller that refuses to settle an old run's journal.
describe('ctx.onRelease and ctx.recoverInterrupted', () => {
  const stoppedJournal = JSON.stringify({ phase: 'stopped', releaseId: 'cafe1234cafe-20260709T090000Z', prevTarget: CURRENT });
  const withJournal = (journal: string) => (over: Parameters<typeof makeRuntime>[0] = {}) => {
    const fake = makeRuntime(over);
    const inner = fake.runtime.execFileSync;
    return {
      calls: fake.calls,
      runtime: {
        execFileSync: (file: string, args: string[]) => {
          const cmd = args[args.length - 1];
          if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) { fake.calls.push(cmd); return journal; }
          return inner(file, args);
        },
      },
    };
  };
  const deploy = (fake: { runtime: unknown; calls: string[] }, ctx: Record<string, unknown>) => {
    try { return { result: release.deployRelease(codeOnly(), {}, { runtime: fake.runtime, sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z'), ...ctx }) }; } catch (thrown) { return { thrown: thrown as any }; }
  };

  it('onRelease gets the release id and the full sha before the worktree is added', () => {
    const fake = makeRuntime();
    const seen: Array<{ releaseId: string; sha: string; callsBefore: number }> = [];
    const out = deploy(fake, { onRelease: (r: { releaseId: string; sha: string }) => seen.push({ ...r, callsBefore: fake.calls.length }) });
    expect(out.thrown).toBeUndefined();
    expect(seen).toEqual([{ releaseId: `${BUILT_SHA.slice(0, 12)}-20260710T090000Z`, sha: BUILT_SHA, callsBefore: expect.any(Number) }]);
    expect(fake.calls.slice(0, seen[0].callsBefore).some((cmd) => cmd.includes('worktree add'))).toBe(false);
    expect(fake.calls.slice(seen[0].callsBefore).some((cmd) => cmd.includes('worktree add'))).toBe(true);
  });

  it('an onRelease that throws fails the deploy before the release exists, with nothing live behind it', () => {
    const fake = makeRuntime();
    const out = deploy(fake, { onRelease: () => { throw new Error('release.json already exists'); } });
    expect(out.thrown.message).toMatch(/release.json already exists/);
    expect(out.thrown.deployResult).toMatchObject({ status: 'aborted-clean', effectsClean: true });
    expect(fake.calls.some((cmd) => cmd.includes('worktree add'))).toBe(false);
  });

  it("recoverInterrupted 'refuse': an interrupted `stopped` journal fails the deploy untouched, without restarting anything", () => {
    const fake = withJournal(stoppedJournal)();
    const steps: string[] = [];
    const out = deploy(fake, { recoverInterrupted: 'refuse', onStep: (e: Step) => steps.push(`${e.step}:${e.class}`) });
    expect(out.thrown.message).toMatch(/will not recover it as a side effect/);
    expect(out.thrown.deployResult).toMatchObject({ status: 'aborted-clean', effectsClean: true });
    expect(steps).not.toContain('recover-interrupted:live');
    expect(fake.calls.some((cmd) => /pm2 (startOrRestart|start|restart|stop)/.test(cmd))).toBe(false);
  });

  it('without the policy (or for recoverRelease) the same journal is recovered, as before', () => {
    const plain = withJournal(stoppedJournal)();
    const steps: string[] = [];
    deploy(plain, { onStep: (e: Step) => steps.push(`${e.step}:${e.class}`) });
    expect(steps).toContain('recover-interrupted:live');

    const recoverFake = withJournal(stoppedJournal)();
    const recoverSteps: string[] = [];
    try {
      release.recoverRelease(codeOnly(), {}, {
        runtime: recoverFake.runtime, sleep: () => {}, now: () => 0, recoverInterrupted: 'refuse', onStep: (e: Step) => recoverSteps.push(`${e.step}:${e.class}`),
      });
    } catch { /* the fake host may not verify the recovery; the point is that it was attempted */ }
    expect(recoverSteps).toContain('recover-interrupted:live');
  });
});

const describeWithFlock = hasFlock ? describe : describe.skip;

describeWithFlock('host-run: effects.jsonl, unresolved admission and full shas', () => {
  let t: Target;
  beforeEach(() => { t = makeTarget(); });
  afterEach(() => t.cleanup());
  const unresolvedFile = () => `deploy-kit-${lock.lockId(t.config)}.unresolved.json`;
  const ledgerLines = (runId: string) => fs.readFileSync(path.join(t.runDirOf(runId), 'effects.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // The real pipeline over a fake target, wired into host-run in place of the fixture's fake deployRelease.
  function realPipeline(pipelineConfig: any, runtimeOver: Parameters<typeof makeRuntime>[0] = {}) {
    return (_cfg: unknown, _opts: unknown, ctx: any) => {
      const fake = makeRuntime(runtimeOver);
      return release.deployRelease(pipelineConfig, {}, {
        ...ctx, runtime: { execFileSync: (file: string, args: string[], o: any) => (/pwd -P/.test(args[args.length - 1] || '') ? t.runtime.execFileSync(file, args, o) : fake.runtime.execFileSync(file, args)) },
        sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z'),
      });
    };
  }
  const forApp = (over: Record<string, unknown> = {}, effects?: Record<string, string>) => codeOnly({
    projectDir: t.config.projectDir, host: null, mode: 'local', onHost: { required: true }, hostLock: t.config.hostLock, ...over,
  }, effects);

  it('appends the staging fetch and each pipeline step to effects.jsonl before it runs, and copies them into terminal.json', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const lines: string[][] = [];
    const run = t.go(runId, {
      pipeline: (_cfg: unknown, _opts: unknown, ctx: any) => {
        ctx.onStep({ step: 'build', class: 'candidate' });
        lines.push(ledgerLines(runId).map((l) => l.step)); // the line is already on disk while the "step" is pending
        ctx.onStep({ step: 'current-pointer', class: 'live' });
        return undefined;
      },
    });
    expect(run.code).toBe(0);
    expect(lines).toEqual([['staging-fetch', 'build']]);
    const expected = [
      { step: 'staging-fetch', class: 'staging' }, { step: 'build', class: 'candidate' }, { step: 'current-pointer', class: 'live' },
    ];
    expect(ledgerLines(runId)).toEqual(expected);
    expect(t.readJson(`runs/${runId}/terminal.json`).effects).toEqual(expected);
  });

  it('writes full 40-hex shas: liveBefore from the pre-acceptance read, liveAfter from a read after the pipeline', () => {
    const runId = runIdN(1);
    t.stage(runId);
    let reads = 0;
    const afterSha = 'e'.repeat(40);
    const run = t.go(runId, {
      git: { readLive: () => { reads += 1; return reads === 1 ? LIVE_SHA : afterSha; } },
      pipeline: () => ({ ...JSON.parse(JSON.stringify({ status: 'deployed', stage: 'done', liveBefore: '000000aaaaaa', liveAfter: '000000bbbbbb', migrated: false, migrationsPending: null, backupId: null, effectsClean: null, recovery: { action: 'none', verified: false }, error: null })) }),
    });
    expect(run.code).toBe(0);
    expect(reads).toBe(2);
    const { result } = t.readJson(`runs/${runId}/terminal.json`);
    expect(result.liveBefore).toBe(LIVE_SHA);
    expect(result.liveAfter).toBe(afterSha);
    expect(result.liveBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(result.liveAfter).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a declared-candidate build failure in the real pipeline: aborted-clean, effectsClean true, no unresolved marker, request re-submittable', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const run = t.go(runId, { pipeline: realPipeline(forApp({}, { install: 'candidate', build: 'candidate' }), { fail: ['npm run build'] }) });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toMatchObject({ status: 'aborted-clean', effectsClean: true, stage: 'build' });
    expect(t.has(unresolvedFile())).toBe(false);
    expect(ledgerLines(runId).map((l) => l.class)).toEqual(expect.not.arrayContaining(['live']));
  });

  // Amendment B's required regression.
  it('an undeclared early hook that fails after a simulated production mutation leaves the app unresolved; a DIFFERENT request is refused', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const productionFile = path.join(t.home, 'production-state');
    const run = t.go(runId, {
      pipeline: realPipeline(forApp(), {
        onCommand: (cmd) => { if (cmd.includes('npm ci')) fs.writeFileSync(productionFile, 'half-written'); },
        fail: ['npm ci'],
      }),
    });
    expect(fs.existsSync(productionFile)).toBe(true);
    expect(run.code).toBe(1);
    const terminal = t.readJson(`runs/${runId}/terminal.json`);
    expect(terminal.result).toMatchObject({ status: 'failed', effectsClean: false });
    expect(terminal.effects.map((e: Step) => `${e.step}:${e.class}`)).toContain('install:live');
    expect(t.readJson(unresolvedFile())).toMatchObject({ requestId: REQUEST_ID, runId, status: 'failed' });

    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID }));
    const blocked = t.go(runIdN(2));
    expect(blocked.code).toBe(1);
    expect(blocked.deployRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('app-unresolved');
  });

  it('the real pipeline records runs/<runId>/release.json with the release it created, before any live step', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const productionFile = path.join(t.home, 'production-state');
    t.go(runId, {
      pipeline: realPipeline(forApp(), {
        onCommand: (cmd) => { if (cmd.includes('npm ci')) fs.writeFileSync(productionFile, `release.json present: ${fs.existsSync(path.join(t.runDirOf(runId), 'release.json'))}`); },
        fail: ['npm ci'],
      }),
    });
    expect(fs.readFileSync(productionFile, 'utf8')).toBe('release.json present: true');
    expect(t.readJson(`runs/${runId}/release.json`)).toEqual({
      runId, requestId: REQUEST_ID, releaseId: `${BUILT_SHA.slice(0, 12)}-20260710T090000Z`, sha: BUILT_SHA,
    });
  });

  it('a verified flip-back keeps failed-recovered and writes no unresolved marker', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const run = t.go(runId, { pipeline: realPipeline(forApp({}, { install: 'candidate', build: 'candidate' }), { runningSha: 'deadbeefdeadbeef' }) });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toMatchObject({
      status: 'failed-recovered', effectsClean: false, recovery: { action: 'flip-back', verified: true },
    });
    expect(t.has(unresolvedFile())).toBe(false);
  });

  it('a failure after the writer stop that recovery cannot verify leaves the app unresolved', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const cfg = config({
      projectDir: t.config.projectDir, host: null, mode: 'local', onHost: { required: true }, hostLock: t.config.hostLock,
    }, { install: 'candidate', build: 'candidate' });
    const run = t.go(runId, { pipeline: realPipeline(cfg, { fail: ['run-migrate', 'run-restore'] }) });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toMatchObject({ status: 'failed-unrecovered', effectsClean: false });
    expect(t.has(unresolvedFile())).toBe(true);
    void SHA;
  });
});
