'use strict';

// Target-state operations (BRAIN-636 D3): the holds, the epoch fence and `request cancel` that the
// deploy controller writes on the host, plus a read-only look at everything it decides on.
//
// Every MUTATING command is ONE remote shell script run as a single process under `setsid`, which
// takes the app lock as owner `kind: session` through the D1a protocol (guard flock, owner record
// with its own pid and sid), fails fast with `refused lock-held` instead of waiting for a running
// deploy, does its work with builtins plus the coreutils a file write needs, and releases the lock
// nonce-matched under the guard. It runs no hook and nothing detached: a lock owner whose descendants
// cannot create another session is what lets a breaker prove the owner gone by its sid.
// The one exception is `request cancel`, which must parse and validate the reservation, the holder's
// terminal.json and the accepted-run metadata with the same validators the status reader uses (status.js,
// deploy-result.js). It runs `node` ONCE, synchronously, by the absolute path `command -v node` +
// `readlink -f` resolve (as on-host/operator.js does), and waits for it inside the critical section. That
// keeps Amendment A's single-session guarantee: the child is not detached, starts no session and exits
// before the lock is released, so the owner's sid still names exactly the owner (plus that waited-for
// child while it validates) and nothing after release. A non-zero exit or an unusable verdict is
// `not-cancellable corrupt`; unreadable accepted-run metadata fails closed the same way. The validators
// are carried inside the node program itself (see validatorSource), so nothing is looked up on the target.
// The reservation shape this reads and writes is on-host/status.js's validateReservation.
// Nothing else may write these files.

const fs = require('fs');
const path = require('path');
const { runOnTarget, shQuote } = require('./exec');
const {
  lockDir, lockId, guardFile, ensureStateDir, guardPrelude, ownerWriter, ownerFields, hostLockDir,
} = require('./lock');
const { isReleaseLayout, releasePaths } = require('./release');
const { parseFramedReply } = require('./on-host/attach');
const { isPlainObject, parseRecord } = require('./on-host/outcome');
const { readRecord, validateReservation } = require('./on-host/status');


const REMOTE_CALL_TIMEOUT_SECONDS = 30;
const BASE_FRAMES = ['hold', 'lastEpoch', 'liveSha', 'appLock', 'appOwner'];
const REQUEST_ID_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_EPOCH_DIGITS = 15;

// Exit codes of the session scripts. 1 is the lock-held refusal of the acquire step.
const EXIT_LOCK_HELD = 1;
const EXIT_REFUSED = 3;

// Journal phases that no longer need recovery. Everything else a journal can hold (stopped, migrated,
// flipped, post-deploy-failed, post-deploy-rollback, post-deploy-rollback-failed, the forward-recovery
// and manual-rollback phases, ...) is an interrupted operation; see readInterruptedDeploy in release.js.
const TERMINAL_JOURNAL_PHASES = new Set([
  'done', 'recovered', 'post-deploy-rolled-back', 'post-deploy-degraded', 'post-deploy-manual-decision',
]);

function stateFiles(config) {
  const base = path.posix.dirname(lockDir(config));
  return {
    base,
    hold: `${base}/deploy-kit-${lockId(config)}.hold.json`,
    epoch: `${base}/.last-epoch`,
    unresolved: `${base}/deploy-kit-${lockId(config)}.unresolved.json`,
    inflight: `${base}/deploy-kit-${lockId(config)}.inflight.json`,
    resolved: `${base}/resolved`,
    requests: `${base}/requests`,
    runs: `${base}/runs`,
  };
}

// ---- mutating commands: one script, one process, one lock ----------------------------------------

