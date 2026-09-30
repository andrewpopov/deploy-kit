'use strict';

// Pure outcome classification for `deploy --on-host` (PKG-187), shared by the
// operator (attach) and tests. Inputs are the raw text (or already-parsed value)
// of the three on-host records; nothing here touches the filesystem.
//
// Every record is validated independently and an invalid or mismatched record
// counts as ABSENT, so a stale or foreign file can never decide a run.

const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{12}-[0-9a-f]{8}$/;

const EXIT_SUCCEEDED = 0;
const EXIT_FAILED = 1;
const EXIT_UNKNOWN = 70;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Parse a record's text. Returns { record } or { error } (absent input: { absent: true }).
function parseRecord(raw) {
  if (raw === undefined || raw === null) return { absent: true };
  if (typeof raw !== 'string') return { record: raw };
  try {
    return { record: JSON.parse(raw) };
  } catch (error) {
    return { error: `malformed JSON (${error.message})` };
  }
}

const isScalarText = (v) => (typeof v === 'string' && v !== '') || Number.isInteger(v);

// A result written by record.sh (result.json / result-unstarted.json).
function validateResultRecord(record, expectedRunId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== expectedRunId) return `runId ${JSON.stringify(record.runId)} is not ${expectedRunId}`;
  if (typeof record.invocationId !== 'string') return 'invocationId is not a string';
  if (typeof record.serviceResult !== 'string' || record.serviceResult === '') return 'serviceResult is not a string';
  if (!isScalarText(record.exitCode)) return 'exitCode is missing';
  if (!isScalarText(record.exitStatus)) return 'exitStatus is missing';
  if (!Number.isFinite(record.finishedAt)) return 'finishedAt is not a number';
  return null;
}

// The outcome host-run writes (outcome.json).
function validateOutcomeRecord(record, expectedRunId) {
  if (!isPlainObject(record)) return 'not an object';
  if (record.runId !== expectedRunId) return `runId ${JSON.stringify(record.runId)} is not ${expectedRunId}`;
  if (typeof record.ok !== 'boolean') return 'ok is not a boolean';
  if ('error' in record && typeof record.error !== 'string') return 'error is not a string';
  if (typeof record.finishedAt !== 'string' || record.finishedAt === '') return 'finishedAt is not a string';
  return null;
}

function readValid(name, raw, validate, expectedRunId, reasons) {
  const parsed = parseRecord(raw);
  if (parsed.absent) return null;
  if (parsed.error) {
    reasons.push(`${name}: ${parsed.error}; treated as absent`);
    return null;
  }
  const problem = validate(parsed.record, expectedRunId);
  if (problem) {
    reasons.push(`${name}: ${problem}; treated as absent`);
    return null;
  }
  return parsed.record;
}

const isCleanExit = (r) => r.serviceResult === 'success' && String(r.exitCode) === 'exited' && String(r.exitStatus) === '0';
const describeResult = (r) => `${r.serviceResult}/${r.exitCode}/${r.exitStatus}`;

function classify({ expectedRunId, result, outcome, resultUnstarted } = {}) {
  const reasons = [];
  const res = readValid('result.json', result, validateResultRecord, expectedRunId, reasons);
  const out = readValid('outcome.json', outcome, validateOutcomeRecord, expectedRunId, reasons);
  const unstarted = readValid('result-unstarted.json', resultUnstarted, validateResultRecord, expectedRunId, reasons);

  if (res && !isCleanExit(res)) {
    reasons.push(`unit ended ${describeResult(res)}`);
    return { exitCode: EXIT_FAILED, status: 'failed', reasons };
  }
  if (out && out.ok === false) {
    reasons.push(`deploy failed${out.error ? `: ${out.error}` : ''}`);
    return { exitCode: EXIT_FAILED, status: 'failed', reasons };
  }
  if (res && out && out.ok === true) {
    return { exitCode: EXIT_SUCCEEDED, status: 'succeeded', reasons };
  }
  if (unstarted) {
    reasons.push(`host-run never claimed the run (${describeResult(unstarted)})`);
    return { exitCode: EXIT_FAILED, status: 'failed-to-start', reasons };
  }
  if (res) reasons.push('result.json reports a clean exit but outcome.json is missing or invalid');
  else if (out) reasons.push('outcome.json reports success but result.json is missing or invalid');
  else reasons.push('no valid records');
  return { exitCode: EXIT_UNKNOWN, status: 'unknown', reasons };
}

module.exports = {
  RUN_ID_RE,
  EXIT_SUCCEEDED,
  EXIT_FAILED,
  EXIT_UNKNOWN,
  parseRecord,
  validateResultRecord,
  validateOutcomeRecord,
  classify,
};
