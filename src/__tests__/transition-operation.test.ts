import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { createTransitionOperationManager } = require('../transition-operation.js');

const config = { transitionAuthority: { command: 'authority', scope: 'host-a' } };
const SHA = 'a'.repeat(40);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const effects = { stop: true, migrate: false, pointerSwap: true, restart: true, databaseRestore: false };
const spec = (over: Record<string, unknown> = {}) => ({
  kind: 'deploy', targetSha: SHA, targetRelease: 'rel-1', priorPointer: null, effects, parentOperationId: null, ...over,
});
const TERMINAL: Record<string, string> = { begin: 'AUTHORIZED', complete: 'COMPLETED', abandon: 'ABANDONED' };
const ok = { observedSha: SHA, verified: true };

// Durable memory: survives across manager instances; writes can be made to fail.
function durable(failWhen: (json: string) => boolean = () => false) {
  const store: { text: string | null; reads: number; writes: number } = { text: null, reads: 0, writes: 0 };
  return {
    store,
    storage: {
      read() { store.reads += 1; return store.text === null ? null : JSON.parse(store.text); },
      write(json: string) {
        store.writes += 1;
        if (failWhen(json)) throw new Error('disk full');
        store.text = json;
        return { status: 'written' };
      },
    },
  };
}
const lastOf = (json: string) => { const j = JSON.parse(json); return j.operations[j.operations.length - 1]; };

// Fake authority that records the exact request bytes it received.
function authority(fails: (action: string, count: number) => boolean = () => false) {
  const requests: string[] = [];
  const actions: string[] = [];
  return {
    requests, actions,
    send(request: Record<string, unknown>) {
      const bytes = JSON.stringify(request);
      requests.push(bytes);
      const action = String(request.action);
      actions.push(action);
      if (fails(action, actions.filter((a) => a === action).length)) throw new Error('timeout');
      return {
        planned: false, operationId: request.operationId, requestDigest: sha256(bytes), receipt: 'receipt-1', state: TERMINAL[action],
      };
    },
  };
}
const ids = (...n: number[]) => { const list = n.map(id); return () => { const next = list.shift(); if (!next) throw new Error('no id'); return next; }; };
const noId = () => { throw new Error('uuid must not be allocated'); };
const make = (d: ReturnType<typeof durable>, a: ReturnType<typeof authority>, uuid: () => string, runtime = {}) =>
  createTransitionOperationManager(config, { storage: d.storage, send: a.send, uuid, runtime });
const rejectsWith = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ code }));

