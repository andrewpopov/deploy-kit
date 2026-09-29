---
kind: added
summary: "deploy --sha <commit> deploys exactly the approved commit, not the branch tip"
---

`deploy-kit deploy` now accepts `--sha <40-hex-sha>`, deploying that exact
commit instead of whatever `git pull`/the branch tip resolves to at run time.
The SHA must be a full, unabbreviated 40-character lowercase hex string and
must already be merged onto the deploy branch — the deploy aborts before
touching the target otherwise, naming both SHAs. `--sha` only moves the
target forward; a SHA behind the target's current HEAD is refused (use
`deploy-kit rollback` to go backward). `--sha` is mutually exclusive with
`--branch`, and is rejected whenever a release-kit config is present and
auto-cut isn't disabled — regardless of whether there is anything to cut —
pass `--no-auto-cut` alongside it to deploy an explicit commit on a repo that
also has auto-cut enabled. `--dry-run --sha <commit>` prints the SHA deploy
path instead of the branch-pull path.

Also, whenever a deploy targets an exact commit (`--sha`, or an auto-cut
release), the tracked-changes check now runs even when stashing is off
(local mode or `--no-stash`). Such a deploy aborts on a dirty tracked tree
instead of building the commit together with the leftover edit.
