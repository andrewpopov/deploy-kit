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
// `deploy-kit resolve` clears it (plan "Amendments from vet round 4", B). A run killed before that point leaves no
// terminal.json and no unresolved.json, so acceptance also writes an in-flight marker (<lock id>.inflight.json) that only
// a terminal result which needs no resolution removes; admission turns a stranded one into the unresolved marker.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { acquireOwnedLocks, releaseOwnedLocks } = require('../lock');
const { runOnTarget } = require('../exec');
const {
  NO_RECOVERY, deployed, failureFromError, pickDeployResult, needsResolution,
} = require('../deploy-result');
const { releasePaths, RELEASE_RECORD } = require('../release');
const { stepClass } = require('../effects');
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

// BRAIN-636 D4d: the effects ledger. One JSON line per step, fsynced BEFORE the step runs, so a crash
// mid-step still shows what was about to happen. `entries` collects the same lines for terminal.json.
function openLedger(file) {
  const fd = fs.openSync(file, 'a', 0o600);
  const entries = [];
  return {
    entries,
    record: ({ step, class: stepClass }) => {
      const entry = { step, class: stepClass };
      entries.push(entry);
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    },
    close: () => fs.closeSync(fd),
  };
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
  // The actual commit of a release directory (never inferred from its name).
  readReleaseSha: (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], GIT_OPTIONS).trim(),
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

// -> the target of a release pointer (`releases/<id>`), or null when it is absent.
function readPointer(link) {
  try {
    return fs.readlinkSync(link);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return null;
    throw error;
  }
}

// Plan section 4.1, `rollback`: `previous` must be the release the request names, and the release being left
// (`current`) must never have migrated. A release record that is missing, unreadable or says anything but
// `migrated: false` counts as migrated: the refusal fails closed (the record is written by deployRelease).
function checkRollback({ request, paths, git }) {
  const target = (link) => {
    const pointer = readPointer(link);
    return pointer === null ? null : path.join(paths.root, pointer);
  };
  const previousDir = target(paths.previousLink);
  if (previousDir === null) throw new Refusal('rollback-target-mismatch', 'no previous release is recorded');
  let previousSha;
  try {
    previousSha = git.readReleaseSha(previousDir);
  } catch (error) {
    throw new Refusal('rollback-target-mismatch', `previous release unreadable: ${error.message}`);
  }
  if (previousSha !== request.rollbackTo) throw new Refusal('rollback-target-mismatch', `previous is ${previousSha}, the request names ${request.rollbackTo}`);
  const currentDir = target(paths.currentLink);
  if (currentDir === null) throw new Refusal('live-unreadable', 'no current release');
  let migrated = true;
  let why = 'no release record';
  const raw = readIfPresent(path.join(currentDir, RELEASE_RECORD));
  if (raw !== null) {
    try {
      migrated = JSON.parse(raw).migrated !== false;
      why = 'the current release migrated';
    } catch {
      why = 'unreadable release record';
    }
  }
  if (migrated) throw new Refusal('rollback-across-migration', `${why}; a manual rollback would run the previous code against a migrated schema`);
}

