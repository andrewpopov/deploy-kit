import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import {
  makeTarget, requestMeta, deployResult, runIdN, KIT_ARTIFACT, SHA, LIVE_SHA, REQUEST_ID, OTHER_REQUEST_ID, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const lock = require('../lock.js');
const kit = require('../index.js');
const release = require('../release.js');
const { classifyJournal } = require('../target-state.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const describeWithFlock = hasFlock ? describe : describe.skip;

// The release the parent deploy (sha SHA) was building when it was interrupted.
const RELEASE_ID = `${SHA.slice(0, 12)}-20261023T095900Z`;
const PARENT = runIdN(2);
const OTHER_PARENT = runIdN(3);

let t: Target;
beforeEach(() => { t = makeTarget(); });
afterEach(() => t.cleanup());

const journalFile = () => path.join(t.config.projectDir, '.deploy-kit-state.json');
const writeJournal = (over: Record<string, unknown> = {}) => fs.writeFileSync(journalFile(), JSON.stringify({ phase: 'stopped', releaseId: RELEASE_ID, ...over }));
const unresolvedRel = () => `deploy-kit-${lock.lockId(t.config)}.unresolved.json`;
const marker = (over: Record<string, unknown> = {}) => ({ requestId: OTHER_REQUEST_ID, runId: PARENT, kind: 'deploy', status: 'failed-unrecovered', error: 'boom', at: '2026-10-23T09:59:30.000Z', ...over });
const recoverMeta = (over: Record<string, unknown> = {}) => requestMeta({ kind: 'recover', parentRunId: PARENT, sha: '0'.repeat(40), ...over });
// The parent run: accepted for SHA, its deploy left the journal and the marker behind.
const stageAndGo = (runId: string, meta: Record<string, unknown>, options: Parameters<Target['go']>[1] = {}) => {
  t.stage(runId, meta);
  return t.go(runId, options);
};
// Its release.json is the pipeline's record of exactly which release the run created; accepted.json carries the sha.
const putParent = (runId = PARENT, releaseId = RELEASE_ID, sha = SHA) => {
  t.put(`runs/${runId}/accepted.json`, { runId, requestId: OTHER_REQUEST_ID, kind: 'deploy', sha });
  t.put(`runs/${runId}/release.json`, { runId, requestId: OTHER_REQUEST_ID, releaseId, sha });
};

// What recoverRelease does on success, as far as the host can see: the live step in the ledger, the journal terminal.
const recoversInterrupted = (_c: unknown, _o: unknown, ctx: { onStep: (e: { step: string; class: string }) => void }) => {
  ctx.onStep({ step: 'recover-interrupted', class: 'live' });
  writeJournal({ phase: 'recovered' });
  return deployResult({ status: 'failed-recovered', stage: 'recover-interrupted', recovery: { action: 'resume-previous', verified: true }, error: null, effectsClean: false });
};

function expectRefused(runId: string, code: string, run: { code: number; recoverRelease: unknown; deployRelease: unknown }) {
  expect(run.code).toBe(1);
  expect(run.recoverRelease).not.toHaveBeenCalled();
  expect(run.deployRelease).not.toHaveBeenCalled();
  expect(t.readJson(`runs/${runId}/refused.json`)).toEqual({ runId, code });
  expect(t.has(`runs/${runId}/accepted.json`)).toBe(false);
  expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
  expect(t.has(`requests/${REQUEST_ID}.json`)).toBe(false);
  expect(t.lockLeft()).toEqual([]);
}

describeWithFlock('recover --on-host: a verified recovery of the parent run', () => {
  it('runs only recoverRelease under the owned locks, leaves the journal recovered, and archives the parent\'s unresolved marker', () => {
    writeJournal();
    putParent();
    t.put(unresolvedRel(), marker());
    const runId = runIdN(1);
    t.stage(runId, recoverMeta());
    const run = t.go(runId, { recoverPipeline: recoversInterrupted });
    expect(run.code).toBe(0);
    expect(run.deployRelease).not.toHaveBeenCalled();
    expect(run.rollbackRelease).not.toHaveBeenCalled();
    expect(run.git.stage).not.toHaveBeenCalled(); // a recover fetches nothing
    expect(t.events).toEqual(['readLive', 'recover-pipeline', 'readLive']);
    const [, , ctx] = run.recoverRelease.mock.calls[0];
    expect(ctx.ownedLocks).toMatchObject({ runId, pid: process.pid });
    expect(t.readJson(`runs/${runId}/accepted.json`)).toMatchObject({ runId, requestId: REQUEST_ID, kind: 'recover', gen: 1 });
    expect(t.readJson(`runs/${runId}/terminal.json`)).toEqual({
      runId,
      kind: 'recover',
      result: deployResult({
        status: 'failed-recovered', stage: 'recover-interrupted', liveBefore: LIVE_SHA, liveAfter: LIVE_SHA, effectsClean: false, error: null,
        recovery: { action: 'resume-previous', verified: true },
      }),
      effects: [{ step: 'recover-interrupted', class: 'live' }],
      kitArtifact: KIT_ARTIFACT,
      finishedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(t.readJson(`runs/${runId}/outcome.json`)).toMatchObject({ runId, ok: true });
    expect(classifyJournal(fs.readFileSync(journalFile(), 'utf8'))).toMatchObject({ class: 'terminal', phase: 'recovered' });
    // the marker is archived like `resolve` does: moved next to a resolution record, and the app is unblocked
    expect(t.has(unresolvedRel())).toBe(false);
    const archive = fs.readdirSync(t.dk('resolved')).sort();
    expect(archive).toEqual([expect.stringMatching(/-req-deploy-gateapp-20261023-3-e0\.resolution\.json$/), expect.stringMatching(/-req-deploy-gateapp-20261023-3-e0\.unresolved\.json$/)]);
    expect(JSON.parse(fs.readFileSync(t.dk(`resolved/${archive[0]}`), 'utf8'))).toMatchObject({
      requestId: OTHER_REQUEST_ID, reason: `recovered by run ${runId} (request ${REQUEST_ID})`,
    });
    expect(JSON.parse(fs.readFileSync(t.dk(`resolved/${archive[1]}`), 'utf8'))).toEqual(marker());
    expect(t.lockLeft()).toEqual([]);
    expect(t.status(runId).state).toBe('terminal');
  });

  it('with no marker on the target (a controller-side unresolved) the recover still runs and writes none', () => {
    writeJournal();
    putParent();
    const run = stageAndGo(runIdN(1), recoverMeta(), { recoverPipeline: recoversInterrupted });
    expect(run.code).toBe(0);
    expect(t.has(unresolvedRel())).toBe(false);
    expect(t.has('resolved')).toBe(false);
  });

  it('a marker naming a different run than the parent is left alone by a verified recovery', () => {
    writeJournal();
    putParent();
    // the gate would refuse this recover; stage the marker after the gates by writing it from the pipeline
    const run = stageAndGo(runIdN(1), recoverMeta(), {
      recoverPipeline: (c, o, ctx) => { t.put(unresolvedRel(), marker({ runId: OTHER_PARENT })); return recoversInterrupted(c, o, ctx); },
    });
    expect(run.code).toBe(0);
    expect(t.readJson(unresolvedRel())).toEqual(marker({ runId: OTHER_PARENT }));
  });
});

describeWithFlock('recover --on-host: a recover that does not verify', () => {
  const failing = (_c: unknown, _o: unknown, ctx: { onStep: (e: { step: string; class: string }) => void }) => {
    ctx.onStep({ step: 'recover-interrupted', class: 'live' });
    throw Object.assign(new Error('MANUAL RECOVERY REQUIRED — failed to bring the previous release back online'), {
      deployResult: deployResult({ status: 'failed-unrecovered', error: 'MANUAL RECOVERY REQUIRED', recovery: { action: 'resume-previous', verified: false } }),
    });
  };

  it('keeps the marker byte for byte, exits 1, and still lets a retry for the same parent through', () => {
    writeJournal();
    putParent();
    t.put(unresolvedRel(), marker());
    const before = fs.readFileSync(t.dk(unresolvedRel()), 'utf8');
    const first = stageAndGo(runIdN(1), recoverMeta(), { recoverPipeline: failing });
    expect(first.code).toBe(1);
    expect(fs.readFileSync(t.dk(unresolvedRel()), 'utf8')).toBe(before);
    expect(t.readJson(`runs/${runIdN(1)}/terminal.json`)).toMatchObject({ kind: 'recover', result: { status: 'failed-unrecovered' } });
    expect(t.readJson(`runs/${runIdN(1)}/outcome.json`)).toMatchObject({ ok: false });
    expect(t.has('resolved')).toBe(false);
    // the marker still names the parent run, so the next recover for that parent is admitted
    t.stage(runIdN(4), recoverMeta({ requestId: OTHER_REQUEST_ID }));
    const retry = t.go(runIdN(4), { recoverPipeline: recoversInterrupted });
    expect(retry.code).toBe(0);
    expect(t.has(unresolvedRel())).toBe(false);
  });

  it('an unverified recovery result (failed-recovered, verified false) is not a success and keeps the marker', () => {
    writeJournal();
    putParent();
    t.put(unresolvedRel(), marker());
    const run = stageAndGo(runIdN(1), recoverMeta(), {
      recoverPipeline: () => deployResult({ status: 'failed-recovered', recovery: { action: 'resume-previous', verified: false } }),
    });
    expect(run.code).toBe(1);
    expect(t.readJson(unresolvedRel())).toEqual(marker());
  });

  it('with no earlier marker, a failed recover writes one naming itself', () => {
    writeJournal();
    putParent();
    const run = stageAndGo(runIdN(1), recoverMeta(), { recoverPipeline: failing });
    expect(run.code).toBe(1);
    expect(t.readJson(unresolvedRel())).toMatchObject({ requestId: REQUEST_ID, runId: runIdN(1), kind: 'recover', status: 'failed-unrecovered' });
  });
});

describeWithFlock('recover --on-host: the kind gate (plan 4.1)', () => {
  it.each([
    ['no journal', null],
    ['a done journal', { phase: 'done', releaseId: RELEASE_ID }],
    ['an already recovered journal', { phase: 'recovered', releaseId: RELEASE_ID }],
    ['a post-deploy-rolled-back journal', { phase: 'post-deploy-rolled-back', releaseId: RELEASE_ID }],
  ])('%s refuses nothing-to-recover', (_name, journal) => {
    putParent();
    if (journal) fs.writeFileSync(journalFile(), JSON.stringify(journal));
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'nothing-to-recover', t.go(runIdN(1)));
  });

  it('a corrupt journal refuses journal-corrupt', () => {
    putParent();
    fs.writeFileSync(journalFile(), '[');
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'journal-corrupt', t.go(runIdN(1)));
  });

  it('a journal for a release the parent run did not deploy refuses recover-parent-mismatch', () => {
    writeJournal({ releaseId: `${'b'.repeat(12)}-20261023T095900Z` });
    putParent();
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'recover-parent-mismatch', t.go(runIdN(1)));
  });

  it('a journal with no release id refuses recover-parent-mismatch', () => {
    fs.writeFileSync(journalFile(), JSON.stringify({ phase: 'stopped' }));
    putParent();
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'recover-parent-mismatch', t.go(runIdN(1)));
  });

  it('a parent run that is not on the host refuses recover-parent-unknown', () => {
    writeJournal();
    t.stage(runIdN(1), recoverMeta({ parentRunId: runIdN(8) }));
    expectRefused(runIdN(1), 'recover-parent-unknown', t.go(runIdN(1)));
  });

  // BRAIN-636 review finding 7: the staged meta.json (or an accepted.json sha) is not evidence of which release a run created.
  it.each([
    ['an unreadable release.json', () => t.put(`runs/${PARENT}/release.json`, '{nope')],
    ['a release.json naming another run', () => t.put(`runs/${PARENT}/release.json`, { runId: OTHER_PARENT, releaseId: RELEASE_ID })],
    ['only a staged meta.json and an accepted.json with the sha', () => {
      fs.rmSync(t.dk(`runs/${PARENT}/release.json`));
      t.put(`runs/${PARENT}/meta.json`, { runId: PARENT, sha: SHA });
    }],
  ])('a parent with %s refuses recover-parent-unknown', (_name, damage) => {
    writeJournal();
    putParent();
    damage();
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'recover-parent-unknown', t.go(runIdN(1)));
  });

  it('two attempts at the SAME sha created different releases: the journal of one is not recoverable as the other', () => {
    const attemptA = `${SHA.slice(0, 12)}-20261023T095900Z`;
    const attemptB = `${SHA.slice(0, 12)}-20261023T095930Z`;
    putParent(PARENT, attemptA);
    putParent(OTHER_PARENT, attemptB);
    writeJournal({ releaseId: attemptB }); // the interrupted journal is attempt B's
    t.stage(runIdN(1), recoverMeta()); // names attempt A as the parent
    expectRefused(runIdN(1), 'recover-parent-mismatch', t.go(runIdN(1)));
    t.stage(runIdN(5), recoverMeta({ requestId: OTHER_REQUEST_ID, parentRunId: OTHER_PARENT }));
    expect(t.go(runIdN(5), { recoverPipeline: recoversInterrupted }).code).toBe(0);
  });

  it('a recover request without a parent run is refused before any lock', () => {
    writeJournal();
    t.stage(runIdN(1), recoverMeta({ parentRunId: null }));
    const run = t.go(runIdN(1));
    expect(run.code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain('meta.parentRunId is required for a recover');
    expect(run.recoverRelease).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });
});

