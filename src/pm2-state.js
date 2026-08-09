'use strict';

const { runOnTarget } = require('./exec');

// The ONE shared `pm2 jlist` reader. Three call sites used to each parse pm2's
// output their own way (deploy.js's `onlinePm2Apps`, release.js's `readPm2`,
// checks.js's `readPm2`) — this module is the single policy all of them share:
// how the command is run, how its output is tolerantly parsed, which pm2
// statuses count as "may still write to the database", and how "unreadable" is
// signaled. See PTRY-510.

// pm2 states in which a process may be running, or about to be, and could
// therefore still write to the database. `stopped` and `errored` are the only
// states we treat as definitely-not-writing: checking for `online` alone would
// let a process that is mid-launch or scheduled to restart slip past the pause
// verification and into the backup window.
const ACTIVE_PM2_STATUSES = new Set([
  'online', 'launching', 'one-launch-status', 'waiting restart', 'stopping',
]);

// `pm2 jlist` is supposed to emit only JSON, but pm2 has a habit of printing
// update notices and deprecation warnings ahead of it. Parse the array out of
// the noise rather than failing open on a preamble, since failing open here
// means a caller's pause/stop verification silently goes unchecked.
//
// Returns the parsed array, or null if the output could not be read as pm2
// process state — null is a distinct "unknown" result callers must never treat
// as "nothing is running".
function parsePm2List(output) {
  const raw = String(output || '').trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    return Array.isArray(direct) ? direct : null;
  } catch {
    // fall through to preamble stripping
  }
  // Do NOT assume the first '[' opens the array: pm2 prefixes its own notices
  // with a literal "[PM2]", so anchoring on the first bracket picks up the
  // warning and fails to parse — precisely the case this salvage exists for.
  // Try every '[' in order and take the first that yields an array.
  const end = raw.lastIndexOf(']');
  if (end === -1) return null;
  for (let start = raw.indexOf('['); start !== -1 && start < end; start = raw.indexOf('[', start + 1)) {
    try {
      const salvaged = JSON.parse(raw.slice(start, end + 1));
      // Only a NON-EMPTY array is trustworthy here. A genuinely empty process
      // list serializes as exactly `[]` and is handled by the direct parse
      // above; reaching this path with an empty array instead means we matched
      // a bracket pair inside pm2's own noise (`[PM2] warning []`), and
      // reporting that as "nothing is running" would silently pass a caller's
      // verification. Fall through to null so it is reported as unreadable.
      if (Array.isArray(salvaged) && salvaged.length) return salvaged;
    } catch {
      // keep scanning — this '[' was noise, not the array
    }
  }
  return null;
}

// Run `pm2 jlist` on the target through the caller's runner and return the
// tolerantly-parsed process list, or null if it could not be read at all
// (the command failed, or its output wasn't parseable pm2 state).
function readPm2List(config, ctx, { timeoutSeconds } = {}) {
  const res = runOnTarget('pm2 jlist', config, { capture: true, runtime: ctx.runtime, timeoutSeconds });
  if (!res.ok) return null;
  return parsePm2List(res.output);
}

// Given an already-parsed pm2 list, return the subset of `names` currently in
// an ACTIVE_PM2_STATUSES state. A name absent from the list (not registered in
// pm2 at all) is simply not in the returned set, same as one that's registered
// but stopped/errored.
function activeNames(list, names) {
  const active = new Set();
  for (const proc of list || []) {
    if (!proc || !names.includes(proc.name)) continue;
    const status = (proc.pm2_env && proc.pm2_env.status) || proc.status;
    if (ACTIVE_PM2_STATUSES.has(status)) active.add(proc.name);
  }
  return active;
}

// Convenience: read pm2 state and return the ACTIVE subset of `names`, or null
// if pm2 state could not be determined (the read failed, or its output wasn't
// parseable). null is a distinct "unknown" result — callers must never treat
// it as "none online".
function onlineAppNames(names, config, ctx, opts) {
  const list = readPm2List(config, ctx, opts);
  if (list === null) return null;
  return activeNames(list, names);
}

module.exports = {
  ACTIVE_PM2_STATUSES, parsePm2List, readPm2List, activeNames, onlineAppNames,
};
