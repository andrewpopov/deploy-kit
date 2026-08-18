# Changelog

## 0.24.0

- deploy now cuts a pending release automatically via an auto-merged PR and deploys exactly that merged SHA, closing the gap where a deploy could advance while the version stood still.
  `deliveryEvent` fires once per DEPLOY, not once per release, and cutting a
  release was a separate manual command. So versions stood still while deploys
  continued, and every deploy re-announced the same release: cairn sat at 1.0.2
  with 24 unreleased fragments, mizen at 0.1.0-alpha.2 with 25, savoro at 1.1.0
  with 52. Announce-once (release-kit 0.6.0) stopped the duplicate posting; this
  closes the underlying defect.
  
  When unreleased fragments exist, `deploy` now cuts on a branch, opens a PR,
  merges it, and deploys the immutable merged commit `R`. It never pushes a
  default branch directly. With no fragments, deploys are unchanged — redeploying
  a version is legitimate. Opt out with `autoCut: false` or `--no-auto-cut`.
  
  Fail-closed throughout. An unresolvable release-kit aborts rather than skipping,
  because warn-and-skip silently recreates the very defect this fixes. The base
  tip is re-asserted immediately *before* merging: a squash onto a moved base
  produces a release commit containing changes that were absent when the version
  and fragments were computed, and checking afterwards is too late to protect the
  release contents. Only paths validated against the cut's expected mutation set
  are staged — never `git add -A`, which would sweep in generated files or a
  developer's stray output. Dry runs perform no local git mutation and no GitHub
  write.
  
  Auto-cut runs only after option validation, lock acquisition, and target
  preflight, so a deploy that was always going to be rejected cannot publish an
  irreversible release first and report the rejection second.
  
  Both pipelines deploy `R` specifically rather than following the branch tip. In
  place, that means requiring the target's HEAD to be an ancestor of `R` (never
  silently downgrading a target already ahead), `merge --ff-only R`, and asserting
  `HEAD === R` both after the fast-forward and again after every pre-restart check
  has run — install, generate, verify-pins, migrate and arbitrary consumer check
  commands all run in between and any of them can move HEAD.
  
  `gh pr merge` exiting zero is not proof of a merge; it can succeed having merely
  queued the PR. The PR state and merge SHA are polled to an actual MERGED outcome
  before `R` is persisted or returned, and a timed-out merge is re-queried rather
  than assumed failed. `.deploy-kit/pending-release.json` (written temp-file-then-
  rename) records `R` so a crash between merge and deploy resumes onto that same
  commit instead of following the branch to a descendant. Once merged, a release
  is published permanently: a later deploy failure is a failed deployment of an
  existing release, never an uncut one — no branch reset, no revert, no version
  decrement.
  
  App cuts create no tags.
  
  In `mode: 'local'` the controller checkout IS the deploy target, so cutting
  there would create a `release/cut-*` branch in the very checkout being deployed
  — a failure partway would strand the live checkout on the wrong branch and trip
  the in-place deploy's own branch guard on the NEXT deploy too, and the cut would
  mutate live application source before the deploy had started. So local mode cuts
  in a detached temporary worktree instead: `git worktree add --detach` shares the
  commit without claiming the branch, so the controller checkout never moves and is
  never mutated, and the worktree is removed in a `finally` on every path. Preflight
  still validates the controller checkout — that is what the guards are about — and
  only the cut itself relocates. ssh mode is unchanged.

## 0.23.0

- deliveryEvent.command now receives DEPLOY_KIT_SHARED_DIR (the shared/ path that survives the release swap) in the releases layout, so hooks can persist what they already announced.
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

## 0.22.0

- Add a validated deploy --branch NAME override
  Operators can now deploy a non-default branch for one invocation without
  editing `.deploy-kit.config.json`. The value passes through the same strict git
  ref validation as `branch` in configuration and is rejected on commands other
  than `deploy`.

## 0.21.0

- Deploys can gate migrations on checks that run before production writers are stopped
  The new `preMigrationChecks` list runs after candidate preparation but before
  the disruptive stop/backup/migrate window. Consumers can rehearse candidate
  migrations against a disposable current-data copy and abort without causing
  downtime when data-dependent SQL fails or times out.
- Release-layout post-deploy checks now have explicit, journaled recovery policies and failure events
  Every release-layout post-deploy check must choose `rollback`, `remain-active`,
  or `manual`. Failed checks persist their pending and terminal recovery state,
  emit a structured failed or degraded delivery event, and make migration-aware
  rollback restore and verify the previous code and database state. Hard
  interruptions and failed rollback gates remain fail-closed for operator recovery.
- Release-layout dry-run now prints a complete deterministic plan without contacting the target
  The planner supplies consistent symbolic capture values for preflight, repository,
  backup, PM2, activation, and pruning state, allowing every release phase to render
  in order and exit successfully. No local target command or SSH probe executes;
  configuration validation still fails by the exact invalid field before planning.
- deploy/rollback/monitor/remote/config no longer report success when a failure was tolerated, blind, discarded, or left unvalidated
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
- Multiline target scripts have an stdin-safe execution path and JSON-encoded scripts fail closed
  `runScriptOnTarget` sends a POSIX shell program over stdin instead of embedding
  it in a controller-shell command. The lower-level target-command builder rejects
  `JSON.stringify(script)` input before literal escaped newline tokens can become
  commands, redirection targets, or deployment-root artifacts.

## 0.20.0

