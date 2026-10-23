'use strict';

// BRAIN-636 D4a: the HOST side of a controller-driven request (`host-run` whose meta.json carries a
// request). Order, fixed by plan §4.1 -- NOTHING before acceptance changes live state:
//   locks (until notAfter) -> bounded staging -> common gates (epoch, hold, deadline, reservation)
//   -> kind gates -> preDeployChecks -> acceptance (accepted.json, then the reservation) -> pipeline
//   -> terminal.json. Every refusal writes refused.json BEFORE the locks are released and exits 1.
//
// accepted.json, terminal.json and refused.json are immutable: created by link() of a synced temp file,
// then the directory is synced. The reservation (requests/<id>.json) is replaced by rename under both
// locks only; its table of cases is plan §4.2. A failure after a possible live effect writes the app's
// unresolved.json (before terminal.json), which blocks every later request for the app until
// `deploy-kit resolve` clears it (plan "Amendments from vet round 4", B).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { acquireOwnedLocks, releaseOwnedLocks } = require('../lock');
const { runOnTarget } = require('../exec');
const {
  NO_RECOVERY, deployed, failureFromError, pickDeployResult,
} = require('../deploy-result');
const { releasePaths } = require('../release');
const {
  stateFiles, classifyHold, classifyEpoch, classifyJournal,
} = require('../target-state');
const { readRecord, validateReservation, validateTerminal } = require('./status');

// Thrown by the crash seam in tests so a "killed" run skips its cleanup, like a real SIGKILL.
class CrashSeam extends Error {}

class Refusal extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'Refusal';
    this.code = code;
  }
}

const defaultCrash = () => process.kill(process.pid, 'SIGKILL');

