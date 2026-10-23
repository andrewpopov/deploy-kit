'use strict';

// Target-state operations (BRAIN-636 D3): the holds, the epoch fence and `request cancel` that the
// deploy controller writes on the host, plus a read-only look at everything it decides on.
//
// Every MUTATING command is ONE remote shell script run as a single process under `setsid`, which
// takes the app lock as owner `kind: session` through the D1a protocol (guard flock, owner record
// with its own pid and sid), fails fast with `refused lock-held` instead of waiting for a running
// deploy, does its work with builtins plus the coreutils a file write needs, and releases the lock
// nonce-matched under the guard. It runs no hook, no node and nothing detached: a lock owner whose
// descendants cannot create another session is what lets a breaker prove the owner gone by its sid.
// The reservation shape this reads and writes is on-host/status.js's validateReservation.
// Nothing else may write these files.

const path = require('path');
const { runOnTarget, shQuote } = require('./exec');
const {
  lockDir, lockId, guardFile, ensureStateDir, guardPrelude, ownerWriter, ownerFields, hostLockDir,
} = require('./lock');
const { isReleaseLayout, releasePaths } = require('./release');
const { parseFramedReply } = require('./on-host/attach');
const { RUN_ID_RE, isPlainObject, parseRecord } = require('./on-host/outcome');
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