- Fail closed on unreadable pm2 state during the DB-bound app pause, and resume only what was actually paused
  The legacy pipeline's DB-bound app pause (the guard around the pre-migration
  backup) used to treat an unreadable `pm2 jlist` as "skip verification and
  proceed" — meaning a pm2/ssh hiccup right before the migration window could
  send a deploy into backup+migrate without ever confirming writers were
  actually stopped. It now retries a bounded number of times and, if the state
  is still unknown, fails closed: aborts before pausing anything if this happens
  before the pause, or resumes and aborts if it happens after. Recovery
  (`resumeDbApps`) also now resumes only the apps it actually observed running
  before the pause — an app that was already stopped (e.g. for maintenance)
  stays stopped through a failed-and-recovered deploy — and verifies the resume
  actually took, surfacing a failed recovery loudly without masking the original
  failure. The `pm2 jlist` probe carries its own short 30s bound rather than
  inheriting `stepTimeoutSeconds`, so the new retry loop cannot hold the deploy
  lock for the better part of an hour (or hang indefinitely on a consumer that
  sets `stepTimeoutSeconds: null`). The app restart now runs as a gated step too:
  it happens while the DB-bound apps are still paused, and a failed restart
  previously aborted without attempting to bring them back at all.
  
  The three separate `pm2 jlist` readers in deploy.js/release.js/checks.js are
  consolidated onto one shared module (`pm2-state.js`) so this policy lives in
  one place. That consolidation also closes two latent fail-open gaps: release.js
  read empty `pm2 jlist` output as "zero processes running" (so an unreadable
  list right after its stop attempt could report writers confirmed stopped), and
  the monitor's `checks.js` reported empty output as "all down" rather than
  UNKNOWN.

## 0.19.1

- Verify DB-bound apps are actually paused before the pre-migration backup/migrate window
  The legacy (non-release-layout) `deploy` pipeline pauses `dbBoundApps` before the pre-migration backup, but the `pm2 stop` was tolerant of failure with no verification — a stop that silently failed still let the backup and migration run against a live writer, risking an inconsistent backup. The pause is now verified: `deploy` snapshots which `dbBoundApps` are running immediately before the stop attempt and asserts none of those are still running immediately after, aborting (and resuming any paused apps first, same as every other gate in this window) if one is. "Running" spans every pm2 state in which a process may still hold database connections — `online`, `launching`, `one-launch-status`, `waiting restart` and `stopping` — so a process that is mid-launch or scheduled to restart cannot slip into the backup window; `stopped` and `errored` are the only states treated as definitely inactive, so an errored app never causes a spurious abort. Apps that were already stopped, or never registered in pm2, are untouched by the check. `pm2 jlist` output is parsed tolerantly of pm2's own `[PM2] …` notices, and genuinely unreadable output is treated as unknown (logged, deploy proceeds) rather than a failure, so a pm2 quirk on one host can't brick a deploy. Release-layout deploys already verify their pause this way and are unaffected.

## 0.19.0

- Add deploy-kit monitor --local to run the monitor and its alert sink on the local machine without ssh
  `deploy-kit monitor` now accepts a `--local` flag that forces `mode: 'local'` for that
  run only, via the existing validated `loadConfig` override. This lets a consumer repo
  keep committing an ssh-mode config for laptop-driven `deploy`/`rollback` while still
  running its 24/7 `monitor` cron directly on the target box — every check and the alert
  sink execute with `sh -c`, no ssh, and `host` still identifies the target in alerts.

## 0.18.0

- New `hooks.generate`, run by deploy-kit itself right after install and before build. A build served from an Nx/Turbo cache silently skips generation steps baked into the build script — the cache restores `dist/` but not artifacts written into `node_modules` — which put clipd into production crash-looping on "@prisma/client did not initialize yet". Because deploy-kit invokes this hook directly, no build tool's cache sits between it and the command, so a cache hit cannot skip it. Runs in the legacy pipeline, the release pipeline and legacy rollback.
- `--dry-run` can now preflight a release-layout host. The dry-run runtime returned an empty string for every command, so the `.deploy-kit-layout` marker read came back empty and preflight aborted with "requires a migrated host" against hosts whose marker existed and was readable — failing on exactly the layout the check protects. Genuinely read-only preflight probes now execute for real; anything that mutates, or depends on this run's own simulated mutations, stays simulated.
- An ssh transport or auth failure is no longer reported as a held lock. Acquiring the lock always ends in a genuine `exit 0` or `exit 1`, so anything else means the script never ran; only a confirmed `exit 1` now reports contention. Previously a `Permission denied (publickey)` surfaced as "Another deploy holds the lock ... pass --steal-lock" — recommending an action that was both useless and destructive, and hiding the real cause long enough that one host sat 19 commits behind.

## 0.17.1

- A production install's absent devDependencies no longer abort the deploy
  `verify-pins` graded a pinned devDependency with nothing installed as a fatal `missing`. But a production deploy target is installed with `npm ci --omit=dev`, so its devDependencies are *correctly* absent — meaning the new deploy pin gate would abort a perfectly healthy deploy. Caught by running the checker against the real hosts before the gate reached them: levelup reported `1 missing` for `@andrewpopov/eslint-config`, a devDependency that should not be on a production host at all.
  
  devDependency absence now reports as the tolerated `absent` status, alongside optional and peer pins. Tolerance covers absence only — a devDependency installed at the *wrong* version still fails as `mismatch`, and an absent plain `dependencies` pin still fails as `missing`.

## 0.17.0

- Deploys now abort when the target's installed packages disagree with what package.json pins
  Neither `npm install` nor `npm ci` re-resolves a `github:owner/repo#<ref>` dependency when only the ref changes — verified against npm 11.9.0: with a lockfile at the v0.19.0 commit and a manifest asserting `#v0.20.0`, both commands exit 0 and leave 0.19.0 on disk. The whole install fallback chain is therefore silent about it, and a deploy reports success while shipping code the manifest says was replaced.
  
  A `verify-pins` step now runs on the target immediately after install — before backup, migrate, build, and restart — and aborts the deploy on a mismatch, so the cost is a failed deploy rather than an outage or a security fix that never lands. It runs under `--skip-deps` too, since skipping the install makes a stale tree more likely, not less.
  
  The checker is shipped to the target on stdin (the verbatim `verify-pins.js` source plus a runner, `fs`/`path` only) rather than invoked there, so it works on hosts whose installed deploy-kit predates the feature and needs no dependency on the target. Opt out with `verifyPins: false` or `--skip-pin-check`.
