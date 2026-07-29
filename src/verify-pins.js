'use strict';

const fs = require('fs');
const path = require('path');

// `npm install` does NOT re-resolve a `github:owner/repo#<ref>` dependency when
// only the ref changes — the lockfile is keyed on the resolved commit, so
// bumping the pin and installing exits 0 while leaving the OLD code in
// node_modules. This module compares what package.json ASSERTS against what is
// actually installed, so that lie shows up before a deploy ships it. Reproduced
// against a live package, not theorised — see PKG-108.

// Matches the two GitHub dependency shorthands npm accepts as a dependency
// VALUE: `github:owner/repo#<ref>` and the bare `owner/repo#<ref>` npm also
// resolves as GitHub. Anything else — a semver range, `file:`, `workspace:`,
// `npm:`, a full `git+https://` URL — does not match and is ignored; this
// module only ever looks at pins it could compare to an installed version.
const GITHUB_SPEC_RE = /^(?:github:)?([\w.-]+)\/([\w.-]+)(?:#(\S+))?$/;

// A ref that names an exact semver version, with or without a leading `v`,
// including prerelease (`v1.8.0-rc.1`). Anything else pinned to a ref — a
// branch (`main`), a commit SHA, an npm `semver:` RANGE, or a missing ref —
// cannot be compared to a single installed `version` field, so checkPin()
// reports it unverifiable rather than silently treating it as passing.
const SEMVER_TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Parse a dependency specifier into { owner, repo, ref } if it is a GitHub
// shorthand pin, else null. `ref` is null when the specifier has no `#<ref>`
// at all (pins to the default branch).
function parseGithubSpecifier(specifier) {
  if (typeof specifier !== 'string') return null;
  const m = GITHUB_SPEC_RE.exec(specifier.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] || null };
}

// Every GitHub-shorthand pin across dependencies/devDependencies/
// optionalDependencies/peerDependencies, tagged with which field it came from.
function collectPins(pkg) {
  const pins = [];
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, specifier] of Object.entries(deps)) {
      const parsed = parseGithubSpecifier(specifier);
      if (parsed) pins.push({
        name, field, specifier, owner: parsed.owner, repo: parsed.repo, ref: parsed.ref,
      });
    }
  }
  return pins;
}

// Resolve the INSTALLED package the way node's own require resolution does:
// walk up from `startDir` looking for node_modules/<name>/package.json, so a
// nested workspace package (e.g. packages/api) correctly finds a dependency
// hoisted to the repo-root node_modules. A pnpm symlinked layout resolves
// through this the same way — fs follows the symlink to its real target.
function resolveInstalled(startDir, name) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch {
        return null; // present but unreadable/corrupt — treat as not resolvable
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// The forced re-install that actually fixes a mismatch/missing pin — see the
// module doc. Uses the owner/repo/ref parsed from the manifest itself, not a
// hardcoded org, so it is correct for every consumer, not just this fleet.
function remediationCommand({ owner, repo, ref }) {
  return `npm install "github:${owner}/${repo}#${ref}" --save`;
}

// Check one pin against what's actually installed in `dir`. Pure given the
// parsed pin and a directory — the testable core `checkPin` builds on.
function checkPin(pin, dir) {
  const semverMatch = pin.ref && SEMVER_TAG_RE.exec(pin.ref);
  if (!semverMatch) return { ...pin, status: 'unverifiable' };

  const expectedVersion = semverMatch[1];
  const installed = resolveInstalled(dir, pin.name);
  if (!installed) {
    return {
      ...pin, status: 'missing', expectedVersion, remediation: remediationCommand(pin),
    };
  }
  if (installed.version !== expectedVersion) {
    return {
      ...pin,
      status: 'mismatch',
      expectedVersion,
      installedVersion: installed.version,
      remediation: remediationCommand(pin),
    };
  }
  return {
    ...pin, status: 'ok', expectedVersion, installedVersion: installed.version,
  };
}

// Read <dir>/package.json, check every GitHub-shorthand pin against what's
// actually installed. Never touches the network — this is entirely a
// package.json + node_modules read. Backs the `deploy-kit verify-pins`
// CLI command.
//
// `ok` is false on any mismatch or missing pin (the two outcomes meaning the
// manifest and node_modules disagree). An unverifiable ref never fails the
// run — there's nothing to compare it to — but is always counted separately
// so it can't be mistaken for "checked and fine".
function verifyPins({ dir = process.cwd() } = {}) {
  const pkgPath = path.join(dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    throw new Error(`verify-pins: cannot read ${pkgPath}: ${error.message}`);
  }

  const entries = collectPins(pkg).map((pin) => checkPin(pin, dir));
  const summary = {
    ok: entries.filter((e) => e.status === 'ok').length,
    mismatch: entries.filter((e) => e.status === 'mismatch').length,
    missing: entries.filter((e) => e.status === 'missing').length,
    unverifiable: entries.filter((e) => e.status === 'unverifiable').length,
  };
  const ok = summary.mismatch === 0 && summary.missing === 0;
  return { ok, entries, summary };
}

function describePin({ name, ref }) {
  return ref ? `${name}: pinned #${ref}` : `${name}: pinned (no ref — resolves to the default branch)`;
}

// Format a verifyPins() result into human-readable report lines + the one-line
// summary. Pure — no I/O — so the exact wording is independently testable.
// Problems (mismatch/missing) and unverifiable refs are returned separately so
// the CLI can print them at different severities (error vs warning).
function formatReport(result) {
  const problemLines = [];
  const unverifiableLines = [];
  for (const e of result.entries) {
    if (e.status === 'mismatch') {
      problemLines.push(`MISMATCH  ${describePin(e)} (want ${e.expectedVersion}), installed ${e.installedVersion}`);
      problemLines.push(`  fix: ${e.remediation}`);
    } else if (e.status === 'missing') {
      problemLines.push(`MISSING   ${describePin(e)} (want ${e.expectedVersion}), not installed`);
      problemLines.push(`  fix: ${e.remediation}`);
    } else if (e.status === 'unverifiable') {
      unverifiableLines.push(`unverifiable  ${describePin(e)} — not a semver tag, cannot verify against an installed version`);
    }
  }
  const { ok, mismatch, missing, unverifiable } = result.summary;
  const summaryLine = `verify-pins: ${ok} ok, ${mismatch} MISMATCH, ${missing} missing, ${unverifiable} unverifiable (non-semver refs)`;
  return { problemLines, unverifiableLines, summaryLine };
}

module.exports = {
  parseGithubSpecifier, resolveInstalled, checkPin, verifyPins, formatReport,
};
