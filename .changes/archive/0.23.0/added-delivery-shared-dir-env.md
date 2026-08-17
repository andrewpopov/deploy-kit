---
kind: added
summary: deliveryEvent.command now receives DEPLOY_KIT_SHARED_DIR (the shared/ path that survives the release swap) in the releases layout, so hooks can persist what they already announced.
---

`deliveryEvent.command` now receives `DEPLOY_KIT_SHARED_DIR` in the releases
layout, set to the resolved absolute `shared/` directory — the one path that
survives the release-dir swap. Announcement hooks can now record what they
already announced there instead of re-announcing the same release on every
deploy. Unset (not empty) when the layout has no shared directory, matching
the existing `DEPLOY_KIT_BACKUP_ID` convention.

Both env injections (`DEPLOY_KIT_SHARED_DIR` and, fixed alongside it,
`DEPLOY_KIT_BACKUP_ID`) now use `export VAR='x'; <command>` rather than a bare
`VAR='x' <command>` assignment prefix. A bare prefix only scopes to the first
simple command of a chain — every real hook is compound (`cd current &&
set -a; . .env; set +a; node …`), and `cd` is a regular (non-special) shell
builtin, so the variable never reached the `node` process at the end.
Verified live: `sh -c "FOO='bar' cd /tmp && node -e \"console.log(process.env.FOO)\""`
prints `undefined`; the `export …;` form prints `bar`.