- `npm run lint` no longer fails just because a git worktree is open
  ESLint linted `.worktree/<slug>/`, a nested checkout holding another branch's copy of the repo. The path-scoped config blocks resolve against the lint root, so a worktree copy of `scripts/verify-pack.mjs` never matched `scripts/**/*.mjs`, fell through to a config with no Node globals, and every `console`/`process` reference became `no-undef` — 8 errors from files that are not this working tree's source. Because `verify` starts with `lint`, anyone with a worktree open could not run the battery at all. `.worktree/**` is now ignored.
- The declared release-kit pin now matches the one actually installed
  `package.json` pinned `release-kit#v0.2.0` while `package-lock.json` resolved to the v0.3.1 commit — a committed disagreement, not stale local state, so `npm ci` installed v0.3.1 while the manifest claimed v0.2.0 and an `npm install` from the manifest could have downgraded it. PKG-98 installed the new version here but never saved the manifest, which is the same class of silent drift the deploy-time pin gate now catches.

## 0.16.1

- monitor: correct the stepCheck header comment and pin the copy to alert-kit with a conformance test
  The `stepCheck` header comment claimed `unknown` "clears the streaks". It never
  did — the code preserves them (as the body comment three lines below always said),
  which is what lets a flapping check still reach its alert threshold when an
  indeterminate run lands between two failures. Documentation-only for behaviour, but
  the comment is what a reader trusts when deciding whether a monitor will fire.
  
  The canonical implementation now lives in `@andrewpopov/alert-kit`. deploy-kit keeps
  its copy deliberately — this package declares zero runtime dependencies, and a
  transitive `github:` resolve onto ARM Pi hosts with no CI is a worse failure than the
  duplication — so alert-kit is a DEV dependency only, and a new conformance test drives
  both implementations through an exhaustive transition matrix (~100k cases) so the copy
  cannot drift silently. Nothing changes at runtime, and the published package still has
  no dependencies.

## 0.16.0

- `deploy-kit verify-pins` — fail loudly when a `github:` pin did not actually install
  `npm install` does not re-resolve a `github:owner/repo#vX.Y.Z` dependency when only the TAG changes — the lockfile is keyed on the already-resolved commit — so bumping a pin can exit 0 while leaving the OLD code in `node_modules`. For a security kit that means a fix you shipped, tagged, and deployed can silently not be running, with every gate green. `deploy-kit verify-pins` asserts that every `github:` pin is installed at the version its tag claims, exits non-zero naming each mismatch alongside the exact re-install command, and resolves packages the way node does so workspace hoisting and pnpm's symlinked layout both work. Refs that carry no assertable version (a branch, a commit SHA, a `semver:` range) are counted and reported as **unverifiable** rather than silently skipped, so the summary never claims more coverage than it has. Standalone like `port-guard` — it reads no `.deploy-kit.config.json` and can gate a deploy via `preRestartChecks`. On its first run across the fleet it found three real problems, including a project running a version older than the one its manifest pinned.
- custom monitor checks now report WHY they failed — stderr is no longer discarded
  A failing `monitor.checks` entry alerted as a bare `<id>: failed`, with no
  indication of what went wrong. `runOnTarget` piped the command's stderr but read
  only `error.stdout` when building the failure detail, so the diagnostic that a
  well-behaved CLI writes to stderr was captured and then thrown away. Every custom
  check in every consumer was affected: the alert named which check broke and
  nothing about why, which is exactly the information an operator needs at 3am.
  `runOnTarget` now returns a separate `stderr` field (populated on the failure
  path), and `checkCustom` composes its detail from stderr first, then stdout — so a
  noisy stdout can no longer crowd the real reason out of the 300-character budget.
  `output` remains pure stdout, so existing parsers (`pm2 jlist` JSON, `df` numbers)
  are unaffected. TypeScript consumers of `runOnTarget` gain `stderr: string` on the
  return type.
- verify-pins: tolerate absent optional/peer pins (mismatch still fails), verify semver:<exact> and build-metadata refs, compare versions by semver equality, and fail corrupt installs

## 0.15.0

- Reject flags a command does not consume, and RollbackResult is now a discriminated union
  Every CLI command now rejects any flag it doesn't actually read, instead of parsing it, doing nothing with it, and exiting 0. This is intentionally breaking: `stop --dry-run` previously ran a real `pm2 stop` against production while looking like a no-op preview — it, and any other command/flag combination outside that command's real support, now fails with a clear error instead of silently doing the wrong thing. Under the release layout, `rollback --skip-build`/`--skip-deps` and `deploy --no-stash` are now rejected rather than silently ignored (`--no-stash` in particular never had a working tree to stash under that layout, so honoring it was never meaningful). If a script in your deploy pipeline passes a flag a command doesn't support, it will now fail loudly — check `deploy-kit <command> --help` and drop the flag or move to a command that supports it.
  
  Separately, for TypeScript consumers: `RollbackResult` is now a discriminated union (`{ sha, ... }` for legacy rollback vs. `{ release, ... }` for release-layout rollback) instead of a single interface with a required `sha`. Release-layout rollback never actually returned a `sha`, so any code that read `result.sha` unconditionally was already trusting a type that lied; it must now narrow on which of `sha`/`release` is present before reading it.
