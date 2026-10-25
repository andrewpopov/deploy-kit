---
kind: added
summary: An opt-in on-host deploy protocol (`onHost.required`) for a controller that dispatches deploys by request id
---

Opting in (`onHost.required: true`, release layout only) makes `deploy`, `rollback` and `recover` run only through `--on-host` as an accepted request under owned locks; direct, `--no-lock` and `--steal-lock` runs are refused, while the config-only `--dry-run` planner still works.

- **Locks:** an opt-in `hostLock` serializes every app on a host. Held locks are never taken over automatically; `lock break` is an operator command that needs proof the owner is gone (same boot: unit inactive with an empty cgroup, or no process left in the owner's session; otherwise a changed boot id).
- **Acceptance:** host-run checks, in order, the epoch fence, hold, start deadline (`--not-after`), the per-request reservation and the per-kind journal gates, then writes immutable `accepted.json`, an in-flight marker and `release.json` before anything live runs. The controller supplies the run id (`--run-id`).
- **Results:** every branch returns a structured `DeployResult`; an effects ledger classifies each step, and `aborted-clean` (retryable) is reported only when no live step ran. A failure after a live step, or a crash, leaves the app unresolved until `recover` or `resolve` settles it.
- **Gates:** `layout.disruptiveGate` checks run once, immediately before the first live step, for deploy and rollback.
- **Migrations:** with `hooks.migrationsExclusive`, the `pendingMigrations` probe runs first and an exact zero skips the writer stop, backup and migrate.
- **Layout:** `layout migrate --to releases|legacy [--dry-run]` converts a host and back, refusing the reverse after a deploy and verifying the restored processes.
- **Status:** `on-host-status <run-id>` reports a run fail-closed (an accepted run with no terminal record is `unknown`).

Apps that do not opt in keep the 0.32.0 behaviour, including byte-identical lock scripts.
