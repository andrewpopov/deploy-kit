---
kind: added
summary: "deploy --sha <commit> deploys exactly the approved commit, not the branch tip"
---

`deploy-kit deploy` now accepts `--sha <40-hex-sha>`, deploying that exact
commit instead of whatever `git pull`/the branch tip resolves to at run time.
The SHA must be a full, unabbreviated 40-character lowercase hex string and
must already be merged onto the deploy branch — the deploy aborts before
touching the target otherwise, naming both SHAs. `--sha` is mutually
exclusive with `--branch`, and aborts before any mutation if auto-cut is
configured and would run (pass `--no-auto-cut` alongside it to deploy an
explicit commit on a repo that also has auto-cut enabled). `--dry-run --sha
<commit>` prints the SHA deploy path instead of the branch-pull path.