// The lock protocol around `body` (a shell function body that returns the command's exit status and
// must never `exit`, so the release below always runs). `pauseFifo` is a test seam only: it stops the
// script inside the critical section on a shell builtin so a test can look at the process tree.
function sessionScript(config, { purpose, body, pauseFifo }) {
  const owned = { ...config, onHost: { ...config.onHost, required: true } }; // always refuse without flock
  const dir = lockDir(config);
  const guard = guardFile(config);
  const prelude = guardPrelude(owned, guard);
  const pause = pauseFifo
    ? [`: > ${shQuote(`${pauseFifo}.ready`)}`, `read _ < ${shQuote(pauseFifo)}`]
    : [];
  return [
    'unset INVOCATION_ID', // the owner is this session, whatever launched it
    ensureStateDir(config),
    'held=',
    'release() {',
    '  [ -n "$held" ] || return 0',
    '  held=',
    prelude,
    `  [ "$(cat "${dir}/nonce" 2>/dev/null)" = "$nonce" ] && rm -rf "${dir}"`,
    '  exec 9>&-',
    '}',
    "trap 'rc=$?; release; exit $rc' EXIT",
    "trap 'exit 143' HUP INT TERM",
    prelude,
    `if mkdir -m 700 "${dir}" 2>/dev/null; then`,
    '  held=1',
    ownerWriter(dir, ownerFields({ kind: 'session', purpose })),
    'else',
    `  echo "deploy-kit: refused lock-held at ${dir}"`,
    `  echo "owner: $(cat "${dir}/owner" 2>/dev/null || echo 'null (no owner record)')"`,
    `  exit ${EXIT_LOCK_HELD}`,
    'fi',
    'exec 9>&-',
    ...pause,
    'run_body() {',
    body,
    '}',
    'run_body',
    'exit $?',
  ].join('\n');
}

// Under setsid when the target has it (-w: wait, so the exit status is the script's), so the owner's sid
// is its own pid and the whole lock session is one process.
function wrapSession(script) {
  return [
    `s=${shQuote(script)}`,
    'if command -v setsid >/dev/null 2>&1; then exec setsid -w sh -c "$s"; fi',
    'exec sh -c "$s"',
  ].join('\n');
}

// -> { outcome: 'ok' | 'refused' | 'lock-held', message }. Anything else (transport, a script that did
// not reach a verdict) throws: it must never read as a refusal.
function runSession(config, runtime, script) {
  const res = runOnTarget(wrapSession(script), { ...config, projectDir: undefined }, {
    capture: true, runtime, timeoutSeconds: REMOTE_CALL_TIMEOUT_SECONDS,
  });
  const message = (res.output || '').trim();
  if (res.ok) return { outcome: 'ok', message };
  const status = res.error && res.error.status;
  if (status === EXIT_LOCK_HELD) return { outcome: 'lock-held', message };
  if (status === EXIT_REFUSED) return { outcome: 'refused', message };
  const detail = (res.stderr || (res.error && res.error.message) || 'unknown error').trim();
  throw new Error(`deploy-kit: the target-state script did not reach a verdict (exit ${status}): ${detail}`);
}

// Temp file in the destination directory, synced when the target can, renamed over the old file.
const atomicWrite = (file, printfArgs) => [
  `  tmp="${file}.tmp.$$"`,
  `  printf ${printfArgs} > "$tmp" || return 2`,
  '  if command -v sync >/dev/null 2>&1; then sync "$tmp" 2>/dev/null; fi',
  `  mv "$tmp" "${file}" || return 2`,
].join('\n');

function holdRecordPrefix({ reason, until, at }) {
  return JSON.stringify({ reason, until, at, epoch: 0 }).replace(/0\}$/, '');
}

function setHold(config, { reason, until = null, now = new Date(), runtime, pauseFifo } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error('deploy-kit: hold set needs a non-empty --reason');
  if (until !== null && !Number.isFinite(Date.parse(until))) throw new Error(`deploy-kit: --until ${JSON.stringify(until)} is not an ISO timestamp`);
  const files = stateFiles(config);
  const body = [
    `  epoch=$(cat "${files.epoch}" 2>/dev/null)`,
    '  case "$epoch" in "") epoch=null ;; *[!0-9]*) epoch=null ;; esac',
    atomicWrite(files.hold, `'%s%s}\\n' ${shQuote(holdRecordPrefix({ reason, until, at: now.toISOString() }))} "$epoch"`),
    '  echo "hold set"',
  ].join('\n');
  return runSession(config, runtime, sessionScript(config, { purpose: 'hold-set', body, pauseFifo }));
}

