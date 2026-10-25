---
kind: added
summary: `hold set|clear`, `epoch set`, `request cancel` and a read-only `target-state --json` for the deploy controller
---

Each mutating command is one remote shell script run as a single process under `setsid`: it takes the app lock as a `kind: session` owner through the lock guard, refuses with `refused lock-held` instead of waiting, writes by temp file and rename, and releases the lock nonce-matched. `hold set|clear` manages `deploy-kit-<lockId>.hold.json`, `epoch set <n>` raises the `.last-epoch` fence and never lowers it, and `request cancel <requestId>` tombstones an unstarted request's reservation only when nothing accepted it or its run ended `aborted-clean` with `effectsClean: true` (otherwise `not-cancellable <reason>`, exit 3). `target-state --json` reads the live sha, journal class, hold, epoch, reservation and lock owners without taking a lock.