describeWithFlock('recover --on-host: the common gates and app-unresolved', () => {
  it('a marker left by a DIFFERENT run than the recover\'s parent blocks it: app-unresolved', () => {
    writeJournal();
    putParent();
    putParent(OTHER_PARENT);
    t.put(unresolvedRel(), marker({ runId: OTHER_PARENT }));
    t.stage(runIdN(1), recoverMeta()); // parent PARENT, marker names OTHER_PARENT
    expectRefused(runIdN(1), 'app-unresolved', t.go(runIdN(1)));
    expect(t.readJson(unresolvedRel())).toEqual(marker({ runId: OTHER_PARENT }));
  });

  it('an unreadable marker blocks a recover too (it vouches for nothing)', () => {
    writeJournal();
    putParent();
    t.put(unresolvedRel(), '{nope');
    t.stage(runIdN(1), recoverMeta());
    expectRefused(runIdN(1), 'app-unresolved', t.go(runIdN(1)));
  });

  it('the marker still blocks a deploy and a rollback, even when it names the recover\'s parent', () => {
    putParent();
    t.put(unresolvedRel(), marker());
    t.stage(runIdN(1), requestMeta());
    expectRefused(runIdN(1), 'app-unresolved', t.go(runIdN(1)));
  });

  it('epoch, hold and reservation apply to a recover as to every kind', () => {
    writeJournal();
    putParent();
    t.put('.last-epoch', '5\n');
    t.stage(runIdN(1), recoverMeta({ epoch: 4 }));
    expectRefused(runIdN(1), 'epoch-mismatch', t.go(runIdN(1)));
    fs.rmSync(t.dk('.last-epoch'));
    t.put(`deploy-kit-${lock.lockId(t.config)}.hold.json`, { reason: 'cutover', until: null, at: 'x', epoch: null });
    t.stage(runIdN(6), recoverMeta());
    expectRefused(runIdN(6), 'hold', t.go(runIdN(6)));
    fs.rmSync(t.dk(`deploy-kit-${lock.lockId(t.config)}.hold.json`));
    t.stage(runIdN(7), recoverMeta({ expectReservation: { state: 'clean-abort', runId: runIdN(9), gen: 1 } }));
    expectRefused(runIdN(7), 'reservation-missing', t.go(runIdN(7)));
  });
});