function clearHold(config, { runtime, pauseFifo } = {}) {
  const body = `  rm -f "${stateFiles(config).hold}" || return 2\n  echo "hold cleared"`;
  return runSession(config, runtime, sessionScript(config, { purpose: 'hold-clear', body, pauseFifo }));
}

function setEpoch(config, value, { runtime, pauseFifo } = {}) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > MAX_EPOCH_DIGITS) {
    throw new Error(`deploy-kit: epoch ${JSON.stringify(text)} is not a non-negative integer of at most ${MAX_EPOCH_DIGITS} digits`);
  }
  const file = stateFiles(config).epoch;
  const body = [
    `  cur=$(cat "${file}" 2>/dev/null)`,
    `  if [ -e "${file}" ]; then`,
    `    case "$cur" in ""|*[!0-9]*) echo "refused epoch-corrupt"; return ${EXIT_REFUSED} ;; esac`,
    `    if [ "\${#cur}" -gt ${MAX_EPOCH_DIGITS} ]; then echo "refused epoch-corrupt"; return ${EXIT_REFUSED}; fi`,
    `    if [ ${text} -lt "$cur" ]; then echo "refused epoch-lower current=$cur requested=${text}"; return ${EXIT_REFUSED}; fi`,
    `    if [ ${text} -eq "$cur" ]; then echo "epoch unchanged ${text}"; return 0; fi`,
    '  fi',
    atomicWrite(file, `'%s\\n' ${text}`),
    `  echo "epoch set ${text}"`,
  ].join('\n');
  return runSession(config, runtime, sessionScript(config, { purpose: 'epoch-set', body, pauseFifo }));
}

// The validator the locked cancel script runs once, synchronously, as `node -e`. It parses and
// validates the reservation, the holder's terminal.json and the accepted-run metadata with the SAME
// validators the status reader uses (status.js validateReservation/validateTerminal, which use
// deploy-result.js validateDeployResult), and prints ONE verdict line: `<verdict> [a [b...]]`.
// Anything it cannot read or parse throws, so the process exits non-zero and the script fails closed.
const VALIDATOR_BODY = String.raw`
const fs = require('fs');
const path = require('path');
const { readRecord, validateReservation, validateTerminal, parseRecord, isPlainObject, REQUEST_ID_RE } = loadValidators();
const { DK_RID: rid, DK_RF: reservationFile, DK_RUNS: runsDir } = process.env;
const readOptional = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const oneLine = (text) => String(text).replace(/\s+/g, ' ');
const say = (...words) => { process.stdout.write(words.join(' ') + '\n'); };

function acceptedRunNamingRequest() {
  let names;
  try { names = fs.readdirSync(runsDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names) {
    if (readOptional(path.join(runsDir, name, 'accepted.json')) === null) continue;
    const meta = parseRecord(readOptional(path.join(runsDir, name, 'meta.json')));
    if (meta.absent || meta.error || !isPlainObject(meta.record)
      || typeof meta.record.requestId !== 'string' || !REQUEST_ID_RE.test(meta.record.requestId)) return { unreadable: name };
    if (meta.record.requestId === rid) return { name };
  }
  return null;
}

const raw = readOptional(reservationFile);
if (raw === null) {
  const taken = acceptedRunNamingRequest();
  if (taken && taken.unreadable) say('corrupt', 'accepted-run metadata of ' + taken.unreadable + ' is unreadable');
  else if (taken) say('missing');
  else say('none');
} else {
  const reservation = readRecord(raw, validateReservation, rid);
  if (reservation.state !== 'valid') say('corrupt', oneLine(reservation.problem));
  else if (reservation.value.state === 'cancelled') say('already', reservation.value.gen);
  else {
    const { runId: holder, gen } = reservation.value;
    const rawTerminal = readOptional(path.join(runsDir, holder, 'terminal.json'));
    if (rawTerminal === null) say('taken', holder);
    else {
      const terminal = readRecord(rawTerminal, validateTerminal, holder);
      if (terminal.state !== 'valid') say('terminal-corrupt', oneLine(terminal.problem));
      else if (terminal.value.result.status === 'aborted-clean' && terminal.value.result.effectsClean === true) say('clean', gen, holder);
      else say('executed', holder);
    }
  }
}
`;

