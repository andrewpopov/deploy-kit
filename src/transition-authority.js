'use strict';

// Internal transport for transition-authority RPCs (PKG-266 slice 1). Not exported
// from the package index. The configured command is trusted operator shell config;
// request values travel ONLY as JSON on stdin. Persistence, retry/conflict handling,
// head/supersession and lifetime exclusion belong to the host adapter, not here.

const crypto = require('crypto');
const { runOnTarget } = require('./exec');

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_ACK_BYTES = 8192;
const MAX_RECEIPT_BYTES = 2048;
const CONTROL = /\p{Cc}/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTIONS = ['begin', 'complete', 'abandon'];
const KINDS = ['deploy', 'manual-rollback', 'automatic-recovery', 'interrupted-recovery', 'recovery-restart'];
const EFFECTS = ['stop', 'migrate', 'pointerSwap', 'restart', 'databaseRestore'];
const ABANDON_REASONS = ['FAILED', 'UNKNOWN'];
const TERMINAL_STATE = { begin: 'AUTHORIZED', complete: 'COMPLETED', abandon: 'ABANDONED' };
const BASE_KEYS = ['protocolVersion', 'action', 'scope', 'operationId', 'parentOperationId', 'kind',
  'targetSha', 'targetRelease', 'priorPointer', 'effects'];
const EXTRA_KEYS = { begin: [], complete: ['receipt', 'observedSha', 'verified'], abandon: ['receipt', 'reason'] };
const ACK_KEYS = ['protocolVersion', 'action', 'scope', 'operationId', 'requestDigest', 'receipt', 'state'];

class TransitionAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransitionAuthorityError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new TransitionAuthorityError(`TRANSITION_AUTHORITY_${code}`, message); };

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Own enumerable data properties only; never invokes a getter.
function readExactData(value, keys, code, message) {
  if (!isPlainObject(value)) return fail(code, message);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return fail(code, message);
  }
  const data = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail(code, message);
    data[key] = descriptor.value;
  }
  return data;
}

const isText = (value, maxLength) => typeof value === 'string' && value.length > 0
  && value.length <= maxLength && !CONTROL.test(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const isReceipt = (value) => isText(value, MAX_RECEIPT_BYTES)
  && Buffer.byteLength(value, 'utf8') <= MAX_RECEIPT_BYTES;

function validateConfig(config) {
  const bad = (m) => fail('CONFIG_INVALID', m || 'transitionAuthority config is missing or invalid');
  if (!config || typeof config !== 'object') bad();
  const raw = config.transitionAuthority;
  if (!isPlainObject(raw)) bad();
  const own = Reflect.ownKeys(raw);
  const allowed = ['command', 'scope', 'timeoutSeconds'];
  if (own.some((key) => !allowed.includes(key)) || !own.includes('command') || !own.includes('scope')) bad();
  const settings = {};
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor.enumerable || !('value' in descriptor)) bad();
    settings[key] = descriptor.value;
  }
  if (!isText(settings.command, 4096) || !isText(settings.scope, 256)) bad();
  const timeoutSeconds = settings.timeoutSeconds === undefined && !own.includes('timeoutSeconds')
    ? DEFAULT_TIMEOUT_SECONDS : settings.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) bad();
  return { command: settings.command, scope: settings.scope, timeoutSeconds };
}

function normalizeRequest(request, scope) {
  const bad = () => fail('REQUEST_INVALID', 'transition authority request is invalid');
  if (!isPlainObject(request)) bad();
  const probe = Object.getOwnPropertyDescriptor(request, 'action');
  const action = probe && probe.value;
  if (!ACTIONS.includes(action)) bad();
  const keys = [...BASE_KEYS, ...EXTRA_KEYS[action]];
  const r = readExactData(request, keys, 'REQUEST_INVALID', 'transition authority request is invalid');
  const effects = readExactData(r.effects, EFFECTS, 'REQUEST_INVALID', 'transition authority request is invalid');
  if (r.protocolVersion !== 1 || r.scope !== scope || !matches(r.operationId, UUID)
    || !(r.parentOperationId === null || matches(r.parentOperationId, UUID))
    || !KINDS.includes(r.kind) || !matches(r.targetSha, FULL_SHA) || !isText(r.targetRelease, 512)
    || !(r.priorPointer === null || isText(r.priorPointer, 4096))
    || EFFECTS.some((key) => typeof effects[key] !== 'boolean')) bad();
  if (action !== 'begin' && !isReceipt(r.receipt)) bad();
  if (action === 'complete' && (!matches(r.observedSha, FULL_SHA) || r.verified !== true)) bad();
  if (action === 'abandon' && !ABANDON_REASONS.includes(r.reason)) bad();
  const normalized = {};
  for (const key of keys) normalized[key] = key === 'effects' ? Object.fromEntries(EFFECTS.map((e) => [e, effects[e]])) : r[key];
  return normalized;
}

function parseAck(output, normalized, requestDigest) {
  const bad = () => fail('ACK_INVALID', 'transition authority acknowledgement is invalid');
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_ACK_BYTES) bad();
  let parsed;
  try { parsed = JSON.parse(output); } catch { bad(); }
  const ack = readExactData(parsed, ACK_KEYS, 'ACK_INVALID', 'transition authority acknowledgement is invalid');
  if (ack.protocolVersion !== 1 || ack.action !== normalized.action || ack.scope !== normalized.scope
    || ack.operationId !== normalized.operationId || ack.requestDigest !== requestDigest
    || ack.state !== TERMINAL_STATE[normalized.action] || !isReceipt(ack.receipt)) bad();
  if (normalized.action !== 'begin' && ack.receipt !== normalized.receipt) bad();
  return ack;
}

function sendTransitionAuthority(config, request, { runtime } = {}) {
  const settings = validateConfig(config);
  const normalized = normalizeRequest(request, settings.scope);
  const json = JSON.stringify(normalized);
  const requestDigest = crypto.createHash('sha256').update(json, 'utf8').digest('hex');
  if (runtime && runtime.dryRun) return { planned: true, requestDigest };
  const result = runOnTarget(settings.command, config, {
    capture: true, runtime, input: json, timeoutSeconds: settings.timeoutSeconds,
  });
  if (!result || !result.ok) fail('COMMAND_FAILED', 'transition authority command failed');
  const ack = parseAck(result.output, normalized, requestDigest);
  return {
    planned: false, operationId: ack.operationId, requestDigest, receipt: ack.receipt, state: ack.state,
  };
}

// Early entrypoint guard. ANY non-null/undefined transitionAuthority counts as
// configured (a malformed value must not bypass it). The existing TTL lock is only
// an operational helper here; host lifetime exclusion is the host adapter's job.
function assertTransitionAuthorityEntryPoint(config, { supported = false, options } = {}) {
  if (!config || config.transitionAuthority === undefined || config.transitionAuthority === null) return;
  if (!supported) {
    fail('UNSUPPORTED', 'this entrypoint does not support a configured transitionAuthority');
  }
  if (config.lock === false || (options && options.stealLock)) {
    fail('OPTIONS_INVALID', 'a configured transitionAuthority requires the lock and forbids stealLock');
  }
}

module.exports = { sendTransitionAuthority, assertTransitionAuthorityEntryPoint, TransitionAuthorityError };
