import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { validateTransitionJournal, encodeTransitionJournal, MAX_JOURNAL_BYTES } = require('../transition-operation-codec.js');

const config = { transitionAuthority: { command: 'authority', scope: 'host-a' } };
const SHA = 'a'.repeat(40);
const RECEIPT = 'receipt-1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

type Json = Record<string, unknown>;
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('fixture field is not text');
  return value;
};
const PENDING_ACTION: Record<string, string> = {
  COMPLETE_PENDING: 'c', COMPLETED: 'c', ABANDON_PENDING: 'a', ABANDONED: 'a',
};
// Wire bytes are written out by hand (fixed key order), independent of the helper.
function wire(action: string, n: number, parent: number | null, extra = '', release = 'rel-1', prior: string | null = null): string {
  const effects = '{"stop":true,"migrate":false,"pointerSwap":true,"restart":true,"databaseRestore":false}';
  return `{"protocolVersion":1,"action":"${action}","scope":"host-a","operationId":"${id(n)}",`
    + `"parentOperationId":${parent === null ? 'null' : `"${id(parent)}"`},"kind":"deploy","targetSha":"${SHA}",`
    + `"targetRelease":"${release}","priorPointer":${prior === null ? 'null' : `"${prior}"`},"effects":${effects}${extra}}`;
}
const completeExtra = `,"receipt":"${RECEIPT}","observedSha":"${SHA}","verified":true`;
const abandonExtra = `,"receipt":"${RECEIPT}","reason":"UNKNOWN"`;

function op(n: number, parent: number | null, state: string, release = 'rel-1', prior: string | null = null): Json {
  const beginJson = wire('begin', n, parent, '', release, prior);
  const pendingAction = PENDING_ACTION[state];
  const pendingJson = pendingAction
    ? wire(pendingAction === 'c' ? 'complete' : 'abandon', n, parent, pendingAction === 'c' ? completeExtra : abandonExtra, release, prior)
    : null;
  return {
    operationId: id(n), parentOperationId: parent === null ? null : id(parent), beginJson,
    beginDigest: digest(beginJson), state, receipt: state === 'BEGIN_PENDING' ? null : RECEIPT,
    pendingJson, pendingDigest: pendingJson === null ? null : digest(pendingJson),
  };
}
const journal = (operations: Json[], active?: string): Json => ({
  schemaVersion: 1, scope: 'host-a',
  activeOperationId: active ?? (text(operations[operations.length - 1].operationId)), operations,
});
const bad = (value: unknown) => {
  expect(() => validateTransitionJournal(config, value)).toThrow(expect.objectContaining({ code: 'JOURNAL_FAILED' }));
};
const mutate = (state: string, change: (o: Json) => void): Json => {
  const o = op(1, null, state);
  change(o);
  return journal([o]);
};