// The validators travel INSIDE the program: the controller runs this over ssh, and the target has no
// persistent kit outside per-run bundles (operator.js buildBundle stages kit/ under runs/<id>/), so no
// builder-side path can be relied on. status.js, outcome.js and deploy-result.js are the same files the
// rest of deploy-kit uses (about 19 KB together); status.js's other requires (exec, lock, attach) are only
// used by its remote readers, never by the validators, so the loader gives them an empty module.
const VALIDATOR_FILES = { 'on-host/status': 'status', 'on-host/outcome': 'outcome', 'deploy-result': 'deploy-result' };
function validatorSource(body = VALIDATOR_BODY) {
  const sources = {};
  for (const [file, name] of Object.entries(VALIDATOR_FILES)) sources[name] = fs.readFileSync(path.join(__dirname, `${file}.js`), 'utf8');
  return `const SOURCES = ${JSON.stringify(sources)};
const LOADED = {};
function loadValidators() {
  const load = (name) => {
    if (LOADED[name]) return LOADED[name].exports;
    const module = { exports: {} };
    LOADED[name] = module;
    const need = (spec) => { const base = spec.split('/').pop(); return SOURCES[base] ? load(base) : {}; };
    new Function('require', 'module', 'exports', SOURCES[name])(need, module, module.exports);
    return module.exports;
  };
  return { ...load('status'), ...load('outcome'), ...load('deploy-result') };
}
${body}`;
}

// The resolve decision for an app with only an in-flight marker (no unresolved one). Prints ONE verdict line:
// `unreadable` (names no run: the operator vouches for production), `mismatch <requestId>`, `finished` (the run wrote a
// valid terminal.json that needs no resolution, so the marker vouches for nothing) or `archive`.
const INFLIGHT_VALIDATOR_BODY = String.raw`
const fs = require('fs');
const path = require('path');
const { readRecord, validateTerminal, parseRecord, isPlainObject, needsResolution } = loadValidators();
const { DK_RID: rid, DK_INFLIGHT: inflightFile, DK_RUNS: runsDir } = process.env;
const readOptional = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const marker = parseRecord(readOptional(inflightFile));
if (marker.error || marker.absent || !isPlainObject(marker.record)
  || typeof marker.record.requestId !== 'string' || typeof marker.record.runId !== 'string') console.log('unreadable');
else if (marker.record.requestId !== rid) console.log('mismatch', marker.record.requestId);
else {
  const terminal = readRecord(readOptional(path.join(runsDir, marker.record.runId, 'terminal.json')), validateTerminal, marker.record.runId);
  console.log(terminal.state === 'valid' && !needsResolution(terminal.value.result) ? 'finished' : 'archive');
}
`;

// An absolute node binary to run a validator with, or empty when there is none (the caller then refuses).
const FIND_NODE_BIN = String.raw`  node_bin=$(command -v node 2>/dev/null) && node_bin=$(readlink -f "$node_bin" 2>/dev/null)
  case "$node_bin" in /*) [ -x "$node_bin" ] || node_bin= ;; *) node_bin= ;; esac`;

