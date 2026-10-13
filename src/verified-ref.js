'use strict';

// `requireVerifiedRef` (BRAIN-567): production only ever receives a commit the
// merge train's full suite verified, i.e. one contained in the named ref
// (normally `green`). ONE rule, called from the legacy pipeline (deploy.js)
// and the release layout (release.js); `deploy --on-host` runs the same
// deploy() on the host, so it inherits both. There is no override flag.
const { wouldAutoCutRun } = require('./auto-cut');

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// Config-time check: null means the guard is off. Returns problem strings.
function verifiedRefProblems(raw, source) {
  const value = raw.requireVerifiedRef;
  if (value == null) return [];
  if (typeof value !== 'string') return [];  // the generic type check already reports it
  const problems = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..')) {
    problems.push(`${source}: "requireVerifiedRef" ("${value}") must be a plain branch name (non-empty, letters, digits, ".", "_", "-", "/"; no whitespace, no leading "-", no "..")`);
  }
  if (typeof raw.branch === 'string' && value === raw.branch) {
    problems.push(`${source}: "requireVerifiedRef" must differ from "branch" ("${raw.branch}") -- the verified ref is what lags the branch`);
  }
  if (raw.autoCut != null && raw.autoCut !== false) {
    problems.push(`${source}: "requireVerifiedRef" cannot be combined with "autoCut" -- auto-cut creates a new merge that "${value}" cannot contain`);
  }
  return problems;
}

// Run-time check at the top of deploy()/deployRelease(), before any target command.
function assertVerifiedRefOptions(config, options = {}, ctx = {}) {
  const ref = config.requireVerifiedRef;
  if (!ref) return;
  if (options.branch !== undefined) {
    throw new Error(
      `deploy: --branch is refused when requireVerifiedRef is set -- the verified ref "${ref}" decides what ships. `
      + `Use --sha with a commit contained in ${config.remote}/${ref} instead.`,
    );
  }
  if (wouldAutoCutRun(config, options, ctx)) {
    throw new Error(
      `deploy: auto-cut would run, but requireVerifiedRef ("${ref}") is set and a freshly cut release cannot be `
      + `contained in "${ref}". Pass --no-auto-cut.`,
    );
  }
}

function verifiedRefLabel(config) {
  return `verified ref "${config.requireVerifiedRef}"`;
}

// `probe.fetch()` / `probe.revParse()` return { ok, output } from the target.
// Returns the verified tip, or throws before anything has been touched.
function resolveVerifiedTip(config, probe) {
  const ref = config.requireVerifiedRef;
  const fetched = probe.fetch();
  const tip = fetched.ok ? (probe.revParse().output || '').trim() : '';
  if (!FULL_SHA_RE.test(tip)) {
    throw new Error(
      `Deploy aborted: could not resolve the verified ref "${ref}" on ${config.remote} -- the merge train has not `
      + `verified anything yet (no "${ref}" branch). Nothing was changed.`,
    );
  }
  return tip;
}

// `isAncestor()` returns true when `sha` is an ancestor of (or equal to) the tip.
function assertContainedInVerified(config, sha, tip, isAncestor) {
  if (isAncestor()) return;
  throw new Error(
    `Deploy aborted: ${sha} has not passed the full suite (not contained in ${config.remote}/${config.requireVerifiedRef} `
    + `${tip.slice(0, 12)}). Wait for the train to advance "${config.requireVerifiedRef}" past it.`,
  );
}

module.exports = {
  verifiedRefProblems, assertVerifiedRefOptions, verifiedRefLabel, resolveVerifiedTip, assertContainedInVerified,
};
