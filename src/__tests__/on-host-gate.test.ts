import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import {
  makeTarget, requestMeta, deployResult, runIdN, CrashSeam, KIT_ARTIFACT, NOW_SEC, SHA, LIVE_SHA, REQUEST_ID, OTHER_REQUEST_ID, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const { resolveRequest } = require('../target-state.js');
const lock = require('../lock.js');
const { requestMeta: operatorRequestMeta, buildBundle } = require('../on-host/operator.js');

const describeWithFlock = hasFlock ? describe : describe.skip;

let t: Target;
beforeEach(() => { t = makeTarget(); });
afterEach(() => t.cleanup());

// A refusal changes nothing live: no acceptance, no reservation, no pipeline, no lock left, and D5 reads it as refused.
function expectRefused(runId: string, code: string, run: { code: number; deployRelease: ReturnType<typeof vi.fn> }) {
  expect(run.code).toBe(1);
  expect(run.deployRelease).not.toHaveBeenCalled();
  expect(t.readJson(`runs/${runId}/refused.json`)).toEqual({ runId, code });
  expect(t.has(`runs/${runId}/accepted.json`)).toBe(false);
  expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
  expect(t.has(`requests/${REQUEST_ID}.json`)).toBe(false);
  expect(t.status(runId).state).toBe('refused');
  expect(t.status(runId).code).toBe(code);
}

describeWithFlock('host-run request protocol: the happy path', () => {
  it('stages, gates, accepts, runs the pipeline with the owned handle, writes terminal.json and releases the locks', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const run = t.go(runId);
    expect(run.code).toBe(0);
    expect(t.events).toEqual(['stage', 'readLive', 'isAncestor', 'pipeline', 'readLive']);
    const [, options, ctx] = run.deployRelease.mock.calls[0];
    expect(options).toEqual({ skipBuild: true, verifyPins: false, sha: SHA, autoCut: false, stealLock: false });
    expect(ctx.recoverInterrupted).toBe('refuse');
    expect(ctx.ownedLocks).toMatchObject({ runId, pid: process.pid });
    expect(t.readJson(`runs/${runId}/accepted.json`)).toMatchObject({ runId, requestId: REQUEST_ID, kind: 'deploy', gen: 1 });
    expect(t.readJson(`requests/${REQUEST_ID}.json`)).toMatchObject({ requestId: REQUEST_ID, gen: 1, state: 'accepted', runId, liveBefore: LIVE_SHA, prev: null });
    expect(t.readJson(`runs/${runId}/terminal.json`)).toEqual({
      runId, kind: 'deploy', result: deployResult({ stage: null, liveBefore: LIVE_SHA, liveAfter: LIVE_SHA }), effects: [{ step: 'staging-fetch', class: 'staging' }], kitArtifact: KIT_ARTIFACT, finishedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(t.readJson(`runs/${runId}/outcome.json`)).toMatchObject({ runId, ok: true });
    expect(t.has('deploy-kit-' + lock.lockId(t.config) + '.unresolved.json')).toBe(false);
    expect(t.lockLeft()).toEqual([]);
    expect(t.status(runId).state).toBe('terminal');
  });

  it('a pipeline that returns a DeployResult has its fields written, without the pipeline\'s legacy fields', () => {
    const runId = runIdN(1);
    t.stage(runId);
    t.go(runId, { pipeline: () => ({ ...deployResult({ liveAfter: SHA }), steps: ['flip'], healthy: true }) });
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toEqual(deployResult({ liveBefore: LIVE_SHA, liveAfter: LIVE_SHA }));
  });
});

describeWithFlock('host-run request protocol: order', () => {
  it('stages BEFORE the gates, and every gate runs BEFORE acceptance', () => {
    const runId = runIdN(1);
    t.config.preDeployChecks.push({ name: 'feeders', command: 'true' });
    t.stage(runId, requestMeta(), { preDeployChecks: t.config.preDeployChecks });
    const checkSnapshots: boolean[] = [];
    t.go(runId, {
      deps: { runCheck: () => { t.snapshots.push({ at: 'check', accepted: fs.existsSync(t.runDirOf(runId) + '/accepted.json'), reservation: t.has(`requests/${REQUEST_ID}.json`) }); checkSnapshots.push(true); return { ok: true }; } },
    });
    expect(t.events.slice(0, 3)).toEqual(['stage', 'readLive', 'isAncestor']);
    for (const at of ['stage', 'readLive', 'isAncestor', 'check']) {
      const seen = t.snapshots.find((s) => s.at === at);
      expect(seen, at).toBeDefined();
      expect(seen, at).toMatchObject({ accepted: false, reservation: false });
    }
    expect(t.snapshots.find((s) => s.at === 'pipeline')).toMatchObject({ accepted: true, reservation: true });
  });

  it('a refusing gate still ran the staging first (the fetch is the only thing that happened)', () => {
    const runId = runIdN(1);
    t.put('deploy-kit-' + lock.lockId(t.config) + '.hold.json', { reason: 'cutover', until: null, at: 'x', epoch: null });
    t.stage(runId);
    const run = t.go(runId);
    expect(t.events).toEqual(['stage']);
    expectRefused(runId, 'hold', run);
  });
});

describeWithFlock('host-run request protocol: refusals', () => {
  const holdFile = () => 'deploy-kit-' + lock.lockId(t.config) + '.hold.json';

  it('refuses `late` when the locks stay held until notAfter (the poll sleeps through the clock)', () => {
    const runId = runIdN(1);
    const optedIn = { ...t.config, onHost: { required: true } };
    const release = lock.acquireLock(optedIn, { runtime: t.runtime }, { kind: 'unit', runId: 'someone-else', purpose: 'deploy' });
    t.stage(runId, requestMeta({ notAfter: NOW_SEC + 90 }));
    const run = t.go(runId);
    expectRefused(runId, 'late', run);
    expect(t.events).toEqual([]);
    release();
  });

  it('refuses `lock-held` and `lock-error` as the lock layer reports them', () => {
    t.stage(runIdN(1));
    const held = t.go(runIdN(1), { deps: { acquireOwnedLocks: () => { throw Object.assign(new Error('held'), { code: 'held' }); } } });
    expectRefused(runIdN(1), 'lock-held', held);
    t.stage(runIdN(2));
    const broken = t.go(runIdN(2), { deps: { acquireOwnedLocks: () => { throw new Error('ssh down'); } } });
    expectRefused(runIdN(2), 'lock-error', broken);
  });

  it('refuses `staging-failed` and never reaches the gates', () => {
    t.stage(runIdN(1));
    const run = t.go(runIdN(1), { git: { stage: () => { throw new Error('fetch timed out'); } } });
    expectRefused(runIdN(1), 'staging-failed', run);
    expect(t.events).toEqual([]);
  });

  it('bounds the staging by min(stepTimeout, notAfter - now)', () => {
    t.stage(runIdN(1), requestMeta({ notAfter: NOW_SEC + 20 }));
    const stage = vi.fn();
    t.go(runIdN(1), { git: { stage } });
    expect(stage.mock.calls[0][0]).toMatchObject({ sha: SHA, remote: 'origin', timeoutMs: 20000 });
    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID, notAfter: NOW_SEC + 3600 }));
    const roomy = vi.fn();
    t.go(runIdN(2), { git: { stage: roomy } });
    expect(roomy.mock.calls[0][0].timeoutMs).toBe(60000);
  });

  it('refuses `late` at the deadline gate when staging used up the time', () => {
    t.stage(runIdN(1), requestMeta({ notAfter: NOW_SEC + 30 }));
    const run = t.go(runIdN(1), { git: { stage: () => t.clock.advance(120) } });
    expectRefused(runIdN(1), 'late', run);
  });

  it('epoch: a fenced target refuses a mismatched epoch; an unfenced one passes any', () => {
    t.put('.last-epoch', '5\n');
    t.stage(runIdN(1), requestMeta({ epoch: 4 }));
    expectRefused(runIdN(1), 'epoch-mismatch', t.go(runIdN(1)));
    t.stage(runIdN(2), requestMeta({ epoch: 6 }));
    expect(t.go(runIdN(2)).code).toBe(1);
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('epoch-mismatch');
    t.stage(runIdN(3), requestMeta({ epoch: 5 }));
    expect(t.go(runIdN(3)).code).toBe(0);
  });

  it('epoch: a corrupt .last-epoch refuses; an unfenced target passes whatever epoch the request carries', () => {
    t.put('.last-epoch', 'banana');
    t.stage(runIdN(1), requestMeta({ epoch: 0 }));
    expectRefused(runIdN(1), 'epoch-mismatch', t.go(runIdN(1)));
    fs.rmSync(t.dk('.last-epoch'));
    t.stage(runIdN(2), requestMeta({ epoch: 9 }));
    expect(t.go(runIdN(2)).code).toBe(0);
  });

  it('epoch: a fenced target refuses a request that carries no epoch (a run without a request included)', () => {
    t.put('.last-epoch', '5\n');
    const { epoch: _epoch, ...noEpoch } = requestMeta() as Record<string, unknown>;
    t.stage(runIdN(1), noEpoch);
    const opted = t.go(runIdN(1));
    expect(opted.code).toBe(1);
    expect(opted.deployRelease).not.toHaveBeenCalled();
    expect(t.logs.error.mock.calls.join()).toContain('meta.epoch');
    t.stage(runIdN(2), null, { onHost: undefined });
    const legacy = t.go(runIdN(2));
    expect(legacy.code).toBe(1);
    expect(legacy.deployRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('epoch-mismatch');
  });

  it('hold: an active hold refuses, an expired one does not, a corrupt one refuses', () => {
    t.put(holdFile(), { reason: 'cutover', until: '2026-10-23T11:00:00Z', at: 'x', epoch: null });
    t.stage(runIdN(1));
    expectRefused(runIdN(1), 'hold', t.go(runIdN(1)));
    t.put(holdFile(), { reason: 'cutover', until: '2026-10-23T09:00:00Z', at: 'x', epoch: null });
    t.stage(runIdN(2));
    expect(t.go(runIdN(2)).code).toBe(0);
    t.put(holdFile(), '{not json');
    t.stage(runIdN(3), requestMeta({ requestId: OTHER_REQUEST_ID }));
    expect(t.go(runIdN(3)).code).toBe(1);
    expect(t.readJson(`runs/${runIdN(3)}/refused.json`).code).toBe('hold');
  });

  it.each([
    ['recovery-pending', { phase: 'stopped', releaseId: 'r1' }, 'recovery-pending'],
    ['recovery-pending (migrated)', { phase: 'migrated', releaseId: 'r1' }, 'recovery-pending'],
    ['journal-corrupt', '{truncated', 'journal-corrupt'],
  ])('journal gate: %s', (_name, journal, code) => {
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), typeof journal === 'string' ? journal : JSON.stringify(journal));
    t.stage(runIdN(1));
    expectRefused(runIdN(1), code, t.go(runIdN(1)));
  });

  it('a terminal journal does not block a deploy', () => {
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), JSON.stringify({ phase: 'done', releaseId: 'r1' }));
    t.stage(runIdN(1));
    expect(t.go(runIdN(1)).code).toBe(0);
  });

  it('forward-only: already-live, not-forward, unreadable live and unreadable ancestry refuse; no current link passes', () => {
    t.stage(runIdN(1));
    expectRefused(runIdN(1), 'already-live', t.go(runIdN(1), { git: { readLive: () => SHA } }));
    t.stage(runIdN(2));
    expect(t.go(runIdN(2), { git: { isAncestor: () => false } }).code).toBe(1);
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('not-forward');
    t.stage(runIdN(3));
    t.go(runIdN(3), { git: { readLive: () => { throw new Error('bad link'); } } });
    expect(t.readJson(`runs/${runIdN(3)}/refused.json`).code).toBe('live-unreadable');
    t.stage(runIdN(4));
    t.go(runIdN(4), { git: { isAncestor: () => { throw new Error('missing object'); } } });
    expect(t.readJson(`runs/${runIdN(4)}/refused.json`).code).toBe('ancestry-unreadable');
    t.stage(runIdN(5));
    const first = t.go(runIdN(5), { git: { readLive: () => null } });
    expect(first.code).toBe(0);
    expect(first.git.isAncestor).not.toHaveBeenCalled();
  });

  it('rollback and recover pass their journal gates and then refuse kind-unsupported (D6/D8 add the pipelines)', () => {
    t.stage(runIdN(1), requestMeta({ kind: 'rollback' }));
    expectRefused(runIdN(1), 'kind-unsupported', t.go(runIdN(1)));
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), JSON.stringify({ phase: 'stopped', releaseId: 'r1' }));
    t.stage(runIdN(2), requestMeta({ kind: 'rollback' }));
    t.go(runIdN(2));
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('recovery-pending');
    t.stage(runIdN(3), requestMeta({ kind: 'recover', parentRunId: runIdN(2) }));
    t.go(runIdN(3));
    expect(t.readJson(`runs/${runIdN(3)}/refused.json`).code).toBe('kind-unsupported');
    expect(t.has(`runs/${runIdN(3)}/accepted.json`)).toBe(false);
  });

  it('recover with nothing interrupted refuses nothing-to-recover; a corrupt journal refuses journal-corrupt', () => {
    t.stage(runIdN(1), requestMeta({ kind: 'recover', parentRunId: runIdN(9) }));
    expectRefused(runIdN(1), 'nothing-to-recover', t.go(runIdN(1)));
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), '[');
    t.stage(runIdN(2), requestMeta({ kind: 'recover', parentRunId: runIdN(9) }));
    t.go(runIdN(2));
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('journal-corrupt');
  });

  it('preDeployChecks run for a deploy, read-only and before acceptance; a failing one refuses pre-check-failed', () => {
    t.config.preDeployChecks.push({ name: 'feeders-idle', command: 'check-feeders' });
    t.stage(runIdN(1), requestMeta(), { preDeployChecks: t.config.preDeployChecks });
    const ran: string[] = [];
    const run = t.go(runIdN(1), { deps: { runCheck: (command: string) => { ran.push(command); return { ok: false }; } } });
    expect(ran).toEqual(['check-feeders']);
    expectRefused(runIdN(1), 'pre-check-failed', run);
  });

  it('an unexpected error before acceptance is a refusal (`gate-error`), never an acceptance', () => {
    fs.mkdirSync(t.dk('deploy-kit-' + lock.lockId(t.config) + '.hold.json'), { recursive: true }); // a directory where the hold file belongs
    t.stage(runIdN(1));
    expectRefused(runIdN(1), 'gate-error', t.go(runIdN(1)));
  });

  it('writes refused.json while the locks are still held, then releases them', () => {
    t.put(holdFile(), { reason: 'cutover', until: null, at: 'x', epoch: null });
    t.stage(runIdN(1));
    let seen: { refused: boolean; locks: number } | undefined;
    t.logs.error.mockImplementation(() => { seen = { refused: t.has(`runs/${runIdN(1)}/refused.json`), locks: t.lockLeft().length }; });
    t.go(runIdN(1));
    expect(seen).toEqual({ refused: true, locks: 2 });
    expect(t.lockLeft()).toEqual([]);
  });
});