// The cancel decision. The shell owns the lock and the one write (the tombstone); node owns every
// parse and validation (validatorSource()). A validator that fails, prints nothing usable or cannot
// be started is `not-cancellable corrupt`, never absent and never cancellable.
function cancelBody(config, requestId, at) {
  const { base, requests, runs } = stateFiles(config);
  const rf = `${requests}/${requestId}.json`;
  return String.raw`
  rid=${shQuote(requestId)}
  at=${shQuote(at)}
  rf="${rf}"
  refuse() { echo "not-cancellable $1"; [ -z "$2" ] || echo "detail: $2"; return ${EXIT_REFUSED}; }
  write_tombstone() {
    mkdir -p -m 700 "${requests}" || return 2
    tmp="$rf.tmp.$$"
    printf '{"requestId":"%s","gen":%s,"state":"cancelled","runId":null,"at":"%s","liveBefore":null,"prev":%s}\n' "$rid" "$1" "$at" "$2" > "$tmp" || return 2
    if command -v sync >/dev/null 2>&1; then sync "$tmp" 2>/dev/null; fi
    mv "$tmp" "$rf" || return 2
    echo "cancelled $rid gen=$1"
  }
${FIND_NODE_BIN}
  if [ -z "$node_bin" ]; then refuse corrupt "no absolute node binary to validate with"; return $?; fi
  verdict_file="${base}/cancel-verdict.$$"
  if ! DK_RID="$rid" DK_RF="$rf" DK_RUNS="${runs}" \
    "$node_bin" -e ${shQuote(validatorSource())} > "$verdict_file" 2>/dev/null; then
    rm -f "$verdict_file"; refuse corrupt "the validator did not complete"; return $?
  fi
  verdict=; a=; b=
  read -r verdict a b < "$verdict_file"; rm -f "$verdict_file"
  case "$verdict" in
    none) write_tombstone 1 null; return $? ;;
    missing) refuse reservation-missing "an accepted run names this request"; return $? ;;
    already) echo "cancelled $rid gen=$a (already)"; return 0 ;;
    taken) refuse request-taken "run $a has no terminal.json"; return $? ;;
    terminal-corrupt) refuse terminal-corrupt "$a $b"; return $? ;;
    executed) refuse request-executed "run $a ended without a clean abort"; return $? ;;
    clean)
      case "$a" in ""|*[!0-9]*) refuse corrupt "the validator reported gen $a"; return $? ;; esac
      write_tombstone "$((a + 1))" '{"runId":"'"$b"'","gen":'"$a"'}'; return $? ;;
    *) refuse corrupt "$verdict $a $b"; return $? ;;
  esac
`;
}

function cancelRequest(config, requestId, { now = new Date(), runtime, pauseFifo } = {}) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new Error(`deploy-kit: ${JSON.stringify(requestId)} is not a request id`);
  }
  const body = cancelBody(config, requestId, now.toISOString());
  return runSession(config, runtime, sessionScript(config, { purpose: 'request-cancel', body, pauseFifo }));
}