// ---- the real recoverRelease -----------------------------------------------------------------------------------

const PREVIOUS = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS_SHA = '00000000aaaa' + 'a'.repeat(28);

// A release-layout host that answers the commands recovery issues; `stateContent` is the journal.
function releaseHost(stateContent: string, health = '200') {
  const calls: string[] = [];
  const cfg = { stateContent };
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return cfg.stateContent;
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20261023T100000Z';
    if (cmd.includes('rev-parse')) return PREVIOUS_SHA;
    if (cmd.includes('readlink -f')) return `/srv/app/${PREVIOUS}`;
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return PREVIOUS;
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return 'releases/00000000bbbb-20260708T090000Z';
    if (cmd.includes('get-running-sha')) return PREVIOUS_SHA;
    if (cmd.includes('curl')) return health;
    return '';
  };
  const steps: Array<{ step: string; class: string }> = [];
  const ctx = { runtime: { execFileSync }, sleep: () => {}, now: () => Date.parse('2026-10-23T10:00:00Z'), onStep: (e: { step: string; class: string }) => steps.push(e) };
  return { calls, steps, ctx };
}

const relConfig = (over: Record<string, unknown> = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore' },
  layout: { type: 'releases', keepReleases: 4, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha' },
  ...over,
});

const stoppedJournal = JSON.stringify({ phase: 'stopped', releaseId: RELEASE_ID, prevTarget: PREVIOUS, migrated: false });
const thrownResult = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return { error: error as Error, result: (error as Error & { deployResult: any }).deployResult };
  }
  throw new Error('expected recoverRelease to throw');
};