function stageObjects({ config, request, paths, nowSec, git, ledger }) {
  const remainingMs = (request.notAfter - nowSec()) * 1000;
  if (remainingMs <= 0) throw new Refusal('late', 'notAfter passed before staging');
  const timeoutMs = Math.min(config.stepTimeoutSeconds * 1000, remainingMs);
  ledger.record({ step: 'staging-fetch', class: stepClass({}, 'staging-fetch') });
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

// -> the parsed unresolved marker, or null when it is absent or unreadable.
function readUnresolved(files) {
  try {
    const marker = JSON.parse(fs.readFileSync(files.unresolved, 'utf8'));
    return marker !== null && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
  } catch {
    return null;
  }
}

function readInflight(files) {
  const raw = readIfPresent(files.inflight);
  if (raw === null) return null;
  try {
    const marker = JSON.parse(raw);
    return marker !== null && typeof marker === 'object' && typeof marker.runId === 'string' && typeof marker.requestId === 'string' ? marker : undefined;
  } catch {
    return undefined;
  }
}

// An in-flight marker whose run never wrote a valid terminal.json belongs to a run that was killed (or lost) after
// acceptance: production may have changed. It becomes the unresolved marker, which `deploy-kit resolve` and a
// recover for that run already know how to settle. A run that did finish just left the marker behind: it is dropped.
// A marker that cannot be read is left alone and blocks (checkUnresolved).
function settleInflight(files, deps) {
  const inflight = readInflight(files);
  if (inflight === null || inflight === undefined) return;
  const terminal = readRecord(readIfPresent(path.join(files.runs, inflight.runId, 'terminal.json')), validateTerminal, inflight.runId);
  if (terminal.state === 'valid') {
    fs.rmSync(files.inflight, { force: true });
    return;
  }
  if (!fs.existsSync(files.unresolved)) {
    replaceRecord(files.unresolved, {
      requestId: inflight.requestId, runId: inflight.runId, kind: inflight.kind, status: 'unknown',
      error: 'the run was accepted but never wrote a terminal.json (killed or lost mid-run)', at: deps.now().toISOString(),
    });
  }
  fs.rmSync(files.inflight, { force: true });
}

// A recover is how an unresolved app gets settled, so the marker does not block the one recover whose parent
// is the run that left it. Any other request, and a marker that cannot be read, still refuse.
function checkUnresolved(files, request, deps) {
  if (fs.existsSync(files.inflight) && readInflight(files) === undefined) {
    throw new Refusal('app-unresolved', `${files.inflight} is unreadable: an earlier run may have changed production; run deploy-kit resolve`);
  }
  settleInflight(files, deps);
  if (!fs.existsSync(files.unresolved)) return;
  const marker = readUnresolved(files);
  if (request.kind === 'recover' && marker !== null && marker.runId === request.parentRunId) return;
  throw new Refusal('app-unresolved', `${files.unresolved} exists: an earlier request may have changed production; run deploy-kit resolve`);
}

// The release a parent run created, as the run itself recorded it (release.json, written by the pipeline before it touched
// the release). Never inferred from a sha: two attempts at one sha create different releases.
function parentRelease(files, parentRunId) {
  const raw = readIfPresent(path.join(files.runs, parentRunId, 'release.json'));
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw);
    return record !== null && typeof record === 'object' && record.runId === parentRunId && typeof record.releaseId === 'string' ? record.releaseId : null;
  } catch {
    return null;
  }
}

function checkRecover({ request, journal, files }) {
  if (journal.class !== 'interrupted') throw new Refusal('nothing-to-recover', `journal is ${journal.class}`);
  const releaseId = parentRelease(files, request.parentRunId);
  if (releaseId === null) throw new Refusal('recover-parent-unknown', `parent run ${request.parentRunId} has no readable release.json`);
  if (journal.releaseId !== releaseId) {
    throw new Refusal('recover-parent-mismatch', `journal release ${journal.releaseId} is not release ${releaseId}, the one parent run ${request.parentRunId} created`);
  }
}