// Clears the app's unresolved.json (written by host-run after a failure that may have changed production)
// once an operator has assessed it. The record is moved into resolved/ next to a resolution record that
// carries the operator's reason; nothing else removes it. A record naming a different request is refused;
// one that names none (unreadable) is archived, since the operator is the one vouching for production.
function resolveRequest(config, requestId, reason, { now = new Date(), runtime, pauseFifo } = {}) {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new Error(`deploy-kit: ${JSON.stringify(requestId)} is not a request id`);
  }
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error('deploy-kit: resolve needs a non-empty --reason');
  const {
    base, unresolved, inflight, resolved, runs,
  } = stateFiles(config);
  const at = now.toISOString();
  const archive = `${resolved}/${at.replace(/[:.]/g, '')}-${requestId}`;
  const reasonJson = shQuote(JSON.stringify(reason));
  // Only the in-flight marker exists when a run was killed after acceptance and its lock then broken: the marker is
  // archived the way the unresolved one is, once the run is shown to have no terminal.json that settled it.
  const body = String.raw`
  rid=${shQuote(requestId)}
  uf="${unresolved}"
  inflight="${inflight}"
  archive_to() {
    mkdir -p -m 700 "${resolved}" || return 2
    printf '{"requestId":"%s","reason":%s,"at":"%s"}
' "$rid" ${reasonJson} ${shQuote(at)} > "${archive}.resolution.json" || return 2
    mv "$1" "${archive}.$2.json" || return 2
    echo "resolved $rid"
  }
  if [ ! -e "$uf" ]; then
    if [ ! -e "$inflight" ]; then echo "not-unresolved"; return ${EXIT_REFUSED}; fi
${FIND_NODE_BIN}
    if [ -z "$node_bin" ]; then echo "not-resolvable no absolute node binary to validate with"; return ${EXIT_REFUSED}; fi
    verdict_file="${base}/resolve-verdict.$$"
    if ! DK_RID="$rid" DK_INFLIGHT="$inflight" DK_RUNS="${runs}" \
      "$node_bin" -e ${shQuote(validatorSource(INFLIGHT_VALIDATOR_BODY))} > "$verdict_file" 2>/dev/null; then
      rm -f "$verdict_file"; echo "not-resolvable the validator did not complete"; return ${EXIT_REFUSED}
    fi
    verdict=; named=
    read -r verdict named < "$verdict_file"; rm -f "$verdict_file"
    case "$verdict" in
      mismatch) echo "request-mismatch $named"; return ${EXIT_REFUSED} ;;
      finished) echo "not-unresolved"; return ${EXIT_REFUSED} ;;
      unreadable|archive) archive_to "$inflight" inflight; return $? ;;
      *) echo "not-resolvable $verdict"; return ${EXIT_REFUSED} ;;
    esac
  fi
  c=$(tr -d ' 	
' < "$uf")
  named=$(printf '%s' "$c" | sed -n 's/.*"requestId":"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$named" ] && [ "$named" != "$rid" ]; then echo "request-mismatch $named"; return ${EXIT_REFUSED}; fi
  archive_to "$uf" unresolved
`;
  return runSession(config, runtime, sessionScript(config, { purpose: 'resolve', body, pauseFifo }));
}

// ---- read-only state ----------------------------------------------------------------------------

const emitFile = (name, file) => `printf 'DK_FILE %s\\n' ${name}; if [ -e ${file} ]; then head -c 65536 ${file}; printf '\\nDK_PRESENT\\n'; else printf 'DK_ABSENT\\n'; fi`;
const emitDir = (name, dir) => `printf 'DK_FILE %s\\n' ${name}; if [ -d ${dir} ]; then printf 'DK_PRESENT\\n'; else printf 'DK_ABSENT\\n'; fi`;
const emitCommand = (name, command) => `printf 'DK_FILE %s\\n' ${name}; if out=$(${command}) && [ -n "$out" ]; then printf '%s\\nDK_PRESENT\\n' "$out"; else printf 'DK_ABSENT\\n'; fi`;

function stateReadScript(config, requestId) {
  const files = stateFiles(config);
  const releases = isReleaseLayout(config);
  const lines = [emitFile('hold', `"${files.hold}"`), emitFile('lastEpoch', `"${files.epoch}"`)];
  if (releases) {
    const paths = releasePaths(config);
    lines.push(
      emitCommand('liveSha', `cd ${paths.currentLink} 2>/dev/null && git rev-parse HEAD 2>/dev/null`),
      emitCommand('liveTarget', `readlink ${paths.currentLink} 2>/dev/null`),
      emitFile('journal', paths.stateFile),
    );
  } else {
    lines.push(emitCommand('liveSha', `cd ${config.projectDir} 2>/dev/null && git rev-parse HEAD 2>/dev/null`));
  }
  lines.push(emitDir('appLock', `"${lockDir(config)}"`), emitFile('appOwner', `"${lockDir(config)}/owner"`));
  if (config.hostLock) lines.push(emitDir('hostLock', `"${hostLockDir(config)}"`), emitFile('hostOwner', `"${hostLockDir(config)}/owner"`));
  if (requestId) lines.push(emitFile('reservation', `"${files.requests}/${requestId}.json"`));
  lines.push("printf 'DK_UNIT\\n'", "printf 'DK_END\\n'");
  return lines.join('\n');
}

