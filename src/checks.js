'use strict';

const { runOnTarget } = require('./exec');

// Each check returns one or more results: { id, status, message, detail?, meta? }.
// status is ok | warn | crit | UNKNOWN — 'unknown' means "could not determine health"
// (ssh/command failure, unparseable output) and is DISTINCT from ok and crit: the
// state machine must never treat unknown as a recovery or a confirmed failure.
// `id` is a stable, collision-free key (pm2:<app>, disk:<path>, public:<id>, …) used
// as the per-check state key. `meta` carries data the state machine persists (e.g. a
// restart baseline). Secrets (probe headers) never appear in message/detail.

const DEFAULT_CHECK_TIMEOUT = 20;

function cap(config, ctx, command, timeoutSeconds) {
  return runOnTarget(command, config, { capture: true, runtime: ctx.runtime, timeoutSeconds });
}

// Read `pm2 jlist` once; shared by the pm2/restart/tunnel checks. Returns
// { list } or { error } — a failed/invalid jlist is an UNKNOWN input, never "all down".
function readPm2(config, ctx, timeoutSeconds) {
  const res = cap(config, ctx, 'pm2 jlist', timeoutSeconds);
  if (!res.ok) return { error: 'pm2 jlist failed' };
  try {
    const list = JSON.parse(res.output || '[]');
    return Array.isArray(list) ? { list } : { error: 'pm2 jlist not an array' };
  } catch {
    return { error: 'pm2 jlist not valid JSON' };
  }
}

function procStatus(pm2, name) {
  const procs = (pm2.list || []).filter((p) => p && p.name === name);
  if (!procs.length) return { present: false };
  // Every instance must be online (cluster-mode-safe default).
  const statuses = procs.map((p) => (p.pm2_env && p.pm2_env.status) || p.status || 'unknown');
  return { present: true, online: statuses.every((s) => s === 'online'), statuses, procs };
}

// pm2: one result per appName. A missing app is crit; not-online is crit; jlist
// failure is unknown (per app, so recovery/escalation attributes correctly).
function checkPm2(config, pm2) {
  return config.appNames.map((name) => {
    const id = `pm2:${name}`;
    if (pm2.error) return { id, status: 'unknown', message: `${name}: pm2 state unknown (${pm2.error})` };
    const s = procStatus(pm2, name);
    if (!s.present) return { id, status: 'crit', message: `${name} is not registered in pm2` };
    return s.online
      ? { id, status: 'ok', message: `${name} online` }
      : { id, status: 'crit', message: `${name} not online (${s.statuses.join(',')})` };
  });
}

// restart-storm: alert when an app's pm2 restart_time grew by MORE than maxDelta
// since the last run. Handles counter resets (delete/recreate ⇒ current < baseline ⇒
// re-baseline, not an alert) and first observation (establish baseline, ok). The new
// baseline is returned in meta for the state machine to persist.
function checkRestartStorm(config, pm2, prevMeta, maxDelta) {
  return config.appNames.map((name) => {
    const id = `restart:${name}`;
    if (pm2.error) return { id, status: 'unknown', message: `${name}: restart count unknown (${pm2.error})` };
    const s = procStatus(pm2, name);
    if (!s.present) return { id, status: 'unknown', message: `${name}: not in pm2, cannot read restart count` };
    const current = Math.max(...s.procs.map((p) => (p.pm2_env && p.pm2_env.restart_time) || 0));
    const prev = prevMeta && prevMeta[id] && typeof prevMeta[id].restart === 'number' ? prevMeta[id].restart : null;
    const meta = { [id]: { restart: current } };
    if (prev == null) return { id, status: 'ok', message: `${name}: baseline ${current} restarts`, meta };
    const delta = current - prev;
    if (delta < 0) return { id, status: 'ok', message: `${name}: restart counter reset (${prev}→${current}); re-baselined`, meta };
    if (delta > maxDelta) return { id, status: 'crit', message: `${name}: ${delta} restarts since last check (> ${maxDelta})`, meta };
    return { id, status: 'ok', message: `${name}: ${delta} restarts since last check`, meta };
  });
}