- Manage releases with release-kit (fragment-based CHANGELOG + version bump)
  Releases are now driven by release-kit: describe each change as a fragment under `.changes/unreleased/` and run `npm run release:cut` to compile them into a new CHANGELOG section, bump the version, and archive the fragments.
- Stop shipping src/__tests__ in the published package
  `src/__tests__` is no longer included in the published tarball (30 files → 23). If you `require`/`import` anything from `src/__tests__` in a consumer, it will now be missing after `npm install`/`npm update` — nothing in the documented public API does this, so no action should be needed for a normal consumer.
- The deploy-kit CLI is executable again, so `npm run deploy` works in consumers.
  `src/cli.js` was committed as mode 100644, so a `github:` install linked `node_modules/.bin/deploy-kit` at a non-executable file and any invocation failed with `Permission denied`. The shebang was correct all along — it just never got to run. Consumers had to work around it by calling `node node_modules/@andrewpopov/deploy-kit/src/cli.js` directly.
- Fix legacy-layout deploys: consistent backups, signal recovery, DB-app restart, and origin/HEAD resolution
  Legacy-layout deploys (the default, no `layout` block configured) now match the safety behavior the release layout already had. The pre-migration backup is taken after DB-bound apps are paused rather than before, so it can no longer capture a snapshot mid-write. Ctrl-C (or a killed process) during a deploy now runs the same recovery as any other abort path — the lock is released and paused apps are resumed, instead of leaving a deploy target wedged. A `dbBoundApp` not also listed in `appNames` or `ensureApps` is now restarted at the end of the deploy; previously it was left stopped even though the deploy reported success. A health-gate failure now tells you to run `deploy-kit rollback` instead of leaving you to figure out the recovery yourself. Both layouts now resolve the branch from the target's `origin/HEAD` through one shared `resolveBranch`. Previously only the legacy layout did this; the release layout fell back to a hardcoded `master`, so a release-layout app whose default branch is `main` with `branch` unset deployed the wrong branch or failed outright. If that describes you, release-layout deploys now target the right branch automatically. Also: a crashed `deploy-kit monitor` run can no longer wedge every later deploy — the lock now has a stale TTL and is reclaimed automatically instead of requiring `--steal-lock`.
- Harden ssh transport defaults and eliminate branch/remote shell injection
  `branch` and `remote` are now shell-quoted at the git call site and charset-validated at config load. Since `branch` defaults to whatever the target's `origin/HEAD` resolves to, an attacker who could influence that ref on the remote could previously get arbitrary shell execution on your deploy target; a config with a `branch`/`remote` outside the legal git-refname charset now fails fast at `loadConfig` instead. `ssh` invocations default to `StrictHostKeyChecking=accept-new` and `BatchMode=yes` (emitted after any `ssh.options` you set, so your overrides still win) — an unattended deploy against a new host no longer hangs on an interactive key prompt, and a MITM'd known host is now caught rather than silently trusted. Lock and rollback state moved off world-writable `/tmp` to `$HOME/.deploy-kit` (mode `700`); no consumer action needed, but anything that inspected `/tmp/deploy-kit-*` directly should look in `~/.deploy-kit` instead. `ssh.options` and `deliveryEvent` are now shape-validated at config load.

## 0.14.0

- Added `runHostOperations` / `deploy-kit run-host-operations --action NAME
  [--api-url-env ENV] [--api-key-env ENV]`: a generic, host-configurable
  operation runner (claim one allowlisted operations-API request matching
  `action`, run this checkout's configured deploy pipeline, complete the
  lease). The action name, API base URL, and API key are now supplied by the
  caller instead of being hardcoded to Cairn. The claim request now sends the
  configured action so a filtering server never leases a request meant for
  another runner; a mismatched claim is released as FAILED (`unsupported
  action for this runner`) instead of being abandoned until lease expiry.
- Deprecated `runCairnOperations` / `deploy-kit run-cairn-operations`: both
  remain as thin wrappers over `runHostOperations` that supply the old
  `DEPLOY_CAIRN_PRODUCTION` action and `CAIRN_OPERATIONS_API_URL` /
  `CAIRN_OPERATIONS_API_KEY` env var defaults, so existing Cairn usage keeps
  working unchanged.
- Backup-hook id parsing no longer degrades silently: when the hook ran but
  its output contained no parseable backup id (or no output at all), deploy-kit
  now logs a loud warning naming the preferred contract — JSON stdout with a
  top-level `backupId` (db-backup >= 0.18.0) — instead of quietly losing
  restore correlation. Legacy fallbacks (`id`, `created.fullPath`,
  `created.fileName`, safe final line) remain supported; the deploy never
  fails over a missing id.

## 0.13.0

- Harden `alert-discord` with the reusable delivery behavior proven by Smart
  Home: bounded stdin, Discord-safe output truncation, severity and reminder
  presentation, service branding, and non-retryable invalid-batch handling so
  malformed input cannot poison the monitor outbox forever.

## 0.12.2

- Legacy in-place delivery events now include the same optional opaque
  `backupReference` as release-layout deploys when the backup hook emits either
  a safe final-line id/path or a db-backup JSON result. Both layouts share one
  validator and expose only the leaf label; unsafe, traversing, skipped, or
  noisy output is omitted without breaking existing backup hooks.
## 0.12.1

- Release-layout delivery events now include an optional opaque
  `backupReference` after a successful pre-migration backup. The reference is
  the backup ID leaf only; host-local backup paths remain internal to the
  restore workflow.

## 0.12.0

