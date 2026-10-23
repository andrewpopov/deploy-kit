'use strict';

// BRAIN-636 D4b: the structured outcome of one deploy/rollback pipeline run. deployRelease and
// rollbackRelease return it on success and attach it to the error they throw on failure, so a caller
// (host-run's terminal.json) never has to infer an outcome from an error message.
//
// `effectsClean` is always null here: only D4d's effects ledger may say whether production was untouched.

const STATUSES = ['deployed', 'aborted-clean', 'failed-recovered', 'failed-unrecovered', 'failed'];
const RECOVERY_ACTIONS = ['none', 'quarantine', 'resume-previous', 'flip-back', 'restore+flip-back', 'remain-active', 'manual'];
const FIELDS = ['status', 'stage', 'liveBefore', 'liveAfter', 'migrated', 'migrationsPending', 'backupId', 'effectsClean', 'recovery', 'error'];

const MANUAL_RECOVERY_RE = /^MANUAL RECOVERY REQUIRED/;
const NO_RECOVERY = { action: 'none', verified: false };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringOrNull = (v) => v === null || typeof v === 'string';

// A release target `releases/<sha>-<timestamp>` -> its sha (as abbreviated in the id); null for anything else.
function shaOfTarget(target) {
  const match = typeof target === 'string' ? /^releases\/([0-9a-f]{7,40})-\d{8}T\d{6}Z$/.exec(target) : null;
  return match ? match[1] : null;
}

function base(facts) {
  return {
    stage: facts.stage ?? null,
    liveBefore: facts.liveBefore ?? null,
    liveAfter: facts.liveAfter ?? null,
    migrated: facts.migrated === true,
    migrationsPending: Number.isInteger(facts.migrationsPending) ? facts.migrationsPending : null,
    backupId: facts.backupId ?? null,
    effectsClean: null,
  };
}

function deployed(facts) {
  return { status: 'deployed', ...base(facts), recovery: { ...NO_RECOVERY }, error: null };
}

// A verified recovery is failed-recovered; a recovery that was attempted (or needs an operator) but is
// not verified is failed-unrecovered; nothing applicable to production (none, quarantine) is plain failed.
function failure(facts, recovery, error) {
  let status = 'failed';
  if (recovery.verified) status = 'failed-recovered';
  else if (!['none', 'quarantine'].includes(recovery.action)) status = 'failed-unrecovered';
  return { status, ...base(facts), recovery: { action: recovery.action, verified: recovery.verified === true }, error };
}

// The recovery an error carries wins; then the recovery recover() attempted; a MANUAL RECOVERY REQUIRED message with no
// recovery attempted (an interrupted-deploy journal, say) is action manual, failed-unrecovered. `facts.liveAfter` may be a function of the effective recovery.
function failureFromError(facts, recovery, error) {
  const message = error instanceof Error ? error.message : String(error);
  let effective = recovery;
  if (error && error.deployRecovery) effective = error.deployRecovery;
  else if (MANUAL_RECOVERY_RE.test(message) && ['none', 'quarantine'].includes(recovery.action)) effective = { action: 'manual', verified: false };
  const liveAfter = typeof facts.liveAfter === 'function' ? facts.liveAfter(effective) : facts.liveAfter;
  return failure({ ...facts, liveAfter }, effective, message);
}

function attach(error, deployResult) {
  if (error instanceof Error && !error.deployResult) error.deployResult = deployResult;
  return error;
}

// The DeployResult fields of a pipeline return value that also carries legacy fields (steps, healthy, ...).
function pickDeployResult(returned) {
  return Object.fromEntries(FIELDS.map((key) => [key, returned[key]]));
}

// -> a problem string, or null when `result` is a well-formed DeployResult.
function validateDeployResult(result) {
  if (!isPlainObject(result)) return 'result is not an object';
  if (!STATUSES.includes(result.status)) return `status ${JSON.stringify(result.status)} is not one of ${STATUSES.join(', ')}`;
  if (!isStringOrNull(result.stage)) return 'stage is not a string or null';
  if (!isStringOrNull(result.liveBefore)) return 'liveBefore is not a string or null';
  if (!isStringOrNull(result.liveAfter)) return 'liveAfter is not a string or null';
  if (typeof result.migrated !== 'boolean') return 'migrated is not a boolean';
  if (result.migrationsPending !== null && !Number.isInteger(result.migrationsPending)) return 'migrationsPending is not an integer or null';
  if (!isStringOrNull(result.backupId)) return 'backupId is not a string or null';
  if (result.effectsClean !== null && typeof result.effectsClean !== 'boolean') return 'effectsClean is not a boolean or null';
  if (!isPlainObject(result.recovery)) return 'recovery is not an object';
  if (!RECOVERY_ACTIONS.includes(result.recovery.action)) return `recovery.action ${JSON.stringify(result.recovery.action)} is not a recovery action`;
  if (typeof result.recovery.verified !== 'boolean') return 'recovery.verified is not a boolean';
  if (!isStringOrNull(result.error)) return 'error is not a string or null';
  return null;
}

module.exports = {
  STATUSES, RECOVERY_ACTIONS, NO_RECOVERY, shaOfTarget, deployed, failure, failureFromError, attach, pickDeployResult, validateDeployResult,
};
