'use strict';

const { runOnTarget, shQuote } = require('./exec');

// Resolve the deploy branch: explicit config wins, else the target's
// `origin/HEAD` (the remote's default branch), else 'master'. Shared by both
// pipelines (legacy in-place `deploy.js` and the release-layout `release.js`)
// so there is ONE branch-resolution rule, not two — README.md documents the
// same null-branch contract for both modes.
//
// `gitDir` lets a caller point this at a bare/mirror repo (`git --git-dir=<gitDir>`)
// instead of relying on cwd being a working tree with `.git` — the release
// layout's repo lives as a bare mirror under `<root>/repo.git`, never checked
// out at `config.projectDir` itself.
function resolveBranch(config, ctx, { gitDir } = {}) {
  if (config.branch) return config.branch;
  const git = gitDir ? `git --git-dir=${gitDir}` : 'git';
  const res = runOnTarget(
    `${git} rev-parse --abbrev-ref ${shQuote(config.remote)}/HEAD 2>/dev/null || true`,
    config,
    { capture: true, runtime: ctx.runtime },
  );
  const ref = (res.output || '').trim().replace(`${config.remote}/`, '');
  return ref || 'master';
}

module.exports = { resolveBranch };
