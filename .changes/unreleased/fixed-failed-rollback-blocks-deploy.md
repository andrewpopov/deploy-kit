---
kind: fixed
summary: "a failed automatic rollback now blocks the next release deploy"
---

When a post-deploy rollback failed (for example the restore hook exited non-zero),
the journal said `post-deploy-rollback-failed` but the next deploy did not read it
and could proceed against an unreconciled database. The next release deploy now
refuses with `MANUAL RECOVERY REQUIRED` before any release work or app change.
Set `"phase":"done"` in the state file (or remove it) once the database and the
`current` pointer are reconciled.
