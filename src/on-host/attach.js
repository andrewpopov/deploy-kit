'use strict';

// `deploy-kit attach <run-id>` (PKG-187): follow an on-host run from the operator
// side. Everything it learns comes from the run dir on the host (the log, the
// three records) plus the unit's ActiveState; the exit code is classify()'s.
// Every ssh call goes through runOnTarget, so config ssh options apply as in ssh mode.

const { runOnTarget, shQuote } = require('../exec');
const { log: defaultLog } = require('../log');
const { classify, RUN_ID_RE } = require('./outcome');
const { findReceipt } = require('./receipts');

const EXIT_TRANSPORT_LOST = 75;
const EXIT_FAILED = 1;

const POLL_SECONDS = 3;
const RETRY_BACKOFF_SECONDS = [1, 2, 4, 8, 16];
const INACTIVE_GRACE_MS = 30000;
const LOG_CHUNK_BYTES = 512 * 1024; // below execFileSync's 1 MiB maxBuffer, with room for the header
const MAX_DRAIN_CHUNKS = 64;
const REMOTE_CALL_TIMEOUT_SECONDS = 30;
const RECORD_FILES = ['started', 'outcome.json', 'result.json', 'result-unstarted.json'];
const LIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);

const defaultSleep = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

// Prints the bytes of the log from `offset` on. The remote reports how many bytes
// it emitted (DK_LOG_N), so the next offset never depends on decoding the text.
function logChunkCommand(runDir, offset) {
  const file = shQuote(`${runDir}/log`);
  return [
    `f=${file}; o=${offset}; s=0; [ -f "$f" ] && s=$(wc -c < "$f")`,
    `if [ "$s" -gt "$o" ]; then n=$((s-o)); [ "$n" -gt ${LOG_CHUNK_BYTES} ] && n=${LOG_CHUNK_BYTES}; echo "DK_LOG_N=$n"; tail -c +$((o+1)) "$f" | head -c "$n"; else echo DK_LOG_N=0; fi`,
  ].join('; ');
}

function parseLogChunk(output) {
  const newline = output.indexOf('\n');
  const header = newline < 0 ? null : /^DK_LOG_N=(\d+)$/.exec(output.slice(0, newline));
  if (!header) return undefined;
  return { bytes: Number(header[1]), text: output.slice(newline + 1) };
}

function stateCommand(runDir, unit) {
  const dir = shQuote(runDir);
  return [
    'XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export XDG_RUNTIME_DIR',
    `for f in ${RECORD_FILES.join(' ')}; do printf 'DK_FILE %s\\n' "$f"; if [ -e ${dir}/"$f" ]; then head -c 65536 ${dir}/"$f"; printf '\\nDK_PRESENT\\n'; else printf 'DK_ABSENT\\n'; fi; done`,
    'printf \'DK_UNIT\\n\'',
    `systemctl --user show -p ActiveState -p SubState ${shQuote(unit)}`,
    'printf \'DK_END\\n\'',
  ].join('\n');
}

// -> { started, outcome, result, resultUnstarted, activeState, subState } (record values are raw
// text, null when absent), or undefined when the reply is incomplete and the poll must be retried.
function parseState(output) {
  const records = {};
  const unitLines = [];
  let current = null;
  let buffer = [];
  let ended = false;
  for (const line of output.split('\n')) {
    if (current === null) {
      const file = /^DK_FILE (\S+)$/.exec(line);
      if (file) { current = file[1]; buffer = []; } else if (line === 'DK_UNIT') current = '';
      continue;
    }
    if (current === '') {
      if (line === 'DK_END') { ended = true; break; }
      unitLines.push(line);
    } else if (line === 'DK_PRESENT' || line === 'DK_ABSENT') {
      records[current] = line === 'DK_PRESENT' ? buffer.join('\n') : null;
      current = null;
    } else {
      buffer.push(line);
    }
  }
  if (!ended || RECORD_FILES.some((name) => !(name in records))) return undefined;
  const unitProp = (key) => unitLines.map((l) => new RegExp(`^${key}=(.*)$`).exec(l)).find(Boolean)?.[1];
  const activeState = unitProp('ActiveState');
  if (activeState === undefined) return undefined;
  return {
    started: records.started,
    outcome: records['outcome.json'],
    result: records['result.json'],
    resultUnstarted: records['result-unstarted.json'],
    activeState,
    subState: unitProp('SubState'),
  };
}

