import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(__filename);
const { sendTransitionAuthority } = require('../transition-authority.js');

type Json = Record<string, unknown>;
type Call = { file: string; args: string[]; options: Json };
const sha1 = 'a1'.repeat(20);
const sha2 = 'b2'.repeat(32);
const OP = '3f2b8c1e-5a4d-4e7b-9c3a-1b2d3e4f5a6b';
const PARENT = '7a9d0c4e-2b1f-4a8c-8d5e-6f7a8b9c0d1e';
const OP2 = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OP3 = '0f1e2d3c-4b5a-4968-8776-655443322110';
const RECEIPT = 'receipt-é-0042';
const EFF = '{"stop":true,"migrate":false,"pointerSwap":true,"restart":true,"databaseRestore":false}';
const BEGIN = `{"protocolVersion":1,"action":"begin","scope":"app-prod","operationId":"${OP}","parentOperationId":"${PARENT}","kind":"deploy","targetSha":"${sha1}","targetRelease":"rel-1","priorPointer":"/srv/app/releases/rel-0","effects":${EFF}}`;
const COMPLETE = `{"protocolVersion":1,"action":"complete","scope":"app-prod","operationId":"${OP2}","parentOperationId":null,"kind":"manual-rollback","targetSha":"${sha2}","targetRelease":"rel-2","priorPointer":null,"effects":${EFF},"receipt":"${RECEIPT}","observedSha":"${sha1}","verified":true}`;
const ABANDON = `{"protocolVersion":1,"action":"abandon","scope":"app-prod","operationId":"${OP3}","parentOperationId":null,"kind":"recovery-restart","targetSha":"${sha1}","targetRelease":"rel-3","priorPointer":null,"effects":${EFF},"receipt":"${RECEIPT}","reason":"FAILED"}`;
const GOLDEN = { begin: BEGIN, complete: COMPLETE, abandon: ABANDON } as const;
const STATE = { begin: 'AUTHORIZED', complete: 'COMPLETED', abandon: 'ABANDONED' } as const;
type Action = keyof typeof GOLDEN;
const expectedDigest = (json: string) => crypto.createHash('sha256').update(json, 'utf8').digest('hex');
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Json => {
  if (!isRecord(value)) throw new Error('Fixture record required');
  return value;
};
const parse = (json: string): Json => record(JSON.parse(json));
const baseConfig = (extra: Json = {}): Json => ({
  mode: 'local', transitionAuthority: { command: 'authority-cli --record', scope: 'app-prod', ...extra },
});
const ack = (action: Action, over: Json = {}): string => JSON.stringify({
  protocolVersion: 1, action, scope: 'app-prod', operationId: parse(GOLDEN[action]).operationId,
  requestDigest: expectedDigest(GOLDEN[action]), receipt: action === 'begin' ? 'new-receipt' : RECEIPT,
  state: STATE[action], ...over,
});
function host(reply: string | Error) {
  const calls: Call[] = [];
  const execFileSync = (file: string, args: string[], options: Json): string => {
    calls.push({ file, args, options });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, runtime: { execFileSync } };
}
function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'NO_CODE';
  }
  return 'NO_THROW';
}
const send = (config: unknown, request: unknown, reply: string | Error = '') => {
  const h = host(reply);
  return { h, run: () => sendTransitionAuthority(config, request, { runtime: h.runtime }) };
};
const rejects = (config: unknown, request: unknown, code: string) => {
  const { h, run } = send(config, request, ack('begin'));
  expect(codeOf(run)).toBe(`TRANSITION_AUTHORITY_${code}`);
  expect(h.calls).toHaveLength(0);
};

