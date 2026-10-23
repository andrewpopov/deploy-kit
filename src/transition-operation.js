'use strict';

// Internal finite operation manager (PKG-266). Sequences the journal (storage), the
// strict codec and the authority transport; it adds no wire format of its own.
// A persisted AUTHORIZED record is reconciliation evidence, never an execution
// permit: only a begin acknowledged in THIS manager invocation yields a handle.

const crypto = require('crypto');
const { prepareTransitionAuthorityRequest, sendTransitionAuthority, readExactData } = require('./transition-authority');
const { createTransitionJournalStorage } = require('./transition-operation-storage');
const { validateTransitionJournal, encodeTransitionJournal, MAX_OPERATIONS } = require('./transition-operation-codec');

const SPEC_KEYS = ['kind', 'targetSha', 'targetRelease', 'priorPointer', 'effects', 'parentOperationId'];
const OBSERVATION_KEYS = ['observedSha', 'verified'];
const PENDING_STATES = ['BEGIN_PENDING', 'COMPLETE_PENDING', 'ABANDON_PENDING'];
const TERMINAL_STATE = { complete: 'COMPLETED', abandon: 'ABANDONED' };
const PENDING_STATE = { complete: 'COMPLETE_PENDING', abandon: 'ABANDON_PENDING' };

class TransitionOperationError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TransitionOperationError';
    this.code = code;
  }
}

const fail = (code, message, cause) => { throw new TransitionOperationError(code, message, cause); };
const copy = (value) => JSON.parse(JSON.stringify(value));

