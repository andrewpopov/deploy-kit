# @andrewpopov/deploy-kit

Hook-driven deploy pipeline, remote PM2 ops CLI, and Cloudflare tunnel launcher
for self-hosted Node services — apps that run under PM2 on a single box (a
Raspberry Pi, a home server, a small VPS) and deploy by `git pull`. One JSON
config per app replaces a hand-rolled `deploy.sh`: the kit runs
stash → pull → install → backup → migrate → build → restart → health-gate, with
the safety behavior those scripts usually lack (the backup gates the migration,
paused apps are resumed on any failure, deploys are locked and health-verified).

## Install

Pin the latest tag (tags are immutable — always pin `vX.Y.Z`, never a branch):

```
npm install github:andrewpopov/deploy-kit#v0.14.0
```

## Quick start

```
npx deploy-kit init          # scaffold .deploy-kit.config.json + scripts block
# edit the config for your app…
npx deploy-kit deploy --dry-run   # print the exact command stream, run nothing
npx deploy-kit deploy             # run it for real
npx deploy-kit deploy --branch feature/demo  # one-run branch override
```

## Configure

Drop a `.deploy-kit.config.json` in the repo root (or run `deploy-kit init`):

```json
{
  "host": "youruser@your-tailscale-host",
  "projectDir": "/srv/yourapp",
  "mode": "ssh",
  "appNames": ["yourapp-app", "yourapp-worker"],
  "dbBoundApps": ["yourapp-app", "yourapp-worker"],
  "tunnelName": "yourapp-tunnel",
  "port": 3000,
  "healthPath": "/api/health",
  "hooks": {
    "install": "npm ci --prefer-offline || npm ci || npm install",
    "backup": "npx db-backup backup --prod --allow-missing",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

## Project policies

See [Contributing](./CONTRIBUTING.md), [Support](./SUPPORT.md), and the
[Security Policy](./SECURITY.md). This package is licensed under [MIT](./LICENSE).

The `.deploy-kit.config.json` holding your real host/paths lives in each
**consumer** repo, never in this package. The config is validated on load —
unknown keys, wrong types, a bad `mode`, or a removed key (e.g.
`ensureTunnelOnDeploy`) fail with a clear error instead of a silent no-op.
This includes NESTED keys, not just top-level ones (unreleased) — a typo like
`hooks.migarte` is rejected by name at load, the same as a top-level typo,
instead of silently validating fine and leaving `hooks.migrate` at its
default. Covers `hooks`, `health`, `ssh`, `layout`, `deliveryEvent`, and every
`monitor` sub-block (`disk`/`backup`/`restartStorm`/`alert`, on top of
`monitor` itself). The one deliberate exception: `healthHeaders` and a public
probe's `headers` are raw HTTP-header maps — the "key" there is a header name
the operator chooses, not a fixed config field, so those stay open to any key.

### Multiline target programs

Programmatic consumers must use `runScriptOnTarget(script, config)` for a
multiline POSIX shell program. It sends the program over stdin to a fixed
`sh -se` command, including through SSH, so no controller shell reparses its
newlines, variables, or command substitutions. Do not use
`JSON.stringify(script)` as shell quoting: deploy-kit rejects that encoded form
before execution because its literal `\n` tokens can be interpreted as command
text or redirection filenames.

### Config reference

| Key | Type | Default | Mode | Since | Notes |
| --- | --- | --- | --- | --- | --- |
| `host` | `string \| null` | `null` | ssh | 0.1 | `user@host`; required for `mode:'ssh'`. |
| `projectDir` | `string \| null` | `null` | both | 0.1 | Absolute path on the target; `cd`-ed into per step. |
| `mode` | `'ssh' \| 'local'` | `'ssh'` | — | 0.1 | `ssh` = deploy from laptop; `local` = script runs on the box. |
| `remote` | `string` | `'origin'` | both | 0.1 | Git remote to fetch/pull. |
| `branch` | `string \| null` | `null` | both | 0.1 | `null` → resolve `origin/HEAD`, fall back to `master`. `deploy --branch NAME` overrides this value for one invocation. |
| `appNames` | `string[]` | `[]` | both | 0.1 | PM2 apps to (re)start; the first is the health-gated web app. |
| `dbBoundApps` | `string[]` | `[]` | both | 0.1 | Apps stopped before migrate to release a SQLite lock; resumed on any failure. |
| `tunnelName` | `string \| null` | `null` | both | 0.1 | cloudflared PM2 process name — ops-verb display only (use `ensureApps` to keep it up). |
| `ensureApps` | `string[]` | `[]` | both | 0.4 | Auxiliary PM2 procs ensured up (tolerant) AFTER the app restart. A failure never fails the deploy. |
| `preDeployChecks` | `{name,command}[]` | `[]` | both | 0.4 | Gates run BEFORE anything is touched; non-zero aborts with nothing changed. |
| `preMigrationChecks` | `{name,command}[]` | `[]` | both | unreleased | Gates run after candidate preparation but before `dbBoundApps` are stopped. Use for a migration rehearsal against a disposable current-data copy; non-zero aborts before the disruptive window. Skipped with `--skip-migrate`. |
| `postDeployChecks` | `{name,command,onFailure?}[]` | `[]` | both | 0.8 | Gates run after restart and health succeeds. Release layouts require `onFailure: 'rollback' \| 'remain-active' \| 'manual'` for every check; see the policy section below. Legacy layouts retain their historical remain-active behavior. |
| `preRestartChecks` | `{name,command}[]` | `[]` | both | 0.10 | Gates run IMMEDIATELY BEFORE the app restart (after build, with `dbBoundApps` still paused; after the release-layout flip). A failure resumes any paused apps (legacy deploy) or runs phase recovery (release-layout deploy) before aborting. Also gates `rollback`'s restart, for both layouts — under the release layout, `current` is flipped to the rollback target BEFORE this check runs, so a failure here flips `current` back and re-verifies the original release before aborting; it never leaves the symlink pointing somewhere the running process disagrees with (unreleased — this used to throw straight out, mid-flip). If the flip-BACK itself also fails, PM2 is deliberately left untouched and the error escalates to `MANUAL RECOVERY REQUIRED` — restarting against an unconfirmed `current` could activate the very release the recovery was trying to move away from, which is worse than doing nothing (unreleased). Use for a check against the freshly-built/flipped candidate right before it takes traffic — e.g. `port-guard` (see below). |
| `ecosystemFile` | `string \| null` | `null` | both | 0.3 | PM2 ecosystem file (rel. to `projectDir`). Enables first-deploy-safe `pm2 start … --only … --update-env \|\| pm2 restart … --update-env`; each deploy refreshes process env from the ecosystem file. |
| `port` | `number` | `3000` | both | 0.1 | Health-probe port (`http://localhost:<port>`). |
| `healthPath` | `string` | `'/api/health'` | both | 0.1 | Health-probe path. |
| `healthHeaders` | `Record<string,string>` | `{}` | both | 0.3.1 | Extra probe headers, e.g. `{"X-Forwarded-Proto":"https"}` behind a TLS proxy. |
| `healthChecks` | `{port?,path?,headers?}[]` | `[]` | both | 0.5 | Extra endpoints to gate (app+worker fleets). Omitted fields fall back to the scalars. |
| `health.attempts` | `number` | `30` | both | 0.1 | Health-poll attempts per endpoint. |
| `health.delaySeconds` | `number` | `2` | both | 0.1 | Delay between health polls. |
| `ssh.connectTimeout` | `number \| null` | `10` | ssh | 0.5 | `-o ConnectTimeout`; `null` omits. |
| `ssh.serverAliveInterval` | `number \| null` | `15` | ssh | 0.5 | `-o ServerAliveInterval`; `null` omits. |
| `ssh.serverAliveCountMax` | `number \| null` | `3` | ssh | 0.5 | `-o ServerAliveCountMax`; `null` omits. |
| `ssh.options` | `string[]` | `[]` | ssh | 0.5 | Extra raw `-o Key=Value` flags. Placed BEFORE `ssh.strictHostKeyChecking`/`ssh.batchMode` on the command line so a `Key=Value` you set here wins: OpenSSH uses the *first* value it sees for a repeated `-o`, so an override must precede deploy-kit's own default of the same key. |
| `ssh.strictHostKeyChecking` | `string \| null` | `'accept-new'` | ssh | unreleased | `-o StrictHostKeyChecking`; `null` omits. Pins a first-seen host key without an interactive prompt. |
| `ssh.batchMode` | `string \| null` | `'yes'` | ssh | unreleased | `-o BatchMode`; `null` omits. Turns any remaining ssh prompt into a fast failure instead of hanging an unattended deploy. |
| `stepTimeoutSeconds` | `number \| null` | `1800` | both | 0.5 | Per-command wall-clock timeout; explicit `null` = no limit. |
| `lock` | `boolean` | `true` | both | 0.5 | Take an atomic target lock so concurrent deploys can't interleave. |
| `buildBeforeMigrate` | `boolean` | `false` | both | 0.2 | Build while apps are UP (paused window = just migration). |
| `verifyPins` | `boolean` | `true` | both | 0.17 | Abort the deploy when the target's installed packages disagree with what its `package.json` pins. Runs on the target right after install, before backup/migrate/build/restart, so a stale install costs a deploy rather than an outage. Neither `npm install` nor `npm ci` re-resolves a changed `github:owner/repo#ref` (verified against npm 11.9.0), so without this a dependency the manifest says was replaced ships silently. Escape hatch: `--skip-pin-check`. |
| `hooks.install` | `string` | `npm ci --prefer-offline \|\| npm ci \|\| npm install` | both | 0.1 | Dependency install; offline-first so a GitHub outage can't break a no-dep-change deploy. |
| `hooks.generate` | `string \| null` | `null` | both | unreleased | Codegen that writes into `node_modules` (e.g. `npx prisma generate`). Runs unconditionally right after install, before build. Keep this OUT of `hooks.build`: a build tool's own cache (Nx/Turbo) can replay a cache hit and skip the build command entirely, silently skipping a generator baked into it while `npm ci` has already wiped what it was supposed to regenerate. `null` = skip. |
| `hooks.backup` | `string \| null` | `null` | both | 0.1 | Pre-migration backup **gate** — a failure aborts before any schema change. Preferred output contract: JSON on stdout with a top-level `backupId` (db-backup >= 0.18.0 emits this). Legacy fallbacks remain supported: `id`, `created.fullPath`, `created.fileName`, or a safe final-line id/path. The parsed id is correlated to `deliveryEvent` as a leaf-only `backupReference`; if nothing parses, deploy-kit logs a loud warning (restore correlation unavailable) but never fails the deploy over it. |
| `hooks.migrate` | `string \| null` | `null` | both | 0.1 | Migration command; runs with `dbBoundApps` paused. |
| `hooks.build` | `string \| null` | `null` | both | 0.1 | Build command. |
| `hooks.restart` | `string \| null` | `null` | both | 0.3 | Override the app (re)start command. `null` → the `ecosystemFile`-aware start-or-restart idiom. |
| `hooks.restore` | `string \| null` | `null` | both | 0.7 | Restore the pre-migration DB backup during release-layout recovery (gets `DEPLOY_KIT_BACKUP_ID`). `null` = no auto-restore. |
| `layout` | `{type:'releases',…} \| null` | `null` | both | 0.7 | Opt-in artifact-first release layout (see below). `null` = legacy in-place deploy. |
| `layout.keepReleases` | `number` | `4` | both | 0.7 | Releases retained when pruning (≥1). |
| `layout.sharedPaths` | `string[]` | `[]` | both | 0.7 | Relative paths symlinked from `shared/` into every release (dirs, `.env`, uploads — never `node_modules` or a bare SQLite file). Validated relative + non-overlapping. |
| `layout.releaseChecks` | `{name,command}[]` | `[]` | both | 0.7 | Commands run INSIDE the candidate release before activation (prisma client loads, entrypoint present). Non-zero quarantines the candidate. |
| `layout.runningShaCommand` | `string \| null` | `null` | both | 0.7 | Returns the SHA the live app reports; asserted == deployed SHA post-flip. |
| `monitor` | `{…} \| null` | `null` | both | 0.8 | Opt-in fleet monitoring + alerting (see below). `null` = disabled. |
| `monitor.alert` | `{command, run?}` | — | both | 0.8 | Required. Policy-free sink; gets the batched alert JSON on stdin. `run`: `controller` (default) or `target`. |
| `monitor.publicProbes` | `{id,url,…}[]` | `[]` | both | 0.8 | External endpoint probes (unique `id`, https url). Proves DNS+ingress+TLS+routing. |
| `monitor.publicProbes[].expectStatus` | `number \| number[]` | `200` | both | 0.8 | Expected `curl` HTTP status code, or a list of acceptable codes; anything else is `crit`. Shape-validated (unreleased). |
| `monitor.publicProbes[].expectBodyIncludes` | `string` | — | both | 0.8 | The probe body must contain this substring, checked with JS `String#includes`; else `crit`. Shape-validated (unreleased). |
| `monitor.publicProbes[].maxTimeSeconds` | `number` | `min(checkTimeoutSeconds - 1, 10)`, floor `2` | both | 0.8 | Per-probe `curl --max-time` override. Shape-validated (unreleased). |
| `monitor.checks` | `{id,command,level?}[]` | `[]` | both | 0.8 | App-supplied checks; non-zero exit ⇒ alert at `level` (static severity). |
| `monitor.disk` / `.backup` / `.restartStorm` / `.tunnel` | see below | off | both | 0.8 | Built-in host checks (omit a key to skip it). |
| `monitor.failAfterRuns` / `.recoverAfterRuns` | `number` | `2` | both | 0.8 | Cross-run debounce before alert / recovery. |
| `monitor.reAlertAfterMinutes` | `number` | `0` | both | 0.8 | Re-fire a still-failing alert after N minutes (0 = quiet). |
| `monitor.stateFile` | `string` | `<dir>/.deploy-kit-monitor-state.json` | both | 0.8 | Abs path to monitor state — a STABLE dir, never under `releases/`. |
| `monitor.checkTimeoutSeconds` | `number` | `20` | both | 0.8 | Per-check wall-clock bound. |
| `deliveryEvent` | `{command} \| null` | `null` | both | 0.9 | Opt-in post-health delivery event (see `announce-discord` below). `null` = skip. `command` is the only valid key — a typo (e.g. `comand`) is now rejected at config load (unreleased) instead of silently no-op'ing the feature. |
| `deliveryEvent.command` | `string` | — | both | 0.9 | Shell command run on the target; receives structured deployment JSON (`event`, `status`, `branch`, `revision`, `deployedAt`, `failedCheck?`, `activeRevision?`, `activeRelease?`, `recovery?`, `backupReference?`) on **stdin**. Events cover success and release-layout post-check recovery. A sink failure is warned and recorded but never changes recovery policy. In the release layout, the command also gets `DEPLOY_KIT_SHARED_DIR` (unreleased, see below). |

