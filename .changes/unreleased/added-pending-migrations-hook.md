---
kind: added
summary: "hooks.pendingMigrations lets a release deploy skip a no-op migrate, so a failed code-only deploy rolls back without restoring the database"
---

A release deploy marks the database as migrated before it runs `hooks.migrate`, so
a code-only deploy that failed a later check still tried to restore the backup, and
a failing restore left the apps stopped. The new optional `hooks.pendingMigrations`
probe runs after the backup with writers stopped; when it exits 0 and prints exactly
`0` as its last line, the migrate hook is skipped and recovery resumes the previous
release without a restore. Any other result (non-zero exit, timeout, malformed
output) runs the migrate hook as before. The probe must use the same selection rules
as your migrator and needs exclusive ownership of schema migrations; see the README.
It is ignored under the legacy layout, and loadConfig warns about it.