- Add a bundled, OPT-IN `deploy-kit announce-discord [--webhook-env NAME]
  [--service NAME]` CLI command: the RELEASE counterpart to `alert-discord`,
  modeled 1:1 on it — a convenience `deliveryEvent.command` implementation for
  `deploy`/`release`. It reads the post-deploy delivery event on stdin (the
  same `{event:'deployment', status:'succeeded', branch, revision,
  deployedAt}` shape `deliveryEvent.command` receives), resolves the webhook
  URL from `process.env.DISCORD_RELEASE_WEBHOOK` (override the env var name
  with `--webhook-env`; override the service name with `--service` or
  `DISCORD_RELEASE_SERVICE`/`DISCORD_ALERT_SERVICE`), formats a concise
  release announcement, and POSTs it to the webhook with a 10s timeout. Zero
  runtime deps — uses Node's built-in `fetch`. The webhook URL is never
  logged. **Asymmetric vs `alert-discord` by design**: since `deliveryEvent`
  is already a tolerated, best-effort step and a release announcement is
  opt-in decoration on an already-succeeded deploy, an unset webhook env,
  malformed stdin, or a failed/timed-out POST is a clear stderr warning and
  exit `0` — never non-zero — so a missing or broken announcement route can
  never turn a healthy deploy red. This does NOT change deploy.js's/
  release.js's policy-free `deliveryEvent` contract; opt in per-project via
  `deliveryEvent: { command: "npx deploy-kit announce-discord" }`.

## 0.11.0

- Add a bundled, OPT-IN `deploy-kit alert-discord [--webhook-env NAME]` CLI
  command: a convenience `alert.command` implementation for `monitor`. It reads
  the monitor's batched alert JSON on stdin (the same `{eventId, createdAtMs,
  host, alerts}` shape any `alert.command` receives), resolves the webhook URL
  from `process.env.DISCORD_ALERT_WEBHOOK` (override the env var name with
  `--webhook-env`), formats a concise message (title + failing/recovered
  checks), and POSTs it to the webhook with a 10s timeout. Zero runtime deps —
  uses Node's built-in `fetch`. The webhook URL is never logged. An unset env
  var, malformed stdin, or a failed/timed-out POST is a clear stderr message
  and a non-zero exit, never a crash. This does NOT change the monitor's
  policy-free contract — `monitor.js`/`checks.js` remain unaware Discord
  exists; opt in per-project via
  `monitor: { alert: { command: "npx deploy-kit alert-discord" } }`.

## 0.10.0

- Add a generic `preRestartChecks` config phase — `{name,command}[]`, same shape
  and validation as `preDeployChecks`/`postDeployChecks`. Runs IMMEDIATELY BEFORE
  the app restart: in the legacy pipeline after build (with any `dbBoundApps`
  still paused — a failure resumes them, same as a failed build); in the
  release-layout pipeline after the `current` symlink flip (a failure runs the
  same 'flipped'-phase recovery as any other failure there). Also gates the
  restart in both `rollback` paths. Strictly config-gated: absent/null/`[]`
  emits a byte-identical command sequence to prior versions.
- Add a `deploy-kit port-guard <port> <pm2-process-name>` CLI command: fails if
  `<port>` is held by a process outside `<pm2-process-name>`'s pm2 process tree
  (own pid + descendants via `pgrep -P`/`ps --ppid`), so a deploy reload on a
  shared multi-tenant host can't collide with an unrelated process on the same
  port. Prefers `lsof`, falls back to `ss`; fails CLOSED (loud, non-zero) if
  neither is available. Wire it into `preRestartChecks` as
  `{"name":"port-safe","command":"npx deploy-kit port-guard <port> <app>"}`.
  Ported from towerpower's hand-rolled `verify_port_is_safe_for_reload`.

## 0.9.4

Fix — release-layout deploys now run `postDeployChecks` and `deliveryEvent`
after the full activation verification, matching the existing legacy deploy
contract. A failed post-deploy gate reports the deploy as failed without
silently rolling back the already healthy release.

## 0.9.2

- Add public contribution, support, and private vulnerability-reporting policies.
- Add the MIT `LICENSE` file shipped with the public package.
- Correct the documented `stepTimeoutSeconds` default to the runtime value of
  `1800`; only an explicit `null` disables the timeout.
- Add `npm run verify` for the local release gate.

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

## 0.9.1

Fix — v0.9.0 accidentally tracked a stray `.worktree/delivery-event` gitlink
(the .gitignore had `.worktrees/` plural, not `.worktree/`). Untracked it and
fixed the ignore rule. Tags are immutable, so this is a fix-forward: pin
`#v0.9.1`, not `#v0.9.0`. No functional change.

## 0.9.0

Feature — **post-deploy verification gates**: opt-in checks that run after the
health gate and fail the deploy if they do not pass (`verifyGates` in config).

Feature — **optional post-health delivery events**: emit an event after a deploy
goes healthy, so a consumer can notify/record without polling.

Both are additive and default to off; existing configs are unaffected.

These shipped on master as three untagged commits and were being consumed by
cairn via a bare SHA pin — which the standards forbid (pin tags, never SHAs).
This release tags them so every consumer can pin `#v0.9.0`.

## 0.8.2

Fix — release SHA resolution could still pick a STALE `origin/<branch>`.

- v0.8.1 fetches `+refs/heads/*:refs/heads/*` (force-updating local heads) but resolution
  still tried `origin/<branch>` FIRST. If `repo.git` carries a `heads→remotes/origin`
  refspec (the migration sets one), `refs/remotes/origin/<branch>` is updated only by a
  plain `git fetch`, NOT by our heads:heads fetch — so after the remote advanced it went
  stale and was preferred over the current `refs/heads/<branch>`, silently rebuilding the
  old sha again. Now resolve `refs/heads/<branch>` FIRST (the ref our own fetch just
  force-updated; always current), with `origin/<branch>` only as a last-ditch fallback.
  Found by a Codex review of the v0.8.1 refspec change.

## 0.8.1

Fix — release-layout deploys built a STALE commit against a `git clone --bare` repo.