function createTransitionOperationManager(config, ctx = {}) {
  const runtime = ctx.runtime;
  const dryRun = Boolean(runtime && runtime.dryRun === true);
  const uuid = ctx.uuid || (() => crypto.randomUUID());
  const send = ctx.send || ((request) => sendTransitionAuthority(config, request, { runtime }));
  const storage = ctx.storage || createTransitionJournalStorage(config, { runtime });

  const records = new Map(); // operationId -> private record of this invocation
  const handles = new WeakMap(); // handle -> record
  const attempted = new Set(); // `${operationId}:${state}` pending RPCs already sent by this manager
  let poisoned = false;
  let reconciled = false;
  let journal = null;
  if (!dryRun) {
    const saved = storage.read();
    journal = saved === null ? null : validateTransitionJournal(config, saved);
  }

  const active = () => (journal ? journal.operations[journal.operations.length - 1] : null);

  function usable() {
    if (dryRun) fail('RECOVERY_REQUIRED', 'dry run: no transition operation is performed');
    if (reconciled) fail('RECOVERY_REQUIRED', 'reconciliation finished; start a new invocation');
    if (poisoned) fail('JOURNAL_FAILED', 'transition journal is poisoned; start a new manager and inspect');
  }

  function persist(next, code = 'JOURNAL_FAILED') {
    usable();
    let json;
    try {
      json = encodeTransitionJournal(config, next);
      storage.write(json);
    } catch (cause) {
      poisoned = true;
      return fail(code, 'transition journal write failed', cause);
    }
    journal = JSON.parse(json);
  }

  const patchActive = (patch) => ({
    ...journal,
    operations: journal.operations.map((op, i) => (i === journal.operations.length - 1 ? { ...op, ...patch } : op)),
  });

  function receiptAccepted(op, receipt) {
    try {
      prepareTransitionAuthorityRequest(config, { ...JSON.parse(op.beginJson), action: 'abandon', receipt, reason: 'FAILED' });
      return true;
    } catch { return false; }
  }

  function ackMatches(ack, op, digest, expectedState, action) {
    if (!ack || ack.planned !== false || ack.operationId !== op.operationId || ack.requestDigest !== digest
      || ack.state !== expectedState || typeof ack.receipt !== 'string') return false;
    return action === 'begin' ? receiptAccepted(op, ack.receipt) : ack.receipt === op.receipt;
  }

  // Sends the exact saved bytes; any throw or mismatched ack is "uncertain".
  function sendSaved(op, json, digest, expectedState, action, code) {
    attempted.add(`${op.operationId}:${op.state}`);
    let ack;
    try {
      ack = send(JSON.parse(json));
    } catch (cause) {
      return fail(code, `transition authority ${action} outcome is uncertain`, cause);
    }
    if (!ackMatches(ack, op, digest, expectedState, action)) {
      return fail(code, `transition authority ${action} acknowledgement is uncertain`);
    }
    return ack;
  }

  function acknowledgeBegin(op) {
    const ack = sendSaved(op, op.beginJson, op.beginDigest, 'AUTHORIZED', 'begin', 'BEGIN_UNCERTAIN');
    persist(patchActive({ state: 'AUTHORIZED', receipt: ack.receipt }));
  }

  function finalizePending(op) {
    const action = op.state === 'COMPLETE_PENDING' ? 'complete' : 'abandon';
    sendSaved(op, op.pendingJson, op.pendingDigest, TERMINAL_STATE[action], action, 'FINALIZATION_UNCERTAIN');
    persist(patchActive({ state: TERMINAL_STATE[action] }), 'FINALIZATION_UNCERTAIN');
    return active();
  }

  function startTerminal(action, extra) {
    const op = active();
    const prepared = prepareTransitionAuthorityRequest(config, {
      ...JSON.parse(op.beginJson), action, receipt: op.receipt, ...extra,
    });
    persist(patchActive({ state: PENDING_STATE[action], pendingJson: prepared.json, pendingDigest: prepared.requestDigest }));
    const done = finalizePending(active());
    const record = records.get(done.operationId);
    if (record) record.finished = true;
    return { operationId: done.operationId, state: done.state };
  }

  function ownedRecord(handle) {
    usable();
    const record = handle !== null && typeof handle === 'object' ? handles.get(handle) : undefined;
    const op = active();
    if (!record || record.finished || !op || op.operationId !== record.operationId) {
      return fail('RECOVERY_REQUIRED', 'transition handle is not valid for this manager');
    }
    return { record, op };
  }

  return {
    inspect() {
      if (dryRun) return { planned: true };
      return { planned: false, journal: journal ? copy(journal) : null };
    },

    begin(spec) {
      const fields = readExactData(spec, SPEC_KEYS, 'TRANSITION_OPERATION_SPEC_INVALID', 'transition begin spec is invalid');
      if (!dryRun) usable();
      const last = active();
      if (last) {
        const recoversMutating = last.state === 'MUTATING' && fields.kind !== 'deploy'
          && fields.parentOperationId === last.operationId;
        const terminal = last.state === 'COMPLETED' || last.state === 'ABANDONED';
        if (!terminal && !recoversMutating) {
          fail('RECOVERY_REQUIRED', PENDING_STATES.includes(last.state)
            ? 'a pending transition RPC must be reconciled first'
            : 'the saved operation must be abandoned or recovered with an explicit parent-linked recovery begin');
        }
        if (journal.operations.length >= MAX_OPERATIONS) fail('JOURNAL_FAILED', 'transition journal operation limit reached');
      }
      const prepared = prepareTransitionAuthorityRequest(config, {
        protocolVersion: 1, action: 'begin', scope: config && config.transitionAuthority && config.transitionAuthority.scope,
        operationId: dryRun ? '00000000-0000-0000-0000-000000000000' : uuid(), parentOperationId: fields.parentOperationId, kind: fields.kind, targetSha: fields.targetSha,
        targetRelease: fields.targetRelease, priorPointer: fields.priorPointer, effects: fields.effects,
      });
      if (dryRun) return { planned: true, requestDigest: prepared.requestDigest };
      const op = {
        operationId: prepared.normalized.operationId, parentOperationId: prepared.normalized.parentOperationId,
        beginJson: prepared.json, beginDigest: prepared.requestDigest, state: 'BEGIN_PENDING', receipt: null,
        pendingJson: null, pendingDigest: null,
      };
      persist({
        schemaVersion: 1, scope: prepared.settings.scope, activeOperationId: op.operationId,
        operations: [...(journal ? journal.operations : []), op],
      });
      acknowledgeBegin(op);
      const handle = Object.freeze({});
      const record = { operationId: op.operationId, consumed: false, observation: null, finished: false };
      records.set(op.operationId, record);
      handles.set(handle, record);
      return { operationId: op.operationId, handle };
    },

    run(handle, callback) {
      const { record, op } = ownedRecord(handle);
      if (record.consumed || op.state !== 'AUTHORIZED') fail('RECOVERY_REQUIRED', 'transition handle was already used');
      if (typeof callback !== 'function') fail('RECOVERY_REQUIRED', 'run requires a synchronous callback');
      record.consumed = true;
      persist(patchActive({ state: 'MUTATING' }));
      let result;
      try {
        result = callback();
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          throw new Error('transition run callback must be synchronous');
        }
      } catch (cause) {
        return fail('RUNTIME_FAILED', 'transition runtime callback failed', cause);
      }
      try {
        const seen = readExactData(result, OBSERVATION_KEYS, 'OBSERVATION_INVALID', 'invalid');
        record.observation = { observedSha: seen.observedSha, verified: seen.verified };
      } catch { record.observation = null; }
      return result;
    },

    complete(handle, observation) {
      const { record, op } = ownedRecord(handle);
      const seen = record.observation;
      const target = JSON.parse(op.beginJson).targetSha;
      let claimed = null;
      try { claimed = readExactData(observation, OBSERVATION_KEYS, 'OBSERVATION_INVALID', 'invalid'); } catch { claimed = null; }
      if (op.state !== 'MUTATING' || !record.consumed || !seen || seen.verified !== true || seen.observedSha !== target
        || !claimed || claimed.verified !== seen.verified || claimed.observedSha !== seen.observedSha) {
        fail('RECOVERY_REQUIRED', 'complete requires the verified observation returned by run for the exact target');
      }
      return startTerminal('complete', { observedSha: seen.observedSha, verified: true });
    },

    abandon(handle, reason) {
      const { op } = ownedRecord(handle);
      if (op.state !== 'AUTHORIZED' && op.state !== 'MUTATING') fail('RECOVERY_REQUIRED', 'operation cannot be abandoned');
      return startTerminal('abandon', { reason });
    },

    abandonSaved(operationId, reason) {
      usable();
      const op = active();
      if (!op || op.operationId !== operationId || (op.state !== 'AUTHORIZED' && op.state !== 'MUTATING')) {
        fail('RECOVERY_REQUIRED', 'only the active acknowledged saved operation can be abandoned');
      }
      return startTerminal('abandon', { reason });
    },

    reconcilePending() {
      usable();
      const op = active();
      if (!op || !PENDING_STATES.includes(op.state)) fail('RECOVERY_REQUIRED', 'no pending transition RPC to reconcile');
      if (attempted.has(`${op.operationId}:${op.state}`)) {
        fail('RECOVERY_REQUIRED', 'this manager already sent that pending RPC; start a new manager');
      }
      if (op.state === 'BEGIN_PENDING') acknowledgeBegin(op);
      else finalizePending(op);
      const done = active();
      reconciled = true;
      return { reconciled: true, operationId: done.operationId, state: done.state };
    },
  };
}

module.exports = { createTransitionOperationManager, TransitionOperationError };
