---
kind: fixed
summary: deploy/rollback/monitor/remote/config no longer report success when a failure was tolerated, blind, discarded, or left unvalidated
---

Seven places where a failure was tolerated, swallowed, hard-coded away, or
left unvalidated now behave honestly.

Legacy `deploy()` aborts before fetch/pull if it cannot establish a rollback
pointer that actually matches HEAD (read independently, not merely checked
for looking SHA-shaped — a write that fails to overwrite an existing pointer
used to leave a silently STALE-but-plausible one in place), instead of
completing a deploy that `rollback` would later reset to the wrong revision.
An unborn branch / brand-new repo (no commits yet) is treated as a legitimate
first deploy, not a recording failure. Accepts both 40-char SHA-1 and 64-char
SHA-256 pointers. `resources`/`gitInfo`/`dashboard` (CLI: `resources`/`git`/
`dashboard`) now return `false` — the CLI now exits `1` — when an underlying
inspection command didn't actually run, instead of always exiting `0`.
`monitor`'s exit code now follows one explicit precedence: alert delivery
FAILED → `2` (this outranks even a crit — once delivery fails, the exit code
is the only channel left that tells anyone anything); else any `crit` → `1`;
else any `unknown` check (ssh down, a probe timed out, …) OR zero checks
configured at all → `2`; else `0` — this is *any* unknown, not just *every*
check, so a run where most checks are fine but one is blind still exits `2`
instead of quietly folding into "all fine". A failing `deliveryEvent.command`
— in both the legacy pipeline and the release layout — still never fails the
deploy, but now logs a warning and sets `DeployResult.deliveryEvent =
{ delivered: false }` instead of vanishing silently.

Release-layout `rollback` no longer leaves `current` pointing at the rollback
target while the original (never-restarted) process is still what's actually
running: a failing `preRestartChecks` check after the flip now triggers the
same post-flip recovery (flip back, restart, re-verify) the unhealthy-target
path already had, instead of throwing straight out mid-flip. And if that
flip-back itself fails, PM2 is deliberately left untouched rather than
restarted against an unconfirmed `current` — which could activate the very
release the recovery was trying to move away from — surfacing `MANUAL
RECOVERY REQUIRED` instead. The identical bug in release-layout `deploy`'s own
mid-flight recovery (the `'flipped'`/`'verify'` phase, reached on ANY
disruptive-window failure — an unhealthy activation, an interrupted process,
not just a failing `preRestartChecks`) is fixed the same way: if the recovery
flip-back fails, PM2 is never restarted onto the failed candidate, and a
migration's DB restore still runs regardless (writers were already confirmed
stopped, so it's a safe, traffic-independent data operation) but nothing is
resumed.

Config validation now checks nested keys, not just top-level ones — a typo
like `hooks.migarte` is rejected by name at load, the same as a top-level
typo, instead of silently validating fine and leaving `hooks.migrate` at its
default. Covers `hooks`, `health`, `ssh`, and every `monitor` sub-block
(`disk`/`backup`/`restartStorm`/`alert`); `healthHeaders` and a public probe's
`headers` remain intentionally open, since those keys are operator-chosen
HTTP header names, not fixed config fields.