// -> { class: 'none' | 'terminal' | 'interrupted' | 'corrupt', phase, releaseId, problem }. A journal that
// exists but cannot be read is `corrupt`, never `none` (release.js reads it as null; host-run must not).
function classifyJournal(raw) {
  const none = { class: 'none', phase: null, releaseId: null };
  if (raw === null || raw === undefined) return none;
  const parsed = parseRecord(raw);
  const problem = parsed.error || (!isPlainObject(parsed.record) && 'not an object')
    || (typeof parsed.record.phase !== 'string' && 'phase is not a string');
  if (problem) return { class: 'corrupt', phase: null, releaseId: null, problem };
  const { phase, releaseId } = parsed.record;
  return {
    class: TERMINAL_JOURNAL_PHASES.has(phase) ? 'terminal' : 'interrupted',
    phase,
    releaseId: typeof releaseId === 'string' ? releaseId : null,
  };
}

function classifyHold(raw, now) {
  if (raw === null || raw === undefined) return null;
  const parsed = parseRecord(raw);
  const hold = parsed.record;
  const problem = parsed.error
    || (!isPlainObject(hold) && 'not an object')
    || (typeof hold.reason !== 'string' || hold.reason === '' ? 'reason is not a string' : null)
    || (typeof hold.at !== 'string' ? 'at is not a string' : null)
    || (hold.until !== null && !Number.isFinite(Date.parse(hold.until)) ? 'until is not an ISO timestamp or null' : null)
    || (hold.epoch !== null && !Number.isInteger(hold.epoch) ? 'epoch is not an integer or null' : null);
  if (problem) return { corrupt: true, problem };
  return {
    reason: hold.reason, until: hold.until, at: hold.at, epoch: hold.epoch,
    expired: hold.until !== null && Date.parse(hold.until) <= now.getTime(),
  };
}

function classifyEpoch(raw) {
  if (raw === null || raw === undefined) return { value: null };
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text) || text.length > MAX_EPOCH_DIGITS) return { value: null, problem: 'not a non-negative integer' };
  return { value: Number(text) };
}

function classifyLock(held, raw) {
  if (held === null) return { held: false, owner: null };
  const parsed = parseRecord(raw);
  if (parsed.absent) return { held: true, owner: null, problem: 'no owner record' };
  if (parsed.error || !isPlainObject(parsed.record)) return { held: true, owner: null, problem: parsed.error || 'not an object' };
  return { held: true, owner: parsed.record };
}

function classifyLive(records) {
  const sha = records.liveSha === null ? null : records.liveSha.trim();
  if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) return { sha: null, problem: `${JSON.stringify(sha)} is not a full commit sha` };
  return { sha, ...(sha === null ? { problem: 'the live sha could not be read' } : {}) };
}

// Pure: the framed reply -> the state document.
function classifyTargetState(config, { framed, requestId, now }) {
  const records = framed.records;
  const releases = isReleaseLayout(config);
  const live = classifyLive(records);
  const state = {
    layout: releases ? 'releases' : 'legacy',
    liveSha: live.sha,
    ...(releases ? { liveTarget: records.liveTarget === null ? null : records.liveTarget.trim() } : {}),
    ...(live.problem ? { liveProblem: live.problem } : {}),
    journal: releases ? classifyJournal(records.journal) : { class: 'none', phase: null, releaseId: null },
    hold: classifyHold(records.hold, now),
    lastEpoch: null,
    locks: { app: classifyLock(records.appLock, records.appOwner) },
  };
  const epoch = classifyEpoch(records.lastEpoch);
  state.lastEpoch = epoch.value;
  if (epoch.problem) state.lastEpochProblem = epoch.problem;
  if (config.hostLock) state.locks.host = classifyLock(records.hostLock, records.hostOwner);
  if (requestId) {
    const reservation = readRecord(records.reservation, validateReservation, requestId);
    state.reservation = { requestId, state: reservation.state, ...(reservation.value ? { record: reservation.value } : {}), ...(reservation.problem ? { problem: reservation.problem } : {}) };
  }
  return state;
}