// The cancel decision, in shell, over the files D5's status.js validates in node. A record that fails the
// shape below is `corrupt`, never absent and never cancellable. Values are tokens (run ids, ints, ISO
// times), so the compact-JSON field extraction is exact for what D4a writes with JSON.stringify.
function cancelBody(config, requestId, at) {
  const { requests, runs } = stateFiles(config);
  const rf = `${requests}/${requestId}.json`;
  const runIdRe = RUN_ID_RE.source;
  return String.raw`
  rid=${shQuote(requestId)}
  at=${shQuote(at)}
  rf="${rf}"
  compact() { tr -d ' \t\r\n' < "$1"; }
  jstr() { printf '%s' "$c" | sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' | head -n 1; }
  jnum() { printf '%s' "$c" | sed -n 's/.*"'"$1"'":\([0-9][0-9]*\)[,}].*/\1/p' | head -n 1; }
  jnull() { printf '%s' "$c" | grep -Eq '"'"$1"'":null[,}]'; }
  isrun() { printf '%s' "$1" | grep -Eq '${runIdRe}'; }
  isgen() { case "$1" in ""|*[!0-9]*|0*|${'?'.repeat(MAX_EPOCH_DIGITS+1)}*) return 1 ;; esac; }
  refuse() { echo "not-cancellable $1"; [ -z "$2" ] || echo "detail: $2"; return ${EXIT_REFUSED}; }
  accepted_run_exists() {
    for m in "${runs}"/*/meta.json; do
      [ -f "$m" ] || continue
      d=$(dirname "$m")
      [ -f "$d/accepted.json" ] || continue
      if compact "$m" | grep -Fq '"requestId":"'"$rid"'"'; then return 0; fi
    done
    return 1
  }
  write_tombstone() {
    mkdir -p -m 700 "${requests}" || return 2
    tmp="$rf.tmp.$$"
    printf '{"requestId":"%s","gen":%s,"state":"cancelled","runId":null,"at":"%s","liveBefore":null,"prev":%s}\n' "$rid" "$1" "$at" "$2" > "$tmp" || return 2
    if command -v sync >/dev/null 2>&1; then sync "$tmp" 2>/dev/null; fi
    mv "$tmp" "$rf" || return 2
    echo "cancelled $rid gen=$1"
  }
  # sets $problem; $state $gen $holder on success
  read_reservation() {
    problem=; state=; gen=; holder=
    c=$(compact "$rf") || { problem="unreadable"; return; }
    case "$c" in "{"*"}") ;; *) problem="not an object"; return ;; esac
    prev=$(printf '%s' "$c" | sed -n 's/.*"prev":{\([^}]*\)}.*/\1/p')
    c=$(printf '%s' "$c" | sed 's/"prev":{[^}]*}/"prev":P/')
    [ "$(jstr requestId)" = "$rid" ] || { problem="requestId is not $rid"; return; }
    gen=$(jnum gen); isgen "$gen" || { problem="gen is not a positive integer"; return; }
    state=$(jstr state)
    case "$state" in accepted|cancelled) ;; *) problem="state is not accepted or cancelled"; return ;; esac
    holder=$(jstr runId)
    if [ -n "$holder" ]; then isrun "$holder" || { problem="runId is not a run id or null"; return; }
    else jnull runId || { problem="runId is not a run id or null"; return; }; fi
    [ "$state" != accepted ] || [ -n "$holder" ] || { problem="an accepted reservation has no runId"; return; }
    [ -n "$(jstr at)" ] || { problem="at is not a string"; return; }
    [ -n "$(jstr liveBefore)" ] || jnull liveBefore || { problem="liveBefore is not a string or null"; return; }
    if printf '%s' "$c" | grep -Fq '"prev":P'; then
      c="{$prev}"; pr=$(jstr runId); pg=$(jnum gen)
      { [ -n "$pr" ] && isrun "$pr" && isgen "$pg"; } || { problem="prev is not null or {runId, gen}"; return; }
    elif ! jnull prev; then problem="prev is not null or {runId, gen}"; return; fi
  }
  if [ ! -e "$rf" ]; then
    if accepted_run_exists; then refuse reservation-missing "an accepted run names this request"; return $?; fi
    write_tombstone 1 null; return $?
  fi
  read_reservation
  if [ -n "$problem" ]; then refuse corrupt "$problem"; return $?; fi
  if [ "$state" = cancelled ]; then echo "cancelled $rid gen=$gen (already)"; return 0; fi
  tf="${runs}/$holder/terminal.json"
  if [ ! -e "$tf" ]; then refuse request-taken "run $holder has no terminal.json"; return $?; fi
  t=$(compact "$tf") || { refuse terminal-corrupt "unreadable"; return $?; }
  case "$t" in "{"*"}") ;; *) refuse terminal-corrupt "not an object"; return $? ;; esac
  c="$t"
  { [ "$(jstr runId)" = "$holder" ] && [ -n "$(jstr finishedAt)" ] && printf '%s' "$t" | grep -Eq '"kind":"(deploy|rollback|recover)"' \
    && printf '%s' "$t" | grep -Fq '"result":{'; } || { refuse terminal-corrupt "fails validation"; return $?; }
  if printf '%s' "$t" | grep -Fq '"status":"aborted-clean"' && printf '%s' "$t" | grep -Fq '"effectsClean":true'; then
    write_tombstone "$((gen + 1))" '{"runId":"'"$holder"'","gen":'"$gen"'}'; return $?
  fi
  refuse request-executed "run $holder ended without a clean abort"; return $?
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
  const { unresolved, resolved } = stateFiles(config);
  const at = now.toISOString();
  const archive = `${resolved}/${at.replace(/[:.]/g, '')}-${requestId}`;
  const body = String.raw`
  rid=${shQuote(requestId)}
  uf="${unresolved}"
  if [ ! -e "$uf" ]; then echo "not-unresolved"; return ${EXIT_REFUSED}; fi
  c=$(tr -d ' 	
' < "$uf")
  named=$(printf '%s' "$c" | sed -n 's/.*"requestId":"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$named" ] && [ "$named" != "$rid" ]; then echo "request-mismatch $named"; return ${EXIT_REFUSED}; fi
  mkdir -p -m 700 "${resolved}" || return 2
  printf '{"requestId":"%s","reason":%s,"at":"%s"}
' "$rid" ${shQuote(JSON.stringify(reason))} ${shQuote(at)} > "${archive}.resolution.json" || return 2
  mv "$uf" "${archive}.unresolved.json" || return 2
  echo "resolved $rid"
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
