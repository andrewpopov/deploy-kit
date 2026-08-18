'use strict';

// Shared call-site wiring for auto-cut, used by BOTH deploy.js's deploy() and
// release.js's deployRelease() so the two pipelines apply the exact same
// dry-run plumbing and --no-auto-cut handling rather than two copies that can
// drift.
const { autoCut } = require('./auto-cut');

// Local mode (`config.mode === 'local'`) means the CONTROLLER checkout --
// the one autoCut() otherwise operates on directly -- IS the deploy target
// (deploy.js/release.js run their own commands as `cd projectDir && ...` on
// the very same machine/checkout, see exec.js's buildTargetCommand). Cutting
// a throwaway `release/cut-*` branch there, in place, would leave that shared
// checkout on the wrong branch for the in-place deploy that follows if
// anything failed partway through the cut. auto-cut.js handles this itself:
// in `mode: 'local'` it cuts, commits, pushes, and merges in a DETACHED temp
// worktree outside the project directory (`git worktree add --detach`, which
// git allows even though the branch is checked out in the controller,
// because a detached worktree never claims the branch), removing the
// worktree in a `finally` on every path including failure -- the controller
// checkout itself never changes branch and is never mutated by the cut; it
// only fast-forwards to the merged release SHA at the very end, exactly as
// it always has. There is nothing left for this call site to guard against.

// Runs on the LOCAL controller checkout, before deploy()/deployRelease() build
// a candidate. `options.dryRun` is read directly off the SAME `options` object
// the CLI already builds from `--dry-run` (see cli.js) -- deploy()/
// deployRelease() receive it unmodified, so no separate plumbing is needed
// here beyond passing it straight through to autoCut(), which is what makes
// its own dry-run branch (no git mutation, no GitHub write) take effect.
function runAutoCutPreflight(config, options, ctx) {
  const projectRoot = options.projectRoot || process.cwd();
  const autoCutOptions = { ...options, dryRun: options.dryRun === true, projectRoot };
  return autoCut(config, autoCutOptions, ctx);
}

module.exports = { runAutoCutPreflight };
