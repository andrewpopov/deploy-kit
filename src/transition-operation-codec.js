'use strict';

// Internal strict codec for the transition-operation journal (PKG-266). Pure: no
// storage, no RPC, no state transitions. Every request is re-prepared through the
// transport's own helper so wire bytes and digests have a single definition.

const crypto = require('crypto');
const { prepareTransitionAuthorityRequest, readExactData } = require('./transition-authority');

const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_OPERATIONS = 32;
const TOP_KEYS = ['schemaVersion', 'scope', 'activeOperationId', 'operations'];
const OPERATION_KEYS = ['operationId', 'parentOperationId', 'beginJson', 'beginDigest', 'state', 'receipt',
  'pendingJson', 'pendingDigest'];
const PENDING_ACTION = {
  COMPLETE_PENDING: 'complete', COMPLETED: 'complete', ABANDON_PENDING: 'abandon', ABANDONED: 'abandon',
};
const STATES = ['BEGIN_PENDING', 'AUTHORIZED', 'MUTATING', ...Object.keys(PENDING_ACTION)];
const TERMINAL = ['COMPLETED', 'ABANDONED'];
const RETAINABLE = ['AUTHORIZED', 'MUTATING'];

class JournalError extends Error {
  constructor() {
    super('transition journal is invalid');
    this.name = 'TransitionJournalError';
    this.code = 'JOURNAL_FAILED';
  }
}

const reject = () => { throw new JournalError(); };
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Re-prepare `text` and require it to be byte-identical canonical wire JSON.
function prepareExact(config, text, digest, action) {
  if (typeof text !== 'string' || text.length > MAX_JOURNAL_BYTES) reject();
  const prepared = prepareTransitionAuthorityRequest(config, JSON.parse(text));
  if (prepared.json !== text || prepared.requestDigest !== digest || sha256(text) !== digest
    || prepared.normalized.action !== action) reject();
  return prepared;
}

function readArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > MAX_OPERATIONS) return reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) reject();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) reject();
    return descriptor.value;
  });
}

function validateOperation(config, value) {
  const op = readExactData(value, OPERATION_KEYS, 'JOURNAL_FAILED', 'invalid');
  const begin = prepareExact(config, op.beginJson, op.beginDigest, 'begin');
  if (op.operationId !== begin.normalized.operationId || op.parentOperationId !== begin.normalized.parentOperationId
    || !STATES.includes(op.state)) reject();
  if (op.state === 'BEGIN_PENDING') {
    if (op.receipt !== null) reject();
  } else {
    // A terminal-shaped request is the transport's own receipt validator.
    prepareTransitionAuthorityRequest(config, {
      ...begin.normalized, action: 'abandon', receipt: op.receipt, reason: 'FAILED',
    });
  }
  const action = PENDING_ACTION[op.state];
  if (!action) {
    if (op.pendingJson !== null || op.pendingDigest !== null) reject();
  } else {
    const pending = prepareExact(config, op.pendingJson, op.pendingDigest, action);
    const same = Object.keys(begin.normalized).filter((key) => key !== 'action');
    if (pending.normalized.receipt !== op.receipt
      || same.some((key) => JSON.stringify(pending.normalized[key]) !== JSON.stringify(begin.normalized[key]))) reject();
  }
  return {
    scope: begin.settings.scope,
    data: {
      operationId: op.operationId, parentOperationId: op.parentOperationId, beginJson: op.beginJson,
      beginDigest: op.beginDigest, state: op.state, receipt: op.receipt,
      pendingJson: op.pendingJson, pendingDigest: op.pendingDigest,
    },
  };
}

function validateChain(operations) {
  const ids = new Set(operations.map((op) => op.operationId));
  if (ids.size !== operations.length) reject();
  operations.forEach((op, index) => {
    const before = operations.slice(0, index);
    const allTerminal = before.every((prior) => TERMINAL.includes(prior.state));
    if (allTerminal) {
      if (op.parentOperationId !== null
        && (index === 0 || op.parentOperationId !== operations[index - 1].operationId)) reject();
    } else if (op.parentOperationId !== operations[index - 1].operationId
      || before.some((prior) => !TERMINAL.includes(prior.state) && !RETAINABLE.includes(prior.state))) reject();
  });
}

function validateTransitionJournal(config, value) {
  try {
    const top = readExactData(value, TOP_KEYS, 'JOURNAL_FAILED', 'invalid');
    if (top.schemaVersion !== 1) reject();
    const checked = readArray(top.operations).map((op) => validateOperation(config, op));
    const operations = checked.map((entry) => entry.data);
    if (checked.some((entry) => entry.scope !== top.scope)
      || top.activeOperationId !== operations[operations.length - 1].operationId) reject();
    validateChain(operations);
    const journal = { schemaVersion: 1, scope: top.scope, activeOperationId: top.activeOperationId, operations };
    if (Buffer.byteLength(JSON.stringify(journal), 'utf8') > MAX_JOURNAL_BYTES) reject();
    return journal;
  } catch {
    return reject();
  }
}

const encodeTransitionJournal = (config, value) => JSON.stringify(validateTransitionJournal(config, value));

module.exports = { validateTransitionJournal, encodeTransitionJournal, MAX_JOURNAL_BYTES, MAX_OPERATIONS };
