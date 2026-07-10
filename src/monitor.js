'use strict';

const { runOnTarget } = require('./exec');
const { acquireLock } = require('./lock');
const { runAllChecks } = require('./checks');
const { log: defaultLog } = require('./log');

const STATE_VERSION = 1;
const EXIT = { OK: 0, CRITICAL: 1, MONITOR_ERROR: 2 };

function nowDefault() { return Date.now(); }
function genIdDefault(nowMs) { return `${nowMs}-${Math.random().toString(36).slice(2, 8)}`; }

function stateFilePath(config) {
  return config.monitor.stateFile || `${config.projectDir}/.deploy-kit-monitor-state.json`;
}

// Read the versioned state from the target. A missing/empty/corrupt/old-version file
// yields a fresh empty state (with a warning) rather than crashing — monitoring must
// survive a lost state file.
function readState(config, ctx) {
  const fresh = { version: STATE_VERSION, checks: {}, pendingEvent: null };
  const res = runOnTarget(`cat ${stateFilePath(config)} 2>/dev/null || true`, config, { capture: true, runtime: ctx.runtime, timeoutSeconds: 10 });
  const raw = (res.output || '').trim();
  if (!raw) return fresh;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { ctx.log.warning('monitor: state file unparseable; starting fresh'); return fresh; }
  if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.checks !== 'object') {
    ctx.log.warning('monitor: state version/shape mismatch; starting fresh');
    return fresh;
  }
  return { version: STATE_VERSION, checks: parsed.checks || {}, pendingEvent: parsed.pendingEvent || null };
}

// Persist state ATOMICALLY: the JSON goes over STDIN (never interpolated into the
// shell — it contains quotes/newlines), written to a same-dir temp file, then renamed.
// Gated: a failed write is a monitor error, not a silent success.
function writeState(config, ctx, state) {
  const file = stateFilePath(config);
  const tmp = `${file}.tmp.$$`;
  const json = JSON.stringify(state);
  const res = runOnTarget(`cat > ${tmp} && chmod 600 ${tmp} && mv -f ${tmp} ${file}`, config, { runtime: ctx.runtime, input: json, timeoutSeconds: 10 });
  if (!res.ok) throw new Error(`monitor: failed to persist state to ${file}`);
}

