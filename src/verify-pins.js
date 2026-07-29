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

// Resolve the INSTALLED package the way node's own require resolution does,
// but BOUNDED to the project — walk up from `startDir` looking for
// node_modules/<name>/package.json, stopping once `boundaryDir` (inclusive)
// has been checked. A nested workspace package (e.g. packages/api) correctly
// finds a dependency hoisted to the repo-root node_modules by passing the
// workspace root as `boundaryDir`; a standalone project passes its own dir
// (the default), so no ancestor walk happens at all. A `.git` directory is an
// additional hard ceiling regardless of `boundaryDir` — never resolved past.
//
// Unbounded (walk-to-filesystem-root) resolution is PKG-108 finding 2: a
// project that never installed a dependency would pass if ANY ancestor
// directory — even one totally unrelated to this project, like a sibling
// package's node_modules — happened to have a same-named copy. A pnpm
// symlinked layout resolves through this the same way — fs follows the
// symlink to its real target.
function resolveInstalled(startDir, name, boundaryDir = startDir) {
  const boundary = path.resolve(boundaryDir);
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
    if (fs.existsSync(path.join(dir, '.git')) || dir === boundary) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root (defensive; boundary should hit first)
    dir = parent;
  }
}

// The forced re-install that actually fixes a mismatch/missing pin — see the
// module doc. Uses the owner/repo/ref parsed from the manifest itself, not a
// hardcoded org, so it is correct for every consumer, not just this fleet.
function remediationCommand({ owner, repo, ref }) {
  return `npm install "github:${owner}/${repo}#${ref}" --save`;
}

// Check one pin against what's actually installed in `dir`, bounded to
// `boundaryDir` (defaults to `dir` — see resolveInstalled). Pure given the
// parsed pin and directories — the testable core `checkPin` builds on.
function checkPin(pin, dir, boundaryDir = dir) {
  const semverMatch = pin.ref && SEMVER_TAG_RE.exec(pin.ref);
  if (!semverMatch) return { ...pin, status: 'unverifiable' };

  const expectedVersion = semverMatch[1];
  const installed = resolveInstalled(dir, pin.name, boundaryDir);
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

// --- Workspace member discovery (PKG-108 finding 1) ------------------------
//
// `verifyPins` reading only the root package.json silently skips every
// sub-package's pins when run at a workspace root. Support both npm/yarn
// (the root `workspaces` field, array or `{ packages: [...] }` object form)
// and pnpm (`pnpm-workspace.yaml`'s `packages:` glob list), and check every
// member manifest too. No runtime dependency is added for glob expansion —
// `engines` pins Node >=20 (fs.globSync needs 22+), so this is a small
// hand-rolled matcher instead.

// Directory names never worth descending into while expanding a workspace
// glob — huge, irrelevant, and (for node_modules) would make an unrelated
// nested package look like a workspace member.
const GLOB_SKIP_DIRS = new Set(['node_modules', '.git']);

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function segmentToRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function listDirsRecursive(dir) {
  const out = [];
  for (const ent of readdirSafe(dir)) {
    if (!ent.isDirectory() || GLOB_SKIP_DIRS.has(ent.name)) continue;
    const sub = path.join(dir, ent.name);
    out.push(sub, ...listDirsRecursive(sub));
  }
  return out;
}

// Expand one glob pattern (e.g. `packages/*`, `apps/**`, or a literal path)
// relative to `rootDir` into the absolute directories it matches on disk.
function expandGlobDirs(rootDir, pattern) {
  const segments = pattern.split('/').filter(Boolean);
  let currentDirs = [rootDir];
  for (const segment of segments) {
    const next = [];
    if (segment === '**') {
      for (const dir of currentDirs) next.push(dir, ...listDirsRecursive(dir));
    } else if (segment.includes('*')) {
      const re = segmentToRegex(segment);
      for (const dir of currentDirs) {
        for (const ent of readdirSafe(dir)) {
          if (ent.isDirectory() && !GLOB_SKIP_DIRS.has(ent.name) && re.test(ent.name)) {
            next.push(path.join(dir, ent.name));
          }
        }
      }
    } else {
      for (const dir of currentDirs) {
        const candidate = path.join(dir, segment);
        try {
          if (fs.statSync(candidate).isDirectory()) next.push(candidate);
        } catch {
          // no such directory — not a match
        }
      }
    }
    currentDirs = next;
  }
  return currentDirs;
}

// Read the `workspaces` field off the root package.json (array or `{ packages
// }` object form). Returns a list of glob patterns, `!`-prefixed entries
// meaning "exclude".
function npmWorkspacePatterns(rootPkg) {
  const ws = rootPkg.workspaces;
  if (Array.isArray(ws)) return ws.filter((p) => typeof p === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter((p) => typeof p === 'string');
  }
  return [];
}

// Minimal `packages:` glob-list reader for pnpm-workspace.yaml. No YAML
// dependency is added (none exists in this package) — the file's contract is
// a flat `packages:` key followed by `  - 'glob'` list items, which this
// hand-rolled reader is sufficient for.
function pnpmWorkspacePatterns(rootDir) {
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
  let raw;
  try {
    raw = fs.readFileSync(yamlPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const patterns = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item) {
        patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
        continue;
      }
      if (/^\S/.test(line)) inPackages = false; // dedented to a new top-level key
    }
  }
  return patterns;
}