// -> the state document, or throws when the host could not be read (a read that failed is never "empty").
function readTargetState(config, { requestId, runtime, now = new Date() } = {}) {
  if (requestId !== undefined && !REQUEST_ID_RE.test(requestId)) throw new Error(`deploy-kit: ${JSON.stringify(requestId)} is not a request id`);
  const reply = runOnTarget(stateReadScript(config, requestId), { ...config, projectDir: undefined }, {
    capture: true, runtime, readOnly: true, timeoutSeconds: REMOTE_CALL_TIMEOUT_SECONDS,
  });
  const framed = reply.ok ? parseFramedReply(reply.output, BASE_FRAMES) : undefined;
  if (!framed) throw new Error('deploy-kit: could not read the target state (incomplete or unreadable reply from the host)');
  return classifyTargetState(config, { framed, requestId, now });
}

// ---- CLI ----------------------------------------------------------------------------------------

const USAGE = {
  hold: 'Usage: deploy-kit hold set --reason <text> [--until <iso>] | deploy-kit hold clear',
  epoch: 'Usage: deploy-kit epoch set <n>',
  request: 'Usage: deploy-kit request cancel <requestId>',
  resolve: 'Usage: deploy-kit resolve --request <requestId> --reason <text>',
  'target-state': 'Usage: deploy-kit target-state --json [--request <id>]',
};

function parseFlags(args, valueFlags) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (valueFlags.includes(args[i])) {
      i += 1;
      if (args[i] === undefined || args[i].startsWith('--')) return null;
      flags[args[i - 1]] = args[i];
    } else if (args[i] === '--json') flags['--json'] = true;
    else if (args[i].startsWith('--')) return null;
    else positional.push(args[i]);
  }
  return { flags, positional };
}

// -> exit code: 0 done, 1 refused lock-held / usage / failure, 3 refused or not-cancellable, 75 unreadable target.
function runCommand(command, args, config, { log, out = console.log, runtime, now } = {}) {
  const usage = () => { log.error(USAGE[command]); return 1; };
  const [sub, ...rest] = args;
  const report = (result) => {
    out(result.message);
    if (result.outcome === 'ok') return 0;
    return result.outcome === 'lock-held' ? EXIT_LOCK_HELD : EXIT_REFUSED;
  };
  try {
    if (command === 'hold' && sub === 'set') {
      const parsed = parseFlags(rest, ['--reason', '--until']);
      if (!parsed || parsed.positional.length > 0 || !parsed.flags['--reason']) return usage();
      return report(setHold(config, { reason: parsed.flags['--reason'], until: parsed.flags['--until'] ?? null, runtime, now }));
    }
    if (command === 'hold' && sub === 'clear' && rest.length === 0) return report(clearHold(config, { runtime }));
    if (command === 'epoch' && sub === 'set' && rest.length === 1) return report(setEpoch(config, rest[0], { runtime }));
    if (command === 'request' && sub === 'cancel' && rest.length === 1) return report(cancelRequest(config, rest[0], { runtime, now }));
    if (command === 'resolve') {
      const parsed = parseFlags(args, ['--request', '--reason']);
      if (!parsed || parsed.positional.length > 0 || !parsed.flags['--request'] || !parsed.flags['--reason']) return usage();
      return report(resolveRequest(config, parsed.flags['--request'], parsed.flags['--reason'], { runtime, now }));
    }
    if (command === 'target-state') {
      const parsed = parseFlags(args, ['--request']);
      if (!parsed || parsed.positional.length > 0 || !parsed.flags['--json']) return usage();
      out(JSON.stringify(readTargetState(config, { requestId: parsed.flags['--request'], runtime, now }), null, 2));
      return 0;
    }
    return usage();
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return command === 'target-state' ? 75 : 1;
  }
}

module.exports = {
  setHold, clearHold, setEpoch, cancelRequest, resolveRequest, readTargetState, classifyJournal, classifyHold, classifyEpoch,
  classifyTargetState, stateFiles, runCommand,
};
