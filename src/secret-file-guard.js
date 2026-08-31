'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

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

function gitLines(projectRoot, args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function verifyNoSecrets({ projectRoot, policy }) {
  validateSecretPolicy(policy);
  let trackedFiles;
  let untrackedNotIgnored;
  try {
    trackedFiles = gitLines(projectRoot, ['ls-files', '-z']);
    untrackedNotIgnored = gitLines(
      projectRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    )
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3));
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