- `git clone --bare` configures no `remote.origin.fetch`, so the materialize step's
  `fetch --prune origin` only moved `FETCH_HEAD` — `refs/heads/<branch>` stayed frozen
  at clone time. Once the remote advanced past the host-migration commit, every deploy
  silently rebuilt the OLD sha (the build-sha match still passed — it was internally
  consistent, just stale). Now fetch with an explicit `+refs/heads/*:refs/heads/*`
  refspec so local heads track the remote. Caught when a smarthome deploy shipped the
  pre-migration HEAD instead of the just-merged master (SMH-116).

## 0.8.0

Shared fleet monitoring + alerting (SMH-116, absorbs the app-agnostic parts of
SMH-152/155). Opt-in; every existing app is untouched until it adds a `monitor` block.

- **New — `deploy-kit monitor`** and a `monitor: {…}` config block. Runs generic ops
  checks on a cron and routes ACTIONABLE alerts through a policy-free sink. Built-in
  checks (each opt-out by omitting its key; pm2 always on): **pm2** app-online (per
  app), **restart-storm** (pm2 restart-count jump beyond `maxDelta`, reset-safe),
  **disk** (free bytes OR inodes), **backup** freshness (stamp mtime), **tunnel**
  process, **public** endpoint probes (curl status/body — proves DNS+ingress+TLS+
  routing), and **custom** app commands (the seam for app-specific signals like
  provider/scheduler readiness — statically-severitied, so a provider outage never
  flaps liveness).
