'use strict';

// `deploy-kit on-host-status <run-id> [--request <id>] --json` (BRAIN-636 D5): one read-only look at
// a run dir (and optionally a request's reservation) on the host, classified for the deploy executor.
//
// This FAILS CLOSED, unlike outcome.js's classify() (which treats an invalid record as absent): an
// unparsable or invalid accepted.json, terminal.json, refused.json or reservation is never read as
// "nothing there", it makes the state `unknown`. An accepted run with no valid terminal.json and a
// dead unit is `unknown` too, never `failed`: the host may have changed production.
// Nothing here writes to the target; the remote command only tests, reads and runs `systemctl show`.

const { runOnTarget, shQuote } = require('../exec');
const { lockId } = require('../lock');
const { RUN_ID_RE, isPlainObject, parseRecord } = require('./outcome');
const {
  parseFramedReply, unitProperty, LIVE_STATES, REMOTE_CALL_TIMEOUT_SECONDS,
} = require('./attach');

const REQUEST_ID_RE = /^[A-Za-z0-9_.-]+$/;
const RUN_FILES = ['started', 'manifest.sha256', 'meta.json', 'accepted.json', 'terminal.json', 'refused.json', 'result-unstarted.json'];
const STATES = ['absent', 'staged', 'claimed', 'refused', 'accepted-running', 'terminal', 'unknown'];

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isGen = (v) => Number.isInteger(v) && v >= 1;
const isRunId = (v) => typeof v === 'string' && RUN_ID_RE.test(v);
const KINDS = new Set(['deploy', 'rollback', 'recover']);

function validateAccepted(record, runId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== runId) return `runId ${JSON.stringify(record.runId)} is not ${runId}`;
  return null;
}

function validateTerminal(record, runId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== runId) return `runId ${JSON.stringify(record.runId)} is not ${runId}`;
  if (!KINDS.has(record.kind)) return 'kind is not deploy, rollback or recover';
  if (!isPlainObject(record.result)) return 'result is not an object';
  if (!isNonEmptyString(record.finishedAt)) return 'finishedAt is not a string';
  return null;
}

function validateRefused(record, runId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== runId) return `runId ${JSON.stringify(record.runId)} is not ${runId}`;
  if (!isNonEmptyString(record.code)) return 'code is not a string';
  return null;
}

function validateUnstarted(record, runId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== runId) return `runId ${JSON.stringify(record.runId)} is not ${runId}`;
  return null;
}

function validateReservation(record, requestId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.requestId !== requestId) return `requestId ${JSON.stringify(record.requestId)} is not ${requestId}`;
  if (!isGen(record.gen)) return 'gen is not a positive integer';
  if (record.state !== 'accepted' && record.state !== 'cancelled') return 'state is not accepted or cancelled';
  if (record.runId !== null && !isRunId(record.runId)) return 'runId is not a run id or null';
  if (record.state === 'accepted' && record.runId === null) return 'an accepted reservation has no runId';
  if (!isNonEmptyString(record.at)) return 'at is not a string';
  if (record.liveBefore !== null && !isNonEmptyString(record.liveBefore)) return 'liveBefore is not a string or null';
  if (record.prev !== null && !(isPlainObject(record.prev) && isRunId(record.prev.runId) && isGen(record.prev.gen))) {
    return 'prev is not null or {runId, gen}';
  }
  return null;
}

// -> { state: 'absent' | 'valid' | 'corrupt', value, problem }. Absence is the ONLY way to read as absent.
function readRecord(raw, validate, expected) {
  const parsed = parseRecord(raw);
  if (parsed.absent) return { state: 'absent' };
  const problem = parsed.error || validate(parsed.record, expected);
  return problem ? { state: 'corrupt', problem } : { state: 'valid', value: parsed.record };
}

function statusCommand(runId, requestId, unit) {
  const dir = '"$HOME"/.deploy-kit/runs/' + runId;
  const emit = (name, file) => `printf 'DK_FILE %s\\n' ${name}; if [ -e ${file} ]; then head -c 65536 ${file}; printf '\\nDK_PRESENT\\n'; else printf 'DK_ABSENT\\n'; fi`;
  const lines = [
    'XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export XDG_RUNTIME_DIR',
    "printf 'DK_FILE rundir\\n'; if [ -d " + dir + " ]; then printf 'DK_PRESENT\\n'; else printf 'DK_ABSENT\\n'; fi",
    ...RUN_FILES.map((name) => emit(name, `${dir}/${name}`)),
  ];
  if (requestId) lines.push(emit('reservation', `"$HOME"/.deploy-kit/requests/${requestId}.json`));
  lines.push("printf 'DK_UNIT\\n'", `systemctl --user show -p ActiveState -p SubState ${shQuote(unit)}`, "printf 'DK_END\\n'");
  return lines.join('\n');
}

