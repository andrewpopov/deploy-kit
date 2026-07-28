---
kind: breaking
summary: Reject flags a command does not consume, and RollbackResult is now a discriminated union
---

Every CLI command now rejects any flag it doesn't actually read, instead of parsing it, doing nothing with it, and exiting 0. This is intentionally breaking: `stop --dry-run` previously ran a real `pm2 stop` against production while looking like a no-op preview — it, and any other command/flag combination outside that command's real support, now fails with a clear error instead of silently doing the wrong thing. Under the release layout, `rollback --skip-build`/`--skip-deps` and `deploy --no-stash` are now rejected rather than silently ignored (`--no-stash` in particular never had a working tree to stash under that layout, so honoring it was never meaningful). If a script in your deploy pipeline passes a flag a command doesn't support, it will now fail loudly — check `deploy-kit <command> --help` and drop the flag or move to a command that supports it.

Separately, for TypeScript consumers: `RollbackResult` is now a discriminated union (`{ sha, ... }` for legacy rollback vs. `{ release, ... }` for release-layout rollback) instead of a single interface with a required `sha`. Release-layout rollback never actually returned a `sha`, so any code that read `result.sha` unconditionally was already trusting a type that lied; it must now narrow on which of `sha`/`release` is present before reading it.