// The journal gate of every kind (plan §4.1 table), then the forward-only check for a deploy.
function checkKind({ request, paths, git, files }) {
  const journal = classifyJournal(readIfPresent(paths.stateFile));
  if (journal.class === 'corrupt') throw new Refusal('journal-corrupt', journal.problem);
  if (request.kind === 'recover') {
    checkRecover({ request, journal, files });
    return readLiveOrNull(git, paths);
  }
  if (journal.class === 'interrupted') throw new Refusal('recovery-pending', `journal phase ${journal.phase}`);
  if (request.kind === 'rollback') checkRollback({ request, paths, git });
  let live;
  try {
    live = git.readLive(paths);
  } catch (error) {
    throw new Refusal('live-unreadable', error.message);
  }
  if (request.kind === 'rollback') return live;
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

function assertBeforeDeadline(request, nowSec) {
  if (nowSec() >= request.notAfter) throw new Refusal('late', `notAfter ${request.notAfter}`);
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
  assertBeforeDeadline(request, nowSec);
  const plan = checkReservation({ files, request, runId });
  checkUnresolved(files, request, deps);
  const liveBefore = checkKind({ request, paths, git, files });
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
  // From here the pipeline may change production: nothing but a terminal result that needs no resolution clears this.
  replaceRecord(files.inflight, { requestId: request.requestId, runId, kind: request.kind, at });
}

// The pipeline's DeployResult (src/deploy-result.js): the fields of what deployRelease returned, or the one
// attached to what it threw. A pipeline that returns nothing usable is a plain success; a throw without a
// result (a bug, or a failure before the pipeline's own try) is a bare `failed`.
function resultOf(returned, thrown) {
  if (thrown !== undefined) return thrown.deployResult || failureFromError({}, NO_RECOVERY, thrown);
  if (returned !== null && typeof returned === 'object' && typeof returned.status === 'string') return pickDeployResult(returned);
  return deployed({});
}

// A recover succeeds when the recovery it ran is verified; every other kind succeeds only by deploying.
function succeeded(kind, result) {
  if (kind === 'recover') return result.status === 'failed-recovered' && result.recovery.verified === true;
  return result.status === 'deployed';
}

function readLiveOrNull(git, paths) {
  try {
    return git.readLive(paths);
  } catch {
    return null;
  }
}

// A verified recovery of the parent run settles that run's unresolved marker: archived next to a resolution record,
// like `deploy-kit resolve` does, and only when the marker names the parent.
function clearSettledMarker({ files, runId, request, finishedAt }) {
  const marker = readUnresolved(files);
  if (marker === null || marker.runId !== request.parentRunId || typeof marker.requestId !== 'string') return;
  const archive = path.join(files.resolved, `${finishedAt.replace(/[:.]/g, '')}-${marker.requestId}`);
  fs.mkdirSync(files.resolved, { recursive: true, mode: 0o700 });
  createRecord(`${archive}.resolution.json`, {
    requestId: marker.requestId, reason: `recovered by run ${runId} (request ${request.requestId})`, at: finishedAt,
  });
  fs.renameSync(files.unresolved, `${archive}.unresolved.json`);
  fsyncDir(files.resolved);
}

function execute({
  files, runDir, runId, request, config, options, handle, deps, crashAt, ledger, liveBefore, paths,
}) {
  let result;
  try {
    const ctx = {
      ownedLocks: handle,
      recoverInterrupted: 'refuse',
      onStep: ledger.record,
      onRelease: ({ releaseId, sha }) => createRecord(path.join(runDir, 'release.json'), { runId, requestId: request.requestId, releaseId, sha }),
      notAfter: request.notAfter,
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
    };
    const pipeline = { deploy: deps.deployRelease, rollback: deps.rollbackRelease, recover: deps.recoverRelease }[request.kind];
    result = resultOf(pipeline(config, options, ctx));
  } catch (error) {
    deps.log.error(error instanceof Error ? error.message : String(error));
    result = resultOf(undefined, error);
  }
  crashAt('after-release-result');
  // The full 40-hex shas, read here rather than taken from the pipeline's release-id prefixes.
  result = { ...result, liveBefore, liveAfter: readLiveOrNull(deps.git || defaultGit, paths) };
  const finishedAt = deps.now().toISOString();
  // A failed recover leaves the marker it was dispatched to settle exactly as it is: rewriting it would name this run
  // and lock out a retry whose parent is the original one.
  const ok = succeeded(request.kind, result);
  if (needsResolution(result) && !(request.kind === 'recover' && fs.existsSync(files.unresolved))) {
    replaceRecord(files.unresolved, {
      requestId: request.requestId, runId, kind: request.kind, status: result.status, error: result.error, at: finishedAt,
    });
  }
  createRecord(path.join(runDir, 'terminal.json'), {
    runId, kind: request.kind, result, effects: ledger.entries, kitArtifact: request.kitArtifact, finishedAt,
  });
  // terminal.json is on disk, so the in-flight marker has done its job: a result that needs resolution already
  // became (or, for a failed recover, kept) the unresolved marker above, and any other needs no marker at all.
  fs.rmSync(files.inflight, { force: true });
  if (request.kind === 'recover' && ok) clearSettledMarker({ files, runId, request, finishedAt });
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
  let ledger = null;
  let accepted = false;
  let crashed = false;
  try {
    handle = takeLocks({ config, request, runId, nowSec, deps });
    crashAt('after-lock');
    fs.mkdirSync(runDir, { recursive: true });
    ledger = openLedger(path.join(runDir, 'effects.jsonl'));
    // A rollback and a recover fetch nothing: their target is a release already on the host.
    if (request.kind === 'deploy') stageObjects({ config, request, paths, nowSec, git: deps.git || defaultGit, ledger });
    crashAt('after-staging');
    const { plan, liveBefore } = checkGates({ files, request, runId, paths, nowSec, deps });
    if (request.kind === 'deploy') runPreDeployChecks({ config, paths, deps });
    crashAt('after-gate');
    assertBeforeDeadline(request, nowSec); // the checks above may have outlived notAfter (plan §4.1 step 5)
    // From accepted.json on, a bookkeeping failure is never dressed as a refusal.
    accept({
      files, runDir, runId, request, plan, liveBefore, deps, crashAt, onAccepted: () => { accepted = true; },
    });
    crashAt('after-accept');
    return execute({
      files, runDir, runId, request, config, options, handle, deps, crashAt, ledger, liveBefore, paths,
    });
  } catch (error) {
    if (error instanceof CrashSeam) crashed = true;
    if (crashed || accepted) throw error;
    const refusal = error instanceof Refusal ? error : new Refusal('gate-error', error instanceof Error ? error.message : String(error));
    writeRefused(runDir, runId, refusal.code); // before the locks go
    deps.log.error(refusal.message);
    return 1;
  } finally {
    if (ledger) ledger.close();
    if (handle && !crashed) releaseOwnedLocks(handle);
  }
}

module.exports = {
  runAccepted, writeRefused, targetFiles, CrashSeam, Refusal, resultOf, needsResolution, succeeded,
};