// Every workspace member manifest declared by the root — npm/yarn
// `workspaces` and/or pnpm's `pnpm-workspace.yaml`, merged and deduped. Each
// entry is `{ dir, pkgPath, pkg }`; entries whose matched directory has no
// package.json are skipped (a glob match is not necessarily a package).
function findWorkspaceMembers(rootDir, rootPkg) {
  const patterns = [...npmWorkspacePatterns(rootPkg), ...pnpmWorkspacePatterns(rootDir)];
  if (!patterns.length) return [];

  const included = new Set();
  const excluded = new Set();
  for (const pattern of patterns) {
    const negate = pattern.startsWith('!');
    const dirs = expandGlobDirs(rootDir, negate ? pattern.slice(1) : pattern);
    for (const dir of dirs) (negate ? excluded : included).add(dir);
  }

  const members = [];
  const seen = new Set();
  for (const dir of included) {
    if (excluded.has(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue; // matched dir, but not a package
    members.push({ dir, pkgPath, pkg: readPackageJson(pkgPath) });
  }
  return members;
}

// Read and parse a package.json, throwing the same operator-facing error
// verifyPins has always thrown for an unreadable root manifest — extended to
// every workspace member manifest too, so a broken member manifest fails the
// run loudly instead of being silently skipped (PKG-108 finding 1 is exactly
// "silently skipped" being the bug).
function readPackageJson(pkgPath) {
  let raw;
  try {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } catch (error) {
    throw new Error(`verify-pins: cannot read ${pkgPath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`verify-pins: cannot read ${pkgPath}: ${error.message}`);
  }
}

// Read <dir>/package.json, check every GitHub-shorthand pin against what's
// actually installed — the root manifest AND, if it declares a workspace
// (npm/yarn `workspaces`, or a pnpm-workspace.yaml), every member manifest
// too (PKG-108 finding 1 — a workspace root run used to check only the root
// and silently skip every sub-package). Never touches the network — this is
// entirely package.json + node_modules reads. Backs the `deploy-kit
// verify-pins` CLI command.
//
// A workspace member's pins are resolved with the WORKSPACE ROOT as the
// installed-package search boundary (hoisting-aware); the root's own pins,
// and any standalone (non-workspace) project's pins, are resolved with no
// ancestor walk at all — see resolveInstalled's `boundaryDir`. This bounds
// resolution to the project (finding 2): a same-named package that only
// exists outside that boundary is reported `missing`, never `ok`.
//
// `ok` is false on any mismatch or missing pin (the two outcomes meaning the
// manifest and node_modules disagree). An unverifiable ref never fails the
// run — there's nothing to compare it to — but is always counted separately
// so it can't be mistaken for "checked and fine".
function verifyPins({ dir = process.cwd() } = {}) {
  const rootDir = path.resolve(dir);
  const rootPkgPath = path.join(rootDir, 'package.json');
  const rootPkg = readPackageJson(rootPkgPath);

  const manifests = [{ dir: rootDir, pkgPath: rootPkgPath, pkg: rootPkg, boundaryDir: rootDir }];
  for (const member of findWorkspaceMembers(rootDir, rootPkg)) {
    manifests.push({
      dir: member.dir, pkgPath: member.pkgPath, pkg: member.pkg, boundaryDir: rootDir,
    });
  }

  const entries = [];
  for (const manifest of manifests) {
    const manifestRel = path.relative(rootDir, manifest.pkgPath) || 'package.json';
    for (const pin of collectPins(manifest.pkg)) {
      entries.push({ ...checkPin(pin, manifest.dir, manifest.boundaryDir), manifest: manifestRel });
    }
  }

  const summary = {
    ok: entries.filter((e) => e.status === 'ok').length,
    mismatch: entries.filter((e) => e.status === 'mismatch').length,
    missing: entries.filter((e) => e.status === 'missing').length,
    unverifiable: entries.filter((e) => e.status === 'unverifiable').length,
    manifests: manifests.length,
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
// the CLI can print them at different severities (error vs warning). Every
// line names the repo-relative manifest path a problem was found in — a bare
// package name is not actionable once a run covers more than one manifest
// (PKG-108 finding 1).
function formatReport(result) {
  const problemLines = [];
  const unverifiableLines = [];
  for (const e of result.entries) {
    if (e.status === 'mismatch') {
      problemLines.push(`MISMATCH  ${e.manifest}  ${describePin(e)} (want ${e.expectedVersion}), installed ${e.installedVersion}`);
      problemLines.push(`  fix: ${e.remediation}`);
    } else if (e.status === 'missing') {
      problemLines.push(`MISSING   ${e.manifest}  ${describePin(e)} (want ${e.expectedVersion}), not installed`);
      problemLines.push(`  fix: ${e.remediation}`);
    } else if (e.status === 'unverifiable') {
      unverifiableLines.push(`unverifiable  ${e.manifest}  ${describePin(e)} — not a semver tag, cannot verify against an installed version`);
    }
  }
  const {
    ok, mismatch, missing, unverifiable, manifests,
  } = result.summary;
  // Manifest count is folded into the summary line only when there's more
  // than one manifest, so a plain single-package run's summary text is
  // unchanged from before this fix.
  const manifestSuffix = manifests > 1 ? ` across ${manifests} manifests` : '';
  const summaryLine = `verify-pins: ${ok} ok, ${mismatch} MISMATCH, ${missing} missing, ${unverifiable} unverifiable (non-semver refs)${manifestSuffix}`;
  return { problemLines, unverifiableLines, summaryLine };
}

module.exports = {
  parseGithubSpecifier, resolveInstalled, checkPin, verifyPins, formatReport,
};