describeWithFlock('host-run request protocol: meta.json validation', () => {
  const fields = ['kind', 'requestId', 'parentRequestId', 'parentRunId', 'epoch', 'notAfter', 'expectReservation', 'kitArtifact'];

  it.each(fields)('an onHost.required app missing %s is refused before any lock', (field) => {
    const meta = requestMeta() as Record<string, unknown>;
    delete meta[field];
    t.stage(runIdN(1), meta);
    const run = t.go(runIdN(1));
    expect(run.code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain(`ONHOST_META: meta.${field} missing`);
    expect(run.deployRelease).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
    expect(t.has(`runs/${runIdN(1)}/accepted.json`)).toBe(false);
  });

  it('an opted-in app with NO request fields at all is refused too', () => {
    t.stage(runIdN(1), null);
    expect(t.go(runIdN(1)).code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain('ONHOST_META');
  });

  it('an app that did not opt in may carry all of the fields or none, never some', () => {
    const { kitArtifact: _k, ...partial } = requestMeta() as Record<string, unknown>;
    t.stage(runIdN(1), partial, { onHost: undefined });
    expect(t.go(runIdN(1)).code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain('ONHOST_META');
  });

  it.each([
    ['kind', 'redeploy'], ['requestId', 'has space'], ['parentRequestId', 5], ['parentRunId', 'nope'], ['epoch', -1], ['epoch', 1.5], ['epoch', '1'],
    ['notAfter', 0], ['notAfter', 1.5], ['notAfter', '9999'], ['expectReservation', { state: 'none', runId: null, gen: 1 }],
    ['expectReservation', { state: 'clean-abort', runId: null, gen: 1 }], ['expectReservation', { state: 'clean-abort', runId: runIdN(1), gen: 0 }],
    ['expectReservation', { state: 'maybe', runId: null, gen: 0 }], ['expectReservation', 'none'],
    ['kitArtifact', null], ['kitArtifact', { version: '', sha256: 'd'.repeat(64) }], ['kitArtifact', { version: '1', sha256: 'xyz' }],
  ])('rejects %s = %j', (field, value) => {
    t.stage(runIdN(1), requestMeta({ [field]: value }));
    const run = t.go(runIdN(1));
    expect(run.code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain('ONHOST_META');
    expect(run.deployRelease).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });
});

describeWithFlock('host-run without a request (an app that did not opt in)', () => {
  it('keeps working exactly as before: the pipeline gets two arguments and only outcome.json is written', () => {
    t.stage(runIdN(1), null, { onHost: undefined });
    const run = t.go(runIdN(1));
    expect(run.code).toBe(0);
    expect(run.deployRelease.mock.calls[0]).toHaveLength(2);
    expect(run.deployRelease.mock.calls[0][1]).toEqual({ skipBuild: true, verifyPins: false, sha: SHA, autoCut: false, stealLock: false });
    for (const name of ['accepted.json', 'terminal.json', 'refused.json']) expect(t.has(`runs/${runIdN(1)}/${name}`)).toBe(false);
    expect(t.readJson(`runs/${runIdN(1)}/outcome.json`)).toMatchObject({ ok: true });
    expect(t.events).toEqual(['pipeline']);
  });

  it('a failing legacy pipeline still writes ok:false and returns 1', () => {
    t.stage(runIdN(1), null, { onHost: undefined });
    const run = t.go(runIdN(1), { pipeline: () => { throw new Error('step exploded'); } });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runIdN(1)}/outcome.json`)).toMatchObject({ ok: false, error: 'step exploded' });
  });
});

describeWithFlock('host-run request protocol: results, unresolved and resolve', () => {
  const unresolvedFile = () => 'deploy-kit-' + lock.lockId(t.config) + '.unresolved.json';

  it('a pipeline that throws leaves an unresolved record (written before terminal.json) and a failed terminal result', () => {
    const runId = runIdN(1);
    t.stage(runId);
    const run = t.go(runId, { pipeline: () => { throw new Error('build exploded'); } });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`).result).toEqual(deployResult({ status: 'failed', stage: null, liveBefore: LIVE_SHA, liveAfter: LIVE_SHA, error: 'build exploded' }));
    expect(t.readJson(unresolvedFile())).toMatchObject({ requestId: REQUEST_ID, runId, kind: 'deploy', status: 'failed', error: 'build exploded' });
    expect(t.readJson(`requests/${REQUEST_ID}.json`)).toMatchObject({ state: 'accepted', runId });
    expect(t.status(runId).state).toBe('terminal');
    expect(t.lockLeft()).toEqual([]);
  });

  it.each([
    ['deployed', { status: 'deployed' }],
    ['a verified clean abort', { status: 'aborted-clean', effectsClean: true }],
    ['a verified recovery', { status: 'failed-recovered', recovery: { verified: true } }],
  ])('%s leaves no unresolved record', (_name, result) => {
    t.stage(runIdN(1));
    t.go(runIdN(1), { pipeline: () => deployResult(result) });
    expect(t.has(unresolvedFile())).toBe(false);
  });

  it.each([
    ['an unverified recovery', { status: 'failed-recovered', recovery: { verified: false } }],
    ['failed-unrecovered', { status: 'failed-unrecovered' }],
    ['a failure with unclean effects', { status: 'failed', effectsClean: false }],
    ['an aborted-clean that does not claim clean effects', { status: 'aborted-clean' }],
  ])('%s leaves an unresolved record', (_name, result) => {
    t.stage(runIdN(1));
    expect(t.go(runIdN(1), { pipeline: () => deployResult(result) }).code).toBe(1);
    expect(t.has(unresolvedFile())).toBe(true);
  });

  it('app-unresolved blocks a DIFFERENT request until `resolve` clears it', () => {
    t.stage(runIdN(1));
    t.go(runIdN(1), { pipeline: () => { throw new Error('hook failed after a live effect'); } });

    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID }));
    const blocked = t.go(runIdN(2));
    expect(blocked.code).toBe(1);
    expect(blocked.deployRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('app-unresolved');
    expect(t.has(`requests/${OTHER_REQUEST_ID}.json`)).toBe(false);

    expect(resolveRequest(t.config, OTHER_REQUEST_ID, 'wrong request', { runtime: t.runtime })).toMatchObject({ outcome: 'refused' });
    expect(t.has(unresolvedFile())).toBe(true);
    const cleared = resolveRequest(t.config, REQUEST_ID, 'assessed: production is at the old sha, health 200', { runtime: t.runtime });
    expect(cleared).toMatchObject({ outcome: 'ok', message: `resolved ${REQUEST_ID}` });
    expect(t.has(unresolvedFile())).toBe(false);
    const archived = fs.readdirSync(t.dk('resolved')).sort();
    expect(archived).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(t.dk(`resolved/${archived.find((n) => n.endsWith('.resolution.json'))}`), 'utf8'))).toMatchObject({
      requestId: REQUEST_ID, reason: 'assessed: production is at the old sha, health 200',
    });

    t.stage(runIdN(3), requestMeta({ requestId: OTHER_REQUEST_ID }));
    expect(t.go(runIdN(3)).code).toBe(0);
  });

  it('resolve with nothing unresolved refuses not-unresolved; an unreadable record is archived on the operator\'s word', () => {
    expect(resolveRequest(t.config, REQUEST_ID, 'why not', { runtime: t.runtime })).toMatchObject({ outcome: 'refused', message: 'not-unresolved' });
    t.put(unresolvedFile(), '{garbage');
    expect(resolveRequest(t.config, REQUEST_ID, 'looked at it', { runtime: t.runtime }).outcome).toBe('ok');
    expect(t.has(unresolvedFile())).toBe(false);
  });

  it('resolve refuses while a deploy holds the app lock', () => {
    t.put(unresolvedFile(), { requestId: REQUEST_ID });
    const optedIn = { ...t.config, onHost: { required: true } };
    const release = lock.acquireLock(optedIn, { runtime: t.runtime }, { kind: 'unit', runId: 'someone-else', purpose: 'deploy' });
    expect(resolveRequest(t.config, REQUEST_ID, 'now', { runtime: t.runtime }).outcome).toBe('lock-held');
    expect(t.has(unresolvedFile())).toBe(true);
    release();
  });
});

