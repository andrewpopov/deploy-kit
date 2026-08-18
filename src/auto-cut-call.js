'use strict';

// Shared call-site wiring for auto-cut, used by BOTH deploy.js's deploy() and
// release.js's deployRelease() so the two pipelines apply the exact same
// dry-run plumbing, --no-auto-cut handling, and local-mode guard rather than
// two copies that can drift.
const { autoCut, wouldAutoCutRun } = require('./auto-cut');

// Local mode (`config.mode === 'local'`) means the CONTROLLER checkout --
// the one autoCut() operates on via `runLocal`/`options.projectRoot` -- IS the
// deploy target (deploy.js/release.js run their own commands as `cd
// projectDir && ...` on the very same machine/checkout, see exec.js's
// buildTargetCommand). autoCut() cuts on a throwaway `release/cut-*` branch,
// pushes, merges, and only returns the controller checkout to `config.branch`
// at the very end (step 9) -- so for the ENTIRE cut (fragments, commit, push,
// PR, merge, any failure in between), the shared checkout sits on the cut
// branch, not `config.branch`. In local mode that shared checkout is also
// what pm2/the running app is served from, and what the deploy about to run
// is going to `git pull`/`git merge` in-place. A crash or thrown error
// mid-cut (network blip creating the PR, a `gh` failure, ...) would leave the
// live target's checkout stuck on a stray `release/cut-*` branch -- a much
// worse failure mode than the ordinary "auto-cut failed, retry" case in
// non-local mode, where the controller and the target are different
// machines/checkouts.
//
// Fail closed rather than attempt a temp-worktree workaround: a worktree
// checking out the SAME branch that is already checked out in the primary
// (local-mode) checkout is rejected by git ("already checked out"), so making
// this safe would require either a full local clone with its origin URL
// repointed at the real remote (fragile, another thing to keep in sync with
// auto-cut.js's own remote/branch assumptions) or changes inside auto-cut.js
// itself to operate against an arbitrary detached worktree. Both are more
// surface area than this integration should carry silently; an operator who
// hits this can run auto-cut from a separate controller checkout/CI runner,
// or pass --no-auto-cut for this target.
function assertNotUnsafeLocalModeAutoCut(config, autoCutOptions, ctx) {
  if (config.mode !== 'local') return;
  if (!wouldAutoCutRun(config, autoCutOptions, ctx)) return;
  throw new Error(
    'auto-cut: local-mode deploy cannot safely auto-cut in the controller\'s own checkout -- the machine '
    + 'running deploy-kit is also the deploy target (config.mode === "local"), so cutting a release/cut-* '
    + 'branch there would leave the checkout this deploy is about to pull from on the wrong branch if '
    + 'anything in the cut fails partway. Run auto-cut from a separate controller checkout or CI runner '
    + '(mode: "ssh"), or pass --no-auto-cut (or set options.autoCut / config.autoCut to false) to disable '
    + 'auto-cut for this target.',
  );
}

// Runs on the LOCAL controller checkout, before deploy()/deployRelease() build
// a candidate. `options.dryRun` is read directly off the SAME `options` object
// the CLI already builds from `--dry-run` (see cli.js) -- deploy()/
// deployRelease() receive it unmodified, so no separate plumbing is needed
// here beyond passing it straight through to autoCut(), which is what makes
// its own dry-run branch (no git mutation, no GitHub write) take effect.
function runAutoCutPreflight(config, options, ctx) {
  const projectRoot = options.projectRoot || process.cwd();
  const autoCutOptions = { ...options, dryRun: options.dryRun === true, projectRoot };
  assertNotUnsafeLocalModeAutoCut(config, autoCutOptions, ctx);
  return autoCut(config, autoCutOptions, ctx);
}

module.exports = { runAutoCutPreflight, assertNotUnsafeLocalModeAutoCut };
