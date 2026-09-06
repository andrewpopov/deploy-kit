---
kind: fixed
summary: Automatically resume an interrupted "stopped"-phase release deploy from the durable host journal
---

Release-layout deploys now resume the previous release from a journaled
`stopped` phase before beginning new work. That journal is written the moment
the stop phase begins, so it only proves no migration or symlink flip had
started — not that writers were actually confirmed stopped. Either way,
resuming the unchanged previous release is safe: deploy-kit validates the
journaled release id and the live `current` pointer, then resumes and
re-verifies the previous release.

An interrupted `migrated` or `flipped` journal is NOT auto-recovered, for two
different reasons. Once the pre-migration backup has been taken (`migrated`,
or `flipped` with `migrated: true`), deploy-kit cannot prove no writes landed
after that snapshot — a service manager (e.g. PM2 resurrect) or an operator may
have already brought the old app back online. A code-only `flipped` journal
(no backup) has no post-backup writes to worry about, but still fails closed
because the on-disk `current`/`previous` pointers can't be trusted against
whatever is actually running without re-deriving that state by hand. Either
way it fails closed with `MANUAL RECOVERY REQUIRED` instead of restoring the
backup, rewriting the `current`/`previous` symlinks, stopping apps, or
restarting PM2. The operator reconciles the database/schema and the `current`
pointer by hand, then marks the journal `done` (or removes it) before
deploying again.