describeWithFlock('host-run request protocol: crash seams, read back by on-host-status', () => {
  it.each(['after-lock', 'after-staging', 'after-gate'])('%s: nothing was accepted, the run reads as claimed', (point) => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: point })).toThrow(CrashSeam);
    expect(t.has(`runs/${runId}/accepted.json`)).toBe(false);
    expect(t.has(`requests/${REQUEST_ID}.json`)).toBe(false);
    expect(t.status(runId).state).toBe('claimed');
  });

  it('in-reservation-rename: accepted.json exists but the reservation does not; the run reads as unknown', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'in-reservation-rename' })).toThrow(CrashSeam);
    expect(t.has(`runs/${runId}/accepted.json`)).toBe(true);
    expect(t.has(`requests/${REQUEST_ID}.json`)).toBe(false);
    expect(t.status(runId).state).toBe('unknown');
    // and a retry of the request is refused, not re-accepted
    t.stage(runIdN(2));
    expect(t.go(runIdN(2)).code).toBe(1);
  });

  it('after-accept: the run is accepted with no terminal.json, so it reads as unknown, and the pipeline never ran', () => {
    const runId = runIdN(1);
    t.stage(runId);
    let pipeline: ReturnType<typeof vi.fn> | undefined;
    try { t.go(runId, { crashAt: 'after-accept' }); } catch (error) { expect(error).toBeInstanceOf(CrashSeam); }
    expect(t.events).not.toContain('pipeline');
    expect(t.has(`runs/${runId}/accepted.json`)).toBe(true);
    expect(t.readJson(`requests/${REQUEST_ID}.json`)).toMatchObject({ gen: 1, runId });
    expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
    const status = t.status(runId);
    expect(status.state).toBe('unknown');
    expect(status.reservation).toMatchObject({ runId, gen: 1 });
    expect(pipeline).toBeUndefined();
  });

  it('after-release-result: the pipeline ran but there is no terminal.json, so it reads as unknown', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: () => { throw new Error('boom'); } })).toThrow(CrashSeam);
    expect(t.events).toContain('pipeline');
    expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
    expect(t.has(`runs/${runId}/outcome.json`)).toBe(false);
    expect(t.status(runId).state).toBe('unknown');
  });

  it('a crash leaves the locks held (nothing released a killed run)', () => {
    t.stage(runIdN(1));
    expect(() => t.go(runIdN(1), { crashAt: 'after-accept' })).toThrow(CrashSeam);
    expect(t.lockLeft()).toHaveLength(2);
  });
});