- **Alerting is safe by construction.** Every check yields a stable id and a status of
  `ok|warn|crit|unknown` — `unknown` (can't determine: ssh/command failure, unparseable
  output) never counts as ok or a recovery. Cross-run **debounce** (`failAfterRuns`/
  `recoverAfterRuns`) rides out flapping; alerts are **batched** into one event per run
  (so one incident isn't four correlated alerts); an **outbox** persists the pending
  event before sending and retains it for retry on failure (at-least-once, with a stable
  `eventId` for sink-side dedup). A run **lock** (separate from the deploy lock) stops
  overlapping crons; state is versioned and written atomically over stdin.
- **Policy-free + injection-safe.** The alert sink is a command that receives the batch
  as JSON on **stdin** (`run: 'controller'|'target'` picks where it runs — controller is
  robust when the monitored app is what's down); deploy-kit ships no transport. Probe
  URLs/headers and state/stamp paths are validated (https, unique safe ids, no shell
  metacharacters, no single-quoted-header escape) and never shell-concatenated.
- **New exec capability:** `runOnTarget` accepts `input` (fed to the command's stdin,
  ssh-forwarded) and a per-call `timeoutSeconds` — the injection-safe way to pass
  arbitrary data to a target command. Exit codes: `0` ok/warn · `1` crit · `2` monitor
  error. Design + code independently reviewed by Codex (design + implementation).

## 0.7.1

Two release-layout fixes, both caught by the mandatory throwaway-PM2 test on the
actual Pi (bigpi) before the smarthome cutover — exactly why that gate exists.

- **SHA resolution failed against a `git clone --bare` repo.** A bare clone maps
  the remote's heads to LOCAL heads (`refs/heads/*`, no `refs/remotes/origin/*`),
  so `git rev-parse origin/<branch>` did not resolve and the deploy aborted in the
  `materialize` phase with *"Could not resolve origin/master to a SHA (got
  'origin/master')"*. Now try `origin/<branch>` first, then fall back to
  `refs/heads/<branch>`, covering both bare-clone and mirror layouts.
- **The backup id validation wrongly rejected absolute paths.** A backup id is
  normally an absolute path to the backup file (e.g.
  `/var/lib/smarthome/backups/smarthome-<ts>.db.gpg`), but the v0.7.0 safe-id check
  rejected any id starting with `/`, so every migrating deploy aborted in the
  `stopped` phase with *"Backup hook did not emit a safe restorable id"*. Absolute
  is now allowed; the check still rejects shell metacharacters (safe charset) and
  `..` traversal, and the id is single-quoted into the restore command.

## 0.7.0

Artifact-first release-layout deploys (SMH-112). Opt-in; every existing app is
untouched until it adds a `layout` block.

- **New — `layout: { type: 'releases', … }` (opt-in).** Switches an app from the
  legacy in-place deploy (which runs `npm ci` + build **on the live worktree**,
  the cause of smarthome's repeated `@prisma/client did not initialize yet`
  crash-storms) to a Capistrano-style release layout. Each deploy materialises an
  immutable release under `releases/<sha>-<ts>` from a **bare repo + detached
  worktree**, installs and builds **inside that release** while the old `current`
  keeps serving, validates it, and only then opens the disruptive window: stop
  writers → backup → migrate → **atomic `current` symlink flip** (`mv -Tf`, a
  namespace-atomic rename on ext4) → restart from a stable PM2 ecosystem. `npm ci`
  and build never mutate the tree the live process runs from.
- **Activation is verified, not assumed.** A deploy only succeeds when the health
  endpoint returns 200, **every** managed PID's `/proc/<pid>/cwd` resolves to the
  new release, the running app reports the deployed SHA (`layout.runningShaCommand`),
  PM2 shows every app online, and restart counts stay flat across a settling
  window — so an old process answering 200 can't mask a failed flip.
- **DB-aware recovery state machine.** Recovery is phase-specific: a failed
  install/build/validate just quarantines the candidate (current never touched);
  a failure after the schema changed **stops and confirms all DB writers are down**,
  restores the pre-migration backup (`hooks.restore`, given `DEPLOY_KIT_BACKUP_ID`)
  and resumes the previous release — or aborts with a loud `MANUAL RECOVERY REQUIRED`
  and the backup id rather than resuming stale code on a new schema. `SIGINT`/`SIGTERM`
  run the same machine, and each disruptive phase is **durably journaled**
  (atomic write) to `.deploy-kit-state.json` before the irreversible step, so a
  process/SSH/power loss leaves an on-host record of what needs restoring. The
  next deploy **refuses to start** if it finds an un-recovered interrupted phase
  (loud "resolve by hand"); a successful recovery clears that state.
- **The writer stop is gated and verified** (a zero-exit `pm2 stop` is not proof —
  the backup only runs once every `dbBoundApp` is confirmed not-online), the
  disruptive window refuses to open without a validated known-good `current`
  pointer to fall back to, and `rollback` flips back to the running release if its
  target comes up unhealthy.
- **`rollback` under `layout`** is an instant symlink flip to the `previous`
  release (already built — no reinstall/rebuild), with a warning that a schema
  rollback is a separate, explicit data-loss decision.
- **Safety rails.** Release deploy refuses a host with no completed layout marker
  (`.deploy-kit-layout`, versioned) and never restructures a live root; a legacy
  deploy/rollback refuses a host that **is** on the release layout; `sharedPaths`
  are validated relative/non-overlapping and rejected if they'd hide a tracked
  file; a free-disk and GNU-`mv` preflight fails closed. Explicit release metadata
  (`.deploy-kit-state.json`) and pruning that only ever touches `releases/` and
  never removes `current`/`previous`.
- **New — `hooks.restore`** (nullable): restore the pre-migration DB backup during
  release-layout recovery. `null` = no auto-restore.

The one-time host migration (restructuring `/srv/<app>` into
`releases/`+`shared/`+`current`) is a separate, explicit, reversible operation per
app — deploy-kit does not perform it. smarthome is the pilot.

## 0.6.1

**Fix — an unknown flag was silently ignored. A typo could run a real production
deploy.**

`parseOptions` matched the flags it knew and dropped everything else on the
floor. That is dangerous for exactly the flag an operator reaches for when being
careful: a typo'd `--dry-rn`, or `--dry-run` passed to a version that predates
it, ran a **full production deploy** while the operator believed nothing would
happen.

This is not hypothetical. On 2026-07-10 a checkout whose `node_modules` held
0.3.1 while its manifest pinned v0.6.0 (see BRAIN-18: `npm install` never
re-resolves a `github:` tag) ran `deploy-kit deploy --dry-run` and deployed for
real. Two failures compounded: an unknown flag was ignored, and a **safety** flag
that did not exist in the installed version degraded to the **unsafe** behaviour.

- Any unrecognised argument now throws, naming the valid options. This includes
  the long-removed `--force`, which was previously ignored — the same treatment a
  removed *config* key already gets.
- A bad argument prints like an unknown command and exits 1, rather than dumping
  a stack trace.
- Every real run now logs `deploy-kit v<version>` first, so a stale install is
  visible in the deploy log instead of only surfacing when a flag misbehaves.

## 0.6.0

Conformance with the shared package standards
(`agent_tools/knowledge/shared-package-standards.md`), standard 3: **a timeout
that defaults to off is not a bound.**

- **Fix — `stepTimeoutSeconds` now defaults to 1800 (30 minutes) instead of
  `null`.** `src/exec.js` applied a process timeout only when the key was set,
  and none of the five consumers (cairn, savoro, smarthome, bewks, sano-os) set
  it. Every deploy step — `npm ci`, build, `prisma migrate`, `pm2 restart`, the
  health probe — ran unbounded on the Pi, directly beneath the code comment
  *"Kill a hung remote command instead of blocking the pipeline forever."*

  The harm is worse than a slow deploy: `deploy()` takes an atomic lock for the
  whole pipeline, so a step that never returns holds that lock forever and blocks
  every **subsequent** deploy until someone runs `--steal-lock`.

  30 minutes per step is deliberately generous — `npm ci` and a Next.js build on
  a Raspberry Pi are legitimately slow, and a bound nobody can hit is a bound
  nobody disables. Consumers can tighten it, or set `stepTimeoutSeconds: null` to
  opt out entirely.
- A killed step now uses `killSignal: 'SIGKILL'` and reports the step and the
  bound rather than a bare `ETIMEDOUT`.
- `src/tunnel.js` is documented as the deliberate exception: that `execFileSync`
  **is** the long-running `cloudflared tunnel run` process, so bounding it would
  kill the tunnel it just started.

## 0.5.0

Maturation hardening (MATURATION.md P0/P1 + selected P2).

- **ssh hardening (safety):** every `ssh` invocation now carries
  `-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`
  (configurable via `ssh: {}`, each opt-out with `null`) so a wedged Tailscale
  route can't hang a deploy forever with db-bound apps paused. New
  `stepTimeoutSeconds` (default null) kills a hung remote command.
- **Config validation:** `loadConfig` now rejects unknown keys, wrong types, a
  bad `mode`, and known-removed keys (e.g. `ensureTunnelOnDeploy`) with a
  migration hint — no more silent no-ops. `strict:false` warns instead of
  throwing; `validate:false` skips. Exposes `validateConfig`.
- **Concurrent-deploy lock:** an atomic `mkdir /tmp/deploy-kit-<id>.lock` guards
  the pipeline (released on exit/abort). `config.lock:false` or `--no-lock`
  disables; `--steal-lock` forces past a held lock.
- **`deploy-kit rollback`:** each deploy records the pre-pull SHA to
  `.deploy-kit-prev-sha`; rollback does `git reset --hard <sha>` + rebuild +
  restart + health-gate, and prints the matching db-backup restore hint (data is
  never auto-restored).
- **`deploy-kit init`:** scaffolds a `.deploy-kit.config.json` skeleton and
  prints the recommended `package.json` scripts block.
- **`--dry-run`:** prints the exact command stream without executing.
- **Multi-endpoint health:** `healthChecks: [{ port, path, headers }]` gates
  app+worker fleets; the scalar `port`/`healthPath` stays as sugar.
- **Stash no longer accumulates:** the deploy-kit tracked-change stash is dropped
  after a successful pull (only ever a deploy-kit stash).
- **Offline-first install (STANDARDS.md Pi failure mode):** default `hooks.install`
  is now `npm ci --prefer-offline || npm ci || npm install`.
- **`hooks.restart`** is now in `DEFAULT_CONFIG` and documented (was read but
  undeclared). Removed the dead `--force` flag.
- **Fail-fast on bad health headers:** a single quote in a `healthHeaders` value
  (which would break curl quoting) now throws instead of emitting a broken probe.
- **Docs:** full config + CLI reference tables, a Troubleshooting section, and
  per-adopter example configs; fixed the stale `#v0.1.0` install line.
- **CI:** `verify:types` (`tsc --noEmit` contract check for `index.d.ts`), a
  Node 22/24 `compat` matrix, and a `ci-success` aggregation job. `test` stays
  the required context name.

## 0.4.0

- **BREAKING:** replace tunnel-specific `ensureTunnelOnDeploy` (v0.3.0) with generic
  **`ensureApps: string[]`** — auxiliary PM2 processes ensured up (tolerant,
  start-or-restart via `ecosystemFile`) AFTER the main `appNames` restart. A tunnel
  is just one entry; the pipeline no longer hardcodes "tunnel". Migration: replace
  `"ensureTunnelOnDeploy": true` + reliance on `tunnelName` with
  `"ensureApps": ["<your-tunnel>"]`. `tunnelName` remains for ops-verb display.
  The deploy step label changes from `tunnel` to `ensure`.
- Add **`preDeployChecks: [{ name, command }]`** — user-defined gates run BEFORE
  anything is touched (no stash/fetch/pull yet). A non-zero exit aborts the deploy
  with nothing changed. For preconditions: free disk, DB reachable, required secret
  present. The kit runs them; the consumer supplies them. Adds `check:<name>` steps.
- `remote.allApps` now includes `ensureApps` (deduped) alongside `appNames`/`tunnelName`.

## 0.3.1

- Add `healthHeaders` config (default `{}`) — extra headers on the health probe,
  applied by both the deploy health-gate and the `remote health` verb. Needed for
  apps that force-redirect plain http to https behind a TLS-terminating proxy: a
  direct localhost curl gets a 301, but `{ "X-Forwarded-Proto": "https" }` makes
  them serve the real 200 (found adopting stoki). Exposes `buildHealthCommand(config)`.

## 0.3.0

- Add `ecosystemFile` (config, default null). When set, the deploy (re)starts
  apps via `pm2 start <file> --only <name> 2>/dev/null || pm2 restart <name>`
  instead of a bare `pm2 restart`, so a not-yet-registered process starts on the
  first deploy and a running one restarts. Null preserves the old
  `pm2 restart <appNames>` (bewks/kira/smarthome/stoki unaffected).
- Add `ensureTunnelOnDeploy` (config, default false). When true and `tunnelName`
  is set, the cloudflared tunnel is brought up at the end of a deploy (start-or-
  restart when `ecosystemFile` is set), tolerant of failure so a tunnel hiccup
  never fails an otherwise-healthy deploy. Adds a `tunnel` step between `restart`
  and `health`. Folds sano's hand-rolled deploy.sh tunnel-ensure tail into the kit.

## 0.2.1

- Renamed package scope `@andrewvpopov/*` -> `@andrewpopov/*` after consolidating the GitHub org into the `andrewpopov` user. No runtime or API change; update imports and the `github:` install path to `andrewpopov/deploy-kit`.

## 0.2.0

- Add `buildBeforeMigrate` (config or option, default false). When true, the build
  runs while the apps are still up — before the backup/stop/migrate block — so the
  app-paused window is just the migration, not migration + build. Repos that build
  first and stop only for the DB work (e.g. stoki) use this to avoid extra downtime.
  A build failure in this mode aborts before anything is stopped. Default (false)
  preserves the existing build-while-paused order (bewks/kira unaffected).

## 0.1.1

- Safety fix: once the DB-bound apps are paused for migration, a failure in
  ANY later step (now including **build**, not just migrate) resumes them via
  `pm2 start` before aborting. Previously a build failure left the paused apps
  stopped — production down. Matches deploy.sh, which resumes on every post-stop
  failure. Recovery now uses `pm2 start` (the apps are stopped) rather than
  `pm2 restart`.

## 0.1.0

Initial extraction (BWK-86) — generalizes the deploy/ops tooling that was
copy-pasted across bewks/kira/smarthome/stoki/sano into one hook-driven kit.

- `deploy(config, options, ctx)` — the pipeline, faithful to the hand-rolled
  `deploy.sh` step order: stash (tracked-only) → fetch → pull `--ff-only` →
  install → **backup gate (aborts before any schema change)** → stop DB-bound
  PM2 apps (release the SQLite lock) → migrate (restarts paused apps + aborts on
  failure) → build → restart apps → **health-gate**. Framework variance is
  isolated to 4 config hooks: `install`/`backup`/`migrate`/`build`.
- `mode: 'ssh' | 'local'` — `ssh` deploys from a laptop; `local` runs on the box
  (sano's model, no SSH).
- `remote` ops CLI — `status/health/dashboard/resources/git/logs/start/stop/
  restart`, generalized from bewks `remote-agent.js`, driven by PM2 app names.
- `startTunnel({ configPath, tunnelName })` — Cloudflare tunnel launcher.
- `deploy-kit` bin + `.deploy-kit.config.json` config file.
- Consumers pair this with `@andrewpopov/db-backup` by pointing `hooks.backup`
  at a db-backup CLI invocation.