// ---- records ---------------------------------------------------------------------------------

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeSynced(file, text) {
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Immutable: link() fails with EEXIST when the record is already there.
function createRecord(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeSynced(tmp, `${JSON.stringify(data)}\n`);
  try { fs.linkSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  fsyncDir(path.dirname(file));
}

function replaceRecord(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeSynced(tmp, `${JSON.stringify(data)}\n`);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function targetFiles(config, home) {
  return Object.fromEntries(Object.entries(stateFiles(config)).map(([key, value]) => [key, value.replace('$HOME', home)]));
}

// ---- default git and check seams (tests inject fakes) ----------------------------------------------

const GIT_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

const defaultGit = {
  // Objects only: FETCH_HEAD is the one file this writes. No release dir, shared path, pm2 or pointer.
  stage: ({ repoGit, remote, sha, timeoutMs }) => execFileSync(
    'git', ['--git-dir', repoGit, 'fetch', '--no-tags', remote, sha], { ...GIT_OPTIONS, timeout: timeoutMs, killSignal: 'SIGKILL' },
  ),
  // null when nothing is deployed yet (no `current` link); throws when the link exists but cannot be read.
  readLive: (paths) => {
    if (!fs.lstatSync(paths.currentLink, { throwIfNoEntry: false })) return null;
    return execFileSync('git', ['-C', paths.currentLink, 'rev-parse', 'HEAD'], GIT_OPTIONS).trim();
  },
  isAncestor: (paths, ancestor, sha) => {
    try {
      execFileSync('git', ['--git-dir', paths.repoGit, 'merge-base', '--is-ancestor', ancestor, sha], GIT_OPTIONS);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  },
};

function writeRefused(runDir, runId, code) {
  createRecord(path.join(runDir, 'refused.json'), { runId, code });
}

// ---- steps -----------------------------------------------------------------------------------------

function takeLocks({ config, request, runId, nowSec, deps }) {
  const acquire = deps.acquireOwnedLocks || acquireOwnedLocks;
  try {
    return acquire(config, { runtime: deps.runtime }, {
      notAfter: request.notAfter,
      runId,
      purpose: request.kind,
      kind: 'unit',
      now: nowSec,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
  } catch (error) {
    if (error.code === 'late') throw new Refusal('late', error.message);
    if (error.code === 'held') throw new Refusal('lock-held', error.message);
    throw new Refusal('lock-error', error.message);
  }
}

function stageObjects({ config, request, paths, nowSec, git }) {
  const remainingMs = (request.notAfter - nowSec()) * 1000;
  if (remainingMs <= 0) throw new Refusal('late', 'notAfter passed before staging');
  const timeoutMs = Math.min(config.stepTimeoutSeconds * 1000, remainingMs);
  try {
    git.stage({ repoGit: paths.repoGit, remote: config.remote, sha: request.sha, timeoutMs });
  } catch (error) {
    throw new Refusal('staging-failed', error.message);
  }
}

// -> true when a run other than this one was accepted for the request (meta.json names it, accepted.json exists).
function acceptedRunExists(files, requestId, runId) {
  const entries = fs.existsSync(files.runs) ? fs.readdirSync(files.runs) : [];
  return entries.some((name) => {
    if (name === runId || !fs.existsSync(path.join(files.runs, name, 'accepted.json'))) return false;
    const raw = readIfPresent(path.join(files.runs, name, 'meta.json'));
    if (raw === null) return false;
    try {
      return JSON.parse(raw).requestId === requestId;
    } catch {
      return true; // an accepted run whose meta cannot be read might be this request: fail closed
    }
  });
}

// Plan §4.2. -> { gen, prev } the acceptance will write.
function checkReservation({ files, request, runId }) {
  const reservation = readRecord(readIfPresent(path.join(files.requests, `${request.requestId}.json`)), validateReservation, request.requestId);
  const expect = request.expectReservation;
  if (reservation.state === 'corrupt') throw new Refusal('reservation-corrupt', reservation.problem);
  if (reservation.state === 'absent') {
    if (expect.state !== 'none') throw new Refusal('reservation-missing', `the controller expected ${expect.state} but there is no reservation`);
    if (acceptedRunExists(files, request.requestId, runId)) throw new Refusal('reservation-missing', 'a run was accepted for this request but its reservation is gone');
    return { gen: 1, prev: null };
  }
  const held = reservation.value;
  if (held.state === 'cancelled') throw new Refusal('request-cancelled', `gen ${held.gen}`);
  const terminal = readRecord(readIfPresent(path.join(files.runs, held.runId, 'terminal.json')), validateTerminal, held.runId);
  if (terminal.state === 'absent') throw new Refusal('request-taken', `run ${held.runId} has no terminal.json`);
  if (terminal.state === 'corrupt') throw new Refusal('terminal-corrupt', `run ${held.runId}: ${terminal.problem}`);
  const { result } = terminal.value;
  if (result.status !== 'aborted-clean' || result.effectsClean !== true) throw new Refusal('request-executed', `run ${held.runId} ended ${result.status}`);
  const matches = expect.state === 'clean-abort' && expect.runId === held.runId && expect.gen === held.gen;
  if (!matches) throw new Refusal('reservation-missing', `run ${held.runId} (gen ${held.gen}) aborted clean but the controller expected ${JSON.stringify(expect)}`);
  return { gen: held.gen + 1, prev: { runId: held.runId, gen: held.gen } };
}

function checkUnresolved(files) {
  if (fs.existsSync(files.unresolved)) {
    throw new Refusal('app-unresolved', `${files.unresolved} exists: an earlier request may have changed production; run deploy-kit resolve`);
  }
}

// The journal gate of every kind (plan §4.1 table), then the forward-only check for a deploy.
function checkKind({ request, paths, git }) {
  const journal = classifyJournal(readIfPresent(paths.stateFile));
  if (journal.class === 'corrupt') throw new Refusal('journal-corrupt', journal.problem);
  if (request.kind === 'recover') {
    if (journal.class !== 'interrupted') throw new Refusal('nothing-to-recover', `journal is ${journal.class}`);
    // TODO(D8): journal.releaseId must equal the parent run's release, then run recoverRelease().
    throw new Refusal('kind-unsupported', 'recover has no pipeline entry yet');
  }
  if (journal.class === 'interrupted') throw new Refusal('recovery-pending', `journal phase ${journal.phase}`);
  if (request.kind === 'rollback') {
    // TODO(D6): previous sha == --to, current release migrated:false, then rollbackRelease().
    throw new Refusal('kind-unsupported', 'rollback has no pipeline entry yet');
  }
  let live;
  try {
    live = git.readLive(paths);
  } catch (error) {
    throw new Refusal('live-unreadable', error.message);
  }
  if (live === null) return null;
  if (live === request.sha) throw new Refusal('already-live', live);
  let forward;
  try {
    forward = git.isAncestor(paths, live, request.sha);
  } catch (error) {
    throw new Refusal('ancestry-unreadable', error.message);
  }
  if (!forward) throw new Refusal('not-forward', `live ${live} is not an ancestor of ${request.sha}`);
  return live;
}

function checkGates({ files, request, runId, paths, nowSec, deps }) {
  const git = deps.git || defaultGit;
  const epoch = readIfPresent(files.epoch);
  if (epoch !== null) {
    const parsed = classifyEpoch(epoch);
    if (parsed.problem || parsed.value !== request.epoch) {
      throw new Refusal('epoch-mismatch', `target ${parsed.problem || parsed.value}, request ${request.epoch}`);
    }
  }
  const hold = classifyHold(readIfPresent(files.hold), deps.now());
  if (hold && (hold.corrupt || !hold.expired)) throw new Refusal('hold', hold.corrupt ? hold.problem : hold.reason);
  if (nowSec() >= request.notAfter) throw new Refusal('late', `notAfter ${request.notAfter}`);
  const plan = checkReservation({ files, request, runId });
  checkUnresolved(files);
  const liveBefore = checkKind({ request, paths, git });
  return { plan, liveBefore };
}

function runPreDeployChecks({ config, paths, deps }) {
  const run = deps.runCheck || ((command) => runOnTarget(command, { ...config, projectDir: paths.root }, {
    capture: true, runtime: deps.runtime, timeoutSeconds: config.stepTimeoutSeconds,
  }));
  for (const check of config.preDeployChecks || []) {
    if (!run(check.command).ok) throw new Refusal('pre-check-failed', check.name);
  }
}

// accepted.json first, then the reservation (plan §4.1 step 7); both under the held locks.
function accept({ files, runDir, runId, request, plan, liveBefore, deps, crashAt, onAccepted }) {
  const at = deps.now().toISOString();
  createRecord(path.join(runDir, 'accepted.json'), {
    runId, requestId: request.requestId, kind: request.kind, sha: request.sha, epoch: request.epoch, gen: plan.gen, acceptedAt: at,
  });
  onAccepted();
  crashAt('in-reservation-rename');
  fs.mkdirSync(files.requests, { recursive: true, mode: 0o700 });
  replaceRecord(path.join(files.requests, `${request.requestId}.json`), {
    requestId: request.requestId, gen: plan.gen, state: 'accepted', runId, at, liveBefore, prev: plan.prev,
  });
}

// The pipeline's DeployResult (src/deploy-result.js): the fields of what deployRelease returned, or the one
// attached to what it threw. A pipeline that returns nothing usable is a plain success; a throw without a
// result (a bug, or a failure before the pipeline's own try) is a bare `failed`.
function resultOf(returned, thrown) {
  if (thrown !== undefined) return thrown.deployResult || failureFromError({}, NO_RECOVERY, thrown);
  if (returned !== null && typeof returned === 'object' && typeof returned.status === 'string') return pickDeployResult(returned);
  return deployed({});
}

// Success, a verified clean abort and a verified recovery settle themselves; anything else may have changed production.
function needsResolution(result) {
  if (result.status === 'deployed') return false;
  if (result.status === 'aborted-clean') return result.effectsClean !== true;
  if (result.status === 'failed-recovered') return !(result.recovery && result.recovery.verified === true);
  return true;
}

function execute({ files, runDir, runId, request, config, options, handle, deps, crashAt }) {
  let result;
  try {
    const ctx = { ownedLocks: handle, recoverInterrupted: 'refuse', ...(deps.runtime ? { runtime: deps.runtime } : {}) };
    result = resultOf(deps.deployRelease(config, options, ctx));
  } catch (error) {
    deps.log.error(error instanceof Error ? error.message : String(error));
    result = resultOf(undefined, error);
  }
  crashAt('after-release-result');
  const finishedAt = deps.now().toISOString();
  if (needsResolution(result)) {
    replaceRecord(files.unresolved, {
      requestId: request.requestId, runId, kind: request.kind, status: result.status, error: result.error, at: finishedAt,
    });
  }
  createRecord(path.join(runDir, 'terminal.json'), {
    runId, kind: request.kind, result, effects: null, kitArtifact: request.kitArtifact, finishedAt,
  });
  const ok = result.status === 'deployed';
  replaceRecord(path.join(runDir, 'outcome.json'), { runId, ok, ...(result.error ? { error: result.error } : {}), finishedAt });
  return ok ? 0 : 1;
}

// -> the process exit code. `deps` carries host-run's seams plus: crash, sleep, runtime, git, runCheck, acquireOwnedLocks.
function runAccepted({ runDir, runId, request, config, options, deps }) {
  const files = targetFiles(config, deps.env.HOME);
  const paths = releasePaths(config);
  const nowSec = () => deps.now().getTime() / 1000;
  const crash = deps.crash || defaultCrash;
  const crashAt = (point) => { if (deps.env.DEPLOY_KIT_TEST_CRASH_AT === point) crash(point); };
  let handle = null;
  let accepted = false;
  let crashed = false;
  try {
    handle = takeLocks({ config, request, runId, nowSec, deps });
    crashAt('after-lock');
    stageObjects({ config, request, paths, nowSec, git: deps.git || defaultGit });
    crashAt('after-staging');
    const { plan, liveBefore } = checkGates({ files, request, runId, paths, nowSec, deps });
    if (request.kind === 'deploy') runPreDeployChecks({ config, paths, deps });
    crashAt('after-gate');
    // From accepted.json on, a bookkeeping failure is never dressed as a refusal.
    accept({
      files, runDir, runId, request, plan, liveBefore, deps, crashAt, onAccepted: () => { accepted = true; },
    });
    crashAt('after-accept');
    return execute({ files, runDir, runId, request, config, options, handle, deps, crashAt });
  } catch (error) {
    if (error instanceof CrashSeam) crashed = true;
    if (crashed || accepted) throw error;
    const refusal = error instanceof Refusal ? error : new Refusal('gate-error', error instanceof Error ? error.message : String(error));
    writeRefused(runDir, runId, refusal.code); // before the locks go
    deps.log.error(refusal.message);
    return 1;
  } finally {
    if (handle && !crashed) releaseOwnedLocks(handle);
  }
}

module.exports = {
  runAccepted, writeRefused, targetFiles, CrashSeam, Refusal, resultOf, needsResolution,
};