describe('transition operation manager', () => {
  it('write failure sends no RPC and poisons the manager', () => {
    const d = durable(() => true);
    const a = authority();
    const m = make(d, a, ids(1, 2));
    rejectsWith(() => m.begin(spec()), 'JOURNAL_FAILED');
    rejectsWith(() => m.begin(spec()), 'JOURNAL_FAILED');
    expect(a.requests).toEqual([]);
  });

  it('begin ACK write failure yields no handle and leaves BEGIN_PENDING durable', () => {
    const d = durable((json) => lastOf(json).state === 'AUTHORIZED');
    const a = authority();
    const m = make(d, a, ids(1));
    let ran = 0;
    rejectsWith(() => m.begin(spec()), 'JOURNAL_FAILED');
    rejectsWith(() => m.run({}, () => { ran += 1; return ok; }), 'JOURNAL_FAILED');
    expect(ran).toBe(0);
    expect(d.store.text && lastOf(d.store.text).state).toBe('BEGIN_PENDING');
  });

  it('timeout keeps the exact request; reconcile resends the same bytes once with no handle', () => {
    const d = durable();
    const a = authority((action, count) => action === 'begin' && count === 1);
    rejectsWith(() => make(d, a, ids(1)).begin(spec()), 'BEGIN_UNCERTAIN');
    expect(d.store.text && lastOf(d.store.text).state).toBe('BEGIN_PENDING');
    const second = make(d, a, noId);
    rejectsWith(() => second.begin(spec()), 'RECOVERY_REQUIRED');
    const result = second.reconcilePending();
    expect(result).toEqual({ reconciled: true, operationId: id(1), state: 'AUTHORIZED' });
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1]).toBe(a.requests[0]);
    rejectsWith(() => second.reconcilePending(), 'RECOVERY_REQUIRED');
    expect(a.requests).toHaveLength(2);
    rejectsWith(() => second.begin(spec()), 'RECOVERY_REQUIRED');
  });

  it('a loaded AUTHORIZED operation is never replayed; abandonSaved then allows a fresh id', () => {
    const d = durable();
    const a = authority();
    make(d, a, ids(1)).begin(spec());
    const loaded = make(d, a, ids(2));
    expect(loaded.inspect().journal.operations[0].state).toBe('AUTHORIZED');
    rejectsWith(() => loaded.begin(spec()), 'RECOVERY_REQUIRED');
    expect(loaded.abandonSaved(id(1), 'UNKNOWN')).toEqual({ operationId: id(1), state: 'ABANDONED' });
    const fresh = loaded.begin(spec());
    expect(fresh.operationId).toBe(id(2));
    expect(a.actions).toEqual(['begin', 'abandon', 'begin']);
  });

  it('rejects forged, reused and foreign handles', () => {
    const d = durable();
    const a = authority();
    const m = make(d, a, ids(1));
    const { handle } = m.begin(spec());
    rejectsWith(() => m.run({}, () => ok), 'RECOVERY_REQUIRED');
    rejectsWith(() => make(d, a, noId).run(handle, () => ok), 'RECOVERY_REQUIRED');
    let calls = 0;
    expect(m.run(handle, () => { calls += 1; return ok; })).toEqual(ok);
    rejectsWith(() => m.run(handle, () => { calls += 1; return ok; }), 'RECOVERY_REQUIRED');
    expect(calls).toBe(1);
  });

  it('persists MUTATING before the callback runs', () => {
    const d = durable();
    const m = make(d, authority(), ids(1));
    const { handle } = m.begin(spec());
    let seen = '';
    m.run(handle, () => { seen = d.store.text ? lastOf(d.store.text).state : ''; return ok; });
    expect(seen).toBe('MUTATING');
  });

  it('only a throwing callback is RUNTIME_FAILED and it leaves MUTATING', () => {
    const d = durable();
    const a = authority();
    const m = make(d, a, ids(1));
    const { handle } = m.begin(spec());
    rejectsWith(() => m.run(handle, () => { throw new Error('boom'); }), 'RUNTIME_FAILED');
    expect(d.store.text && lastOf(d.store.text).state).toBe('MUTATING');
    rejectsWith(() => m.complete(handle, ok), 'RECOVERY_REQUIRED');
    expect(a.actions).toEqual(['begin']);
  });

  it('rejects complete before run or with unobserved/mismatched evidence', () => {
    const d = durable();
    const a = authority();
    const m = make(d, a, ids(1));
    const { handle } = m.begin(spec());
    rejectsWith(() => m.complete(handle, ok), 'RECOVERY_REQUIRED');
    m.run(handle, () => ({ observedSha: 'b'.repeat(40), verified: true }));
    rejectsWith(() => m.complete(handle, { observedSha: 'b'.repeat(40), verified: true }), 'RECOVERY_REQUIRED');
    expect(a.actions).toEqual(['begin']);
  });

  it('lost complete ACK: a restarted manager retries only the saved complete', () => {
    const d = durable();
    const a = authority((action, count) => action === 'complete' && count === 1);
    const m = make(d, a, ids(1));
    const { handle } = m.begin(spec());
    m.run(handle, () => ok);
    rejectsWith(() => m.complete(handle, ok), 'FINALIZATION_UNCERTAIN');
    const restarted = make(d, a, noId);
    rejectsWith(() => restarted.begin(spec()), 'RECOVERY_REQUIRED');
    expect(restarted.reconcilePending()).toEqual({ reconciled: true, operationId: id(1), state: 'COMPLETED' });
    expect(a.actions).toEqual(['begin', 'complete', 'complete']);
    expect(a.requests[2]).toBe(a.requests[1]);
    expect(make(d, a, ids(2)).begin(spec()).operationId).toBe(id(2));
  });

  it('terminal ACK write failure is FINALIZATION_UNCERTAIN', () => {
    const d = durable((json) => lastOf(json).state === 'COMPLETED');
    const m = make(d, authority(), ids(1));
    const { handle } = m.begin(spec());
    m.run(handle, () => ok);
    rejectsWith(() => m.complete(handle, ok), 'FINALIZATION_UNCERTAIN');
    expect(d.store.text && lastOf(d.store.text).state).toBe('COMPLETE_PENDING');
  });

  it('a loaded MUTATING operation must be explicitly abandoned before any fresh begin, then recovers cleanly', () => {
    const d = durable();
    const a = authority();
    let oldCallbacks = 0;
    const first = make(d, a, ids(1));
    const { handle } = first.begin(spec());
    rejectsWith(() => first.run(handle, () => { oldCallbacks += 1; throw new Error('boom'); }), 'RUNTIME_FAILED');
    const loaded = make(d, a, ids(2));
    const before = d.store.text;
    const sent = a.requests.length;
    rejectsWith(() => loaded.begin(spec()), 'RECOVERY_REQUIRED');
    rejectsWith(() => loaded.begin(spec({ kind: 'interrupted-recovery' })), 'RECOVERY_REQUIRED');
    rejectsWith(() => loaded.begin(spec({ parentOperationId: id(1) })), 'RECOVERY_REQUIRED');
    rejectsWith(() => loaded.begin(spec({ kind: 'interrupted-recovery', parentOperationId: id(1) })), 'RECOVERY_REQUIRED');
    expect(d.store.text).toBe(before);
    expect(a.requests).toHaveLength(sent);
    expect(loaded.abandonSaved(id(1), 'UNKNOWN')).toEqual({ operationId: id(1), state: 'ABANDONED' });
    const recovery = loaded.begin(spec({ kind: 'interrupted-recovery', parentOperationId: id(1) }));
    expect(recovery.operationId).toBe(id(2));
    expect(loaded.run(recovery.handle, () => ok)).toEqual(ok);
    loaded.complete(recovery.handle, ok);
    const ordinary = make(d, a, ids(3)).begin(spec());
    expect(ordinary.operationId).toBe(id(3));
    const records = JSON.parse(d.store.text ?? '{}').operations.map((op: { operationId: string; state: string; parentOperationId: string | null }) =>
      [op.operationId, op.state, op.parentOperationId]);
    expect(records).toEqual([
      [id(1), 'ABANDONED', null], [id(2), 'COMPLETED', id(1)], [id(3), 'AUTHORIZED', null],
    ]);
    expect(a.actions).toEqual(['begin', 'abandon', 'begin', 'complete', 'begin']);
    expect(oldCallbacks).toBe(1);
  });

  it('never overwrites an unresolved pending begin', () => {
    const d = durable();
    const a = authority((action) => action === 'begin');
    rejectsWith(() => make(d, a, ids(1)).begin(spec()), 'BEGIN_UNCERTAIN');
    const before = d.store.text;
    const sent = a.requests.length;
    rejectsWith(() => make(d, a, ids(2)).begin(spec()), 'RECOVERY_REQUIRED');
    expect(d.store.text).toBe(before);
    expect(a.requests).toHaveLength(sent);
  });

  it('dry run performs no storage, authority or uuid effects', () => {
    const d = durable();
    const a = authority();
    const m = make(d, a, noId, { dryRun: true });
    expect(m.inspect()).toEqual({ planned: true });
    expect(m.begin(spec())).toMatchObject({ planned: true });
    expect(d.store).toEqual({ text: null, reads: 0, writes: 0 });
    expect(a.requests).toEqual([]);
  });
});