// Run the alert sink with the batched event JSON on STDIN. `run:'controller'` executes
// it on the machine running deploy-kit (robust when the monitored host/app is the thing
// that's down); `run:'target'` executes it on the monitored host. Returns { ok }.
function deliverAlert(config, ctx, event) {
  const { command, run } = config.monitor.alert;
  const json = JSON.stringify(event);
  if (run === 'target') {
    return runOnTarget(command, config, { runtime: ctx.runtime, input: json, capture: true, timeoutSeconds: 20 });
  }
  // controller-local execution via the injected runtime (default: real execFileSync).
  const { execFileSync } = ctx.runtime && ctx.runtime.execFileSync ? ctx.runtime : require('child_process');
  try {
    execFileSync('sh', ['-c', command], { input: json, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

const isNonOk = (s) => s === 'warn' || s === 'crit';

// The per-check state machine. Given the observed status and the persisted check
// state, decide the new state and whether an alert fires. `unknown` HOLDS (never a
// recovery or a confirmed failure) and clears the streaks. Returns { next, alert? }.
function stepCheck(prev, result, opts) {
  const { failAfterRuns, recoverAfterRuns, reAlertAfterMinutes, nowMs } = opts;
  const s = prev || { notif: 'healthy', failStreak: 0, recoverStreak: 0, lastAlertAtMs: 0, lastAlertedStatus: null };
  const st = result.status;
  const base = { notif: s.notif, failStreak: s.failStreak, recoverStreak: s.recoverStreak, lastAlertAtMs: s.lastAlertAtMs, lastAlertedStatus: s.lastAlertedStatus };
  if (result.meta) base.meta = result.meta[result.id]; // persist e.g. restart baseline

  if (st === 'unknown') {
    return { next: { ...base, failStreak: 0, recoverStreak: 0 } }; // hold; surface but don't transition
  }
  if (st === 'ok') {
    const recoverStreak = s.recoverStreak + 1;
    if (s.notif === 'alerted' && recoverStreak >= recoverAfterRuns) {
      return { next: { ...base, notif: 'healthy', failStreak: 0, recoverStreak: 0, lastAlertedStatus: null },
        alert: { id: result.id, kind: 'recovery', status: 'ok', message: result.message } };
    }
    return { next: { ...base, failStreak: 0, recoverStreak } };
  }
  // warn | crit
  const failStreak = s.failStreak + 1;
  if (s.notif === 'healthy') {
    if (failStreak >= failAfterRuns) {
      return { next: { ...base, notif: 'alerted', failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: st },
        alert: { id: result.id, kind: 'alert', status: st, message: result.message } };
    }
    return { next: { ...base, failStreak, recoverStreak: 0 } };
  }
  // already alerted: escalate warn→crit, or re-alert after the interval
  if (s.lastAlertedStatus === 'warn' && st === 'crit') {
    return { next: { ...base, failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: 'crit' },
      alert: { id: result.id, kind: 'escalation', status: 'crit', message: result.message } };
  }
  if (reAlertAfterMinutes > 0 && nowMs - s.lastAlertAtMs >= reAlertAfterMinutes * 60000) {
    return { next: { ...base, failStreak, recoverStreak: 0, lastAlertAtMs: nowMs, lastAlertedStatus: st },
      alert: { id: result.id, kind: 'reminder', status: st, message: result.message } };
  }
  return { next: { ...base, failStreak, recoverStreak: 0 } };
}

// Run one monitor pass: lock → read state → run checks → step the state machine →
// batch alerts → OUTBOX deliver (persist pending BEFORE send, clear on success, retain
// on failure) → persist state → summary. Returns { exitCode, results, alerts }.
function monitor(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const now = ctx.now || nowDefault;
  const genId = ctx.genId || genIdDefault;
  const c = { ...ctx, log, runtime: ctx.runtime };
  const m = config.monitor;
  const failAfterRuns = m.failAfterRuns || 2;
  const recoverAfterRuns = m.recoverAfterRuns || 2;
  const reAlertAfterMinutes = m.reAlertAfterMinutes || 0;
  const nowMs = now();

  log.header(`🩺 Monitor (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const release = acquireLock(config, c, { steal: options.stealLock === true, suffix: 'monitor' });
  try {
    const state = readState(config, c);
    const prevMeta = Object.fromEntries(Object.entries(state.checks).filter(([, v]) => v && v.meta).map(([id, v]) => [id, v.meta]));
    const results = runAllChecks(config, c, { prevMeta, nowMs });

    const newAlerts = [];
    const nextChecks = { ...state.checks };
    for (const r of results) {
      const { next, alert } = stepCheck(state.checks[r.id], r, { failAfterRuns, recoverAfterRuns, reAlertAfterMinutes, nowMs });
      nextChecks[r.id] = next;
      if (alert) newAlerts.push(alert);
    }
    // Retire state for checks that are no longer configured — silently (no false recovery).
    const liveIds = new Set(results.map((r) => r.id));
    for (const id of Object.keys(nextChecks)) if (!liveIds.has(id)) delete nextChecks[id];

    // ---- OUTBOX: accumulate any undelivered prior alerts + this run's, deliver once ----
    const pending = state.pendingEvent;
    const allAlerts = [...(pending ? pending.alerts : []), ...newAlerts];
    let exitCode = results.some((r) => r.status === 'crit') ? EXIT.CRITICAL : EXIT.OK;

    if (allAlerts.length) {
      const event = {
        eventId: pending ? pending.eventId : genId(nowMs),
        createdAtMs: pending ? pending.createdAtMs : nowMs,
        host: config.host || 'local',
        alerts: allAlerts,
      };
      // Persist the pending event + new check states BEFORE sending, so a crash after
      // delivery can't lose the alert and a crash before delivery retries next run.
      writeState(config, c, { version: STATE_VERSION, checks: nextChecks, pendingEvent: event });
      const sent = deliverAlert(config, c, event);
      if (sent.ok) {
        writeState(config, c, { version: STATE_VERSION, checks: nextChecks, pendingEvent: null });
        log.success(`monitor: delivered ${event.alerts.length} alert(s) (event ${event.eventId})`);
      } else {
        log.error(`monitor: alert delivery FAILED (event ${event.eventId} retained for retry)`);
        exitCode = EXIT.MONITOR_ERROR;
      }
    } else {
      writeState(config, c, { version: STATE_VERSION, checks: nextChecks, pendingEvent: null });
    }

    for (const r of results) {
      const mark = { ok: '✓', warn: '▲', crit: '✗', unknown: '?' }[r.status] || '?';
      log.step(`${mark} ${r.id}: ${r.message}`);
    }
    log.info(`monitor: ${results.filter((r) => r.status === 'ok').length}/${results.length} ok, ${results.filter((r) => r.status === 'crit').length} crit, ${results.filter((r) => r.status === 'unknown').length} unknown, ${newAlerts.length} new alert(s)`);
    return { exitCode, results, alerts: newAlerts };
  } finally {
    release();
  }
}

module.exports = { monitor, stepCheck, readState, writeState, deliverAlert, EXIT, STATE_VERSION };
