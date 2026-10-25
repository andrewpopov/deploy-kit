// Plan §4.2: the reservation table, one row per test, driven through host-run with real locks and records.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import {
  makeTarget, requestMeta, deployResult, runIdN, CrashSeam, NOW_SEC, REQUEST_ID, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const { cancelRequest } = require('../target-state.js');

const describeWithFlock = hasFlock ? describe : describe.skip;

let t: Target;
beforeEach(() => { t = makeTarget(); });
afterEach(() => t.cleanup());

const none = { state: 'none', runId: null, gen: 0 };
const cleanAbort = (runId: string, gen: number) => ({ state: 'clean-abort', runId, gen });
const refusedCode = (runId: string) => t.readJson(`runs/${runId}/refused.json`).code;
const reservationFile = `requests/${REQUEST_ID}.json`;

// Run `runId` expecting `expect`; -> its exit code. The run is staged fresh each time.
function attempt(runId: string, expectReservation: unknown = none, go: Parameters<Target['go']>[1] = {}) {
  t.stage(runId, requestMeta({ expectReservation }));
  return t.go(runId, go).code;
}

describeWithFlock('reservation: no file yet', () => {
  it('missing + the controller expects none + no accepted run: gen 1 is created at acceptance', () => {
    expect(attempt(runIdN(1))).toBe(0);
    expect(t.readJson(reservationFile)).toMatchObject({ requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: runIdN(1), prev: null });
  });

  it('missing but the controller expects a clean abort: reservation-missing (unresolved)', () => {
    expect(attempt(runIdN(1), cleanAbort(runIdN(9), 1))).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('reservation-missing');
    expect(t.has(reservationFile)).toBe(false);
  });

  it('missing but an accepted run names this request: reservation-missing', () => {
    t.putAcceptedRun(runIdN(8));
    expect(attempt(runIdN(1))).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('reservation-missing');
    expect(t.has(reservationFile)).toBe(false);
  });

  it('a lost reservation after a real accepted run refuses (the file is deleted behind a finished run)', () => {
    expect(attempt(runIdN(1))).toBe(0);
    fs.rmSync(t.dk(reservationFile));
    expect(attempt(runIdN(2))).toBe(1);
    expect(refusedCode(runIdN(2))).toBe('reservation-missing');
  });

  it('an accepted run of ANOTHER request does not count', () => {
    t.putAcceptedRun(runIdN(8), 'req-someone-else');
    expect(attempt(runIdN(1))).toBe(0);
  });

  it('an accepted run whose meta.json cannot be read counts (fail closed)', () => {
    t.put(`runs/${runIdN(8)}/meta.json`, '{broken');
    t.put(`runs/${runIdN(8)}/accepted.json`, { runId: runIdN(8) });
    expect(attempt(runIdN(1))).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('reservation-missing');
  });
});

describeWithFlock('reservation: corrupt', () => {
  it.each([
    ['unparsable', '{nope'],
    ['wrong request id', { requestId: 'other', gen: 1, state: 'accepted', runId: runIdN(1), at: 'x', liveBefore: null, prev: null }],
    ['gen 0', { requestId: REQUEST_ID, gen: 0, state: 'accepted', runId: runIdN(1), at: 'x', liveBefore: null, prev: null }],
    ['accepted with no run', { requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: null, at: 'x', liveBefore: null, prev: null }],
    ['unknown state', { requestId: REQUEST_ID, gen: 1, state: 'pending', runId: null, at: 'x', liveBefore: null, prev: null }],
  ])('%s: reservation-corrupt, never read as absent', (_name, content) => {
    t.put(reservationFile, content);
    expect(attempt(runIdN(1))).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('reservation-corrupt');
    expect(t.has(`runs/${runIdN(1)}/accepted.json`)).toBe(false);
  });
});

