// BRAIN-636 review finding 1: a run killed after acceptance leaves no terminal.json and no unresolved marker, so
// nothing but the in-flight marker (written at acceptance) keeps a different request out once the lock is broken.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import {
  makeTarget, requestMeta, deployResult, runIdN, SHA, REQUEST_ID, OTHER_REQUEST_ID, CrashSeam, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const lock = require('../lock.js');
const { resolveRequest } = require('../target-state.js');

const describeWithFlock = hasFlock ? describe : describe.skip;
const RELEASE_ID = `${SHA.slice(0, 12)}-20261023T095900Z`;

let t: Target;
beforeEach(() => { t = makeTarget(); });
afterEach(() => t.cleanup());

const inflightRel = () => `deploy-kit-${lock.lockId(t.config)}.inflight.json`;
const unresolvedRel = () => `deploy-kit-${lock.lockId(t.config)}.unresolved.json`;
const journalFile = () => path.join(t.config.projectDir, '.deploy-kit-state.json');

type Ctx = { onStep: (e: { step: string; class: string }) => void; onRelease?: (r: { releaseId: string; sha: string }) => void };
// A deploy that got as far as stopping the writers: a live step in the ledger, its release recorded, its journal `stopped`.
const stopsWriters = (_c: unknown, _o: unknown, ctx: Ctx) => {
  ctx.onRelease?.({ releaseId: RELEASE_ID, sha: SHA });
  ctx.onStep({ step: 'stop-writers', class: 'live' });
  fs.writeFileSync(journalFile(), JSON.stringify({ phase: 'stopped', releaseId: RELEASE_ID }));
  return undefined;
};
// What `deploy-kit lock break` ends with once it has proven the owner gone: both lock directories moved aside.
const breakLocks = () => { for (const dir of t.lockLeft()) fs.renameSync(dir, `${dir}.broken.test`); };