describe('recoverRelease: only the interrupted-journal recovery', () => {
  it('resumes the previous release, journals recovered, and returns a verified failed-recovered DeployResult with a live ledger step', () => {
    const { calls, steps, ctx } = releaseHost(stoppedJournal);
    const result = release.recoverRelease(relConfig(), {}, ctx);
    expect(result).toEqual({
      status: 'failed-recovered', stage: 'recover-interrupted', liveBefore: '00000000aaaa', liveAfter: '00000000aaaa', migrated: false,
      migrationsPending: null, backupId: null, effectsClean: false, recovery: { action: 'resume-previous', verified: true }, error: null,
    });
    expect(steps).toEqual([{ step: 'preflight', class: 'read-only' }, { step: 'recover-interrupted', class: 'live' }]);
    expect(calls.some((c) => c.includes('pm2 startOrRestart'))).toBe(true);
    expect(calls.filter((c) => c.includes('"phase":"recovered"'))).toHaveLength(1);
    // nothing of a deploy ran: no fetch, no worktree, no hook, no backup, no restore, no pointer flip
    for (const forbidden of ['fetch', 'worktree add', 'npm ci', 'npm run build', 'run-backup', 'run-migrate', 'run-restore', 'pm2 stop', 'ln -s', 'mv -Tf']) {
      expect(calls.filter((c) => c.includes(forbidden)), forbidden).toEqual([]);
    }
  });

  it('a journal that is not interrupted throws, with a clean-abort DeployResult, and starts nothing', () => {
    for (const journal of ['', JSON.stringify({ phase: 'done', releaseId: RELEASE_ID }), JSON.stringify({ phase: 'recovered', releaseId: RELEASE_ID })]) {
      const { calls, ctx } = releaseHost(journal);
      const { error, result } = thrownResult(() => release.recoverRelease(relConfig(), {}, ctx));
      expect(error.message).toMatch(/^Nothing to recover/);
      // nothing was touched (only the read-only preflight ran), which the ledger classes as a clean abort
      expect(result).toMatchObject({ status: 'aborted-clean', effectsClean: true, recovery: { action: 'none', verified: false } });
      expect(calls.some((c) => c.includes('pm2 startOrRestart') || c.includes('"phase":"recovered"'))).toBe(false);
    }
  });

  it('a migrated journal fails closed: failed-unrecovered, manual, no restore and no journal write', () => {
    const migrated = JSON.stringify({ phase: 'migrated', releaseId: RELEASE_ID, prevTarget: PREVIOUS, migrated: true, backupId: 'b1' });
    const { calls, ctx } = releaseHost(migrated);
    const { error, result } = thrownResult(() => release.recoverRelease(relConfig(), {}, ctx));
    expect(error.message).toMatch(/MANUAL RECOVERY REQUIRED/);
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'manual', verified: false } });
    expect(calls.filter((c) => /run-restore|pm2 startOrRestart|"phase":/.test(c))).toEqual([]);
  });

  it('a previous release that does not come back healthy is failed-unrecovered and leaves the journal as it was', () => {
    const { calls, ctx } = releaseHost(stoppedJournal, '500');
    const { result } = thrownResult(() => release.recoverRelease(relConfig(), {}, ctx));
    expect(result).toMatchObject({ status: 'failed-unrecovered', recovery: { action: 'resume-previous', verified: false } });
    expect(calls.some((c) => c.includes('"phase":"recovered"'))).toBe(false);
  });

  it('refuses a transition-authority config: its recovery ends the invocation instead', () => {
    const { ctx } = releaseHost(stoppedJournal);
    expect(() => release.recoverRelease({ ...relConfig(), transitionAuthority: {} }, {}, ctx)).toThrow(/transitionAuthority/);
  });

  it('deployRelease still recovers an interrupted journal before its own work (the old behaviour, unchanged)', () => {
    const { calls, ctx } = releaseHost(stoppedJournal);
    const config = relConfig({ preDeployChecks: [{ name: 'stop-here', command: 'stop-here' }] });
    const failing = { ...ctx, runtime: { execFileSync: (file: string, args: string[]) => {
      if (args[args.length - 1].includes('stop-here')) throw Object.assign(new Error('stop'), { stdout: '' });
      return ctx.runtime.execFileSync(file, args);
    } } };
    expect(() => release.deployRelease(config, {}, failing)).toThrow(/Pre-deploy check failed/);
    expect(calls.some((c) => c.includes('"phase":"recovered"'))).toBe(true);
  });
});
