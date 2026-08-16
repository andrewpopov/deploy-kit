---
kind: added
summary: Deploys can gate migrations on checks that run before production writers are stopped
---

The new `preMigrationChecks` list runs after candidate preparation but before
the disruptive stop/backup/migrate window. Consumers can rehearse candidate
migrations against a disposable current-data copy and abort without causing
downtime when data-dependent SQL fails or times out.