// Pure: framed reply -> { runId, state, records, reservation, terminal, unit, reasons, corrupt }.
// `framed` is parseFramedReply's result (or undefined for an unreadable reply).
function classifyStatus({ runId, requestId, framed }) {
  const reasons = [];
  const result = { runId, state: 'unknown', records: {}, reservation: null, terminal: null, unit: null, reasons, corrupt: [] };
  if (!framed) {
    reasons.push('incomplete or unreadable reply from the host; nothing can be concluded');
    return result;
  }
  const { records: raw, unitLines } = framed;
  const activeState = unitProperty(unitLines, 'ActiveState');
  result.unit = activeState === undefined ? null : { activeState, subState: unitProperty(unitLines, 'SubState') || null };

  const read = {
    accepted: readRecord(raw['accepted.json'], validateAccepted, runId),
    terminal: readRecord(raw['terminal.json'], validateTerminal, runId),
    refused: readRecord(raw['refused.json'], validateRefused, runId),
    unstarted: readRecord(raw['result-unstarted.json'], validateUnstarted, runId),
  };
  const reservation = requestId ? readRecord(raw.reservation, validateReservation, requestId) : { state: 'absent' };
  const files = { 'accepted.json': read.accepted, 'terminal.json': read.terminal, 'refused.json': read.refused, 'result-unstarted.json': read.unstarted };
  if (requestId) files.reservation = reservation;

  for (const [name, rec] of Object.entries(files)) {
    result.records[name] = rec.state;
    if (rec.state === 'corrupt') {
      result.corrupt.push(name);
      reasons.push(`${name}: corrupt (${rec.problem}); not treated as absent`);
    }
  }
  for (const name of ['started', 'manifest.sha256', 'meta.json']) result.records[name] = raw[name] === null ? 'absent' : 'present';
  if (reservation.state === 'valid') result.reservation = reservation.value;
  if (read.terminal.state === 'valid') result.terminal = read.terminal.value;
  if (result.corrupt.length > 0) return result;

  const present = (name) => raw[name] !== null;
  const accepted = read.accepted.state === 'valid';
  const unknownBecause = (why) => { reasons.push(why); return result; };

  if (raw.rundir === null) {
    result.state = 'absent';
    return result;
  }
  if (accepted) {
    if (read.refused.state === 'valid') return unknownBecause('accepted.json and refused.json both exist');
    if (read.terminal.state === 'valid') {
      result.state = 'terminal';
      return result;
    }
    if (result.unit && LIVE_STATES.has(result.unit.activeState)) {
      result.state = 'accepted-running';
      return result;
    }
    return unknownBecause('accepted with no valid terminal.json and the unit is not running; production may have changed');
  }
  if (read.terminal.state === 'valid') return unknownBecause('terminal.json exists without accepted.json');
  if (read.refused.state === 'valid') {
    result.state = 'refused';
    result.code = read.refused.value.code;
    return result;
  }
  if (present('started')) {
    result.state = 'claimed';
    return result;
  }
  if (read.unstarted.state === 'valid') {
    result.state = 'refused';
    result.code = 'unit-never-started';
    return result;
  }
  result.state = 'staged';
  return result;
}

// -> classifyStatus's result. A transport failure is `unknown` with `transport: 'lost'`.
function onHostStatus(config, runId, { requestId, runtime } = {}) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`ONHOST_RUN_ID: ${JSON.stringify(runId)} is not a run id (YYYYMMDDTHHMMSSZ-<sha12>-<8 hex>)`);
  if (requestId !== undefined && !REQUEST_ID_RE.test(requestId)) throw new Error(`ONHOST_REQUEST_ID: ${JSON.stringify(requestId)} is not a request id`);
  if (typeof config.host !== 'string' || !/^[^\s-]\S*$/.test(config.host)) throw new Error('ONHOST_HOST: config host must be a non-empty user@host');
  const unit = `deploy-kit-${lockId(config)}-${runId}`;
  const sshConfig = { ...config, mode: 'ssh', projectDir: undefined };
  const reply = runOnTarget(statusCommand(runId, requestId, unit), sshConfig, {
    capture: true, runtime, readOnly: true, timeoutSeconds: REMOTE_CALL_TIMEOUT_SECONDS,
  });
  const names = ['rundir', ...RUN_FILES, ...(requestId ? ['reservation'] : [])];
  const framed = reply.ok ? parseFramedReply(reply.output, names) : undefined;
  const result = classifyStatus({ runId, requestId, framed });
  if (!framed) result.transport = 'lost';
  return result;
}

module.exports = {
  onHostStatus, classifyStatus, statusCommand, STATES, REQUEST_ID_RE, readRecord, validateReservation, validateTerminal,
};
