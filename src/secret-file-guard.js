'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync: nodeExecFileSync } = require('child_process');

const PATTERN_KINDS = new Set([
  'basename-equals',
  'basename-prefix',
  'basename-suffix',
  'path-segment',
  'root-path',
]);

function validateSecretPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Guard config must define a `secrets` object');
  }
  if (!Array.isArray(policy.patterns) || policy.patterns.length === 0) {
    throw new Error('secrets.patterns must be a non-empty array');
  }
  for (const [index, pattern] of policy.patterns.entries()) {
    if (
      !pattern
      || !PATTERN_KINDS.has(pattern.kind)
      || typeof pattern.value !== 'string'
      || !pattern.value
    ) {
      throw new Error(
        `secrets.patterns[${index}] must define a supported kind and non-empty string value`,
      );
    }
  }
}

function patternMatches(file, pattern) {
  const basename = path.basename(file);
  switch (pattern.kind) {
    case 'basename-equals': return basename === pattern.value;
    case 'basename-prefix': return basename.startsWith(pattern.value);
    case 'basename-suffix': return basename.endsWith(pattern.value);
    case 'path-segment': return file.split('/').includes(pattern.value);
    case 'root-path': return file === pattern.value || file.startsWith(`${pattern.value}/`);
    default: return false;
  }
}

// 64 MiB — comfortably above Node's 1 MiB execFileSync default so a repo with
// a very large tracked/untracked path list doesn't overflow, while still
// bounded rather than unlimited.
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(execFileSync, projectRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
  } catch (error) {
    if (error && error.code === 'ENOBUFS') {
      throw new Error(
        `git ${args.join(' ')} produced more than ${GIT_OUTPUT_MAX_BUFFER} bytes of output — `
        + 'this is a fixed 64 MiB cap; narrow the check with --dir to scan a smaller project root',
      );
    }
    throw error;
  }
}

function gitLines(execFileSync, projectRoot, args) {
  return runGit(execFileSync, projectRoot, args).split('\0').filter(Boolean);
}

// `git status` paths are always relative to the repository root, even when
// run with cwd inside a subdirectory — unlike `git ls-files`, which resolves
// paths relative to cwd. When `--dir` points at a nested project root (a
// subdirectory of a larger repo), a raw status path both means something
// different than the ls-files paths above and can name a file entirely
// outside projectRoot. Re-root it onto projectRoot, or drop it if it falls
// outside.
function toProjectRelative(repoRootAbs, projectRootAbs, repoRelativePath) {
  const relative = path.relative(projectRootAbs, path.join(repoRootAbs, repoRelativePath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function verifyNoSecrets({ projectRoot, policy }, ctx = {}) {
  const execFileSync = ctx.execFileSync || nodeExecFileSync;
  validateSecretPolicy(policy);
  let trackedFiles;
  let untrackedNotIgnored;
  try {
    trackedFiles = gitLines(execFileSync, projectRoot, ['ls-files', '-z']);
    const repoRootAbs = runGit(execFileSync, projectRoot, ['rev-parse', '--show-toplevel']).trim();
    const projectRootAbs = fs.realpathSync(path.resolve(projectRoot));
    untrackedNotIgnored = gitLines(
      execFileSync,
      projectRoot,
      // `-- .` scopes the scan to cwd (projectRoot) instead of the whole
      // repository — porcelain paths stay repo-root-relative regardless (see
      // toProjectRelative below), so this only narrows which entries git
      // considers, not how they're formatted.
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
    )
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .map((repoRelativePath) => toProjectRelative(repoRootAbs, projectRootAbs, repoRelativePath))
      .filter((file) => file !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, violations: [], errors: [`cannot inspect git working tree: ${message}`] };
  }

  const violations = [];
  const inspect = (file, reason) => {
    const pattern = policy.patterns.find((candidate) => patternMatches(file, candidate));
    if (pattern) {
      violations.push({
        file,
        pattern: pattern.name || `${pattern.kind}:${pattern.value}`,
        reason,
      });
    }
  };
  for (const file of trackedFiles) inspect(file, 'tracked by git');
  for (const file of untrackedNotIgnored) {
    inspect(file, 'untracked and not gitignored — `git add -A` would stage it');
  }

  return {
    ok: violations.length === 0,
    violations,
    errors: [],
    checkedPatterns: policy.patterns.length,
  };
}

module.exports = { PATTERN_KINDS, patternMatches, verifyNoSecrets };
