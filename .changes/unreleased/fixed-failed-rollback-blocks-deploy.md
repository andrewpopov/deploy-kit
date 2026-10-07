---
kind: fixed
summary: "a failed automatic rollback now blocks the next release deploy, and a failed restore logs the tail of its output"
---

When a post-deploy rollback failed (for example the restore hook exited non-zero),
the journal said `post-deploy-rollback-failed` but the next deploy did not read it
and could proceed against an unreconciled database. The next release deploy now
refuses with `MANUAL RECOVERY REQUIRED` before any release work or app change. The
restore hook runs exactly as configured and its output still streams live with no size
limit, and the last 4 KB is now logged when it fails, so the cause is visible instead of only "could not
be auto-restored".