### mode: local

Set `"mode": "local"` for a box that runs the deploy on itself (no SSH) — it runs
each step as `sh -c 'cd <projectDir> && …'` and skips the tracked-file stash. See
the local-mode example below.

### Release layout (artifact-first deploys)

The default (legacy) deploy runs `pull → npm ci → migrate → build → restart` **on
the live worktree** — `npm ci` and build mutate the very `node_modules`/generated
tree the running process is loading, which is how a mid-deploy restart hits
`@prisma/client did not initialize yet` and crash-loops. Adding a `layout` block
switches an app to an immutable-release layout where install and build never touch
the live tree. Note this does NOT by itself protect a generator (e.g. `prisma
generate`) baked into `hooks.build`: a build tool's own cache (Nx/Turbo) is
typically keyed by content, not by directory, so a cache hit inside a freshly
materialized release can still skip the generator entirely. Use `hooks.generate`
(see the config reference) for anything that must run every time regardless of
any build cache, under either layout:

```
/srv/<app>/
  repo.git/                 # bare repo (fetch target; never runnable)
  releases/<sha>-<ts>/      # one detached worktree per deploy, self-contained
  shared/                   # persistent state symlinked into each release
    .env  cache/npm  data/  ecosystem.config.cjs   # (literal cwd: …/current)
  current  -> releases/<active>     # atomic symlink; PM2 cwd points here
  previous -> releases/<known-good>
  .deploy-kit-layout        # versioned marker (host is migrated)
  .deploy-kit-state.json    # explicit release metadata
```