// Follow one run (a receipt) until it has a result, the unit is gone, or the transport is lost.
function attachReceipt(receipt, config, deps = {}) {
  const {
    runtime, log = defaultLog, sleep = defaultSleep, now = Date.now,
    write = (text) => process.stdout.write(text),
  } = deps;
  const { runId, host, unit, runDir } = receipt;
  const sshConfig = { ...config, mode: 'ssh', host, projectDir: undefined };

  // One ssh call, retried with backoff; undefined means the transport is lost.
  const remote = (command, parse) => {
    for (let attempt = 0; ; attempt += 1) {
      const result = runOnTarget(command, sshConfig, {
        capture: true, runtime, timeoutSeconds: REMOTE_CALL_TIMEOUT_SECONDS,
      });
      const parsed = result.ok ? parse(result.output) : undefined;
      if (parsed !== undefined) return parsed;
      if (attempt >= RETRY_BACKOFF_SECONDS.length) return undefined;
      sleep(RETRY_BACKOFF_SECONDS[attempt]);
    }
  };

  const transportLost = () => {
    log.error(`transport lost — the deploy continues on ${host} as ${unit}; reattach: deploy-kit attach ${runId}`);
    return EXIT_TRANSPORT_LOST;
  };

  let offset = 0;
  const pullLog = () => {
    const chunk = remote(logChunkCommand(runDir, offset), parseLogChunk);
    if (!chunk) return undefined;
    if (chunk.text) write(chunk.text);
    offset += chunk.bytes;
    return chunk.bytes;
  };

  const finish = () => {
    for (let i = 0; i < MAX_DRAIN_CHUNKS; i += 1) {
      const bytes = pullLog();
      if (bytes === undefined) return transportLost();
      if (bytes === 0) break;
    }
    const state = remote(stateCommand(runDir, unit), parseState);
    if (!state) return transportLost();
    const verdict = classify({
      expectedRunId: runId, result: state.result, outcome: state.outcome, resultUnstarted: state.resultUnstarted,
    });
    const detail = verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : '';
    if (verdict.exitCode === 0) log.success(`run ${runId}: ${verdict.status}${detail}`);
    else log.error(`run ${runId}: ${verdict.status}${detail}`);
    return verdict.exitCode;
  };

  let inactiveSince = null;
  let startedLogged = false;
  for (;;) {
    if (pullLog() === undefined) return transportLost();
    const state = remote(stateCommand(runDir, unit), parseState);
    if (!state) return transportLost();
    if (state.started !== null && !startedLogged) {
      startedLogged = true;
      log.info(`host-run started on ${host} (unit ${unit}, ${state.activeState}/${state.subState || '?'})`);
    }
    if (state.result !== null || state.resultUnstarted !== null) return finish();
    if (LIVE_STATES.has(state.activeState)) {
      inactiveSince = null;
    } else {
      if (inactiveSince === null) inactiveSince = now();
      if (now() - inactiveSince >= INACTIVE_GRACE_MS) return finish();
    }
    sleep(POLL_SECONDS);
  }
}

// `deploy-kit attach <run-id>`: look the run up in the local receipts file.
function attachRun(runId, config, deps = {}) {
  const log = deps.log || defaultLog;
  if (!RUN_ID_RE.test(runId)) {
    log.error(`ONHOST_RUN_ID: ${JSON.stringify(runId)} is not a run id (YYYYMMDDTHHMMSSZ-<sha12>-<8 hex>)`);
    return EXIT_FAILED;
  }
  const receipt = findReceipt(runId, deps.receiptsPath);
  if (!receipt) {
    log.error(`ONHOST_NO_RECEIPT: no on-host run ${runId} in the local receipts file; it was started from another machine or account`);
    return EXIT_FAILED;
  }
  return attachReceipt(receipt, config, deps);
}

module.exports = {
  attachRun, attachReceipt, parseState, parseLogChunk, logChunkCommand, stateCommand,
  EXIT_TRANSPORT_LOST, POLL_SECONDS, RETRY_BACKOFF_SECONDS, INACTIVE_GRACE_MS,
};
