---
kind: added
summary: deploy now cuts a pending release automatically via an auto-merged PR and deploys exactly that merged SHA, closing the gap where a deploy could advance while the version stood still.
---

`deliveryEvent` fires once per DEPLOY, not once per release, and cutting a
release was a separate manual command. So versions stood still while deploys
continued, and every deploy re-announced the same release: cairn sat at 1.0.2
with 24 unreleased fragments, mizen at 0.1.0-alpha.2 with 25, savoro at 1.1.0
with 52. Announce-once (release-kit 0.6.0) stopped the duplicate posting; this
closes the underlying defect.

When unreleased fragments exist, `deploy` now cuts on a branch, opens a PR,
merges it, and deploys the immutable merged commit `R`. It never pushes a
default branch directly. With no fragments, deploys are unchanged — redeploying
a version is legitimate. Opt out with `autoCut: false` or `--no-auto-cut`.

Fail-closed throughout. An unresolvable release-kit aborts rather than skipping,
because warn-and-skip silently recreates the very defect this fixes. The base
tip is re-asserted immediately *before* merging: a squash onto a moved base
produces a release commit containing changes that were absent when the version
and fragments were computed, and checking afterwards is too late to protect the
release contents. Only paths validated against the cut's expected mutation set
are staged — never `git add -A`, which would sweep in generated files or a
developer's stray output. Dry runs perform no local git mutation and no GitHub
write.

Auto-cut runs only after option validation, lock acquisition, and target
preflight, so a deploy that was always going to be rejected cannot publish an
irreversible release first and report the rejection second.

Both pipelines deploy `R` specifically rather than following the branch tip. In
place, that means requiring the target's HEAD to be an ancestor of `R` (never
silently downgrading a target already ahead), `merge --ff-only R`, and asserting
`HEAD === R` both after the fast-forward and again after every pre-restart check
has run — install, generate, verify-pins, migrate and arbitrary consumer check
commands all run in between and any of them can move HEAD.

`gh pr merge` exiting zero is not proof of a merge; it can succeed having merely
queued the PR. The PR state and merge SHA are polled to an actual MERGED outcome
before `R` is persisted or returned, and a timed-out merge is re-queried rather
than assumed failed. `.deploy-kit/pending-release.json` (written temp-file-then-
rename) records `R` so a crash between merge and deploy resumes onto that same
commit instead of following the branch to a descendant. Once merged, a release
is published permanently: a later deploy failure is a failed deployment of an
existing release, never an uncut one — no branch reset, no revert, no version
decrement.

App cuts create no tags.

In `mode: 'local'` the controller checkout IS the deploy target, so cutting
there would create a `release/cut-*` branch in the very checkout being deployed
— a failure partway would strand the live checkout on the wrong branch and trip
the in-place deploy's own branch guard on the NEXT deploy too, and the cut would
mutate live application source before the deploy had started. So local mode cuts
in a detached temporary worktree instead: `git worktree add --detach` shares the
commit without claiming the branch, so the controller checkout never moves and is
never mutated, and the worktree is removed in a `finally` on every path. Preflight
still validates the controller checkout — that is what the guards are about — and
only the cut itself relocates. ssh mode is unchanged.