A `deploy` then: fetches into `repo.git`, resolves the exact SHA, `worktree add
--detach`es a new release, symlinks `sharedPaths` in, runs `hooks.install`
(`npm_config_cache` → `shared/cache/npm`) and `hooks.build` **inside the release**
while `current` still serves, validates it (`releaseChecks` + SHA match), and only
then opens the disruptive window — stop `dbBoundApps` → `hooks.backup` → `hooks.migrate`
→ atomic `mv -Tf` flip of `current` → `pm2 startOrRestart` from the stable
`ecosystemFile`. Activation is confirmed against `/proc/<pid>/cwd`, the app-reported
SHA (`layout.runningShaCommand`), PM2 online state, and a restart-count settling
window before the deploy is called healthy. `rollback` is an instant flip back to
`previous` (already built). A failed deploy recovers per phase and, if a migration
had already run, restores the backup (`hooks.restore`) or stops with `MANUAL
RECOVERY REQUIRED` — it never resumes stale code against a migrated schema. If the
symlink flip-BACK during that recovery itself fails, PM2 is deliberately left
untouched (never restarted onto whatever `current` still resolves to — possibly the
failed candidate) and the failure escalates to `MANUAL RECOVERY REQUIRED` naming
the still-active target; a migration's DB restore still runs regardless (writers
were already confirmed stopped, so it's a safe, traffic-independent data operation)
but nothing is resumed (unreleased).

A hard process, SSH, or power interruption is checked at the start of the next
`deploy`, before any new release work begins — but only a `stopped` journal is
recovered automatically: the journal is written the moment the stop phase
begins, so it only proves no migration or symlink flip had begun — not that
writers were actually confirmed stopped. Either way resuming the untouched
previous release is safe, so deploy-kit validates the journaled release id
and the live `current` pointer, then resumes the previous release and
re-verifies it. An interrupted
`migrated` or `flipped` journal fails closed with `MANUAL RECOVERY REQUIRED`
instead of being auto-restored, for two different reasons. Once the
pre-migration backup has been taken (a `migrated` journal, or `flipped` with
`migrated: true`), deploy-kit has no reliable way to prove no writes have
landed since that backup — a service manager (e.g. PM2 resurrect replaying a
previously saved dump) or an operator may have already brought the old app
back online before the next deploy runs. A code-only `flipped` journal (no
backup, `migrated: false`) has no post-backup writes to worry about, but it
still fails closed because deploy-kit cannot trust the on-disk
`current`/`previous` pointers against whatever process is actually running
without re-deriving that state by hand. Either way, deploy-kit does not stop
apps, restore the backup, rewrite the `current`/`previous` symlinks, or restart
PM2; the operator must reconcile the database/schema and the `current` pointer
by hand, then set `"phase":"done"` in `.deploy-kit-state.json` (or remove it)
before deploying again. Post-deploy policy/rollback interruptions likewise
require manual reconciliation.