describe('transition operation codec', () => {
  it('accepts every state as a detached, byte-stable journal', () => {
    for (const state of ['BEGIN_PENDING', 'AUTHORIZED', 'MUTATING', 'COMPLETE_PENDING', 'COMPLETED',
      'ABANDON_PENDING', 'ABANDONED']) {
      const input = journal([op(1, null, state)]);
      const out = validateTransitionJournal(config, input);
      expect(out).toEqual(input);
      expect(out).not.toBe(input);
      expect(encodeTransitionJournal(config, input)).toBe(JSON.stringify(input));
    }
  });

  it('accepts terminal chains and retained-parent recovery children', () => {
    validateTransitionJournal(config, journal([op(1, null, 'COMPLETED'), op(2, null, 'ABANDONED'), op(3, null, 'MUTATING')]));
    validateTransitionJournal(config, journal([op(1, null, 'MUTATING'), op(2, 1, 'AUTHORIZED')]));
    validateTransitionJournal(config, journal([op(1, null, 'ABANDONED'), op(2, 1, 'AUTHORIZED')]));
    validateTransitionJournal(config, journal([op(1, null, 'AUTHORIZED'), op(2, 1, 'ABANDONED'), op(3, 2, 'BEGIN_PENDING')]));
  });

  it('rejects top-level corruption', () => {
    const good = journal([op(1, null, 'AUTHORIZED')]);
    bad({ ...good, schemaVersion: 2 });
    bad({ ...good, scope: 'host-b' });
    bad({ ...good, extra: 1 });
    bad({ schemaVersion: 1, scope: 'host-a', operations: good.operations });
    bad({ ...good, activeOperationId: id(9) });
    bad({ ...good, operations: [] });
    bad({ ...good, operations: null });
    bad(null);
    bad([]);
    bad(Object.create({ inherited: true }));
  });

  it('rejects accessors, symbols and exotic containers without invoking getters', () => {
    let called = false;
    const accessor = journal([op(1, null, 'AUTHORIZED')]);
    Object.defineProperty(accessor, 'scope', { enumerable: true, get() { called = true; return 'host-a'; } });
    bad(accessor);
    expect(called).toBe(false);
    const accessorOperations = [op(1, null, 'AUTHORIZED')];
    Object.defineProperty(accessorOperations, '0', { enumerable: true, get() { called = true; return op(1, null, 'AUTHORIZED'); } });
    bad(journal(accessorOperations, id(1)));
    expect(called).toBe(false);
    bad({ ...journal([op(1, null, 'AUTHORIZED')]), [Symbol('x')]: 1 });
    const sparseOperations = [op(1, null, 'AUTHORIZED')];
    sparseOperations.length = 2;
    bad(journal(sparseOperations, id(1)));
    const subclass = journal([op(1, null, 'AUTHORIZED')]);
    Object.setPrototypeOf(subclass.operations, class extends Array {}.prototype);
    bad(subclass);
    bad(journal(Array.from({ length: 33 }, (_, i) => op(i + 1, null, 'COMPLETED'))));
  });

  it('rejects operation field, byte and digest corruption', () => {
    bad(mutate('AUTHORIZED', (o) => { o.extra = 1; }));
    bad(mutate('AUTHORIZED', (o) => { delete o.pendingDigest; }));
    bad(mutate('AUTHORIZED', (o) => { o.beginJson = 7; }));
    bad(mutate('AUTHORIZED', (o) => { o.beginJson = ` ${o.beginJson}`; o.beginDigest = digest(text(o.beginJson)); }));
    bad(mutate('AUTHORIZED', (o) => { o.beginJson = text(o.beginJson).replace('"protocolVersion":1,"action":"begin"', '"action":"begin","protocolVersion":1'); o.beginDigest = digest(text(o.beginJson)); }));
    bad(mutate('AUTHORIZED', (o) => { o.beginDigest = 'f'.repeat(64); }));
    bad(mutate('AUTHORIZED', (o) => { o.beginJson = wire('complete', 1, null, completeExtra); o.beginDigest = digest(text(o.beginJson)); }));
    bad(mutate('AUTHORIZED', (o) => { o.operationId = id(2); }));
    bad(mutate('AUTHORIZED', (o) => { o.parentOperationId = id(2); }));
    bad(mutate('AUTHORIZED', (o) => { o.beginJson = 'x'.repeat(200 * 1024); }));
  });

  it('rejects state, receipt and pending mismatches', () => {
    bad(mutate('AUTHORIZED', (o) => { o.state = 'PAUSED'; }));
    bad(mutate('BEGIN_PENDING', (o) => { o.receipt = RECEIPT; }));
    bad(mutate('AUTHORIZED', (o) => { o.receipt = null; }));
    bad(mutate('AUTHORIZED', (o) => { o.receipt = 'bad\nreceipt'; }));
    bad(mutate('MUTATING', (o) => { o.pendingJson = wire('complete', 1, null, completeExtra); o.pendingDigest = digest(text(o.pendingJson)); }));
    bad(mutate('AUTHORIZED', (o) => { o.pendingDigest = 'f'.repeat(64); }));
    bad(mutate('COMPLETE_PENDING', (o) => { o.pendingJson = null; o.pendingDigest = null; }));
    bad(mutate('COMPLETE_PENDING', (o) => { o.pendingDigest = 'f'.repeat(64); }));
    bad(mutate('COMPLETED', (o) => { o.pendingJson = wire('abandon', 1, null, abandonExtra); o.pendingDigest = digest(text(o.pendingJson)); }));
    bad(mutate('ABANDONED', (o) => { o.pendingJson = wire('complete', 1, null, completeExtra); o.pendingDigest = digest(text(o.pendingJson)); }));
    bad(mutate('COMPLETED', (o) => { o.receipt = 'other'; }));
    bad(mutate('COMPLETED', (o) => { o.pendingJson = wire('complete', 1, null, completeExtra).replace('"restart":true', '"restart":false'); o.pendingDigest = digest(text(o.pendingJson)); }));
    bad(mutate('COMPLETED', (o) => { o.pendingJson = wire('complete', 1, null, completeExtra.replace('true', 'false')); o.pendingDigest = digest(text(o.pendingJson)); }));
  });

  it('rejects chain violations', () => {
    bad(journal([op(1, 2, 'COMPLETED')]));
    bad(journal([op(1, null, 'COMPLETED'), op(1, null, 'COMPLETED')]));
    bad(journal([op(1, null, 'MUTATING'), op(2, null, 'AUTHORIZED')]));
    bad(journal([op(1, null, 'MUTATING'), op(2, 3, 'AUTHORIZED')]));
    bad(journal([op(1, 2, 'MUTATING'), op(2, 1, 'AUTHORIZED')]));
    bad(journal([op(1, null, 'BEGIN_PENDING'), op(2, 1, 'BEGIN_PENDING')]));
    bad(journal([op(1, null, 'COMPLETE_PENDING'), op(2, 1, 'AUTHORIZED')]));
    bad(journal([op(1, null, 'ABANDON_PENDING'), op(2, 1, 'AUTHORIZED')]));
    bad(journal([op(1, null, 'MUTATING'), op(2, 1, 'COMPLETED'), op(3, 2, 'AUTHORIZED')].slice(0, 2), id(1)));
    bad(journal([op(1, null, 'MUTATING'), op(2, 1, 'BEGIN_PENDING'), op(3, 2, 'AUTHORIZED')]));
  });

  it('refuses to encode invalid journals and oversize input', () => {
    expect(() => encodeTransitionJournal(config, { schemaVersion: 1 })).toThrow(expect.objectContaining({ code: 'JOURNAL_FAILED' }));
  });

  it('enforces the aggregate byte cap only on otherwise valid requests', () => {
    const fat = (n: number) => op(n, null, 'COMPLETED', 'r'.repeat(512), 'p'.repeat(4096));
    const perOperation = JSON.stringify(fat(1)).length + 1;
    const count = Math.floor(MAX_JOURNAL_BYTES / perOperation);
    expect(count).toBeGreaterThan(1);
    expect(count + 1).toBeLessThanOrEqual(32);
    const build = (size: number) => journal(Array.from({ length: size }, (_, i) => fat(i + 1)));
    const nearCap = build(count);
    expect(JSON.stringify(nearCap).length).toBeLessThanOrEqual(MAX_JOURNAL_BYTES);
    expect(validateTransitionJournal(config, nearCap)).toEqual(nearCap);
    const overCap = build(count + 1);
    expect(JSON.stringify(overCap).length).toBeGreaterThan(MAX_JOURNAL_BYTES);
    bad(overCap);
  });

  it('refuses a journal for a different configured scope', () => {
    expect(() => validateTransitionJournal({ transitionAuthority: { command: 'authority', scope: 'host-b' } },
      journal([op(1, null, 'AUTHORIZED')]))).toThrow(expect.objectContaining({ code: 'JOURNAL_FAILED' }));
  });
});
