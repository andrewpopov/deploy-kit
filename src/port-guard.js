'use strict';

const { execFileSync: nodeExecFileSync } = require('child_process');

// Runtime seam so port-guard is unit-testable: tests inject a fake execFileSync
// and assert behavior without real lsof/ss/pm2/pgrep on the machine running tests.
function normalizeRuntime(runtime = {}) {
  return { execFileSync: runtime.execFileSync || nodeExecFileSync };
}

// Run a command, returning trimmed stdout on success or '' on any failure (missing
// binary, non-zero exit, nothing found) — every caller here treats "no output" and
// "command failed" identically, matching the shell `|| true` idiom in the original.
function tryRun(execFileSync, file, args) {
  try {
    return String(execFileSync(file, args, { encoding: 'utf8' }) || '').trim();
  } catch {
    return '';
  }
}

function commandExists(execFileSync, name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

const PID_RE = /^\d+$/;

// PIDs of every process holding a LISTEN socket on `port`. lsof is preferred
// (unambiguous PID output); ss is the fallback (parses `pid=<n>` out of its
// `-p` output). { source: null, pids: [] } when neither tool is present.
function getListeningPids(port, execFileSync) {
  if (commandExists(execFileSync, 'lsof')) {
    const out = tryRun(execFileSync, 'lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
    const pids = out.split('\n').map((s) => s.trim()).filter((s) => PID_RE.test(s));
    return { source: 'lsof', pids: uniq(pids) };
  }
  if (commandExists(execFileSync, 'ss')) {
    const out = tryRun(execFileSync, 'ss', ['-ltnp', `sport = :${port}`]);
    const pids = [];
    for (const line of out.split('\n')) {
      const m = line.match(/pid=(\d+)/);
      if (m) pids.push(m[1]);
    }
    return { source: 'ss', pids: uniq(pids) };
  }
  return { source: null, pids: [] };
}

// Root PID(s) of a PM2-managed process by name.
function getPm2Pids(processName, execFileSync) {
  const out = tryRun(execFileSync, 'pm2', ['pid', processName]);
  const pids = out.split(/\s+/).map((s) => s.trim()).filter((s) => PID_RE.test(s) && Number(s) > 0);
  return uniq(pids);
}

function getChildPids(pid, execFileSync) {
  if (commandExists(execFileSync, 'pgrep')) {
    const out = tryRun(execFileSync, 'pgrep', ['-P', pid]);
    return out.split('\n').map((s) => s.trim()).filter((s) => PID_RE.test(s));
  }
  const out = tryRun(execFileSync, 'ps', ['-o', 'pid=', '--ppid', pid]);
  return out.split('\n').map((s) => s.trim()).filter((s) => PID_RE.test(s));
}

// BFS the process tree rooted at `rootPids` (pgrep -P / ps --ppid), matching the
// bash `get_descendant_pids` this ports. Returns a Set of every pid discovered,
// including the roots themselves.
function getDescendantPids(rootPids, execFileSync) {
  const known = new Set(rootPids);
  let frontier = [...rootPids];
  while (frontier.length) {
    const next = [];
    for (const parent of frontier) {
      for (const child of getChildPids(parent, execFileSync)) {
        if (!known.has(child)) {
          known.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return known;
}

// Port-conflict guard for a PM2-managed reload: is every process currently
// LISTENing on `port` owned by `processName` (its PM2 pid or a descendant)? Ports
// a shared multi-tenant host from a deploy reload colliding with an unrelated
// process squatting on the same port.
//
//   no listeners                -> ok:true  (port free)
//   all listeners are ours      -> ok:true
//   any listener is foreign     -> ok:false, names the squatting PID(s)
//   neither lsof nor ss present -> ok:false, FAIL-CLOSED (loud; see README) —
//     an unverifiable guard is not a passed guard, and a squatting process on an
//     unguarded host is exactly the failure mode this check exists to catch.
function checkPortGuard(port, processName, { runtime, log } = {}) {
  const { execFileSync } = normalizeRuntime(runtime);
  const { source, pids: listening } = getListeningPids(port, execFileSync);

  if (!source) {
    const message = `Neither lsof nor ss is available; cannot verify port ${port} is safe for `
      + `${processName} to reload. Failing closed — install lsof or ss on this host.`;
    if (log) log.warning(message);
    return { ok: false, message };
  }

  if (!listening.length) {
    return { ok: true, message: `Port ${port} is free for deployment` };
  }

  const pm2Pids = getPm2Pids(processName, execFileSync);
  const safePids = pm2Pids.length ? getDescendantPids(pm2Pids, execFileSync) : new Set();
  const foreign = listening.filter((pid) => !safePids.has(pid));

  if (foreign.length) {
    const message = `Port ${port} is already used by process(es) not owned by "${processName}": `
      + `PID ${foreign.join(', ')}. Refusing to reload — this would take an unrelated process offline. `
      + `Configure a dedicated port for ${processName} before deploying.`;
    return { ok: false, message };
  }

  return { ok: true, message: `Port ${port} is currently owned by ${processName} (pid ${listening.join(', ')}); reload is safe` };
}

module.exports = {
  normalizeRuntime, getListeningPids, getPm2Pids, getChildPids, getDescendantPids, checkPortGuard,
};