#### Post-deploy failure policy

Every release-layout `postDeployChecks` entry must choose what happens when its
command fails:

```json
"postDeployChecks": [
  { "name": "public-smoke", "command": "npm run smoke:prod", "onFailure": "rollback" }
]
```

- `rollback` stops and confirms DB writers when a migration ran, flips `current`
  to the prior release, restores the pre-migration backup, restarts, and verifies
  the prior release. If any recovery gate fails, traffic is not blindly resumed
  and the command escalates to `MANUAL RECOVERY REQUIRED`.
- `remain-active` keeps the already activation-verified candidate serving but
  records the deployment as degraded.
- `manual` also leaves the verified candidate serving, records a failed deployment,
  and names the unresolved operator decision explicitly.

The on-host journal is written at failure, before rollback, and at the terminal
outcome. A configured `deliveryEvent.command` then receives a `failed` or
`degraded` event with the failed check, attempted revision, active release or
revision, recovery policy/outcome, and only the redacted backup leaf reference.
A failed event sink is warned but cannot change the chosen recovery action; the
journal remains the durable local record. A hard interruption during post-deploy
rollback is recognized on the next invocation and blocks a new deploy until
reconciled — same as an interrupted `migrated`/`flipped` journal (see above);
only an interrupted `stopped` journal recovers automatically.

**Flag semantics differ by layout** — the same flag can mean something
different, or nothing, depending on which pipeline is running:

- `deploy --skip-build`/`--skip-deps` are honored the same way as legacy:
  they skip the build/install step inside the candidate release.
- `deploy --no-stash` is **rejected** under this layout: each release is
  materialized fresh via `git worktree add`, so there is no working tree to
  stash. Legacy deploys still honor it.
- `rollback --skip-build`/`--skip-deps` are **rejected** under this layout:
  rollback is an instant flip to the already-built `previous` release, so
  there is no install/build step for those flags to skip. Legacy `rollback`
  still honors both (it really does rebuild).

Release deploy **requires a migrated host** (the `.deploy-kit-layout` marker) and a
stable `ecosystemFile` whose `cwd` is the literal `…/current`. deploy-kit never
performs the one-time host restructure — that is a separate, per-app, reversible
migration. A legacy deploy against a migrated host (or vice-versa) fails closed.

`--dry-run` against a release layout is a deterministic, config-only plan. It
prints the complete command stream from preflight through materialize, install,
pin verification, build, validation, backup/migration, activation verification,
post-deploy checks, delivery event, metadata, and pruning without opening SSH or
executing a local target command. Captured values that later phases require —
layout marker, current/previous pointers, commit SHA, release timestamp, backup
reference, PM2 state, health, and running SHA — are internally consistent symbolic
values. Config validation still runs before planning and fails by the exact invalid
field. Use a real deploy or an explicit live diagnostic when host truth is required;
the dry-run is an executable-plan review, not a host health check (unreleased,
CAIRN-369).

### `port-guard` (shared-host port-conflict guard)

On a multi-tenant host, a stale/unrelated process can end up squatting on the port
your app is about to (re)claim — the reload then either fails or, worse, silently
takes the WRONG process offline. `deploy-kit port-guard <port> <pm2-process-name>`
checks who currently holds `<port>`:

- nothing listening → exit 0 (free)
- every listener is `<pm2-process-name>`'s pm2 process or a descendant PID (BFS via
  `pgrep -P` / `ps --ppid`) → exit 0 (safe to reload)
- any listener is a foreign process → exit 1, naming the squatting PID(s)
- neither `lsof` nor `ss` is present on the host → exit 1 (**fails closed**; an
  unverifiable guard is not a passed guard)

It's a plain check command, so wire it into `preRestartChecks` (it then runs on the
target immediately before the restart, gating it):

```json
"preRestartChecks": [
  { "name": "port-safe", "command": "npx deploy-kit port-guard 3006 towerpower-app" }
]
```

### `verify-pins` (did the pin you bumped actually install?)

`npm install` does **not** re-resolve a `github:owner/repo#tag` dependency when
only the tag changes — the lockfile is keyed on the already-resolved commit. So
this sequence is silent and green, and leaves you running the old code:

```
pinned #v0.2.0  ->  installed 0.2.0
   (bump the manifest to #v0.3.0, npm install, exit 0)
pinned #v0.3.0  ->  installed 0.2.0      <-- manifest and reality disagree
```

For an ordinary dependency that is an annoyance. For a security kit it means a
fix you shipped, tagged, and deployed can silently not be running, with every
gate green. `deploy-kit verify-pins` turns that into a loud failure:

```
$ npx deploy-kit verify-pins
✗ MISMATCH  package.json  @andrewpopov/release-kit: pinned #v0.3.0 (want 0.3.0), installed 0.2.0
✗   fix: npm install "github:andrewpopov/release-kit#v0.3.0" --save
✗ verify-pins: 0 ok, 1 MISMATCH, 0 missing, 0 unverifiable (non-semver refs), 0 absent, 0 corrupt
```