describe('request flags: operator -> meta.json', () => {
  const cfg = (onHost?: unknown) => ({ onHost });
  const flags = { kind: 'deploy', request: REQUEST_ID, epoch: '3', notAfter: '1800000000', expectReservation: '{"state":"none","runId":null,"gen":0}' };

  it('turns the five flags into the meta fields (parents null)', () => {
    expect(operatorRequestMeta(cfg({ required: true }), flags)).toEqual({
      kind: 'deploy', requestId: REQUEST_ID, parentRequestId: null, parentRunId: null, epoch: 3, notAfter: 1800000000,
      expectReservation: { state: 'none', runId: null, gen: 0 },
    });
  });

  it('an app that did not opt in may pass none of them', () => {
    expect(operatorRequestMeta(cfg(), {})).toBeNull();
  });

  it.each(Object.keys(flags))('an onHost.required app missing --%s is refused ONHOST_REQUEST', (key) => {
    const { [key]: _gone, ...rest } = flags as Record<string, string>;
    expect(() => operatorRequestMeta(cfg({ required: true }), rest)).toThrow(/ONHOST_REQUEST/);
    expect(() => operatorRequestMeta(cfg(), rest)).toThrow(/ONHOST_REQUEST/); // partial is refused for everyone
  });

  it.each([
    ['kind', 'redeploy'], ['request', 'a b'], ['epoch', '-1'], ['epoch', '1.5'], ['notAfter', 'soon'], ['expectReservation', '{nope'],
  ])('rejects --%s %s', (key, value) => {
    expect(() => operatorRequestMeta(cfg({ required: true }), { ...flags, [key]: value })).toThrow(/ONHOST_REQUEST/);
  });

  it('the bundle carries the kit artifact identity only for a request, and it changes with the kit', () => {
    const dir = fs.mkdtempSync(path.join(t.home, 'bundle-'));
    const kitRoot = fs.mkdtempSync(path.join(t.home, 'kit-'));
    fs.mkdirSync(path.join(kitRoot, 'src'));
    fs.writeFileSync(path.join(kitRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(kitRoot, 'src', 'cli.js'), '//one');
    const jsYamlDir = fs.mkdtempSync(path.join(t.home, 'yaml-'));
    const build = (withKitArtifact: boolean) => {
      const meta: Record<string, unknown> = { operatorVersion: '0.33.0' };
      buildBundle(fs.mkdtempSync(path.join(dir, 'b-')), { kitRoot, jsYamlDir, config: {}, meta, withKitArtifact });
      return meta.kitArtifact as { version: string; sha256: string } | undefined;
    };
    const first = build(true);
    expect(first).toMatchObject({ version: '0.33.0', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(build(false)).toBeUndefined();
    fs.writeFileSync(path.join(kitRoot, 'src', 'cli.js'), '//two');
    expect(build(true)?.sha256).not.toBe(first?.sha256);
  });
});