// tunnel: the configured tunnel process is online (proves the process exists — NOT
// that ingress works; the public probe proves routing).
function checkTunnel(config, pm2) {
  if (!config.monitor.tunnel || !config.tunnelName) return [];
  const id = `tunnel:${config.tunnelName}`;
  if (pm2.error) return [{ id, status: 'unknown', message: `tunnel state unknown (${pm2.error})` }];
  const s = procStatus(pm2, config.tunnelName);
  if (!s.present) return [{ id, status: 'crit', message: `tunnel ${config.tunnelName} not registered in pm2` }];
  return [s.online
    ? { id, status: 'ok', message: `tunnel ${config.tunnelName} online` }
    : { id, status: 'crit', message: `tunnel ${config.tunnelName} not online (${s.statuses.join(',')})` }];
}

// disk: crit if free BYTES or free INODES on projectDir's filesystem falls below the
// threshold (OR, not AND). LC_ALL=C for a stable, machine-readable df. Unreadable df
// or a non-existent path ⇒ unknown (fail-closed against a false "ok").
function checkDisk(config, ctx, timeoutSeconds) {
  const d = config.monitor.disk;
  if (!d) return [];
  const id = `disk:${config.projectDir}`;
  const minKiB = d.minFreeKiB != null ? d.minFreeKiB : 512 * 1024;
  const minInodes = d.minFreeInodes != null ? d.minFreeInodes : 10000;
  const bytesRes = cap(config, ctx, `LC_ALL=C df -kP '${config.projectDir}' | awk 'NR==2{print $4}'`, timeoutSeconds);
  const availKiB = parseInt((bytesRes.output || '').trim(), 10);
  if (!bytesRes.ok || !Number.isFinite(availKiB)) return [{ id, status: 'unknown', message: `disk: could not read free space on ${config.projectDir}` }];
  const inodeRes = cap(config, ctx, `LC_ALL=C df -iP '${config.projectDir}' | awk 'NR==2{print $4}'`, timeoutSeconds);
  const ifreeRaw = (inodeRes.output || '').trim();
  const problems = [];
  if (availKiB < minKiB) problems.push(`${availKiB} KiB free < ${minKiB} KiB`);
  // Inodes: '-' means the FS doesn't report them (skip). A command failure or any
  // non-numeric, non-'-' value is UNKNOWN — never silently treat it as healthy.
  if (ifreeRaw !== '-') {
    if (!inodeRes.ok || !/^\d+$/.test(ifreeRaw)) return [{ id, status: 'unknown', message: `disk: could not read free inodes on ${config.projectDir}` }];
    if (parseInt(ifreeRaw, 10) < minInodes) problems.push(`${ifreeRaw} inodes free < ${minInodes}`);
  }
  return [problems.length
    ? { id, status: 'crit', message: `disk pressure on ${config.projectDir}: ${problems.join('; ')}` }
    : { id, status: 'ok', message: `disk ok (${availKiB} KiB free)` }];
}

// backup: the freshness stamp's mtime is within maxAgeHours. Contract: the backup job
// updates the stamp ONLY after a verified successful backup. Missing stamp ⇒ crit; a
// stat error ⇒ unknown; a future mtime ⇒ unknown (clock skew / tampering).
function checkBackup(config, ctx, nowMs, timeoutSeconds) {
  const b = config.monitor.backup;
  if (!b) return [];
  const id = `backup:${b.id || 'default'}`;
  const maxAgeHours = b.maxAgeHours != null ? b.maxAgeHours : 30;
  // Distinguish MISSING (crit — no backup) from a stat ERROR (unknown — can't tell):
  // absent ⇒ the marker; present ⇒ `stat -c %Y` (a stat failure on a present file
  // makes the command non-zero → res.ok false → unknown), never a false "missing".
  const res = cap(config, ctx, `if [ ! -e '${b.stampFile}' ]; then echo __DK_MISSING__; else stat -c %Y '${b.stampFile}'; fi`, timeoutSeconds);
  const out = (res.output || '').trim();
  if (!res.ok) return [{ id, status: 'unknown', message: `backup: could not stat ${b.stampFile}` }];
  if (out === '__DK_MISSING__') return [{ id, status: 'crit', message: `backup stamp ${b.stampFile} is missing` }];
  const mtimeMs = parseInt(out, 10) * 1000;
  if (!Number.isFinite(mtimeMs)) return [{ id, status: 'unknown', message: `backup: unparseable stamp mtime (${out})` }];
  if (mtimeMs > nowMs + 60000) return [{ id, status: 'unknown', message: `backup stamp mtime is in the future (clock skew?)` }];
  const ageHours = (nowMs - mtimeMs) / 3600000;
  return [ageHours > maxAgeHours
    ? { id, status: 'crit', message: `backup is stale: ${ageHours.toFixed(1)}h old (> ${maxAgeHours}h)` }
    : { id, status: 'ok', message: `backup fresh (${ageHours.toFixed(1)}h old)` }];
}