Run at a workspace root — npm/yarn's `workspaces` field or pnpm's
`pnpm-workspace.yaml` — it checks the root manifest **and every workspace
member manifest**, naming which one each problem is in (the summary line adds
`across N manifests` once there's more than one):

```
$ npx deploy-kit verify-pins
✗ MISMATCH  packages/api/package.json  ghost-pkg: pinned #v1.0.0 (want 1.0.0), installed 0.9.0
✗   fix: npm install "github:andrewpopov/ghost-pkg#v1.0.0" --save
✗ verify-pins: 12 ok, 1 MISMATCH, 0 missing, 0 unverifiable (non-semver refs), 0 absent, 0 corrupt across 3 manifests
```

Each pin is resolved the way node does — walking up from its manifest's
directory through `node_modules/<name>` — but **bounded to the project**: a
workspace member's walk stops at (and includes) the workspace root, so hoisted
and pnpm's symlinked layouts both work, and the root's own pins (or any
standalone, non-workspace project's) never walk past their own directory at
all. A same-named package that only exists further up — an unrelated sibling
project's `node_modules`, say — is reported `missing`, not `ok`; the tool
never resolves past a `.git` directory either way. Pins whose ref is a branch
or a commit SHA — or a `semver:` RANGE (`semver:^1.0.0`, `semver:1.x`) — carry
no single assertable version; those are counted and printed as
**unverifiable** rather than dropped, so the summary never claims more
coverage than it has. An exact npm `semver:<version>` selector
(`semver:1.2.3`) and build metadata on a tag (`#v1.2.3+build.1`) ARE
verifiable — compared like an ordinary tag, with a leading `v` and build
metadata ignored on both the pin and the installed version (only the
prerelease identifier, if any, must match exactly). The INSTALLED version is
validated against the same semver grammar before that comparison — a garbage
installed `version` field (`1.2.3+`, `1.2.3+build..1`) is a `MISMATCH`, never
silently normalized down to something that happens to match.

A pin in `optionalDependencies` or `peerDependencies` that isn't installed at
all is reported **absent**, not `missing` — npm never guarantees either gets
installed (an optional dep can fail to build and is skipped; a peer dep is
often left for the consumer to provide), so an absent one doesn't fail the
run. A present-but-wrong-version optional/peer pin is still a `MISMATCH` and
still fails — `absent` only covers "never installed", not "installed wrong".
If `node_modules/<name>/package.json` EXISTS but can't be read or parsed,
that's reported **corrupt**, never `absent` — something IS on disk and it
isn't the package it claims to be, which fails the run for every dep field,
optional/peer included.

If the same package name is pinned in more than one dependency field of the
same manifest (e.g. both `dependencies` and `optionalDependencies`), only ONE
entry is reported, for the field npm gives effective precedence to —
currently just `optionalDependencies` winning over `dependencies` — so an
absent optional/peer duplicate is never also double-reported as a failing
`missing` for the same install.

Run it wherever you want the guarantee — a `verify` script, or as a
`preRestartChecks` command to gate a deploy:

```json
"preRestartChecks": [
  { "name": "pins", "command": "npx deploy-kit verify-pins" }
]
```

### Repository guards (`verify-tunnel-config`, `verify-no-secrets`)

These standalone commands let each application keep its own policy in a
checked-in `deploy-kit.guards.json` while deploy-kit owns the verification
mechanics. Neither command reads `.deploy-kit.config.json`.

```json
{
  "tunnel": {
    "configFile": "cloudflared-config.yml",
    "requiredRules": [
      { "hostname": "app.example.com", "path": "^/api(/.*)?$", "service": "http://127.0.0.1:3002" },
      { "hostname": "app.example.com", "path": "^/health$", "service": "http://127.0.0.1:3002" }
    ],
    "requiredHostnameRules": [
      {
        "hostname": "ha.example.com",
        "service": "http://127.0.0.1:8124",
        "allowPath": false
      }
    ],
    "forbiddenServiceIncludes": [":8123"],
    "requireAnchoredPaths": true,
    "finalService": "http_status:404"
  },
  "secrets": {
    "patterns": [
      { "name": ".env", "kind": "basename-equals", "value": ".env" },
      { "name": ".env.bak*", "kind": "basename-prefix", "value": ".env.bak" },
      { "name": "*.pem", "kind": "basename-suffix", "value": ".pem" },
      { "name": ".gnupg/", "kind": "path-segment", "value": ".gnupg" },
      { "name": "backups/", "kind": "root-path", "value": "backups" }
    ]
  }
}
```

`verify-tunnel-config` checks that each required rule's `hostname`+`path`
exists, routes to its exact service, and appears before the first catch-all
that could shadow it — a pathless rule only shadows a required path when the
pathless rule itself has no hostname (a global fallback) or its hostname
matches the required rule's; a same-path catch-all scoped to a *different*
host never shadows it. It also checks anchored path regexes, required
full-host routes, forbidden direct origins, and the final fallback when
configured. `verify-no-secrets` checks both tracked paths and
untracked, unignored paths that `git add -A` could stage. It is deliberately a
filename-policy guard, not a content secret scanner.

```bash
npx deploy-kit verify-tunnel-config
npx deploy-kit verify-no-secrets
```

Use `--dir PATH`, `--guard-config PATH`, or `--json` when a repository needs a
non-default root/config path or machine-readable output. Supported secret
pattern kinds are `basename-equals`, `basename-prefix`, `basename-suffix`,
`path-segment`, and `root-path`.

### Monitoring (`deploy-kit monitor`)

Add a `monitor` block to turn on cron-driven ops monitoring + alerting. It runs the
generic checks every fleet host needs (so five apps don't each re-implement them) and
routes actionable alerts through a sink you supply:

```json
"monitor": {
  "disk": { "minFreeKiB": 524288, "minFreeInodes": 10000 },
  "backup": { "id": "db", "stampFile": "/var/lib/app/backups/.last-success", "maxAgeHours": 30 },
  "restartStorm": { "maxDelta": 3 },
  "tunnel": true,
  "publicProbes": [{ "id": "api", "url": "https://app.example.com/health", "expectStatus": 200 }],
  "checks": [{ "id": "ready", "command": "curl -fsS localhost:3002/ready", "level": "warn" }],
  "alert": { "command": "curl -fsS -X POST -d @- https://app.example.com/internal/alert", "run": "controller" },
  "failAfterRuns": 2, "recoverAfterRuns": 2, "reAlertAfterMinutes": 60,
  "stateFile": "/var/lib/app/deploy-kit-monitor-state.json"
}
```

Run it on a cron: `*/5 * * * * cd /path/to/app && npx deploy-kit monitor`. Each run
locks, reads state, runs every enabled check, and applies a per-check state machine:
a check must be non-`ok` for `failAfterRuns` consecutive runs before it alerts and `ok`
for `recoverAfterRuns` before it clears, so flapping is ridden out. A status of
`unknown` (ssh/command failure, unparseable output) never counts as ok or a recovery —
it holds. All transitions in a run are **batched into one alert event** (one incident
isn't four correlated pages), delivered to `alert.command` as JSON on **stdin**; the
event is persisted to `stateFile` *before* sending and retained for retry if delivery
fails (at-least-once; the `eventId` lets your sink dedupe). `alert.run: 'controller'`
runs the sink on the machine running deploy-kit (robust when the monitored app is what's
down); `'target'` runs it on the host. Exit codes, in precedence order (unreleased —
this used to be CRITICAL-or-OK only, `2` was unreachable, and a crit whose alert
delivery failed silently ranked above a crit whose delivery succeeded, with no single
place in the code deciding it): **(1)** alert delivery to `alert.command` FAILED this
run → `2` — this outranks even a crit. Counterintuitive, so: once delivery fails, the
exit code is the ONLY channel left that still tells anyone anything — a crit whose
alert WAS delivered already reached the operator through the sink, so `1` is just
confirmation; a crit whose delivery FAILED reached nobody, and `1` alone would
understate that. Rank by how much the operator can actually learn from this run, not
by which signal sounds scariest in isolation. **(2)** else any check `crit` → `1` — a
real critical condition that DID get through (delivered, or nothing needed delivering
yet — e.g. still inside the debounce window). **(3)** else any check `unknown` (ssh
down, a probe timed out, …), or **zero checks configured at all** (a `monitor` block
only requires `alert` — one with no disk/backup/tunnel/probes/checks/appNames
inspects nothing, every run) → `2`, a monitor/config/delivery failure — this is *any*,
not *all*: a run where four of five checks are unknown and one is `ok` still exits
`2`, because blindness about even one configured check must not be silently folded
into "all fine". **(4)** else → `0`. Provider/scheduler-specific signals
belong in `checks[]` (statically-severitied) so they alert without flapping liveness —
keep the app's own `/live` vs `/ready` split app-side.

**`deploy-kit monitor --local`** (Since 0.19): forces `mode:'local'` for this run only,
via the same validated config-override path `loadConfig()` already exposes — it does not
touch the config file. Use it when a consumer repo commits an ssh-mode config for
laptop-driven `deploy`/`rollback`, but the 24/7 `monitor` cron runs on the target box
itself: every check and the alert sink then execute locally (no ssh), while `host` is
left untouched and still identifies the target in the monitor header/alert event.

#### `alert-discord` — bundled Discord sink (opt-in convenience, not a policy change)

`monitor.alert` is deliberately **policy-free**: `monitor.js`/`checks.js` only know
how to hand the batched alert JSON to whatever `command` you configure — they have
no idea what Discord, Slack, or PagerDuty are, and this stays true after adding
`alert-discord`. What ships is a *consumer* of that same stdin-JSON contract, exactly
like a hand-rolled `curl` one-liner would be, just bundled so a project doesn't have
to hand-roll it:

```json
"monitor": {
  "alert": { "command": "npx deploy-kit alert-discord" }
}
```

It reads the batched alert event on stdin, resolves the webhook URL from
`process.env.DISCORD_ALERT_WEBHOOK` (override the env var name with
`--webhook-env NAME`), and POSTs with a 10s timeout. Use `--service NAME` or
`DISCORD_ALERT_SERVICE` to brand the message. Input is bounded to 256 KiB and
output to Discord's 2,000-character limit. Invalid or empty input is
non-retryable and exits `0`, preventing a poison batch from remaining in the
monitor outbox forever. An unset env var or a failed/timed-out POST remains a
genuine delivery failure and exits non-zero. The webhook URL is never logged.

#### `announce-discord` — bundled release sink (opt-in convenience, not a policy change)

The RELEASE counterpart to `alert-discord`, modeled 1:1 on it. `deliveryEvent`
is likewise deliberately **policy-free**: `deploy.js`/`release.js` only know how
to pipe the post-deploy event JSON to whatever `command` you configure, run
`tolerate: true` so a broken sink never fails the deploy. `announce-discord` is
just a bundled *consumer* of that stdin-JSON contract:

```json
"deliveryEvent": { "command": "npx deploy-kit announce-discord" }
```

It reads the delivery event on stdin (`{event:'deployment', status, branch,
revision, deployedAt, failedCheck?, activeRevision?, activeRelease?, recovery?,
backupReference?}` — see `deploy.js`/`release.js`) and renders success, degraded,
and failed recovery outcomes distinctly.
When either deploy layout captured a safe backup id, `backupReference` contains
only its opaque leaf label; host paths and unsafe/noisy output are omitted. It
resolves the webhook URL from `process.env.DISCORD_RELEASE_WEBHOOK` (override with
`--webhook-env NAME`), picks a service name from `--service NAME` /
`DISCORD_RELEASE_SERVICE` / `DISCORD_ALERT_SERVICE` (default `app`), formats
`🚀 \`<service>\` deployed \`<branch>@<shortsha>\` at <time>`, and POSTs it with
a 10s timeout — zero runtime deps, using Node's built-in `fetch`. The webhook
URL is never logged.

**Asymmetric vs `alert-discord` on purpose**: a release announcement is opt-in
decoration on top of an *already-tolerated* `deliveryEvent` step, not the
incident route itself. So an unset `DISCORD_RELEASE_WEBHOOK` prints
`announce-discord: DISCORD_RELEASE_WEBHOOK not set — skipping release
announcement` and **exits 0** — a missing release channel is a skip, never a
reason to turn a healthy deploy red. Malformed stdin and a failed/timed-out
POST are likewise a clear stderr warning and exit `0`. `alert-discord` also
drops malformed input because it cannot become valid on retry, but a missing
webhook or failed POST is retryable and exits non-zero because a broken
incident route is itself a problem.

## Use

```
npx deploy-kit init              # scaffold config + print scripts block
npx deploy-kit port-guard 3006 towerpower-app   # fail if 3006 is held by a foreign process
npx deploy-kit alert-discord [--webhook-env NAME] [--service NAME]  # convenience alert.command: post to Discord
npx deploy-kit announce-discord [--webhook-env NAME] [--service NAME]  # convenience deliveryEvent.command: post a release announcement
npx deploy-kit run-host-operations --action DEPLOY_PRODUCTION  # claim one allowlisted operations-API request and run this configured deploy
npx deploy-kit run-cairn-operations  # deprecated alias: same as above with the Cairn defaults
npx deploy-kit deploy            # full pipeline
npx deploy-kit deploy --dry-run  # print a complete deterministic command plan; contacts no target
npx deploy-kit deploy --branch feature/demo  # deploy this validated branch once; config is unchanged
npx deploy-kit rollback          # git reset to the pre-last-deploy SHA + rebuild + restart
npx deploy-kit dashboard         # status + health + git
npx deploy-kit status|health|resources|git
npx deploy-kit start|stop|restart
npx deploy-kit logs [--lines N] [--follow] [--errors]
npx deploy-kit clear-pending-release  # discard a stuck auto-cut pending-release pointer; the release stays merged
```

### CLI reference

| Command | Flags | Does |
| --- | --- | --- |
| `init` | — | Write a `.deploy-kit.config.json` skeleton (never overwrites) + print the scripts block. |
| `port-guard <port> <pm2-process-name>` | — | Exit 0 if `<port>` is free or held only by `<pm2-process-name>`'s pm2 process tree; exit 1 (naming the PID) if a foreign process holds it, or if neither `lsof` nor `ss` is available (fails closed). Meant to run ON the target as a `preRestartChecks` command — see below. |
| `verify-pins` | `--dir PATH` `--json` | Assert that every `github:owner/repo#vX.Y.Z` dependency is actually **installed** at the version its pin claims. `npm install` does not re-resolve a `github:` tag, so bumping a pin can exit 0 while leaving the old code in `node_modules`. Exits 1 naming each mismatch and the exact re-install command that fixes it. Reports pins whose ref carries no assertable version (`#main`, a commit SHA) rather than silently skipping them. Standalone — reads no `.deploy-kit.config.json`. See below. |
| `verify-tunnel-config` | `--dir PATH` `--guard-config PATH` `--json` | Verify Cloudflare ingress ordering, exact services, anchored path regexes, required host routes, forbidden origins, and final fallback against app-owned `deploy-kit.guards.json`. Standalone. |
| `verify-no-secrets` | `--dir PATH` `--guard-config PATH` `--json` | Fail when an app-configured secret-shaped filename is tracked or is untracked and not ignored. Filename guard only; it does not scan contents. Standalone. |
| `clear-pending-release` | `--dir PATH` `--json` | Discard the crash-recovery pointer at `.deploy-kit/pending-release.json` that auto-cut writes after merging a release PR. Prints the version/sha/PR/timestamp it is discarding, then removes the file. Does **not** unpublish, revert, or un-merge that release — it stays merged and released; the next deploy just stops resuming onto that SHA and deploys current HEAD instead, cutting any pending fragments. Idempotent — no pending pointer is a plain success, exit 0. Standalone, and dispatched before config is loaded — it works even when `.deploy-kit.config.json` or the deploy target is broken, which is exactly the situation an operator reaching for this is in. |
| `alert-discord` | `--webhook-env NAME` `--service NAME` | Convenience `alert.command`: read bounded monitor alert JSON on stdin and POST a length-safe message to Discord (env var `NAME`, default `DISCORD_ALERT_WEBHOOK`). Invalid/empty input exits 0 so a poison batch cannot retry forever; an unset webhook or failed POST remains non-zero. Opt-in — the monitor stays policy-free. |
| `announce-discord` | `--webhook-env NAME` `--service NAME` | Convenience `deliveryEvent.command`: read the post-deploy delivery event on stdin, POST a release announcement to a Discord webhook (env var `NAME`, default `DISCORD_RELEASE_WEBHOOK`). Always exits 0 — an unset env var, malformed stdin, or a failed/timed-out POST is a clear stderr warning, never a failure, since a broken announcement must never fail an already-succeeded deploy. Opt-in — deploy/release stay policy-free. |
| `run-host-operations` | `--action NAME` `--api-url-env ENV` `--api-key-env ENV` | Host-agent command. Requires a base URL and a narrowly scoped API key, read from the env vars named by `--api-url-env`/`--api-key-env` (default `HOST_OPERATIONS_API_URL` / `HOST_OPERATIONS_API_KEY`). Claims at most one request matching `--action`, runs this checkout's existing configured deploy pipeline, and completes the short-lived lease with a redacted result. It never executes a command, host, or path supplied by the operations API. Example: a Cairn-hosted operations API polling for `DEPLOY_CAIRN_PRODUCTION` requests would run `deploy-kit run-host-operations --action DEPLOY_CAIRN_PRODUCTION --api-url-env CAIRN_OPERATIONS_API_URL --api-key-env CAIRN_OPERATIONS_API_KEY`. |
| `run-cairn-operations` | — | **Deprecated** alias for `run-host-operations` with the old fixed defaults (action `DEPLOY_CAIRN_PRODUCTION`, env vars `CAIRN_OPERATIONS_API_URL` / `CAIRN_OPERATIONS_API_KEY`). Kept for existing Cairn consumers; new integrations should use `run-host-operations` directly. |
| `deploy` | `--skip-build` `--skip-deps` `--skip-migrate` `--skip-pin-check` `--no-stash` `--dry-run` `--steal-lock` `--no-lock` `--branch NAME` | Run the full pipeline. `--branch` selects a validated git branch for this invocation without changing config. Under the release layout, `--no-stash` is rejected (nothing to stash — see Release layout below). |
| `rollback` | `--skip-build` `--skip-deps` `--dry-run` `--steal-lock` `--no-lock` | Reset to the recorded pre-deploy SHA, rebuild, restart, health-gate. Does **not** accept `--skip-migrate` or `--no-stash` — rollback never reads them. Under the release layout, `--skip-build`/`--skip-deps` are rejected (rollback is an instant flip to an already-built release — see Release layout below). |
| — `--dry-run` | | Prints the complete deterministic command stream and executes nothing locally or remotely. Release-layout captured values are symbolic and internally consistent so every phase can be reviewed; config validation remains real. See Release layout below. |
| `monitor` | `--steal-lock` `--no-lock` `--local` | Run the `monitor` checks, alert on transitions, exit `0`/`1`/`2`. For a cron. `--local` (Since 0.19) forces `mode:'local'` for this run. |
| `status` / `health` / `resources` / `git` / `dashboard` | — | Read-only target inspection. Exits `1` if the underlying command(s) didn't actually run (e.g. the SSH connection failed) — `dashboard` exits `1` if any of `status`/`health`/`git` does (unreleased; these used to exit `0` regardless). |
| `start` / `stop` / `restart` | — | PM2 lifecycle over `appNames`. Take **no** flags — including no `--dry-run`; these always run for real, and passing any flag (e.g. a typo'd `--dry-run`) is rejected rather than silently ignored. |
| `logs` | `--lines N` `--follow` `--errors` | Tail PM2 logs for `appNames`. |

Every command rejects a flag it does not consume — the Flags column above is the
enforced set (`src/cli.js` `COMMAND_FLAGS`, matched against every command except
`port-guard`, which does its own positional-arg parsing and rejects any `-`-prefixed
argument directly), not just a suggestion. Passing an unsupported flag (a typo, or a
flag from a different command) exits `1` naming the offending flag(s) and what the
command actually supports, instead of parsing fine and silently doing nothing with it.

Or programmatically:

```js
const { loadConfig, deploy } = require('@andrewpopov/deploy-kit');
deploy(loadConfig());
```

## Safety behavior

- **Rollback pointer gate** — before fetch/pull touch anything, the legacy
  (non-release-layout) deploy reads HEAD independently and compares it to the
  pre-pull SHA it just recorded, aborting if they disagree — not merely
  checking that the recorded value LOOKS like a SHA (unreleased fix: a write
  that fails to overwrite an EXISTING, readable pointer — read-only fs,
  permissions, a full disk stopping the redirect from truncating — used to
  leave the OLD, still-plausible-looking SHA in place, and the deploy
  proceeded with that silently STALE pointer). An unborn branch / a brand-new
  repo with no commits yet (HEAD undeterminable) is treated as a legitimate
  first deploy, not a recording failure — there is genuinely nothing to roll
  back to yet, so nothing is gated; `deploy-kit rollback` reports that
  honestly if it's ever run before a first successful deploy. Accepts both
  git object-hash formats (40-char SHA-1, 64-char SHA-256). The release layout
  is unaffected (its rollback is a symlink flip, not this pointer).
- **Backup before migrate** — a failed `hooks.backup` aborts before any schema change.
- **SQLite-lock release** — `dbBoundApps` are `pm2 stop`ped before migrate and
  restarted on any post-stop failure, so a crashed migration/build never leaves
  them down.
- **`--ff-only` pull** and **tracked-only stash** (never sweeps untracked
  `.ssh`/`.cloudflared` into a stash); the deploy-kit stash is dropped after a
  successful pull so stashes don't pile up.
- **Concurrent-deploy lock** — an atomic `mkdir` lock under `$HOME/.deploy-kit/`
  on the target (created mode `700`) stops two deploys of the same target from
  interleaving pm2 stop/start + git pulls. A lock older than
  `stepTimeoutSeconds * 4` (~2h with the default `stepTimeoutSeconds`) is
  considered stale and is taken over automatically on the next run, with a
  logged `stale lock … taking it over` line — no manual step required; within
  that window, `--steal-lock` forces past it. Lock and rollback (`prev-sha`)
  state used to live under `/tmp`, which is world-writable and wiped on
  reboot; an existing `/tmp` `prev-sha` is migrated forward automatically the
  first time a lock is acquired after upgrading. If you scripted around the
  old `/tmp/deploy-kit-<id>.lock` / `.prev-sha` paths, update those scripts.
- **ssh timeouts** — `ConnectTimeout`/`ServerAlive*` so a wedged route fails fast
  instead of hanging the pipeline with apps paused.
- **Health-gate** — polls `http://localhost:<port><healthPath>` (plus any
  `healthChecks`) and fails the deploy if it never returns 200.

Pair with [`@andrewpopov/db-backup`](https://github.com/andrewpopov/db-backup)
for the backup hook.

## Troubleshooting

- **Health probe returns 301, deploy fails as unhealthy.** The app force-redirects
  plain http to https behind a TLS-terminating proxy. Set
  `"healthHeaders": {"X-Forwarded-Proto": "https"}` so the localhost curl gets the
  real 200. (Since 0.3.1.)
- **First deploy of a brand-new PM2 process fails at restart.** `pm2 restart`
  requires the process to already exist. Set `ecosystemFile` so the deploy uses
  `pm2 start <file> --only <name> --update-env || pm2 restart <name> --update-env`.
  The environment refresh is required when the ecosystem file derives a release
  ID or other deploy-time configuration. (Since 0.3.0.)
- **"Another deploy holds the lock".** A previous deploy is still running, or one
  died without releasing. A lock older than `stepTimeoutSeconds * 4` (~2h by
  default) is taken over automatically on the next run — this is what recovers a
  cron `monitor` that wedged mid-run and would otherwise leave every later run
  exiting `2` forever. Inside that window, wait or pass `--steal-lock` to force
  past it.
- **Deploy hangs.** A wedged Tailscale/ssh route. The ssh `ConnectTimeout` bounds
  the connect; set `stepTimeoutSeconds` to bound a long-running remote command.
- **"Invalid deploy-kit config: unknown key …".** A typo or a removed key. The
  error lists valid keys / the migration. `ensureTunnelOnDeploy` → `ensureApps`.
- **A migration ran but you rolled the code back.** `deploy-kit rollback` reverts
  code only. Restore data with your db-backup restore command (the rollback prints
  a reminder when a `backup` hook is configured).

## Examples

**ssh mode — app + worker, both db-bound:**

```json
{
  "host": "shop@pi",
  "projectDir": "/srv/shop",
  "appNames": ["shop-app", "shop-worker"],
  "dbBoundApps": ["shop-app", "shop-worker"],
  "tunnelName": "shop-tunnel",
  "ensureApps": ["shop-tunnel"],
  "healthChecks": [{ "port": 3001, "path": "/worker/health" }],
  "hooks": {
    "backup": "npx db-backup backup --prod --allow-missing",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

**build before migrate, proxy health headers:**

```json
{
  "host": "blog@pi",
  "projectDir": "/srv/blog",
  "appNames": ["blog-app"],
  "dbBoundApps": ["blog-app"],
  "buildBeforeMigrate": true,
  "healthHeaders": { "X-Forwarded-Proto": "https" },
  "hooks": {
    "backup": "npx db-backup backup --prod",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

**local mode — ecosystem file, pre-deploy disk check:**

```json
{
  "mode": "local",
  "projectDir": "/srv/kiosk",
  "branch": "main",
  "appNames": ["kiosk-app"],
  "dbBoundApps": ["kiosk-app"],
  "tunnelName": "kiosk-tunnel",
  "ensureApps": ["kiosk-tunnel"],
  "ecosystemFile": "ecosystem.config.cjs",
  "preDeployChecks": [
    { "name": "disk", "command": "test \"$(df -Pk /srv/kiosk | awk 'NR==2{print $4}')\" -ge 512000" }
  ],
  "port": 3003,
  "hooks": {
    "install": "pnpm install --frozen-lockfile",
    "backup": "bash scripts/backup-db.sh",
    "migrate": "pnpm --filter @kiosk/api db:migrate",
    "build": "pnpm build"
  }
}
```
