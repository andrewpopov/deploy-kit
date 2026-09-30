import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { classify, validateResultRecord, validateOutcomeRecord } = require('../on-host/outcome.js');

const RUN = '20260930T120000Z-0123456789ab-deadbeef';
const result = (over: Record<string, unknown> = {}) => JSON.stringify({
  runId: RUN, invocationId: 'a'.repeat(32), serviceResult: 'success', exitCode: 'exited', exitStatus: '0', finishedAt: 1, ...over,
});
const outcome = (over: Record<string, unknown> = {}) => JSON.stringify({ runId: RUN, ok: true, finishedAt: '2026-09-30T12:00:00Z', ...over });
const go = (args: Record<string, unknown>) => classify({ expectedRunId: RUN, ...args });

describe('classify truth table', () => {
  it('success: clean result + ok outcome -> 0', () => {
    expect(go({ result: result(), outcome: outcome() })).toMatchObject({ exitCode: 0, status: 'succeeded' });
  });
  it('failure through the outcome -> 1', () => {
    const r = go({ result: result(), outcome: outcome({ ok: false, error: 'boom' }) });
    expect(r.exitCode).toBe(1);
    expect(r.reasons.join()).toContain('boom');
  });
  it.each([
    ['exit 3', { serviceResult: 'exit-code', exitCode: 'exited', exitStatus: '3' }],
    ['SIGKILL', { serviceResult: 'signal', exitCode: 'killed', exitStatus: 'KILL' }],
    ['stop', { serviceResult: 'success', exitCode: 'killed', exitStatus: 'TERM' }],
  ])('failure through the result (%s) -> 1 even with an ok outcome', (_n, over) => {
    expect(go({ result: result(over), outcome: outcome() }).exitCode).toBe(1);
  });
  it('missing outcome + failed result -> 1', () => {
    expect(go({ result: result({ serviceResult: 'signal', exitCode: 'killed', exitStatus: 'KILL' }) }).exitCode).toBe(1);
  });
  it('missing outcome + success result -> 70', () => {
    expect(go({ result: result() })).toMatchObject({ exitCode: 70, status: 'unknown' });
  });
  it('outcome ok but no result -> 70', () => {
    expect(go({ outcome: outcome() }).exitCode).toBe(70);
  });
  it('result-unstarted -> 1', () => {
    expect(go({ resultUnstarted: result({ serviceResult: 'exit-code', exitStatus: '1' }) })).toMatchObject({ exitCode: 1, status: 'failed-to-start' });
  });
  it('wrong run id counts as absent', () => {
    const r = go({ result: result({ runId: 'other' }), outcome: outcome() });
    expect(r.exitCode).toBe(70);
    expect(r.reasons.join()).toContain('treated as absent');
    expect(go({ result: result(), outcome: outcome({ runId: 'other' }) }).exitCode).toBe(70);
  });
  it('a wrong-run-id failed result does not fail a run', () => {
    expect(go({ result: result({ runId: 'other', exitStatus: '3' }), outcome: outcome() }).exitCode).toBe(70);
  });
  it('malformed JSON counts as absent', () => {
    expect(go({ result: '{nope', outcome: outcome() }).exitCode).toBe(70);
    expect(go({ result: result(), outcome: '{nope' }).exitCode).toBe(70);
  });
  it('no records -> 70', () => {
    expect(go({})).toMatchObject({ exitCode: 70, status: 'unknown' });
  });
  it('accepts already-parsed records', () => {
    expect(go({ result: JSON.parse(result()), outcome: JSON.parse(outcome()) }).exitCode).toBe(0);
  });
});

describe('record validators', () => {
  it('reject bad shapes by reason', () => {
    expect(validateResultRecord(null, RUN)).toBeTruthy();
    expect(validateResultRecord(JSON.parse(result({ finishedAt: 'x' })), RUN)).toContain('finishedAt');
    expect(validateResultRecord(JSON.parse(result()), RUN)).toBeNull();
    expect(validateOutcomeRecord(JSON.parse(outcome({ ok: 'yes' })), RUN)).toContain('ok');
    expect(validateOutcomeRecord(JSON.parse(outcome()), RUN)).toBeNull();
  });
});