describe('transition authority transport', () => {
  it.each(['begin', 'complete', 'abandon'] as const)('%s sends golden JSON on stdin and returns the ack', (action) => {
    const { h, run } = send(baseConfig(), parse(GOLDEN[action]), ack(action));
    const result = run();
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call.options.input).toBe(GOLDEN[action]);
    expect(call.file).toBe('sh');
    expect(call.args).toEqual(['-c', 'authority-cli --record']);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(call.options.timeout).toBe(30000);
    const wire = call.args.join(' ');
    for (const value of [OP, OP2, OP3, PARENT, RECEIPT, sha1, sha2]) expect(wire).not.toContain(value);
    expect(result).toEqual({
      planned: false, operationId: parse(GOLDEN[action]).operationId, requestDigest: expectedDigest(GOLDEN[action]),
      receipt: action === 'begin' ? 'new-receipt' : RECEIPT, state: STATE[action],
    });
  });

  it.each([[1, 1000], [300, 300000]])('timeoutSeconds %i maps to %i ms', (seconds, ms) => {
    const { h, run } = send(baseConfig({ timeoutSeconds: seconds }), parse(BEGIN), ack('begin'));
    run();
    expect(h.calls[0].options.timeout).toBe(ms);
  });

  it('dryRun plans without RPC or receipt, and still validates the request', () => {
    const h = host(ack('begin'));
    const runtime = { ...h.runtime, dryRun: true };
    expect(sendTransitionAuthority(baseConfig(), parse(BEGIN), { runtime }))
      .toEqual({ planned: true, requestDigest: expectedDigest(BEGIN) });
    expect(codeOf(() => sendTransitionAuthority(baseConfig(), { ...parse(BEGIN), kind: 'nope' }, { runtime })))
      .toBe('TRANSITION_AUTHORITY_REQUEST_INVALID');
    expect(h.calls).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ['timeout 0', baseConfig({ timeoutSeconds: 0 })], ['timeout 301', baseConfig({ timeoutSeconds: 301 })],
    ['timeout 1.5', baseConfig({ timeoutSeconds: 1.5 })], ['timeout string', baseConfig({ timeoutSeconds: '5' })],
    ['timeout undefined', baseConfig({ timeoutSeconds: undefined })], ['unknown key', baseConfig({ extra: 1 })],
    ['missing command', { mode: 'local', transitionAuthority: { scope: 'app-prod' } }],
    ['missing scope', { mode: 'local', transitionAuthority: { command: 'x' } }],
    ['empty command', baseConfig({ command: '' })], ['control in scope', baseConfig({ scope: 'a\nb' })],
    ['missing block', { mode: 'local' }], ['null config', null],
    ['getter', { mode: 'local', transitionAuthority: Object.defineProperty({ scope: 'app-prod' }, 'command', { enumerable: true, get: () => 'x' }) }],
  ])('rejects config: %s', (_name, config) => {
    rejects(config, parse(BEGIN), 'CONFIG_INVALID');
  });

  const reqCases: Array<[string, (r: Json) => unknown]> = [
    ['unknown field', (r) => ({ ...r, extra: 1 })], ['missing field', ({ priorPointer: _p, ...r }) => r],
    ['unknown action', (r) => ({ ...r, action: 'retry' })], ['wrong scope', (r) => ({ ...r, scope: 'other' })],
    ['version 2', (r) => ({ ...r, protocolVersion: 2 })], ['bad kind', (r) => ({ ...r, kind: 'x' })],
    ['uppercase uuid', (r) => ({ ...r, operationId: OP.toUpperCase() })],
    ['short sha', (r) => ({ ...r, targetSha: sha1.slice(1) })], ['mixed-case sha', (r) => ({ ...r, targetSha: sha1.toUpperCase() })],
    ['missing effect', (r) => ({ ...r, effects: { stop: true } })],
    ['non-boolean effect', (r) => ({ ...r, effects: { ...record(r.effects), stop: 1 } })],
    ['symbol key', (r) => ({ ...r, [Symbol('s')]: 1 })],
    ['exotic prototype', (r) => Object.assign(Object.create({ inherited: 1 }), r)],
    ['array', () => []], ['null', () => null],
  ];
  it.each(reqCases)('rejects request: %s', (_name, mutate) => {
    rejects(baseConfig(), mutate(parse(BEGIN)), 'REQUEST_INVALID');
  });

  it('never invokes request getters or coerces objects', () => {
    let reads = 0;
    const counted = { toString: () => { reads += 1; return sha1; } };
    const getterReq = Object.defineProperty(parse(BEGIN), 'kind', { enumerable: true, get: () => { reads += 1; return 'deploy'; } });
    const effectGetter = parse(BEGIN);
    effectGetter.effects = Object.defineProperty({ ...record(effectGetter.effects) }, 'stop', { enumerable: true, get: () => { reads += 1; return true; } });
    for (const req of [getterReq, effectGetter, { ...parse(BEGIN), targetSha: counted }, { ...parse(BEGIN), operationId: counted }]) {
      rejects(baseConfig(), req, 'REQUEST_INVALID');
    }
    expect(reads).toBe(0);
  });

  it.each(['\n', '\r', ' ', ' '])('rejects id/sha with trailing %j; valid 40/64 pass', (tail) => {
    rejects(baseConfig(), { ...parse(BEGIN), operationId: OP + tail }, 'REQUEST_INVALID');
    rejects(baseConfig(), { ...parse(BEGIN), parentOperationId: PARENT + tail }, 'REQUEST_INVALID');
    rejects(baseConfig(), { ...parse(BEGIN), targetSha: sha1 + tail }, 'REQUEST_INVALID');
    rejects(baseConfig(), { ...parse(COMPLETE), observedSha: sha2 + tail }, 'REQUEST_INVALID');
    for (const sha of [sha1, sha2]) {
      const { run } = send(baseConfig(), { ...parse(BEGIN), targetSha: sha }, ack('begin', { requestDigest: expectedDigest(BEGIN.replace(sha1, sha)) }));
      expect(run()).toMatchObject({ planned: false });
    }
  });

  it('enforces receipt UTF-8 bounds and control guards on complete/abandon', () => {
    const withReceipt = (receipt: unknown) => ({ ...parse(COMPLETE), receipt });
    for (const bad of ['', 'x'.repeat(2049), 'é'.repeat(1025), 'a\u0001b', 'a\u0085b', 'a\u007fb', 7]) {
      rejects(baseConfig(), withReceipt(bad), 'REQUEST_INVALID');
    }
    rejects(baseConfig(), { ...parse(BEGIN), receipt: RECEIPT }, 'REQUEST_INVALID');
    const ok = 'x'.repeat(2048);
    const reply = ack('complete', { receipt: ok, requestDigest: expectedDigest(COMPLETE.replace(RECEIPT, ok)) });
    expect(send(baseConfig(), withReceipt(ok), reply).run()).toMatchObject({ receipt: ok });
  });

  const ackCases: Array<[string, Action, Json | string]> = [
    ['wrong version', 'begin', { protocolVersion: 2 }], ['wrong action', 'begin', { action: 'complete' }],
    ['wrong scope', 'begin', { scope: 'other' }], ['wrong operation', 'begin', { operationId: OP2 }],
    ['wrong digest', 'begin', { requestDigest: expectedDigest('x') }],
    ['begin replied COMPLETED', 'begin', { state: 'COMPLETED' }], ['begin replied permission', 'begin', { state: 'AUTHORIZED', permission: true }],
    ['complete wrong state', 'complete', { state: 'AUTHORIZED' }], ['abandon wrong state', 'abandon', { state: 'COMPLETED' }],
    ['complete wrong receipt', 'complete', { receipt: 'other' }], ['abandon wrong receipt', 'abandon', { receipt: 'other' }],
    ['begin empty receipt', 'begin', { receipt: '' }], ['begin control receipt', 'begin', { receipt: 'a\u0085' }],
    ['missing field', 'begin', { state: undefined }], ['unknown field', 'begin', { extra: 1 }],
    ['malformed JSON', 'begin', '{"protocolVersion":1'], ['array', 'begin', '[]'], ['null', 'begin', 'null'], ['empty', 'begin', ''],
    ['oversized', 'begin', ack('begin', { receipt: 'x'.repeat(8200) })],
  ];
  it.each(ackCases)('rejects ack: %s', (_name, action, over) => {
    const reply = typeof over === 'string' ? over : ack(action, over);
    const { h, run } = send(baseConfig(), parse(GOLDEN[action]), reply);
    expect(codeOf(run)).toBe('TRANSITION_AUTHORITY_ACK_INVALID');
    expect(h.calls).toHaveLength(1);
  });

  it.each([['plain failure', new Error('boom')], ['timeout', Object.assign(new Error('late'), { code: 'ETIMEDOUT' })]])(
    'command %s yields a generic error without leaking output', (_name, error) => {
      const leaky = Object.assign(error, { stdout: 'SECRET-STDOUT-9x', stderr: 'SECRET-STDERR-9x' });
      const { run } = send(baseConfig(), parse(BEGIN), leaky);
      let caught: Error | undefined;
      try { run(); } catch (e) { if (!(e instanceof Error)) throw e; caught = e; }
      expect(caught && 'code' in caught ? caught.code : undefined).toBe('TRANSITION_AUTHORITY_COMMAND_FAILED');
      expect(caught?.message).not.toMatch(/SECRET|boom|late|authority-cli/);
    });
});