// public probes: curl the PUBLIC url and assert the status (proves DNS+ingress+TLS+
// routing end-to-end). URL is config-validated (https, no shell metacharacters).
// Headers may hold secrets → they're sent but NEVER echoed. curl failure/timeout ⇒
// crit (cross-run debounce smooths transient DNS/routing blips). Body match optional.
function checkPublicProbes(config, ctx) {
  const probes = config.monitor.publicProbes || [];
  const to = config.monitor.checkTimeoutSeconds || DEFAULT_CHECK_TIMEOUT;
  return probes.map((pr) => {
    const id = `public:${pr.id}`;
    const maxTime = pr.maxTimeSeconds != null ? pr.maxTimeSeconds : Math.max(2, Math.min(to - 1, 10));
    // Headers are validated free of single quotes at config time, so single-quoting
    // is safe here. Values are never echoed in messages (may hold secrets).
    const headerArgs = Object.entries(pr.headers || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
    const codeRes = cap(config, ctx, `curl -sS -o /dev/null -w '%{http_code}' --max-time ${maxTime} ${headerArgs} '${pr.url}'`, to);
    const code = (codeRes.output || '').trim();
    const expected = pr.expectStatus != null ? (Array.isArray(pr.expectStatus) ? pr.expectStatus : [pr.expectStatus]) : [200];
    // A curl failure/timeout (non-zero exit) is crit even if it printed a code (e.g. 000).
    if (!codeRes.ok || !expected.map(String).includes(code)) {
      return { id, status: 'crit', message: `probe ${pr.id}: HTTP ${code || 'no-response'} (expected ${expected.join('/')})` };
    }
    if (pr.expectBodyIncludes) {
      const bodyRes = cap(config, ctx, `curl -fsS --max-time ${maxTime} ${headerArgs} '${pr.url}'`, to);
      if (!bodyRes.ok || !(bodyRes.output || '').includes(pr.expectBodyIncludes)) return { id, status: 'crit', message: `probe ${pr.id}: body check failed` };
    }
    return { id, status: 'ok', message: `probe ${pr.id}: HTTP ${code}` };
  });
}

// custom checks: run an app-supplied command (the seam for app-specific signals, e.g.
// smarthome provider/scheduler readiness) — this is arbitrary code by design (the
// deploy config is trusted). Non-zero exit ⇒ alert at the STATICALLY configured level
// (an exit code can't convey warn-vs-crit). Timeout/kill ⇒ unknown. Output is bounded
// and sanitized before use as a message.
function checkCustom(config, ctx) {
  const checks = config.monitor.checks || [];
  const to = config.monitor.checkTimeoutSeconds || DEFAULT_CHECK_TIMEOUT;
  return checks.map((c) => {
    const id = `custom:${c.id}`;
    const res = cap(config, ctx, c.command, to);
    if (res.ok) return { id, status: 'ok', message: `${c.id}: ok` };
    if (res.error && res.error.code === 'ETIMEDOUT') return { id, status: 'unknown', message: `${c.id}: check timed out` };
    const level = c.level === 'warn' ? 'warn' : 'crit';
    const detail = String(res.output || '').replace(/[^\x20-\x7e]/g, ' ').slice(0, 300).trim();
    return { id, status: level, message: `${c.id}: failed${detail ? ` — ${detail}` : ''}` };
  });
}

// Run every enabled check and return a flat list of results (stable ids).
function runAllChecks(config, ctx, { prevMeta = {}, nowMs }) {
  const to = config.monitor.checkTimeoutSeconds || DEFAULT_CHECK_TIMEOUT;
  const pm2 = readPm2(config, ctx, to);
  const maxDelta = (config.monitor.restartStorm && config.monitor.restartStorm.maxDelta != null) ? config.monitor.restartStorm.maxDelta : 3;
  return [
    ...checkPm2(config, pm2),
    ...(config.monitor.restartStorm ? checkRestartStorm(config, pm2, prevMeta, maxDelta) : []),
    ...checkTunnel(config, pm2),
    ...checkDisk(config, ctx, to),
    ...checkBackup(config, ctx, nowMs, to),
    ...checkPublicProbes(config, ctx),
    ...checkCustom(config, ctx),
  ];
}

module.exports = {
  readPm2, checkPm2, checkRestartStorm, checkTunnel, checkDisk, checkBackup,
  checkPublicProbes, checkCustom, runAllChecks,
};