describeWithFlock('the in-flight marker', () => {
  it('a pipeline killed after a live step, with the lock then broken: a DIFFERENT request is refused app-unresolved', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: stopsWriters })).toThrow(CrashSeam);
    expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
    expect(t.has(unresolvedRel())).toBe(false); // nothing but the in-flight marker stands between production and the next request
    expect(t.readJson(inflightRel())).toMatchObject({ requestId: REQUEST_ID, runId, kind: 'deploy' });

    breakLocks();
    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID }));
    const second = t.go(runIdN(2));
    expect(second.code).toBe(1);
    expect(second.deployRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('app-unresolved');
    // `deploy-kit resolve` and a recover for the run know the unresolved marker, so the stranded run becomes one
    expect(t.readJson(unresolvedRel())).toMatchObject({ requestId: REQUEST_ID, runId, kind: 'deploy', status: 'unknown' });
    expect(t.has(inflightRel())).toBe(false);
  });

  it('a recover for the killed run is let through, and its verified recovery clears the marker for good', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: stopsWriters })).toThrow(CrashSeam);
    breakLocks();

    t.stage(runIdN(2), requestMeta({ kind: 'recover', requestId: OTHER_REQUEST_ID, parentRunId: runId, sha: '0'.repeat(40) }));
    const recover = t.go(runIdN(2), {
      recoverPipeline: (_c: unknown, _o: unknown, ctx: Ctx) => {
        ctx.onStep({ step: 'recover-interrupted', class: 'live' });
        fs.writeFileSync(journalFile(), JSON.stringify({ phase: 'recovered', releaseId: RELEASE_ID }));
        return deployResult({ status: 'failed-recovered', recovery: { action: 'resume-previous', verified: true } });
      },
    });
    expect(recover.code).toBe(0);
    expect(t.has(inflightRel())).toBe(false);
    expect(t.has(unresolvedRel())).toBe(false);

    t.stage(runIdN(3), requestMeta({ requestId: `${OTHER_REQUEST_ID}9` }));
    expect(t.go(runIdN(3)).code).toBe(0); // the app is free again
  });

  it.each([
    ['deployed', { status: 'deployed' }, false],
    ['aborted-clean with effectsClean true', { status: 'aborted-clean', effectsClean: true, error: 'gate' }, false],
    ['failed-recovered, verified', { status: 'failed-recovered', recovery: { action: 'flip-back', verified: true }, error: 'x' }, false],
    ['failed (effects unverified)', { status: 'failed', effectsClean: false, error: 'x' }, true],
    ['failed-recovered, not verified', { status: 'failed-recovered', recovery: { action: 'flip-back', verified: false }, error: 'x' }, true],
  ])('a terminal %s leaves no in-flight marker; unresolved marker present: %s', (_name, result, unresolved) => {
    const runId = runIdN(1);
    t.stage(runId);
    t.go(runId, { pipeline: () => deployResult(result) });
    expect(t.has(`runs/${runId}/terminal.json`)).toBe(true);
    expect(t.has(inflightRel())).toBe(false);
    expect(t.has(unresolvedRel())).toBe(unresolved);
  });

  it('is present while the pipeline runs', () => {
    const runId = runIdN(1);
    t.stage(runId);
    let during: unknown = null;
    t.go(runId, { pipeline: () => { during = t.readJson(inflightRel()); return undefined; } });
    expect(during).toMatchObject({ requestId: REQUEST_ID, runId, kind: 'deploy' });
  });

  it('a leftover marker of a run that did write its terminal.json is dropped, not a blocker', () => {
    t.put(inflightRel(), { requestId: OTHER_REQUEST_ID, runId: runIdN(7), kind: 'deploy', at: '2026-10-23T09:00:00.000Z' });
    t.putTerminal(runIdN(7), { status: 'deployed' });
    t.stage(runIdN(1));
    expect(t.go(runIdN(1)).code).toBe(0);
    expect(t.has(inflightRel())).toBe(false);
  });

  it('an unreadable marker blocks every request (it vouches for nothing)', () => {
    t.put(inflightRel(), '{nope');
    t.stage(runIdN(1));
    const run = t.go(runIdN(1));
    expect(run.code).toBe(1);
    expect(run.deployRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(1)}/refused.json`).code).toBe('app-unresolved');
  });

  it('crash after a live step, lock break, then `resolve` settles the in-flight marker and a new request is admitted', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: stopsWriters })).toThrow(CrashSeam);
    breakLocks();
    expect(t.has(unresolvedRel())).toBe(false);

    expect(resolveRequest(t.config, OTHER_REQUEST_ID, 'wrong request', { runtime: t.runtime })).toMatchObject({ outcome: 'refused' });
    expect(t.has(inflightRel())).toBe(true);
    const resolved = resolveRequest(t.config, REQUEST_ID, 'assessed: stopped at stop-writers, restarted by hand', { runtime: t.runtime });
    expect(resolved).toMatchObject({ outcome: 'ok', message: `resolved ${REQUEST_ID}` });
    expect(t.has(inflightRel())).toBe(false);
    const archived = fs.readdirSync(t.dk('resolved')).sort();
    expect(archived.some((n) => n.endsWith('.inflight.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(t.dk(`resolved/${archived.find((n) => n.endsWith('.resolution.json'))}`), 'utf8')))
      .toMatchObject({ requestId: REQUEST_ID, reason: 'assessed: stopped at stop-writers, restarted by hand' });

    t.stage(runIdN(2), requestMeta({ requestId: OTHER_REQUEST_ID }));
    // resolve settles the app-level marker only; the interrupted release journal is the operator's recovery to finish.
    expect(t.go(runIdN(2)).code).toBe(1);
    expect(t.readJson(`runs/${runIdN(2)}/refused.json`).code).toBe('recovery-pending');
    fs.writeFileSync(journalFile(), JSON.stringify({ phase: 'recovered', releaseId: RELEASE_ID }));
    t.stage(runIdN(3), requestMeta({ requestId: OTHER_REQUEST_ID }));
    expect(t.go(runIdN(3)).code).toBe(0);
  });

  it('resolve works with a hold set (a hold stops admission, not the operator\'s settlement)', () => {
    const runId = runIdN(1);
    t.stage(runId);
    expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: stopsWriters })).toThrow(CrashSeam);
    breakLocks();
    t.put(`deploy-kit-${lock.lockId(t.config)}.hold.json`, { reason: 'cutover', until: null, at: 'x', epoch: null });
    expect(resolveRequest(t.config, REQUEST_ID, 'assessed under the hold', { runtime: t.runtime }).outcome).toBe('ok');
    expect(t.has(inflightRel())).toBe(false);
  });

  it('resolve refuses an in-flight marker whose run finished with a result that needs no resolution', () => {
    t.put(inflightRel(), { requestId: REQUEST_ID, runId: runIdN(7), kind: 'deploy', at: '2026-10-23T09:00:00.000Z' });
    t.putTerminal(runIdN(7), { status: 'deployed' });
    expect(resolveRequest(t.config, REQUEST_ID, 'why', { runtime: t.runtime })).toMatchObject({ outcome: 'refused', message: 'not-unresolved' });
    expect(t.has(inflightRel())).toBe(true);
  });

  it('resolve archives an in-flight marker whose run finished with a result that needs resolution, and an unreadable one on the operator\'s word', () => {
    t.put(inflightRel(), { requestId: REQUEST_ID, runId: runIdN(7), kind: 'deploy', at: '2026-10-23T09:00:00.000Z' });
    t.putTerminal(runIdN(7), { status: 'failed', effectsClean: false, error: 'x' });
    expect(resolveRequest(t.config, REQUEST_ID, 'assessed', { runtime: t.runtime }).outcome).toBe('ok');
    expect(t.has(inflightRel())).toBe(false);
    t.put(inflightRel(), '{nope');
    expect(resolveRequest(t.config, REQUEST_ID, 'looked at it', { runtime: t.runtime }).outcome).toBe('ok');
    expect(t.has(inflightRel())).toBe(false);
  });
});