describeWithFlock('reservation: held by an earlier run', () => {
  it('by a verified clean abort the controller expects: replaced at gen+1 with prev', () => {
    t.putReservation({ gen: 1, runId: runIdN(1) });
    t.putTerminal(runIdN(1), { status: 'aborted-clean', effectsClean: true });
    expect(attempt(runIdN(2), cleanAbort(runIdN(1), 1))).toBe(0);
    expect(t.readJson(reservationFile)).toMatchObject({ gen: 2, state: 'accepted', runId: runIdN(2), prev: { runId: runIdN(1), gen: 1 } });
    expect(t.readJson(`runs/${runIdN(2)}/accepted.json`)).toMatchObject({ gen: 2 });
  });

  it.each([
    ['expects none', none],
    ['names another run', cleanAbort(runIdN(7), 1)],
    ['names another gen', cleanAbort(runIdN(1), 2)],
  ])('by a verified clean abort but the controller %s: reservation-missing', (_name, expectation) => {
    t.putReservation({ gen: 1, runId: runIdN(1) });
    t.putTerminal(runIdN(1), { status: 'aborted-clean', effectsClean: true });
    expect(attempt(runIdN(2), expectation)).toBe(1);
    expect(refusedCode(runIdN(2))).toBe('reservation-missing');
    expect(t.readJson(reservationFile)).toMatchObject({ gen: 1, runId: runIdN(1) });
  });

  it('by a run still running or with no terminal.json: request-taken', () => {
    t.putReservation({ runId: runIdN(1) });
    expect(attempt(runIdN(2))).toBe(1);
    expect(refusedCode(runIdN(2))).toBe('request-taken');
    expect(attempt(runIdN(3), cleanAbort(runIdN(1), 1))).toBe(1);
    expect(refusedCode(runIdN(3))).toBe('request-taken');
  });

  it.each([
    ['deployed', { status: 'deployed' }],
    ['failed', { status: 'failed', effectsClean: false }],
    ['aborted-clean without effectsClean', { status: 'aborted-clean', effectsClean: false }],
    ['aborted-clean with no effectsClean field', { status: 'aborted-clean' }],
  ])('by a run that ended %s: request-executed', (_name, result) => {
    t.putReservation({ runId: runIdN(1) });
    t.putTerminal(runIdN(1), result);
    expect(attempt(runIdN(2), cleanAbort(runIdN(1), 1))).toBe(1);
    expect(refusedCode(runIdN(2))).toBe('request-executed');
  });

  it('by a run whose terminal.json is corrupt: terminal-corrupt', () => {
    t.putReservation({ runId: runIdN(1) });
    t.put(`runs/${runIdN(1)}/terminal.json`, '{nope');
    expect(attempt(runIdN(2))).toBe(1);
    expect(refusedCode(runIdN(2))).toBe('terminal-corrupt');
  });

  it('cancelled: request-cancelled', () => {
    t.putReservation({ state: 'cancelled', runId: null });
    expect(attempt(runIdN(1))).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('request-cancelled');
  });
});

describeWithFlock('reservation: a stale operator after a retry', () => {
  it('request-taken when the retry is accepted and not finished', () => {
    t.stage(runIdN(1), requestMeta({ expectReservation: none, notAfter: NOW_SEC + 3600 }));
    t.stage(runIdN(2), requestMeta({ expectReservation: none }));
    expect(() => t.go(runIdN(2), { crashAt: 'after-accept' })).toThrow(CrashSeam);
    for (const dir of t.lockLeft()) fs.rmSync(dir, { recursive: true, force: true }); // what a lock break does for the dead retry
    const stale = t.go(runIdN(1));
    expect(stale.code).toBe(1);
    expect(stale.deployRelease).not.toHaveBeenCalled();
    expect(refusedCode(runIdN(1))).toBe('request-taken');
    expect(t.readJson(reservationFile)).toMatchObject({ runId: runIdN(2), gen: 1 });
  });

  it('request-executed when the retry already finished', () => {
    t.stage(runIdN(1), requestMeta({ expectReservation: none }));
    expect(attempt(runIdN(2))).toBe(0);
    expect(t.go(runIdN(1)).code).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('request-executed');
  });

  it('request-cancelled when the controller tombstoned the request first (D3 request cancel)', () => {
    t.stage(runIdN(1), requestMeta({ expectReservation: none }));
    expect(cancelRequest(t.config, REQUEST_ID, { runtime: t.runtime }).outcome).toBe('ok');
    expect(t.go(runIdN(1)).code).toBe(1);
    expect(refusedCode(runIdN(1))).toBe('request-cancelled');
  });
});

describeWithFlock('reservation: clean abort then a replacement run', () => {
  it('the aborted run keeps the reservation and leaves no unresolved record; the replacement takes gen 2; a third attempt is executed', () => {
    expect(attempt(runIdN(1), none, { pipeline: () => deployResult({ status: 'aborted-clean', effectsClean: true }) })).toBe(1);
    expect(t.readJson(`runs/${runIdN(1)}/terminal.json`).result).toMatchObject({ status: 'aborted-clean', effectsClean: true });
    expect(t.readJson(reservationFile)).toMatchObject({ gen: 1, runId: runIdN(1) });
    expect(t.status(runIdN(1)).state).toBe('terminal');

    expect(attempt(runIdN(2), cleanAbort(runIdN(1), 1))).toBe(0);
    expect(t.readJson(reservationFile)).toMatchObject({ gen: 2, runId: runIdN(2), prev: { runId: runIdN(1), gen: 1 } });

    expect(attempt(runIdN(3), cleanAbort(runIdN(2), 2))).toBe(1);
    expect(refusedCode(runIdN(3))).toBe('request-executed');
  });
});
