'use strict';

const path = require('path');
const { execFileSync: nodeExecFileSync } = require('child_process');
const { runOnTarget, buildHealthCommand, shQuote } = require('./exec');
const { acquireLock, validateOwnedLocks } = require('./lock');
const { log: defaultLog, logFailureOutput } = require('./log');
const { backupIdFromOutput, isSafeBackupId, backupReferenceFromId } = require('./backup-reference');
const { resolveBranch } = require('./branch');
const { buildPinCheckProgram, PIN_CHECK_COMMAND } = require('./pin-gate');
const { parsePm2List } = require('./pm2-state');
const { runAutoCutPreflight } = require('./auto-cut-call');
const { clearAutoCutPending } = require('./auto-cut');
const { assertShaOptions } = require('./sha-options');
const { DEFAULT_WEBHOOK_ENV: ALERT_WEBHOOK_ENV } = require('./alert-discord');
const {
  assertVerifiedRefOptions, verifiedRefLabel, resolveVerifiedTip, assertContainedInVerified,
} = require('./verified-ref');
const { atomicWriteCommand, writeLastDeployRecord } = require('./last-deploy');
const { assertTransitionAuthorityEntryPoint } = require('./transition-authority');
const { createTransitionOperationManager, TransitionOperationError } = require('./transition-operation');
const { createReleasePhaseStorage } = require('./transition-operation-storage');

// A run may execute trusted hooks that write the production DB, so every effect is declared.
const CONSERVATIVE_EFFECTS = {
  stop: true, migrate: true, pointerSwap: true, restart: true, databaseRestore: true,
};
const recoveryRequired = (message, cause) => new TransitionOperationError('RECOVERY_REQUIRED', message, cause);

// Bump when the on-host layout changes shape. The host migration writes this
// version into .deploy-kit-layout; a release deploy refuses a host whose marker
// is absent or a different version, so an out-of-date host can't be deployed to.
const LAYOUT_VERSION = 1;
const PHASE_JOURNAL_VERSION = 1;

// A protected phase write whose durability is unknown (storage JOURNAL_FAILED, possibly wrapped
// by manager.run as RUNTIME_FAILED). Must never be abandoned, retried or generically recovered.
const isPhaseWriteUncertain = (err) => err?.code === 'JOURNAL_FAILED' || err?.cause?.code === 'JOURNAL_FAILED';

// Post-restart settling window: after the app is healthy, sample PM2 restart
// counts this many times, this many seconds apart, and require they never climb.
// Catches a crash-loop that answers one healthy probe between restarts.
const SETTLE_SAMPLES = 3;
const SETTLE_DELAY_SECONDS = 3;

// Minimum free space (KiB) required on the target FS before an install. Filling
// the disk during `npm ci` can corrupt the live SQLite app even though the build
// happens in another directory (Codex). ~500 MiB.
const MIN_FREE_KIB = 512 * 1024;

// A materialized release id is `<sha>-<UTCtimestamp>`. This is the ONLY grammar a
// release directory or symlink target may match — it forbids `.`/`..`/absolute
// paths, so a pointer or listing entry can never traverse out of releases/ or be
// shell-injected. `date -u +%Y%m%dT%H%M%SZ` is fixed-width, so lexical == chronological.
const RELEASE_ID_BODY = '[0-9a-f]{7,40}-\\d{8}T\\d{6}Z';
const RELEASE_ID_RE = new RegExp(`^${RELEASE_ID_BODY}$`);
const RELEASE_TARGET_RE = new RegExp(`^releases\\/${RELEASE_ID_BODY}$`);
const IDENTICAL_CHECK_FAILURE_NOTE = 'check failed identically on both releases: likely the check or its environment, not the release';

function defaultSleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// All host paths derived from the app root (config.projectDir). Everything the
// release layout touches lives under here; nothing is inferred at runtime except
// current/previous, which are read from the symlinks themselves.
function releasePaths(config) {
  const root = config.projectDir;
  return {
    root,
    repoGit: `${root}/repo.git`,
    releasesDir: `${root}/releases`,
    sharedDir: `${root}/shared`,
    currentLink: `${root}/current`,
    previousLink: `${root}/previous`,
    markerFile: `${root}/.deploy-kit-layout`,
    stateFile: `${root}/.deploy-kit-state.json`,
    npmCache: `${root}/shared/cache/npm`,
  };
}

function isReleaseLayout(config) {
  return Boolean(config.layout && config.layout.type === 'releases');
}

// Run one command on the target in a chosen directory (buildTargetCommand prefixes
// `cd <projectDir> &&`, so we clone the config with projectDir swapped to `dir`).
function runInDir(dir, command, config, ctx, { capture = false, tolerate = false, input } = {}) {
  const res = runOnTarget(command, { ...config, projectDir: dir }, { capture, runtime: ctx.runtime, input });
  if (!res.ok && !tolerate && !capture) {
    throw new Error(`Deploy aborted: command failed in ${dir}: ${command}`);
  }
  return res;
}

// Capture trimmed stdout of a command on the target (returns '' on failure).
// `readOnly: true` (see exec.js) lets a caller mark a genuinely non-mutating
// read so it runs for real under `--dry-run` instead of coming back fake-empty
// (PKG-127) — used only by preflight-style reads of pre-existing host state,
// never by a read whose answer depends on something a dry run only PRETENDED
// to have done (e.g. a materialized release directory that doesn't exist yet).
function capture(dir, command, config, ctx, { readOnly = false } = {}) {
  const res = runOnTarget(command, { ...config, projectDir: dir }, { capture: true, runtime: ctx.runtime, readOnly });
  return (res.output || '').trim();
}

// PM2 restart command from the STABLE ecosystem file (literal cwd:current). Never
// bake a real release path into PM2 — startOrRestart re-resolves the symlink when
// it respawns each child (verified post-flip via /proc/<pid>/cwd). Not `reload`
// (graceful overlap is undesirable around a SQLite migration).
function pm2Activate(config, paths) {
  const eco = `${paths.root}/${config.ecosystemFile}`;
  return `pm2 startOrRestart ${eco} --update-env`;
}

// Parse `pm2 jlist` JSON into { name -> { pid, restarts, online } } for our apps.
// Parsing is shared with deploy.js/checks.js via pm2-state.js's tolerant
// `parsePm2List` (PTRY-510 Part 1) — it also fixes a latent gap this local
// version had: `capture()` returns '' both when the command's output was
// genuinely empty AND when the command failed outright (a thrown error's
// `stdout` is captured, and a fake/real failure with no stdout is also '').
// The old `JSON.parse(out || '[]')` treated BOTH cases as "zero processes
// running" — a failed/unreadable `pm2 jlist` right after `stopWritersConfirmed`'s
// stop attempt would silently read back as "confirmed stopped" instead of
// "unknown", exactly the fail-open gap Part 2 closes in deploy.js. No known
// caller here exercised that (no test configures a failing `pm2 jlist`), so
// this is a same-shape drift fix, not a behavior change under existing tests.
function readPm2(config, paths, ctx) {
  const out = capture(paths.root, 'pm2 jlist', config, ctx);
  const list = parsePm2List(out);
  if (list === null) return null; // unreadable — caller treats as a failed check
  const byName = {};
  for (const proc of list) {
    const env = proc.pm2_env || {};
    byName[proc.name] = {
      pid: proc.pid,
      restarts: env.restart_time != null ? env.restart_time : (proc.restart_time || 0),
      online: (env.status || proc.status) === 'online',
    };
  }
  return byName;
}

// Poll the health endpoint(s) until 200 or attempts exhausted (same probe the
// legacy path uses). Returns true/false; does not assert cwd/SHA (that is layered
// on top in verifyActivation).
function waitForHealth(config, ctx) {
  const { attempts, delaySeconds } = config.health;
  const checks = [{}, ...(config.healthChecks || [])];
  for (const check of checks) {
    const command = buildHealthCommand(config, check);
    let ok = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const res = runOnTarget(command, config, { capture: true, runtime: ctx.runtime });
      if ((res.output || '').trim() === '200') { ok = true; break; }
      if (attempt < attempts) ctx.sleep(delaySeconds);
    }
    if (!ok) return false;
  }
  return true;
}

// Poll the running-SHA probe until the app reports the deployed SHA, or attempts
// run out — the SAME attempts/delay policy waitForHealth uses (no separate
// contract: the probe is health-adjacent, usually the same endpoint). A restart
// is not instantaneous: right after `pm2 startOrRestart` the probe can briefly
// answer with the PREVIOUS release's SHA (the old worker still holding the port
// while PM2's scheduler respawns, or the app still serving startup state), so a
// single sample raced exactly the transition it existed to observe and
// false-negatived good deploys into rollbacks. Bounded and fail-closed: on
// exhaustion `ok` is false and `running` is the LAST observed value (possibly
// '' when the probe itself failed), so the caller's diagnostic names what the
// app finally reported rather than just "mismatch".
function waitForRunningSha(config, paths, sha, ctx) {
  const { attempts, delaySeconds } = config.health;
  const expected = sha.slice(0, 12);
  // Protected non-dry-run: only a successful probe whose stdout is exactly the full SHA counts.
  const exact = config.transitionAuthority != null && ctx.runtime?.dryRun !== true;
  let running = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (exact) {
      const res = runOnTarget(config.layout.runningShaCommand, { ...config, projectDir: paths.root }, { capture: true, runtime: ctx.runtime });
      running = (res.output || '').trim();
      if (res.ok && /^[0-9a-f]{40}$/.test(running) && running === sha) return { ok: true, running };
    } else {
      running = capture(paths.root, config.layout.runningShaCommand, config, ctx);
      if (running && running.slice(0, 12) === expected) return { ok: true, running };
    }
    if (attempt < attempts) ctx.sleep(delaySeconds);
  }
  return { ok: false, running };
}

// Every managed app is online under PM2 with a cwd inside `releaseDir` (the release
// IDENTITY, so an old process still online from another release cannot pass). Shared
// by verifyActivation and the rollback recovery. Returns { ok, reason }.
function appsRunFromRelease(config, paths, releaseDir, ctx) {
  const pm2 = readPm2(config, paths, ctx);
  if (!pm2) return { ok: false, reason: 'could not read `pm2 jlist`' };

  const canonicalRelease = capture(paths.root, `readlink -f ${releaseDir}`, config, ctx);
  // Fail closed: without a resolved release path the cwd comparison below is
  // meaningless (an empty canonical + empty cwd would spuriously "match").
  if (!canonicalRelease) return { ok: false, reason: `could not resolve release path ${releaseDir}` };
  for (const name of config.appNames) {
    const proc = pm2[name];
    if (!proc || !proc.online) return { ok: false, reason: `PM2 process ${name} is not online` };
    if (proc.pid == null) return { ok: false, reason: `PM2 process ${name} has no pid` };
    const cwd = capture(paths.root, `readlink -f /proc/${proc.pid}/cwd`, config, ctx);
    // The process may run from a subdirectory of the release (e.g. an API whose
    // ecosystem cwd is <release>/packages/api), so assert cwd is WITHIN the new
    // release, not exactly equal to its root.
    if (!cwd || (cwd !== canonicalRelease && !cwd.startsWith(`${canonicalRelease}/`))) {
      return { ok: false, reason: `${name} (pid ${proc.pid}) cwd is ${cwd || '<unknown>'}, not under ${canonicalRelease}` };
    }
  }
  return { ok: true };
}

// Full activation verification (Codex's five conditions). A deploy "succeeds" only
// when ALL hold, so an old process answering 200 can't mask a failed flip.
//   1. health endpoint(s) return 200
//   2. every managed PID's /proc/<pid>/cwd resolves to the new release
//   3. the running app reports the deployed SHA (if runningShaCommand is set —
//      retried across the health window, but still only ever satisfied by
//      actually observing the expected SHA)
//   4. PM2 reports every app online
//   5. restart counts stay flat across the settling window
// Returns { ok, reason }.
function verifyActivation(config, paths, sha, releaseDir, ctx) {
  const log = ctx.log;
  if (!waitForHealth(config, ctx)) return { ok: false, reason: 'health endpoint never returned 200' };

  const fromRelease = appsRunFromRelease(config, paths, releaseDir, ctx);
  if (!fromRelease.ok) return fromRelease;

  // SHA assertion only applies to a forward deploy (a known target SHA). Recovery
  // and rollback verify the PREVIOUS release with sha=null and skip this check.
  if (config.layout.runningShaCommand && sha) {
    const { ok, running } = waitForRunningSha(config, paths, sha, ctx);
    if (!ok) {
      return {
        ok: false,
        reason: `running app reports SHA ${running || '<none>'}, expected ${sha.slice(0, 12)} after `
          + `${config.health.attempts} attempt${config.health.attempts === 1 ? '' : 's'}`,
      };
    }
  }

  // Settling window: restart counts must not climb (a crash-loop keeps restarting).
  let baseline = null;
  for (let i = 0; i < SETTLE_SAMPLES; i += 1) {
    const snap = readPm2(config, paths, ctx);
    if (!snap) return { ok: false, reason: 'could not read `pm2 jlist` during settle' };
    for (const name of config.appNames) {
      const r = snap[name] ? snap[name].restarts : null;
      if (r == null) return { ok: false, reason: `PM2 process ${name} vanished during settle` };
      if (baseline && r > baseline[name]) {
        return { ok: false, reason: `${name} restarted during the settling window (crash loop): ${baseline[name]} -> ${r}` };
      }
    }
    if (!baseline) baseline = Object.fromEntries(config.appNames.map((n) => [n, snap[n].restarts]));
    if (i < SETTLE_SAMPLES - 1) ctx.sleep(SETTLE_DELAY_SECONDS);
  }
  if (log) log.success('Activation verified (cwd + SHA + online + restart counts stable)');
  return { ok: true };
}

// A release pointer target must be exactly `releases/<release-id>` (RELEASE_TARGET_RE
// forbids `.`/`..`/absolute paths) so it is safe to interpolate into `ln -s` and
// cannot activate code outside the releases tree.
function assertSafeTarget(target, label) {
  if (!target || !RELEASE_TARGET_RE.test(target)) {
    throw new Error(`Refusing to use ${label} pointer "${target || '<empty>'}" — not a safe releases/<id> target.`);
  }
  return target;
}

// Read the current/previous release targets (relative, e.g. "releases/<id>") from
// the symlinks — never inferred from directory listings. Targets are NOT validated
// here (a caller that needs a safe target calls assertSafeTarget).
function readPointers(config, paths, ctx) {
  const readOnly = { readOnly: true };
  const current = capture(paths.root, `readlink ${paths.currentLink} 2>/dev/null || true`, config, ctx, readOnly);
  const previous = capture(paths.root, `readlink ${paths.previousLink} 2>/dev/null || true`, config, ctx, readOnly);
  return { current: current || null, previous: previous || null };
}

// Preflight: host is migrated (marker present + version matches), GNU coreutils
// (mv -T is namespace-atomic), a stable ecosystem file is configured, and there is
// enough free disk. Any failure aborts before a single file is written.
function preflight(config, paths, ctx) {
  // Every read in preflight() answers a question about state that ALREADY
  // exists on the host, independent of anything this deploy will do -- so
  // under `--dry-run` these are marked readOnly to run for real (see
  // capture()/exec.js's readOnly doc). Before this fix (PKG-127) the marker
  // read came back fake-empty under every dry run, so `--dry-run` could never
  // complete against a real release-layout host — it always aborted here with
  // "requires a migrated host", even when the host genuinely was migrated.
  const marker = capture(paths.root, `cat ${paths.markerFile} 2>/dev/null || true`, config, ctx, { readOnly: true });
  if (!marker) {
    throw new Error(
      `Release deploy requires a migrated host: ${paths.markerFile} is missing. Run the one-time host `
      + `migration first (it writes the layout marker). deploy-kit never restructures a live root.`,
    );
  }
  let parsed;
  try { parsed = JSON.parse(marker); } catch { parsed = null; }
  if (!parsed || parsed.layout !== 'releases' || parsed.version !== LAYOUT_VERSION) {
    throw new Error(
      `Host layout marker mismatch (${paths.markerFile}): got ${marker}, expected `
      + `{"layout":"releases","version":${LAYOUT_VERSION}}. Re-run the host migration for this deploy-kit version.`,
    );
  }
  if (!config.ecosystemFile) {
    throw new Error('Release deploy requires `ecosystemFile` (the stable PM2 ecosystem with literal cwd:<root>/current).');
  }
  // Auto-recovery after a failed migration needs a consistent pre-migration backup
  // AND a way to restore it — otherwise a mid-migration failure can only be resolved
  // by hand. Require both when a migration hook is configured under the release layout.
  if (config.hooks.migrate) {
    if (!config.hooks.backup) throw new Error('Release deploy with a `migrate` hook requires a `backup` hook (no consistent pre-migration snapshot otherwise).');
    if (!config.hooks.restore) throw new Error('Release deploy with a `migrate` hook requires a `restore` hook (recovery from a failed migration would otherwise be manual-only).');
  }
  const mvGnu = capture(paths.root, 'mv --version 2>/dev/null | head -1', config, ctx, { readOnly: true });
  if (!/GNU|coreutils/i.test(mvGnu)) {
    throw new Error('Release deploy requires GNU coreutils `mv` (for the atomic `mv -T` symlink swap); not detected on target.');
  }
  // A full filesystem during `npm ci` can corrupt the live SQLite app, so an
  // UNREADABLE disk result must also abort — fail closed, not open.
  const avail = parseInt(capture(paths.root, `df -kP ${paths.root} | awk 'NR==2{print $4}'`, config, ctx, { readOnly: true }), 10);
  if (!Number.isFinite(avail)) {
    throw new Error(`Could not read free disk on ${paths.root} (df returned no usable value); refusing to deploy.`);
  }
  if (avail < MIN_FREE_KIB) {
    throw new Error(`Insufficient free disk on ${paths.root}: ${avail} KiB free, need >= ${MIN_FREE_KIB} KiB.`);
  }
}

// The pending-migrations probe passes only on a clean exit AND a last stdout line
// that is exactly a base-10 integer (no sign, exponent, padding or trailing words).
// Only exactly-empty lines are skipped (after dropping one trailing \r per line), so
// a final whitespace-only line is the answer, and it is not a number. Returns the count, or null for anything else -- null means
// "unknown", which the caller treats as "may have migrated". The full runner
// result is inspected (not `capture()`, which discards the exit status) so a
// failed or timed-out probe that happened to print "0" is never believed.
function parsePendingCount(res) {
  if (!res.ok) return null;
  const lines = (res.output || '').split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined || !/^[0-9]+$/.test(last)) return null;
  const count = Number(last);
  return Number.isSafeInteger(count) ? count : null;
}

// Read a previous deploy's durable recovery journal. Only "stopped" is safe to
// recover automatically: the journal is written the moment the stop phase BEGINS
// (before stopWritersConfirmed() runs — see the disruptive-window call site), so
// it proves only that no migration or symlink flip had begun, not that writers
// were actually confirmed paused. Either way resuming the untouched previous
// release is safe: recoverInterruptedDeploy() re-verifies it comes back healthy,
// and if it was never actually stopped, `pm2 startOrRestart` is a no-op restart
// of the same still-running previous release. "migrated" and "flipped" journals
// are fail-closed, for two different reasons. A "migrated"
// journal (or migrated:true) means a backup was taken and writers were stopped for
// the migration — this same process never got as far as `pm2 startOrRestart`, but
// writers may since have been resumed externally after the interruption. A hard
// interruption at that point leaves the door open for a service manager (e.g.
// PM2 resurrect replaying a previously saved dump) or an operator to bring the old
// app back online and accept writes before the next deploy runs, so deploy-kit
// cannot prove the backup is still an accurate snapshot. A code-only "flipped"
// journal has no pre-migration backup and no post-backup writes to worry about,
// but it still fails closed because the on-disk `current`/`previous` pointers and
// the actually-running process can't be trusted across process invocations without
// re-deriving them. Post-deploy policy transitions remain manual for a related
// reason: resuming them requires an operator decision or delivery-event context
// that may not be present.
function readInterruptedDeploy(config, paths, ctx) {
  // Same pre-existing-state read as preflight() above — readOnly so a dry run
  // reports the real interrupted-deploy status of the host instead of always
  // reading empty.
  const raw = capture(paths.root, `cat ${paths.stateFile} 2>/dev/null || true`, config, ctx, { readOnly: true });
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch { return null; } // unreadable → best-effort, don't block
  if (!state) return null;
  if (state.phase === 'stopped') return state;
  if (['migrated', 'flipped'].includes(state.phase)) {
    const reason = (state.migrated === true || state.phase === 'migrated')
      ? 'deploy-kit cannot prove no writes occurred after the pre-migration backup — a service manager '
        + '(e.g. PM2 resurrect) or an operator may have already brought the old app back online'
      : 'deploy-kit cannot trust the on-disk `current`/`previous` pointers against whatever process is '
        + 'actually running without re-deriving that state by hand';
    throw new Error(
      `MANUAL RECOVERY REQUIRED — a previous deploy was interrupted mid-"${state.phase}" (release `
      + `${state.releaseId || '?'}, backup ${state.backupId || 'none'}). ${reason}, so it will not `
      + 'auto-restore the backup, rewrite the `current`/`previous` symlinks, stop apps, or restart PM2. '
      + 'Reconcile the database/schema and the `current` pointer by hand, then set "phase":"done" in '
      + `${paths.stateFile} (or remove it) before deploying again.`,
    );
  }
  if (state.phase === 'post-deploy-rollback-failed') {
    throw new Error(
      `MANUAL RECOVERY REQUIRED — a previous deploy's automatic rollback FAILED (phase "${state.phase}", release `
      + `${state.releaseId || '?'}, backup ${state.backupId || 'none'}). The database and the running release may `
      + 'not match, and deploy-kit will not retry the restore or touch any app. Reconcile the database/schema and '
      + `the \`current\` pointer by hand, then set "phase":"done" in ${paths.stateFile} (or remove it) before `
      + 'deploying again.',
    );
  }
  if (['post-deploy-failed', 'post-deploy-rollback'].includes(state.phase)) {
    throw new Error(
      `A previous deploy was interrupted mid-"${state.phase}" (release ${state.releaseId || '?'}, backup `
      + `${state.backupId || 'none'}). Resolve it by hand — verify the DB/schema and the running release — then `
      + `set "phase":"done" in ${paths.stateFile} (or remove it) before deploying again.`,
    );
  }
  return null;
}

// With `ctx.ownedLocks` (host-run's handle) the locks are already held: validate
// the handle and return a no-op release. Otherwise take the app lock as always.
function acquireOrAdoptLock(config, c, { steal }) {
  if (c.ownedLocks == null) return acquireLock(config, c, { steal });
  validateOwnedLocks(config, c, c.ownedLocks);
  return () => {};
}

// The full artifact-first release deploy. See the failure-phase table in the ticket:
// every phase records enough state that recover() can restore a known-good running
// release, and the ONLY disruptive window is stop → backup → migrate → flip.
function deployRelease(config, options = {}, ctx = {}) {
  assertTransitionAuthorityEntryPoint(config, { supported: true, options });
  // `--sha`'s format and its exclusivity with `--branch` -- checked here too,
  // before ANYTHING else: `deployRelease()` is itself exported and callable
  // directly (not just via deploy()'s layout delegation), so the CLI's
  // parse-time checks are not the only way in (PKG-164 review finding 6).
  assertShaOptions(options);
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const c = { ...ctx, log, sleep, runtime: ctx.runtime };
  assertVerifiedRefOptions(config, options, c);
  const paths = releasePaths(config);

  // Populated inside the try block below, AFTER lock acquisition and target
  // preflight (preflight(), interrupted recovery, pre-deploy checks)
  // -- see the auto-cut call site further down for why it must not run any
  // earlier.
  let autoCutResult = { ran: false };
  let R = null;

  const {
    skipMigrate = false, stealLock = false, skipBuild = false, skipDeps = false, stash,
    // Same precedence as the legacy pipeline: an explicitly supplied option
    // (`--skip-pin-check`) wins over config, and with neither the gate is on.
    // Previously this path ANDed the two, so a config `verifyPins: false` could
    // not be re-enabled per-run while the legacy path allowed it (Codex review).
    verifyPins = config.verifyPins !== false,
  } = options;

  // `--no-stash` (options.stash === false) has no analog under the release
  // layout: the legacy stash step exists because a legacy deploy pulls INTO an
  // existing working tree that may carry local tracked changes worth preserving.
  // A release is materialized fresh via `git worktree add --detach` every time —
  // there is no persistent working tree to have local changes on, so there is
  // nothing to stash. Silently ignoring the flag would be exactly the BWK-136
  // failure mode (operator believes it took effect); refuse instead.
  if (stash === false) {
    throw new Error(
      '--no-stash does not apply to the release layout: each release is materialized as a fresh git '
      + 'worktree, never an in-place working tree that could carry local changes to stash. Remove the flag.',
    );
  }

  for (const [index, check] of (config.postDeployChecks || []).entries()) {
    if (!['rollback', 'remain-active', 'manual'].includes(check.onFailure)) {
      throw new Error(
        `Release layout requires postDeployChecks[${index}].onFailure to be "rollback", `
        + '"remain-active", or "manual".',
      );
    }
  }

  log.header(`🚀 Deploying [release layout] (${config.mode}${config.host ? ` → ${config.host}` : ''})`);

  const steps = [];
  // Mutable state the recovery machine reads. phase names match the failure table.
  const freshState = () => ({
    phase: 'preflight', dbAppsPaused: false, flipped: false, prevTarget: null,
    releaseDir: null, releaseId: null, sha: null, branch: null, backupId: null,
    migrated: false, migrationsPending: null, failedCheck: null, failurePolicy: null, recoveryOutcome: null,
    recoveryNote: null,
  });
  const st = freshState();
  let recoveringInterrupted = false;

  // Informational audit field, written only once a probe has answered: a deploy
  // without `hooks.pendingMigrations` keeps a byte-identical journal (the consumer
  // regression fixtures pin that).
  const migrationsPendingField = () => (st.migrationsPending == null ? {} : { migrationsPending: st.migrationsPending });

  // Durably journal the disruptive-phase state BEFORE each irreversible op, so a
  // process/SSH/power loss leaves an on-host record of whether the DB was migrated
  // and which backup restores it (recovery on the next invocation is a follow-up;
  // this at least makes the truth recoverable instead of lost in process memory).
  const protectedMode = config.transitionAuthority != null;
  const dryRun = c.runtime?.dryRun === true;
  let manager = null;
  let authorityHandle = null;
  let operationIdentity = null; // set only once an authority begin is acknowledged
  const journal = (overrides = {}) => persistState(config, paths, {
    ...(operationIdentity || {}),
    phase: st.phase, releaseId: st.releaseId, sha: st.sha, backupId: st.backupId,
    migrated: st.migrated, ...migrationsPendingField(), flipped: st.flipped, prevTarget: st.prevTarget,
    failedCheck: st.failedCheck, failurePolicy: st.failurePolicy,
    recoveryOutcome: st.recoveryOutcome,
    ...(st.recoveryNote ? { recoveryNote: st.recoveryNote } : {}),
    ...overrides,
  }, c);

  // After a SUCCESSFUL recovery, overwrite the journaled disruptive phase so the
  // next deploy isn't blocked by assertNoInterruptedDeploy — only a HARD interruption
  // (no recovery ran) leaves a stopped/migrated/flipped phase on disk. Best-effort:
  // a metadata write failing here must not mask the recovery that just succeeded.
  const markRecovered = () => {
    st.phase = 'recovered';
    try { journal(); } catch (err) { if (isPhaseWriteUncertain(err)) throw err; /* best effort */ }
  };

  // Stop the DB-bound apps and PROVE they are actually stopped (a zero-exit
  // `pm2 stop` is not proof; writers left online would corrupt the backup/restore).
  // Returns true only when every dbBoundApp is confirmed not-online.
  const stopWritersConfirmed = () => {
    if (!config.dbBoundApps.length) return true;
    runInDir(paths.root, `pm2 stop ${config.dbBoundApps.join(' ')}`, config, c, { tolerate: true });
    const snap = readPm2(config, paths, c);
    if (!snap) return false;
    return config.dbBoundApps.every((n) => !snap[n] || !snap[n].online);
  };

  const resumePrevious = (targetSha = null) => {
    // Bring the previous release's apps back and verify it is actually healthy —
    // a zero-exit `pm2 start` is not proof (Codex).
    runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
    return verifyActivation(config, paths, targetSha, `${paths.root}/${st.prevTarget}`, c);
  };

  // The rollback target is restored (DB and pointer) but did not verify. It must still
  // end up RUNNING: a rollback that cannot prove health is a reason to alert, never a
  // reason to leave the service stopped. Starts the apps again only when one is not online.
  const ensureRollbackTargetRunning = () => {
    const runsFromTarget = () => appsRunFromRelease(config, paths, `${paths.root}/${st.prevTarget}`, c).ok;
    if (runsFromTarget()) return true;
    log.warning('Rollback target is not fully online (or an app still runs from another release); starting its apps again');
    runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
    return runsFromTarget();
  };

  const restoreDb = () => {
    if (!config.hooks.restore) return false;
    // backupId is validated to a safe charset before migrate; single-quote anyway.
    // `export …; ` (not a bare assignment prefix) so the variable survives into
    // every command of a compound hook (`cd … && …`), not just the first one --
    // a bare `VAR=x cmd1 && cmd2` only scopes VAR to cmd1 (verified: `sh -c
    // "FOO='bar' cd /tmp && node -e \"console.log(process.env.FOO)\""` prints
    // undefined; `export FOO='bar'; cd /tmp && node …` prints bar).
    const env = st.backupId ? `export DEPLOY_KIT_BACKUP_ID='${st.backupId}'; ` : '';
    const res = runInDir(paths.root, `${env}${config.hooks.restore}`, config, c, { tolerate: true });
    return res.ok;
  };

  // Delivery events are best-effort transport, while the on-host journal is the
  // durable source of truth. Every terminal post-check outcome is journaled first
  // and then offered to the configured sink with only an opaque backup leaf.
  const emitDeliveryEvent = (status, extra = {}) => {
    if (!config.deliveryEvent?.command) return undefined;
    const backupReference = backupReferenceFromId(st.backupId);
    const payload = JSON.stringify({
      event: 'deployment', status, branch: st.branch, revision: st.sha,
      deployedAt: new Date().toISOString(),
      ...(backupReference ? { backupReference } : {}),
      ...extra,
    });
    // Survives the release-dir swap (unlike `current`), so a hook can record what
    // it already announced under this path without re-announcing every deploy.
    // `export …; ` so the variable reaches the LAST command in a compound hook
    // (real hooks look like `cd current && set -a; . .env; set +a; node …`) --
    // a bare assignment prefix only scopes to the first command in the chain.
    const env = `export DEPLOY_KIT_SHARED_DIR='${paths.sharedDir}'; `;
    const delivery = runInDir(paths.root, `${env}${config.deliveryEvent.command}`, config, c, {
      tolerate: true,
      input: payload,
    });
    steps.push('delivery-event');
    if (!delivery.ok) {
      log.warning(
        'Delivery event command failed (deliveryEvent.command); the on-host release journal contains the '
        + 'outcome, but the receiving system did not receive it.',
      );
    }
    return { delivered: delivery.ok };
  };

  const rollbackToPrevious = (fail, targetSha = null) => {
    if (!st.prevTarget) {
      fail('no previous release exists to satisfy the configured rollback policy');
    }
    if (st.migrated && !stopWritersConfirmed()) {
      fail('a migration ran but DB writers could not be confirmed stopped; do NOT restore over live writers — resolve by hand');
    }
    let flippedBack = true;
    if (st.flipped) {
      log.warning(`Flipping current back to ${st.prevTarget}`);
      flippedBack = activateSymlink(config, paths, st.prevTarget, c, { tolerate: true });
    }
    if (st.migrated) {
      if (!restoreDb()) {
        fail(`a migration ran but the DB could not be auto-restored (backup ${st.backupId || 'unknown'}); restore it by hand before serving traffic`);
      }
      log.warning(`Restored pre-migration DB backup ${st.backupId || ''}`);
    }
    if (!flippedBack) {
      fail(
        `the symlink flip-back to ${st.prevTarget} itself failed; \`current\` may still point at the failed `
        + `candidate release (${st.releaseId || st.releaseDir || 'unknown'}). PM2 was deliberately NOT `
        + 'restarted; manually confirm the pointer and running process',
      );
    }
    const resumed = resumePrevious(targetSha);
    if (!resumed.ok) {
      // Protected: read-only facts only; a restart would be an unfenced nested mutation.
      const appsOnline = targetSha
        ? appsRunFromRelease(config, paths, `${paths.root}/${st.prevTarget}`, c).ok
        : ensureRollbackTargetRunning();
      fail(
        `the previous release did not come back healthy after DB/symlink recovery (${resumed.reason}); `
        + `its apps were left ${appsOnline ? 'running' : 'NOT online'}`,
        { rollbackTargetRestored: true, appsOnline },
      );
    }
  };

  // Re-run the failed post-deploy check against the rolled-back release. The same
  // check failing on both releases points at the check or its environment, not the release.
  const failedCheckAlsoFailsOnPrevious = () => {
    const check = config.postDeployChecks.find((candidate) => candidate.name === st.failedCheck);
    if (!check) return false;
    return !runInDir(paths.root, check.command, config, c, { tolerate: true }).ok;
  };

  const noteIdenticalCheckFailure = () => {
    if (failedCheckAlsoFailsOnPrevious()) st.recoveryNote = IDENTICAL_CHECK_FAILURE_NOTE;
  };

  // Delivery events usually reach only the app's own release channel, which is how a
  // dead service went unnoticed for hours. A failed rollback therefore also posts one
  // message straight to the fleet alert webhook when it is set in THIS process's
  // environment. alert-discord's own CLI does the send: the URL travels in the child's
  // env, never argv or a log line, and a failure here only warns.
  const postFleetAlert = (message) => {
    const env = c.env || process.env;
    if (!env[ALERT_WEBHOOK_ENV]) return;
    const event = {
      eventId: `deploy-rollback-failed-${st.releaseId || 'unknown'}`,
      createdAtMs: c.now ? c.now() : Date.now(),
      host: config.host || 'local',
      alerts: [{ id: 'deploy-rollback-failed', kind: 'alert', status: 'crit', message }],
    };
    const args = [path.join(__dirname, 'cli.js'), 'alert-discord'];
    const service = path.basename(config.projectDir || '');
    if (service) args.push('--service', service);
    try {
      const send = (c.runtime && c.runtime.execFileSync) || nodeExecFileSync;
      send(process.execPath, args, {
        input: JSON.stringify(event), env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15000,
      });
      log.info('Posted the failed-rollback alert to the fleet alert webhook');
    } catch {
      log.warning('Could not post the failed-rollback alert to the fleet alert webhook; the journal and delivery event still record it');
    }
  };

  // Phase-appropriate recovery. Returns nothing; throws a distinct MANUAL RECOVERY
  // error if it cannot restore a known-good running release (never a routine abort).
  const recover = (err) => {
    const fail = (msg, details = {}) => {
      throw Object.assign(new Error(`MANUAL RECOVERY REQUIRED — ${msg}. Original: ${err && err.message}`), details);
    };
    log.error(`Deploy failed in phase "${st.phase}": ${err && err.message}`);
    switch (st.phase) {
      case 'preflight':
      case 'materialize':
      case 'install':
      case 'build':
      case 'validate':
        // current never touched, apps never stopped — just quarantine the candidate.
        if (st.releaseDir) {
          log.warning(`Quarantining candidate release ${st.releaseDir}`);
          runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree remove --force ${st.releaseDir} 2>/dev/null || rm -rf ${st.releaseDir}`, config, c, { tolerate: true });
          runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree prune 2>/dev/null || true`, config, c, { tolerate: true });
        }
        log.info(`No change was made to the live release on ${config.host || 'this machine'}; it is safe to re-run deploy.`);
        return;
      case 'stopped':
        // writers stopped, nothing migrated/flipped — resume previous, verify.
        if (!resumePrevious().ok) fail('failed to bring the previous release back online after aborting pre-migration');
        markRecovered();
        return;
      case 'migrated':
      case 'flipped':
      case 'verify': {
        rollbackToPrevious(fail);
        markRecovered();
        return;
      }
      case 'post-deploy-failed': {
        const eventBase = {
          failedCheck: st.failedCheck,
          activeRevision: st.sha,
          activeRelease: `releases/${st.releaseId}`,
        };
        if (st.failurePolicy === 'remain-active') {
          st.phase = 'post-deploy-degraded';
          st.recoveryOutcome = 'remained-active';
          journal();
          emitDeliveryEvent('degraded', {
            ...eventBase,
            recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: true },
          });
          return;
        }
        if (st.failurePolicy === 'manual') {
          st.phase = 'post-deploy-manual-decision';
          st.recoveryOutcome = 'manual-decision-required';
          journal();
          emitDeliveryEvent('failed', {
            ...eventBase,
            recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: true },
          });
          return;
        }

        st.phase = 'post-deploy-rollback';
        st.recoveryOutcome = 'pending';
        journal();
        try {
          rollbackToPrevious(fail);
          st.phase = 'post-deploy-rolled-back';
          st.recoveryOutcome = 'rolled-back';
          // Persist the verified rollback before the diagnostic re-run: a re-run that hangs or
          // throws must neither leave a recovered host looking mid-rollback nor turn it into a
          // failed rollback.
          journal();
          try {
            noteIdenticalCheckFailure();
            if (st.recoveryNote) journal();
          } catch (noteError) {
            log.warning(`Could not re-run the failed check on the rollback target: ${noteError.message}`);
          }
          emitDeliveryEvent('failed', {
            failedCheck: st.failedCheck,
            activeRelease: st.prevTarget,
            ...(st.recoveryNote ? { note: st.recoveryNote } : {}),
            recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: true },
          });
        } catch (recoveryError) {
          // Restoration (DB + pointer) and startup are tracked separately. Not restored:
          // the apps are deliberately NOT restarted (old code on an unknown schema may be
          // wrong). Restored: the target is left RUNNING if it is, else it is a distinct
          // not-started outcome. Either restored case names the rollback target, never the candidate.
          const restored = recoveryError.rollbackTargetRestored === true;
          const running = restored && recoveryError.appsOnline === true;
          const outcome = running ? 'rollback-failed-running' : (restored ? 'rollback-failed-not-started' : 'rollback-failed');
          const appsState = running ? 'running' : (restored ? 'not-running' : 'not-restarted');
          st.phase = 'post-deploy-rollback-failed';
          st.recoveryOutcome = outcome;
          if (restored) noteIdenticalCheckFailure();
          try { journal(); } catch { /* original recovery error remains primary */ }
          const alertText = {
            'rollback-failed-running': `deploy and automatic rollback both failed verification; ${st.prevTarget} is left RUNNING and needs manual review`,
            'rollback-failed-not-started': `deploy failed and the rollback restored ${st.prevTarget}, but its apps are NOT confirmed running; the service may be DOWN`,
            'rollback-failed': 'deploy failed and the automatic rollback could not restore a known-good release; the apps were NOT restarted and the service may be DOWN',
          }[outcome];
          log.error(`ALERT: ${alertText}`);
          if (st.recoveryNote) log.error(st.recoveryNote);
          emitDeliveryEvent('failed', {
            ...(restored ? { failedCheck: st.failedCheck, activeRelease: st.prevTarget } : eventBase),
            appsState,
            ...(st.recoveryNote ? { note: st.recoveryNote } : {}),
            recovery: { policy: st.failurePolicy, outcome, verified: false },
          });
          postFleetAlert(`${alertText} (${outcome}).${st.recoveryNote ? ` ${st.recoveryNote}.` : ''}`);
          throw recoveryError;
        }
        return;
      }
      default:
        fail(`unknown phase "${st.phase}"`);
    }
  };

  const recoverInterruptedDeploy = () => {
    // readInterruptedDeploy() above already fails closed (throws) for a
    // migrated/flipped/post-deploy-* journal, so the only phase that can reach
    // this point is "stopped" — the stop phase had begun but no migration or
    // symlink flip had, so resuming and re-verifying the untouched previous
    // release is safe whether the stop itself completed or not.
    const saved = readInterruptedDeploy(config, paths, c);
    if (!saved) return;

    const phase = saved.phase;
    const releaseId = typeof saved.releaseId === 'string' ? saved.releaseId : '';
    const prevTarget = typeof saved.prevTarget === 'string' ? saved.prevTarget : '';
    if (!RELEASE_ID_RE.test(releaseId)) {
      throw new Error(`MANUAL RECOVERY REQUIRED — interrupted ${phase} journal has an unsafe or missing releaseId.`);
    }
    assertSafeTarget(prevTarget, 'interrupted deploy previous');

    // A "stopped" journal implies current was never touched — it must still
    // point at the previous release. Anything else (still on the candidate,
    // or some third, unrelated value) is an impossible/untrustworthy state.
    const current = readPointers(config, paths, c).current;
    assertSafeTarget(current, 'current during interrupted recovery');
    if (current !== prevTarget) {
      throw new Error(
        `MANUAL RECOVERY REQUIRED — interrupted ${phase} journal says the flip had not started, but current `
        + `points to ${current} instead of ${prevTarget}.`,
      );
    }

    Object.assign(st, freshState(), {
      phase, releaseId, releaseDir: `${paths.releasesDir}/${releaseId}`, prevTarget,
    });

    log.warning(`Recovering interrupted deploy ${releaseId} from phase "${phase}" before starting a new release`);
    recoveringInterrupted = true;
    recover(new Error(`previous deploy interrupted during ${phase}`));
    recoveringInterrupted = false;
    steps.push(`recover-interrupted:${phase}`);
    Object.assign(st, freshState());
  };

  // DO NOT DELETE THIS AS DEAD CODE -- see the fuller note in deploy.js. This
  // pipeline is synchronous too, so a mid-deploy signal is never dispatched
  // before `finally` removes these listeners; the body below is unreachable in
  // that window. Registering it is still load-bearing: it suppresses Node's
  // default disposition, which would otherwise kill the process instantly and
  // skip the `finally` recovery entirely.
  //
  // The body is kept as a correct safety net should any of this become async.
  // It re-raises rather than calling process.exit(1) so an embedder calling
  // deployRelease() programmatically keeps control of its own shutdown.
  const onSignal = (sig) => {
    log.error(protectedMode && !dryRun ? `Received ${sig} mid-deploy — recovery required for phase "${st.phase}"` : `Received ${sig} mid-deploy — running recovery for phase "${st.phase}"`);
    if (protectedMode && !dryRun) {
      // Never generic recover() or a re-entrant manager call; the journal is preserved.
      log.error(`Recovery required: interrupted by ${sig} under transition authority; journal preserved for assessment`);
    } else {
      try { recover(new Error(`interrupted by ${sig}`)); } catch (e) { log.error(e.message); }
    }
    process.removeListener(sig, sigHandlers[sig]);
    process.kill(process.pid, sig);
  };
  const sigHandlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };

  const runPreDeployChecks = () => {
    for (const check of config.preDeployChecks) {
      st.phase = protectedMode ? 'hook-running' : 'preflight';
      const res = runInDir(paths.root, check.command, config, c, { tolerate: true });
      if (!res.ok) throw new Error(`Pre-deploy check failed: ${check.name}`);
    }
  };

  // Protected mode: inspect the saved authority journal BEFORE any recovery or configured hook.
  // Only a matched durable stop-only record can enter a fresh recovery operation;
  // every other unsettled state requires explicit assessment.
  function initializeTransitionAuthority() {
    const inspected = inspectTransitionAuthority(config, paths, c, ctx, { allowStoppedRecovery: true });
    manager = inspected.manager;
    if (inspected.kind === 'stoppedRecovery') recoverStoppedInterrupted(inspected);
  }

  // Interrupted stop-only deploy: settle the old operation, restore the previous release under a fresh
  // parent-linked child, then END the invocation. Never continues into a new deployment.
  function recoverStoppedInterrupted({ saved, oldOperationId, previousSha, observedCurrent }) {
    Object.assign(st, freshState(), {
      phase: 'stopped', releaseId: saved.releaseId, sha: saved.sha, prevTarget: saved.prevTarget,
      releaseDir: `${paths.releasesDir}/${saved.releaseId}`, backupId: saved.backupId ?? null,
      migrated: false, flipped: false,
    });
    manager.abandonSaved(oldOperationId, 'UNKNOWN');
    const begun = manager.begin({
      kind: 'interrupted-recovery', targetSha: previousSha, targetRelease: saved.prevTarget, priorPointer: observedCurrent,
      effects: { ...CONSERVATIVE_EFFECTS }, parentOperationId: oldOperationId,
    });
    operationIdentity = { operationId: begun.operationId, targetSha: previousSha };
    let observation;
    try {
      observation = manager.run(begun.handle, () => {
        st.phase = 'interrupted-recovery';
        st.sha = previousSha;
        journal();
        if (!resumePrevious(previousSha).ok) throw new Error('failed to bring the previous release back online');
        const final = verifyActivation(config, paths, previousSha, `${paths.root}/${st.prevTarget}`, c);
        if (!final.ok) throw new Error(`Activation verification failed: ${final.reason}`);
        return { observedSha: previousSha, verified: true };
      });
    } catch (err) {
      if (!(err instanceof TransitionOperationError && err.code === 'RUNTIME_FAILED') || isPhaseWriteUncertain(err)) throw err;
      try {
        manager.abandon(begun.handle, 'UNKNOWN');
      } catch (abandonErr) {
        throw recoveryRequired('interrupted recovery failed and abandon was not acknowledged; recovery assessment required', abandonErr);
      }
      throw recoveryRequired('interrupted recovery failed and was abandoned UNKNOWN; manual recovery required', err);
    }
    manager.complete(begun.handle, observation);
    st.phase = 'recovered';
    journal();
    throw recoveryRequired(`interrupted deploy ${saved.releaseId} recovered to ${saved.prevTarget}; start a new invocation`);
  }

  // Failed protected forward deploy, after the failed operation's acknowledged UNKNOWN abandon.
  // Always throws: the requested forward deployment failed even when the previous release recovers.
  // Only phases whose effects are fully understood are recovered; everything else is assessed manually.
  function recoverProtectedForward(failure, failedOperationId, failedPhase) {
    const reason = failure.cause?.message || failure.message;
    const rollbackPhase = ['migrated', 'flipped', 'verify'].includes(failedPhase)
      || (failedPhase === 'post-deploy-failed' && st.failurePolicy === 'rollback');
    const policyPhase = failedPhase === 'post-deploy-failed' && ['remain-active', 'manual'].includes(st.failurePolicy);
    const postDeploy = failedPhase === 'post-deploy-failed';
    if (failedPhase !== 'stopped' && !rollbackPhase && !policyPhase) {
      throw recoveryRequired(`forward operation failed in phase "${failedPhase}" (${reason}) and was abandoned UNKNOWN; manual recovery assessment required`, failure);
    }
    const candidateTarget = `releases/${st.releaseId}`;
    let targetSha;
    let actualCurrent;
    try {
      if (!policyPhase && !st.prevTarget) throw new Error('no previous release recorded');
      actualCurrent = readPointers(config, paths, c).current;
      assertSafeTarget(actualCurrent, 'current');
      targetSha = resolveReleaseSha(config, paths, policyPhase ? actualCurrent : st.prevTarget, policyPhase ? 'current' : 'previous', c);
      const mismatch = policyPhase ? actualCurrent !== candidateTarget
        : (failedPhase === 'stopped' ? actualCurrent !== st.prevTarget : ![st.prevTarget, candidateTarget].includes(actualCurrent));
      if (mismatch) throw new Error(`current points to ${actualCurrent}, which does not match the failed ${failedPhase} phase`);
    } catch (assessErr) {
      throw recoveryRequired(`forward operation failed (${reason}) and no safe previous release could be assessed; manual recovery required`, assessErr);
    }
    if (failedPhase !== 'stopped' && !policyPhase) st.flipped = actualCurrent !== st.prevTarget;
    const previousSha = targetSha;
    const withFacts = (error, childOperationId) => Object.assign(error, { childOperationId, failedOperationId });
    // One fenced child: begin + identity before any effect; settle exactly once (verified -> complete,
    // otherwise FAILED; a callback runtime error -> UNKNOWN). Terminal RPC errors propagate untouched.
    const runChild = (spec, body) => {
      const begun = manager.begin({ ...spec, effects: { ...CONSERVATIVE_EFFECTS }, parentOperationId: spec.parentOperationId });
      operationIdentity = { operationId: begun.operationId, targetSha: spec.targetSha };
      let observation;
      try {
        observation = manager.run(begun.handle, body);
      } catch (err) {
        if (!(err instanceof TransitionOperationError && err.code === 'RUNTIME_FAILED') || isPhaseWriteUncertain(err)) throw err;
        try {
          manager.abandon(begun.handle, 'UNKNOWN');
        } catch (abandonErr) {
          throw withFacts(recoveryRequired('forward recovery failed and abandon was not acknowledged; recovery assessment required', abandonErr), begun.operationId);
        }
        return { operationId: begun.operationId, runtimeFailure: err };
      }
      const verified = observation.verified === true;
      if (verified) manager.complete(begun.handle, observation); else manager.abandon(begun.handle, 'FAILED');
      return { operationId: begun.operationId, verified };
    };
    const targetDir = `${paths.root}/${st.prevTarget}`;
    // Journal + announce the post-deploy rollback outcome; always called inside a MUTATING callback.
    const reportRollbackOutcome = (outcome, restored) => {
      const rolledBack = outcome === 'rolled-back';
      st.phase = rolledBack ? 'post-deploy-rolled-back' : 'post-deploy-rollback-failed';
      st.recoveryOutcome = outcome;
      if (restored) {
        try { noteIdenticalCheckFailure(); } catch (noteError) {
          log.warning(`Could not re-run the failed check on the rollback target: ${noteError.message}`);
        }
      }
      journal();
      const appsState = { 'rolled-back': 'running', 'rollback-failed-running': 'running', 'rollback-failed-not-started': 'not-running' }[outcome] || 'not-restarted';
      const alertText = {
        'rollback-failed-running': `deploy and automatic rollback both failed verification; ${st.prevTarget} is left RUNNING and needs manual review`,
        'rollback-failed-not-started': `deploy failed and the rollback restored ${st.prevTarget}, but its apps are NOT confirmed running; the service may be DOWN`,
        'rollback-failed': 'deploy failed and the automatic rollback could not restore a known-good release; the apps were NOT restarted and the service may be DOWN',
      }[outcome];
      if (alertText) log.error(`ALERT: ${alertText}`);
      if (st.recoveryNote) log.error(st.recoveryNote);
      emitDeliveryEvent('failed', {
        failedCheck: st.failedCheck,
        ...(restored ? { activeRelease: st.prevTarget } : { activeRevision: st.sha, activeRelease: candidateTarget }),
        ...(rolledBack ? {} : { appsState }),
        ...(st.recoveryNote ? { note: st.recoveryNote } : {}),
        recovery: { policy: st.failurePolicy, outcome, verified: false },
      });
      if (alertText) postFleetAlert(`${alertText} (${outcome}).${st.recoveryNote ? ` ${st.recoveryNote}.` : ''}`);
    };
    const settledFailure = (child, message) => {
      throw withFacts(recoveryRequired(`forward deployment failed (${reason}); ${message}`, failure), child.operationId);
    };
    const concludeVerified = (child) => {
      journal({ phase: 'recovered', sha: previousSha });
      log.success(`Restored the previous release ${st.prevTarget}`);
      return settledFailure(child, `previous release ${st.prevTarget} recovered`);
    };
    const concludeUnverified = (child) => {
      if (!policyPhase) {
        st.phase = postDeploy ? 'post-deploy-rollback-failed' : 'forward-recovery-failed';
        if (postDeploy) st.recoveryOutcome = appsRunFromRelease(config, paths, targetDir, c).ok ? 'rollback-failed-running' : 'rollback-failed-not-started';
        journal();
      }
      return settledFailure(child, policyPhase
        ? `post-deploy policy "${st.failurePolicy}" left the candidate active; manual review required`
        : 'recovery did not verify the previous release; manual recovery required');
    };

    const firstBody = () => {
      if (policyPhase) {
        const degraded = st.failurePolicy === 'remain-active';
        st.phase = degraded ? 'post-deploy-degraded' : 'post-deploy-manual-decision';
        st.recoveryOutcome = degraded ? 'remained-active' : 'manual-decision-required';
        journal();
        emitDeliveryEvent(degraded ? 'degraded' : 'failed', {
          failedCheck: st.failedCheck, activeRevision: targetSha, activeRelease: actualCurrent,
          recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: false },
        });
        return { observedSha: targetSha, verified: false };
      }
      if (postDeploy) { st.phase = 'post-deploy-rollback'; st.recoveryOutcome = 'pending'; journal(); } else {
        journal({ phase: 'forward-recovery', sha: previousSha });
      }
      try {
        if (failedPhase === 'stopped') {
          if (!resumePrevious(previousSha).ok) {
            throw Object.assign(new Error('failed to bring the previous release back online after aborting pre-migration'), {
              rollbackTargetRestored: !st.migrated,
              appsOnline: appsRunFromRelease(config, paths, targetDir, c).ok,
            });
          }
        } else {
          rollbackToPrevious((msg, details = {}) => {
            throw Object.assign(new Error(`MANUAL RECOVERY REQUIRED — ${msg}. Original: ${reason}`), details);
          }, previousSha);
        }
      } catch (rollbackError) {
        // Restored-but-unhealthy defers its report to the restart child; anything unproven reports here.
        if (postDeploy && rollbackError.rollbackTargetRestored !== true) reportRollbackOutcome('rollback-failed', false);
        throw rollbackError;
      }
      if (!postDeploy) return { observedSha: previousSha, verified: true };
      reportRollbackOutcome('rolled-back', true);
      return { observedSha: previousSha, verified: verifyActivation(config, paths, previousSha, targetDir, c).ok };
    };

    const first = runChild({
      kind: 'automatic-recovery', targetSha, targetRelease: policyPhase ? actualCurrent : st.prevTarget,
      priorPointer: actualCurrent, parentOperationId: failedOperationId,
    }, firstBody);
    if (!first.runtimeFailure) {
      return first.verified ? concludeVerified(first) : concludeUnverified(first);
    }

    const facts = first.runtimeFailure.cause;
    if (policyPhase || facts?.rollbackTargetRestored !== true) {
      throw withFacts(recoveryRequired('forward recovery failed and was abandoned UNKNOWN; recovery assessment required', first.runtimeFailure), first.operationId);
    }
    // Restoration (pointer + DB) was proven but the target did not verify: one fresh restart child, no retry after it.
    try {
      if (readPointers(config, paths, c).current !== st.prevTarget
        || resolveReleaseSha(config, paths, st.prevTarget, 'previous', c) !== previousSha) {
        throw new Error('restored release pointer or HEAD no longer matches the recovery target');
      }
    } catch (proofErr) {
      throw withFacts(recoveryRequired('forward recovery was abandoned UNKNOWN and the restored release could not be re-proven; recovery assessment required', proofErr), first.operationId);
    }
    const restart = runChild({
      kind: 'recovery-restart', targetSha: previousSha, targetRelease: st.prevTarget,
      priorPointer: st.prevTarget, parentOperationId: first.operationId,
    }, () => {
      journal({ phase: 'forward-recovery-restart', sha: previousSha });
      ensureRollbackTargetRunning();
      if (postDeploy) {
        const running = appsRunFromRelease(config, paths, targetDir, c).ok;
        const healthy = running && verifyActivation(config, paths, previousSha, targetDir, c).ok;
        reportRollbackOutcome(healthy ? 'rolled-back' : (running ? 'rollback-failed-running' : 'rollback-failed-not-started'), true);
      }
      return { observedSha: previousSha, verified: verifyActivation(config, paths, previousSha, targetDir, c).ok };
    });
    if (restart.runtimeFailure) {
      throw withFacts(recoveryRequired('recovery restart failed and was abandoned UNKNOWN; recovery assessment required', restart.runtimeFailure), restart.operationId);
    }
    return restart.verified ? concludeVerified(restart) : concludeUnverified(restart);
  }

  const release = acquireOrAdoptLock(config, c, { steal: stealLock });
  process.on('SIGINT', sigHandlers.SIGINT);
  process.on('SIGTERM', sigHandlers.SIGTERM);
  try {
    preflight(config, paths, c);
    if (protectedMode && !dryRun) initializeTransitionAuthority();
    if (!protectedMode || dryRun) recoverInterruptedDeploy();
    if (!protectedMode) runPreDeployChecks();

    // Auto-cut, on the LOCAL controller checkout, runs here -- AFTER the lock
    // is held and after target preflight, interrupted recovery, and pre-deploy
    // checks have already rejected an un-deployable target, but
    // still BEFORE the materialize phase below fetches/resolves anything.
    // Running it any earlier (e.g. before the `--no-stash`-combination and
    // postDeployChecks[].onFailure option validation above) would mutate
    // GitHub (cut, push, open, and merge a PR) for a deploy that was always
    // going to be rejected anyway -- wasting a real release. See deploy.js's
    // matching call for the full rationale; identical here so both pipelines
    // behave the same whether a release-layout deploy was reached directly or
    // via deploy()'s delegation (deploy.js's own call site is skipped in that
    // case -- see the `return require('./release').deployRelease(...)` branch
    // above the legacy setup).
    autoCutResult = runAutoCutPreflight(config, options, c);
    R = autoCutResult.ran ? autoCutResult.sha : null;
    if (R) {
      log.info(`auto-cut: deploying release ${autoCutResult.version} (${R.slice(0, 12)}, PR #${autoCutResult.prNumber})`);
    } else if (options.sha) {
      // `--sha`: an operator-supplied exact commit, taking over from the
      // branch tip exactly the way auto-cut's `R` does below -- see the
      // matching comment in deploy.js for why runAutoCutPreflight above has
      // already thrown if auto-cut is configured and would actually run.
      R = options.sha;
      log.info(`--sha: deploying ${R.slice(0, 12)} exactly`);
    }
    // See the matching comment in deploy.js -- strict either/or provenance,
    // never a guess.
    const rFromAutoCut = R != null && autoCutResult.ran;
    let rLabel = rFromAutoCut ? 'auto-cut release' : 'the --sha commit';

    const pointers = readPointers(config, paths, c);
    // A present current pointer must always be a valid release target (a corrupt
    // pointer must never be trusted, disruptive deploy or not).
    if (pointers.current) assertSafeTarget(pointers.current, 'current');
    st.prevTarget = pointers.current; // the release we will fall back to

    // ---- Phase: materialize (current untouched) ----
    st.phase = 'materialize';
    log.step('Fetching into the bare repo');
    // Fetch with an EXPLICIT refspec updating local heads. A repo created with
    // `git clone --bare` configures NO `remote.origin.fetch`, so a plain `fetch origin`
    // only moves FETCH_HEAD — `refs/heads/<branch>` stays frozen at clone time and the
    // deploy silently builds a STALE sha once the remote advances. `+refs/heads/*:refs/
    // heads/*` force-updates every local head to the remote (releases are detached, so
    // no worktree has a branch checked out). It also updates a mirror clone's heads
    // harmlessly. --prune keeps deleted branches from lingering.
    runInDir(paths.root, `git --git-dir=${paths.repoGit} fetch --prune ${shQuote(config.remote)} '+refs/heads/*:refs/heads/*'`, config, c);
    // Same branch-resolution rule as the legacy path (README.md: null branch ->
    // resolve origin/HEAD, fall back to master) — the release layout's repo lives
    // as a bare mirror at repoGit rather than a checked-out working tree, so pass
    // gitDir through rather than relying on cwd having a `.git`.
    const branch = resolveBranch(config, c, { gitDir: paths.repoGit });
    st.branch = branch;
    // requireVerifiedRef: no --sha means the verified ref's tip ships, never the
    // branch tip. The heads:heads fetch above already mirrored it into the bare repo.
    const verifiedRef = config.requireVerifiedRef;
    const verifiedHead = `refs/heads/${verifiedRef}`;
    const verifiedProbe = {
      fetch: () => ({ ok: true }),
      revParse: () => runInDir(paths.root, `git --git-dir=${paths.repoGit} rev-parse --verify --quiet ${shQuote(`${verifiedHead}^{commit}`)}`, config, c, { capture: true }),
    };
    let verifiedTip = null;
    if (verifiedRef && !R) {
      verifiedTip = resolveVerifiedTip(config, verifiedProbe);
      R = verifiedTip;
      rLabel = verifiedRefLabel(config);
      log.info(`${rLabel}: deploying ${R.slice(0, 12)}`);
    }
    // Resolve the exact SHA from `refs/heads/<branch>` FIRST — that is the ref the
    // explicit `+refs/heads/*:refs/heads/*` fetch above just force-updated, so it is
    // always current. A remote-tracking `origin/<branch>` (present if repo.git has a
    // heads→remotes/origin refspec) is only updated by a PLAIN `git fetch`, NOT by our
    // heads:heads fetch, so preferring it would resolve a STALE sha after the remote
    // advanced. Keep it only as a last-ditch fallback. `git rev-parse` echoes the arg
    // on failure, so validate the 40-hex result rather than trusting the exit code.
    if (R) {
      // Deploy-by-SHA: detach to and verify the EXACT release auto-cut merged,
      // never the branch tip -- a descendant landing on the remote between the
      // merge and this fetch must never be silently followed instead.
      st.sha = R;
      const haveR = runInDir(paths.root, `git --git-dir=${paths.repoGit} cat-file -e ${shQuote(`${R}^{commit}`)}`, config, c, { tolerate: true });
      if (!haveR.ok) {
        throw new Error(
          `Deploy aborted: fetched ${config.remote} into ${paths.repoGit} for ${rLabel} ${R.slice(0, 12)}, `
          + `but \`git cat-file -e ${R}^{commit}\` still fails -- the commit is not actually present there. `
          + 'Refusing to materialize a release from a commit the bare repo does not have.',
        );
      }
      // Merged-only guard: R must be an ancestor of the deploy branch's own
      // tip. `refs/heads/<branch>` was already force-updated by the fetch
      // above, so no extra fetch is needed here. Auto-cut's R always
      // satisfies this by construction -- this only ever fires for a
      // manually-supplied `--sha` naming a commit that is unmerged, on a
      // different branch, or simply doesn't exist on the remote.
      const mergedRes = runInDir(
        paths.root,
        `git --git-dir=${paths.repoGit} merge-base --is-ancestor ${shQuote(R)} refs/heads/${shQuote(branch)}`,
        config, c, { tolerate: true },
      );
      if (!mergedRes.ok) {
        throw new Error(
          `Deploy aborted: release ${R.slice(0, 12)} is NOT an ancestor of refs/heads/${branch} in ${paths.repoGit} `
          + `-- refusing to deploy a commit that is not merged onto "${branch}". Merge it first, or check --sha `
          + 'for a typo.',
        );
      }
      if (verifiedRef && !verifiedTip) {
        // `--sha` under requireVerifiedRef: also contained in the verified ref.
        const tip = resolveVerifiedTip(config, verifiedProbe);
        assertContainedInVerified(config, R, tip, () => runInDir(
          paths.root,
          `git --git-dir=${paths.repoGit} merge-base --is-ancestor ${shQuote(R)} ${shQuote(verifiedHead)}`,
          config, c, { tolerate: true },
        ).ok);
      }
    } else {
      const resolveSha = (ref) => capture(paths.root, `git --git-dir=${paths.repoGit} rev-parse ${ref}`, config, c);
      st.sha = resolveSha(`refs/heads/${shQuote(branch)}`);
      if (!/^[0-9a-f]{40}$/.test(st.sha)) st.sha = resolveSha(`${shQuote(config.remote)}/${shQuote(branch)}`);
      if (!/^[0-9a-f]{40}$/.test(st.sha)) {
        throw new Error(`Could not resolve ${config.remote}/${branch} (or refs/heads/${branch}) to a SHA in ${paths.repoGit} (got "${st.sha}")`);
      }
    }
    const ts = capture(paths.root, 'date -u +%Y%m%dT%H%M%SZ', config, c);
    const releaseId = `${st.sha.slice(0, 12)}-${ts}`;
    st.releaseId = releaseId;
    st.releaseDir = `${paths.releasesDir}/${releaseId}`;
    log.step(`Materializing release ${releaseId} at ${st.sha.slice(0, 12)}`);
    runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree add --detach ${st.releaseDir} ${st.sha}`, config, c);
    steps.push('materialize');

    // Symlink shared state in (verifying the release does not track the path).
    for (const rel of (config.layout.sharedPaths || [])) {
      const src = `${paths.sharedDir}/${rel}`;
      const dest = `${st.releaseDir}/${rel}`;
      const tracked = capture(st.releaseDir, `git ls-files --error-unmatch ${rel} 2>/dev/null && echo TRACKED || true`, config, c);
      if (tracked.includes('TRACKED')) {
        throw new Error(`sharedPath "${rel}" is tracked in the release — it would hide a committed file. Remove it from git or from sharedPaths.`);
      }
      // The shared source must already exist (the host migration creates it); fail
      // closed rather than symlink to a missing target.
      runInDir(paths.root, `test -e ${src} || { echo "shared source ${src} missing"; exit 1; }`, config, c);
      runInDir(paths.root, `mkdir -p "$(dirname ${dest})" && rm -rf ${dest} && ln -s ${src} ${dest}`, config, c);
    }
    steps.push('shared');

    // Protected: a configured hook may mutate production, so "hook-running" is journaled BEFORE
    // it and retained after it ("stopped" then only means the stop-only window).
    const beginProtectedHook = () => {
      if (!protectedMode) return;
      st.phase = 'hook-running';
      if (operationIdentity) journal();
    };

    const executeCandidate = () => {
    if (protectedMode) {
      // Delayed pre-deploy hooks may mutate production: identity is journaled first.
      st.phase = 'hook-running';
      if (operationIdentity) journal();
      runPreDeployChecks();
    }
    // ---- Phase: install (inside the candidate; current still serving) ----
    st.phase = 'install';
    if (skipDeps) {
      log.warning('Skipping dependency install (--skip-deps) — the candidate release will have no node_modules unless sharedPaths supplies one');
    } else {
      log.step('Installing dependencies in the candidate release');
      runInDir(st.releaseDir, `npm_config_cache=${paths.npmCache} ${config.hooks.install}`, config, c);
      steps.push('install');
      // Always run right after install, never folded into `hooks.build` — a
      // fresh worktree can still hit a build tool's GLOBAL cache (Nx/Turbo
      // caches are typically keyed by content, not by directory), so the
      // release layout is not itself immune to PKG-127's failure mode. See
      // config.js's `hooks.generate` comment for the full incident.
      if (config.hooks.generate) {
        log.step('Running post-install generation in the candidate release');
        runInDir(st.releaseDir, config.hooks.generate, config, c);
        steps.push('generate');
      }
    }

    // Same gate as the legacy pipeline, inside the candidate. Cheaper here than
    // anywhere else: the candidate is not serving yet, so a lying pin costs a
    // discarded release directory and nothing else.
    if (verifyPins) {
      st.phase = 'verify-pins';
      log.step('Verifying dependency pins in the candidate release');
      runInDir(st.releaseDir, PIN_CHECK_COMMAND, config, c, { input: buildPinCheckProgram() });
      steps.push('verify-pins');
    }

    // ---- Phase: build (inside the candidate) ----
    if (config.hooks.build) {
      st.phase = 'build';
      if (skipBuild) {
        log.warning('Skipping build (--skip-build)');
      } else {
        log.step('Building the candidate release');
        runInDir(st.releaseDir, config.hooks.build, config, c);
        steps.push('build');
      }
    }

    // ---- Phase: validate (candidate is now immutable) ----
    st.phase = 'validate';
    const builtSha = capture(st.releaseDir, 'git rev-parse HEAD', config, c);
    if (builtSha !== st.sha) throw new Error(`Candidate SHA ${builtSha} != resolved ${st.sha}`);
    for (const check of (config.layout.releaseChecks || [])) {
      log.step(`Release check: ${check.name}`);
      runInDir(st.releaseDir, check.command, config, c);
    }
    steps.push('validate');

    // Candidate code and migration files are now final, but production writers
    // are still online. This is the last non-disruptive gate: consumers can take
    // a WAL-safe disposable copy, run the candidate migrations against it, and
    // abort without stopping the live service when data-dependent SQL fails.
    if (!skipMigrate) {
      for (const check of config.preMigrationChecks) {
        log.step(`Pre-migration check: ${check.name}`);
        runInDir(st.releaseDir, check.command, config, c);
        steps.push(`pre-migration-check:${check.name}`);
      }
    }

    // ================= disruptive window opens =================
    // From here a failure can leave production stopped or the schema changed, so we
    // MUST have a validated known-good release to fall back to. Refuse to proceed if
    // `current` is missing or not a safe releases/<id> target.
    const opensDisruptive = !skipMigrate && (config.dbBoundApps.length || config.hooks.migrate);
    if (opensDisruptive) assertSafeTarget(st.prevTarget, 'current (known-good)');

    if (!skipMigrate && config.dbBoundApps.length) {
      // Codex ordering: stop writers FIRST, THEN back up (consistent snapshot), THEN
      // migrate. The stop is GATED and verified — writers left online would corrupt
      // the backup and defeat the consistent-snapshot guarantee.
      st.phase = 'stopped';
      journal();
      log.step(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`);
      if (!stopWritersConfirmed()) throw new Error(`Could not confirm DB-bound apps (${config.dbBoundApps.join(', ')}) stopped before backup/migrate`);
      st.dbAppsPaused = true;
    }
    if (!skipMigrate && config.hooks.backup) {
      beginProtectedHook();
      log.step('Backing up the database (writers stopped)');
      const res = runInDir(st.releaseDir, config.hooks.backup, config, c, { capture: true });
      if (!res.ok) {
        logFailureOutput('Backup hook', res, log);
        throw new Error('Pre-migration database backup failed');
      }
      // The backup hook must print a restorable id/path as its last non-empty stdout
      // line. Validate it to a safe charset before it is interpolated into restore.
      st.backupId = backupIdFromOutput(res.output, { log });
      // The id may be used as a path by the restore hook. A backup id is typically
      // an ABSOLUTE path to the backup file (e.g.
      // /var/lib/smarthome/backups/smarthome-<ts>.db.gpg), so absolute is allowed.
      // Reject shell metacharacters, `..` traversal, and directory-only values — the
      // id is produced by our own backup hook and single-quoted into the restore command.
      if (config.hooks.migrate && !isSafeBackupId(st.backupId)) {
        throw new Error(`Backup hook did not emit a safe restorable id as its last line (got "${st.backupId || ''}"); refusing to migrate without a usable restore point`);
      }
      steps.push('backup');
    }
    // An exact, trustworthy 0 means the migrate hook has nothing to do, so it is
    // not run and `migrated` stays false: a later failure then rolls code back
    // without restoring the DB. Every other outcome is "unknown" and falls through
    // to the migrate block below unchanged. Writers are stopped and the backup is
    // taken, so the answer cannot move under us (given exclusive migration
    // ownership -- see README "Skipping a no-op migration").
    let migrateHookNeeded = !skipMigrate && Boolean(config.hooks.migrate);
    if (migrateHookNeeded && config.hooks.pendingMigrations) {
      beginProtectedHook();
      log.step('Checking for pending database migrations (writers stopped)');
      const probe = runInDir(st.releaseDir, config.hooks.pendingMigrations, config, c, { capture: true });
      if (!probe.ok) {
        logFailureOutput('Pending-migration probe', probe, log);
        if (protectedMode) throw new Error('Pending-migration probe failed; manual recovery assessment required');
      }
      const pending = parsePendingCount(probe);
      if (pending === 0) {
        st.migrationsPending = 0;
        journal();
        migrateHookNeeded = false;
        steps.push('migrate-skipped');
        log.success('No pending database migrations; skipping the migrate hook');
      } else if (pending === null) {
        log.warning(
          `Pending-migration probe ${probe.ok ? 'printed no usable count' : 'failed'}; treating the result as unknown `
          + 'and running the migrate hook',
        );
      } else {
        st.migrationsPending = pending;
        log.info(`${pending} pending database migration${pending === 1 ? '' : 's'}`);
      }
    }
    if (migrateHookNeeded) {
      // Mark migrated BEFORE running: a migration that fails partway may have already
      // touched the schema, so recovery from here on must restore the DB, not just
      // resume the previous (possibly-incompatible) code.
      st.phase = 'migrated';
      st.migrated = true;
      journal();
      log.step('Running database migrations');
      runInDir(st.releaseDir, config.hooks.migrate, config, c);
      steps.push('migrate');
    }

    // ---- Phase: flip (atomic activation) ----
    st.phase = 'flipped';
    journal();
    // Point `previous` at the old current (the known-good fallback) before flipping
    // `current` forward. Only when the old target is a safe releases/<id> value — a
    // pure code deploy with no prior current just skips the previous update.
    if (st.prevTarget && RELEASE_TARGET_RE.test(st.prevTarget)) {
      activateSymlink(config, paths, st.prevTarget, c, { link: paths.previousLink });
    }
    activateSymlink(config, paths, `releases/${releaseId}`, c);
    st.flipped = true;
    steps.push('flip');

    // Pre-restart checks: gated, run IMMEDIATELY BEFORE the pm2 restart — after
    // `current` has flipped to the new release, before it takes over the port/
    // process. A failure here throws into the 'flipped'-phase recovery (flips
    // `current` back, restores DB if migrated, resumes the previous release) —
    // the same recovery a failure anywhere else in this phase gets.
    for (const check of config.preRestartChecks) {
      log.step(`Pre-restart check: ${check.name}`);
      runInDir(paths.root, check.command, config, c);
      steps.push(`pre-restart-check:${check.name}`);
    }

    log.step('Restarting apps from the stable ecosystem');
    runInDir(paths.root, pm2Activate(config, paths), config, c);
    runInDir(paths.root, 'pm2 save 2>/dev/null || true', config, c, { tolerate: true });

    // ---- Phase: verify ----
    st.phase = 'verify';
    const v = verifyActivation(config, paths, st.sha, st.releaseDir, c);
    if (!v.ok) throw new Error(`Activation verification failed: ${v.reason}`);
    steps.push('health');

    // These hooks are part of the public deploy contract, not a legacy-only
    // feature. Run from the stable root so callers can explicitly `cd current`
    // when their command needs release files, while preserving hooks that only
    // operate on shared host state. Every failure policy is explicit and its
    // outcome is journaled before a durable delivery event is attempted.
    st.phase = 'post-deploy';
    journal();
    for (const check of config.postDeployChecks) {
      log.step(`Post-deploy check: ${check.name}`);
      const result = runInDir(paths.root, check.command, config, c, { tolerate: true });
      if (!result.ok) {
        st.failedCheck = check.name;
        st.failurePolicy = check.onFailure;
        st.recoveryOutcome = 'pending';
        st.phase = 'post-deploy-failed';
        journal();
        throw new Error(`Post-deploy check failed: ${check.name} (policy: ${check.onFailure})`);
      }
      steps.push(`post-check:${check.name}`);
    }
    const deliveryEvent = emitDeliveryEvent('succeeded');

    // ---- Phase: metadata + prune (success; still holding the lock) ----
    // Fenced (protected, non-dry-run) candidates stay nonterminal with identity until
    // the authority completion ACK; only then does recordSuccess run.
    const fenced = protectedMode && !dryRun;
    if (!fenced) recordSuccess();
    prune(config, paths, releaseId, c);
    steps.push('prune');

    // See deploy.js's matching call for the full rationale: the resume window
    // only closes once R has actually landed (activated + verified here), not
    // at merge time. Best-effort so a pointer-clear failure never turns an
    // otherwise-successful deploy into a failure.
    if (autoCutResult.ran) {
      try {
        clearAutoCutPending({ projectRoot: options.projectRoot || process.cwd() }, c);
      } catch (error) {
        log.warning(`auto-cut: could not clear the pending-release pointer after a successful deploy: ${error.message}`);
      }
    }

    if (!fenced) log.success(`Deployment completed successfully (release ${releaseId})`);
    return {
      branch, mode: config.mode, host: config.host, sha: st.sha, release: releaseId, steps, healthy: true,
      ...(deliveryEvent ? { deliveryEvent } : {}),
    };
    };
    // Terminal success metadata: retains operation identity when protected.
    const recordSuccess = () => {
      st.phase = 'done';
      persistState(config, paths, {
        ...(operationIdentity || {}),
        phase: 'done', current: `releases/${releaseId}`, previous: st.prevTarget, sha: st.sha, backupId: st.backupId, migrated: st.migrated, ...migrationsPendingField(), ts,
      }, c);
      // Restart, health and every post-deploy check have passed: record it for host monitoring.
      writeLastDeployRecord(config, { sha: st.sha, layout: 'release', release: releaseId }, c);
    };
    if (!protectedMode) return executeCandidate();
    if (dryRun) {
      log.info('[dry-run] transition authority would be required: begin/run/complete around the candidate; none performed');
      return executeCandidate();
    }
    const candidateRead = runOnTarget('git rev-parse HEAD', { ...config, projectDir: st.releaseDir }, { capture: true, runtime: c.runtime });
    if (!candidateRead.ok) throw recoveryRequired(`Candidate SHA read failed in ${st.releaseDir}; refusing authority begin`);
    const candidateSha = (candidateRead.output || '').trim();
    if (!/^[0-9a-f]{40}$/.test(candidateSha) || candidateSha !== st.sha) throw recoveryRequired(`Candidate SHA ${candidateSha} != resolved ${st.sha}; refusing authority begin`);
    const begun = manager.begin({
      kind: 'deploy', targetSha: st.sha, targetRelease: `releases/${releaseId}`, priorPointer: st.prevTarget,
      effects: { ...CONSERVATIVE_EFFECTS }, parentOperationId: null,
    });
    authorityHandle = begun.handle;
    operationIdentity = { operationId: begun.operationId, targetSha: st.sha };
    let deployed;
    const observation = manager.run(authorityHandle, () => {
      deployed = executeCandidate();
      const final = verifyActivation(config, paths, st.sha, st.releaseDir, c);
      if (!final.ok) throw new Error(`Activation verification failed: ${final.reason}`);
      return { observedSha: st.sha, verified: true };
    });
    manager.complete(authorityHandle, observation);
    authorityHandle = null;
    // Post-ACK: persistence failures propagate (no generic recovery in protected mode).
    recordSuccess();
    log.success(`Deployment completed successfully (release ${releaseId})`);
    return deployed;
  } catch (err) {
    if (protectedMode) {
      // Never generic recover(): early hooks may have mutated production.
      if (err instanceof TransitionOperationError && err.code === 'RUNTIME_FAILED' && authorityHandle && !isPhaseWriteUncertain(err)) {
        const handle = authorityHandle;
        const failedOperationId = operationIdentity?.operationId;
        const failedPhase = st.phase;
        authorityHandle = null;
        try {
          manager.abandon(handle, 'UNKNOWN');
        } catch (abandonErr) {
          throw recoveryRequired('forward operation failed and abandon was not acknowledged; recovery assessment required', abandonErr);
        }
        recoverProtectedForward(err, failedOperationId, failedPhase);
      }
      throw err;
    }
    if (recoveringInterrupted) throw err;
    recover(err);
    throw err;
  } finally {
    process.removeListener('SIGINT', sigHandlers.SIGINT);
    process.removeListener('SIGTERM', sigHandlers.SIGTERM);
    release();
  }
}

// Protected mode: inspect the saved authority journal BEFORE any recovery or configured hook.
// Shared by forward deploy and manual rollback; only forward deploy admits matched stopped recovery.
// Returns { kind: 'ready', manager }, or (only with the forward-only allowStoppedRecovery option)
// { kind: 'stoppedRecovery', manager, saved, oldOperationId, previousSha, observedCurrent }.
function inspectTransitionAuthority(config, paths, c, ctx, { allowStoppedRecovery = false } = {}) {
  if (typeof config.layout.runningShaCommand !== 'string' || !config.layout.runningShaCommand.trim()) throw recoveryRequired('transition authority requires a running SHA command for exact activation verification');
  const manager = (ctx.transitionManagerFactory || createTransitionOperationManager)(config, c);
  const operations = manager.inspect().journal?.operations || [];
  const op = operations[operations.length - 1];
  if (op && op.state === 'MUTATING' && allowStoppedRecovery) {
    return assessStoppedRecovery(config, paths, c, manager, op);
  }
  if (op) {
    if (['BEGIN_PENDING', 'COMPLETE_PENDING', 'ABANDON_PENDING'].includes(op.state)) {
      manager.reconcilePending();
      throw recoveryRequired('pending transition RPC reconciled; start a new invocation');
    }
    if (op.state === 'AUTHORIZED') {
      manager.abandonSaved(op.operationId, 'UNKNOWN');
      throw recoveryRequired('saved authorized operation abandoned UNKNOWN; start a new invocation');
    }
    if (op.state === 'MUTATING') {
      throw recoveryRequired('saved MUTATING operation requires recovery assessment');
    }
  }
  let saved;
  try {
    saved = createReleasePhaseStorage({ ...config, projectDir: paths.root }, { runtime: c.runtime }).read();
  } catch (readErr) {
    throw recoveryRequired('deploy state journal could not be read under transition authority', readErr);
  }
  if (saved) {
    // A legacy (unversioned) phase file is never trusted under protected mode.
    if (saved.phaseJournalVersion !== PHASE_JOURNAL_VERSION || saved.layoutVersion !== LAYOUT_VERSION) throw recoveryRequired('deploy state journal is not a versioned protected phase journal; recovery assessment required');
    if (!['done', 'recovered'].includes(saved.phase)) {
      throw recoveryRequired(`previous deploy journal in phase "${saved.phase}" requires recovery under transition authority`);
    }
  }
  return { kind: 'ready', manager };
}

// Read-only assessment of a saved MUTATING deploy interrupted in the stop-only window.
// Everything is validated BEFORE any settlement; any doubt refuses with manual recovery.
function assessStoppedRecovery(config, paths, c, manager, op) {
  const refuse = (why, cause) => recoveryRequired(`saved MUTATING operation requires recovery assessment (${why})`, cause);
  let begin;
  try { begin = JSON.parse(op.beginJson); } catch (err) { throw refuse('unreadable begin record', err); }
  let saved;
  try {
    saved = createReleasePhaseStorage({ ...config, projectDir: paths.root }, { runtime: c.runtime }).read();
  } catch (err) {
    throw refuse('deploy state journal unreadable', err);
  }
  const fullSha = /^[0-9a-f]{40}$/;
  const releaseId = saved?.releaseId;
  const ok = begin && begin.kind === 'deploy' && saved
    && saved.phaseJournalVersion === PHASE_JOURNAL_VERSION && saved.layoutVersion === LAYOUT_VERSION
    && saved.phase === 'stopped' && saved.operationId === op.operationId
    && typeof begin.targetSha === 'string' && fullSha.test(begin.targetSha)
    && saved.targetSha === begin.targetSha && saved.sha === begin.targetSha
    && typeof releaseId === 'string' && RELEASE_ID_RE.test(releaseId)
    && `releases/${releaseId}` === begin.targetRelease
    && begin.targetSha.startsWith(releaseId.split('-')[0])
    && typeof saved.prevTarget === 'string' && RELEASE_TARGET_RE.test(saved.prevTarget)
    && saved.prevTarget === begin.priorPointer
    && saved.migrated === false && saved.flipped === false;
  if (!ok) throw refuse('journal does not match a stop-only deploy');
  const read = runOnTarget(`readlink ${paths.currentLink}`, { ...config, projectDir: paths.root }, { capture: true, runtime: c.runtime, readOnly: true });
  const observedCurrent = read.ok ? (read.output || '').trim() : '';
  if (!read.ok || !RELEASE_TARGET_RE.test(observedCurrent) || observedCurrent !== saved.prevTarget) throw refuse('current does not point at the previous release');
  const previousSha = resolveReleaseSha(config, paths, saved.prevTarget, 'previous', c);
  return { kind: 'stoppedRecovery', manager, saved, oldOperationId: op.operationId, previousSha, observedCurrent };
}

// Read-only: the ACTUAL full commit of a release worktree (never inferred from the directory name).
function resolveReleaseSha(config, paths, target, label, c) {
  assertSafeTarget(target, label);
  const res = runOnTarget('git rev-parse HEAD', { ...config, projectDir: `${paths.root}/${target}` }, { capture: true, runtime: c.runtime, readOnly: true });
  if (!res.ok) throw recoveryRequired(`${label} ${target} SHA read failed`);
  const sha = (res.output || '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw recoveryRequired(`${label} ${target} did not resolve to a full 40-hex commit SHA`);
  return sha;
}

// Atomic symlink swap: create a uniquely-named temp symlink in the same directory,
// then GNU `mv -T` renames it over the target (a single namespace op on ext4 —
// readers see the old or new link, never a missing one). Relative target so the
// tree can be relocated. `link` overrides which symlink is written (current by default).
// Returns whether the swap actually took (PKG-135 Finding B) -- a `tolerate:
// true` caller that ignores this return value gets the OLD behavior (log
// nothing, throw nothing, keep going); a caller that needs to know whether
// `current` actually moved before deciding what to do next (recovery, below)
// can now ask.
function activateSymlink(config, paths, relTarget, ctx, { link, tolerate = false } = {}) {
  const dest = link || paths.currentLink;
  const tmp = `${paths.root}/.dk-swap.$$.${dest.split('/').pop()}`;
  const cmd = `ln -s ${relTarget} ${tmp} && mv -Tf ${tmp} ${dest}`;
  const res = runOnTarget(cmd, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
  if (!res.ok) {
    runOnTarget(`rm -f ${tmp} 2>/dev/null || true`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
    if (!tolerate) throw new Error(`Deploy aborted: atomic symlink swap failed (${dest})`);
  }
  return res.ok;
}

// Persist explicit release metadata (never inferred) ATOMICALLY: write a same-dir
// temp file then `mv -f` over the state file, so an interruption can never leave a
// truncated/empty state. Gated — a failed write aborts rather than silently
// reporting success. Used both for durable journaling and the final success record.
function persistState(config, paths, state, ctx) {
  if (config.transitionAuthority != null && ctx.runtime?.dryRun !== true) {
    // Protected: fsync-backed write acknowledged only after rename + parent fsync; failures
    // carry JOURNAL_FAILED so callers can tell phase-write uncertainty from ordinary errors.
    createReleasePhaseStorage({ ...config, projectDir: paths.root }, { runtime: ctx.runtime })
      .write(JSON.stringify({ ...state, phaseJournalVersion: PHASE_JOURNAL_VERSION, layoutVersion: LAYOUT_VERSION }));
    return;
  }
  const cmd = atomicWriteCommand(paths.stateFile, JSON.stringify({ ...state, layoutVersion: LAYOUT_VERSION }));
  const res = runOnTarget(cmd, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
  if (!res.ok) throw new Error(`Failed to persist release metadata (${paths.stateFile})`);
}

// Prune old releases down to keepReleases total, NEVER removing current/previous or
// the just-activated release, only ever touching recognized ids under releases/, via
// git-aware removal. Runs post-activation holding the lock.
function prune(config, paths, keepId, ctx) {
  const keepN = Math.max(1, config.layout.keepReleases || 4);
  const pointers = readPointers(config, paths, ctx);
  const idOf = (t) => (t && t.startsWith('releases/') ? t.slice('releases/'.length) : null);
  const protectedIds = new Set([keepId, idOf(pointers.current), idOf(pointers.previous)].filter(Boolean));
  const listing = capture(paths.root, `ls -1 ${paths.releasesDir} 2>/dev/null || true`, config, ctx);
  const entries = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  const matching = entries.filter((id) => RELEASE_ID_RE.test(id)).sort().reverse(); // newest first
  for (const id of entries) if (!RELEASE_ID_RE.test(id)) ctx.log.warning(`Prune: leaving unrecognized entry in releases/: ${id}`);

  // Retain protected ids plus the newest releases up to keepN total; delete the rest.
  const retain = new Set(protectedIds);
  for (const id of matching) { if (retain.size >= keepN) break; retain.add(id); }
  const toRemove = matching.filter((id) => !retain.has(id));
  for (const id of toRemove) {
    const dir = `${paths.releasesDir}/${id}`;
    ctx.log.step(`Pruning old release ${id}`);
    runOnTarget(`git --git-dir=${paths.repoGit} worktree remove --force ${dir} 2>/dev/null || rm -rf ${dir}`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
  }
  runOnTarget(`git --git-dir=${paths.repoGit} worktree prune 2>/dev/null || true`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
}

// Post-flip rollback recovery (PKG-135 Finding 5), shared by every failure path
// that can occur AFTER `current` has already been flipped to the rollback
// target: a failing preRestartCheck, or an activation that never verifies
// healthy. Nothing after the flip may throw without first attempting this --
// the alternative is `current` pointing at the rolled-back release while the
// ORIGINAL process (never restarted) is still the one actually serving
// traffic, which is the worst state to be in mid-incident: the symlink and
// the running process disagree about what's live. `reason` is a plain
// description of what triggered the recovery (a failed check, an unhealthy
// verification, ...) -- this ALWAYS throws: either a "restored, here's what
// triggered it" error, or MANUAL RECOVERY when the restore itself can't be
// confirmed (no safe originalCurrent to restore to, or the restored release
// doesn't come back healthy either).
// With `restoredSha` (protected recovery child) a verified restore RETURNS the exact
// observation instead of throwing, so the caller completes the authority first.
function recoverFailedRollback(config, paths, originalCurrent, c, reason, restoredSha = null) {
  c.log.error(`${reason}; flipping back to ${originalCurrent}`);
  if (!(originalCurrent && RELEASE_TARGET_RE.test(originalCurrent))) {
    throw new Error(`MANUAL RECOVERY REQUIRED — ${reason} and no safe original release to restore.`);
  }
  // PKG-135 Finding B: the flip-back itself can fail (permissions, disk,
  // whatever broke the forward flip could just as easily break this one) --
  // `activateSymlink(..., { tolerate: true })` neither throws nor reports
  // that on its own, so a blind `pm2Activate` right after it would restart
  // PM2 against WHATEVER `current` still points at, which may still be the
  // release that just failed its own check/verification. That is WORSE than
  // doing nothing: it can activate the very target this recovery exists to
  // move away from. So: check the flip-back's own result FIRST. If it did
  // not take, do not touch PM2 at all -- change nothing further and shout.
  const flipped = activateSymlink(config, paths, originalCurrent, c, { tolerate: true });
  if (!flipped) {
    throw new Error(
      `MANUAL RECOVERY REQUIRED — ${reason} AND the recovery symlink swap back to ${originalCurrent} itself `
      + `failed. \`current\` (${paths.currentLink}) may still point at the release this recovery was trying to `
      + 'move away from -- PM2 was deliberately NOT restarted, since doing so could activate that release '
      + 'instead of restoring the original one. Manually confirm what `current` points at and what is actually '
      + 'running before touching PM2 yourself.',
    );
  }
  runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
  const back = verifyActivation(config, paths, restoredSha, `${paths.root}/${originalCurrent}`, c);
  if (!back.ok) {
    throw new Error(`MANUAL RECOVERY REQUIRED — ${reason} AND the original release did not come back (${back.reason}).`);
  }
  if (restoredSha) return { observedSha: restoredSha, verified: true };
  throw new Error(`Rollback aborted: ${reason}; restored the original release ${originalCurrent}.`);
}

// Release-layout rollback: flip `current` back to the recorded previous release and
// restart. NO reinstall/rebuild (the previous release is already built). Data is NOT
// touched — a schema rollback is a data-loss decision the operator makes explicitly.
function rollbackRelease(config, options = {}, ctx = {}) {
  assertTransitionAuthorityEntryPoint(config, { supported: true, options });
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const c = { ...ctx, log, sleep, runtime: ctx.runtime };
  const paths = releasePaths(config);

  // Release-layout rollback NEVER reinstalls or rebuilds, with or without these
  // flags — the previous release directory is already built (see the module
  // comment above). So --skip-build/--skip-deps have no step to skip here; unlike
  // the legacy rollback (which really does gate an install/build step on them),
  // honoring or ignoring the flag would both look like a no-op to the caller.
  // Refuse loudly rather than let an operator believe the flag did something.
  if (options.skipBuild) {
    throw new Error(
      '--skip-build does not apply to release-layout rollback: it never rebuilds — the previous release is '
      + 'already built. Remove the flag.',
    );
  }
  if (options.skipDeps) {
    throw new Error(
      '--skip-deps does not apply to release-layout rollback: it never reinstalls dependencies — the previous '
      + 'release already has its node_modules in place. Remove the flag.',
    );
  }

  log.header(`⏪ Rolling back [release layout] (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const release = acquireOrAdoptLock(config, c, { steal: options.stealLock === true });
  try {
    preflight(config, paths, c);
    const fenced = config.transitionAuthority != null && c.runtime?.dryRun !== true;
    const manager = fenced ? inspectTransitionAuthority(config, paths, c, ctx).manager : null;
    const pointers = readPointers(config, paths, c);
    if (!pointers.previous) throw new Error(`No previous release recorded (${paths.previousLink}); cannot roll back.`);
    assertSafeTarget(pointers.previous, 'previous');
    // Remember what current pointed at so a failed rollback can flip back to it
    // instead of leaving a broken `previous` release serving traffic.
    const originalCurrent = pointers.current;
    if (fenced && originalCurrent) assertSafeTarget(originalCurrent, 'current');
    const isRuntimeFailure = (err) => err instanceof TransitionOperationError && err.code === 'RUNTIME_FAILED';
    const phaseJournal = (identity, fields) => persistState(config, paths, { ...identity, ...fields }, c);

    // Every flip/check/restart/save/verify effect; `targetSha` is the ACTUAL commit when
    // fenced (failures then throw into the authority runtime, never unfenced recovery).
    const executeRollback = (targetSha) => {
      log.step(`Flipping current back to ${pointers.previous}`);
      activateSymlink(config, paths, pointers.previous, c);
      // Pre-restart checks: gated, run IMMEDIATELY BEFORE the pm2 restart, same as
      // the forward deploy. `current` has ALREADY been flipped, so a failing check must
      // not throw straight out (PKG-135 Finding 5) when unfenced.
      for (const check of config.preRestartChecks) {
        log.step(`Pre-restart check: ${check.name}`);
        try {
          runInDir(paths.root, check.command, config, c);
        } catch (err) {
          const reason = `Pre-restart check "${check.name}" failed during rollback (${err.message})`;
          if (targetSha) throw new Error(reason);
          recoverFailedRollback(config, paths, originalCurrent, c, reason);
        }
      }
      runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
      runInDir(paths.root, 'pm2 save 2>/dev/null || true', config, c, { tolerate: true });

      const v = verifyActivation(config, paths, targetSha, `${paths.root}/${pointers.previous}`, c);
      if (!v.ok) {
        const reason = `Rollback target ${pointers.previous} was unhealthy (${v.reason})`;
        if (targetSha) throw new Error(reason);
        recoverFailedRollback(config, paths, originalCurrent, c, reason);
      }
      return targetSha ? { observedSha: targetSha, verified: true } : null;
    };
    const finish = () => {
      log.success(`Rolled back to ${pointers.previous}`);
      if (config.hooks.backup) {
        log.warning('Code rolled back to the previous release. If the failed deploy ran a migration, the previous '
          + 'code may not run against the migrated schema — restore the pre-migration DB backup explicitly if needed.');
      }
      return { release: pointers.previous, mode: config.mode, host: config.host, healthy: true };
    };

    if (fenced) {
      const previousSha = resolveReleaseSha(config, paths, pointers.previous, 'previous', c);
      const begun = manager.begin({
        kind: 'manual-rollback', targetSha: previousSha, targetRelease: pointers.previous, priorPointer: originalCurrent,
        effects: { ...CONSERVATIVE_EFFECTS }, parentOperationId: null,
      });
      const identity = { operationId: begun.operationId, targetSha: previousSha };
      let observation;
      try {
        observation = manager.run(begun.handle, () => {
          phaseJournal(identity, { phase: 'manual-rollback', current: originalCurrent, previous: pointers.previous });
          return executeRollback(previousSha);
        });
      } catch (err) {
        if (!isRuntimeFailure(err) || isPhaseWriteUncertain(err)) throw err;
        // Uncertainty ends only by an acknowledged UNKNOWN abandon; then a fresh child recovers.
        try {
          manager.abandon(begun.handle, 'UNKNOWN');
        } catch (abandonErr) {
          throw recoveryRequired('manual rollback failed and abandon was not acknowledged; recovery assessment required', abandonErr);
        }
        return recoverFencedRollback(err, begun.operationId);
      }
      manager.complete(begun.handle, observation);
      phaseJournal(identity, { phase: 'done', current: pointers.previous, previous: originalCurrent, sha: previousSha });
      return finish();
    }

    executeRollback(null);
    return finish();

    // Failed protected rollback: fresh automatic-recovery child back to the original release.
    function recoverFencedRollback(failure, failedOperationId) {
      const reason = failure.cause?.message || failure.message;
      let originalSha;
      try {
        originalSha = resolveReleaseSha(config, paths, originalCurrent, 'original current', c);
      } catch (shaErr) {
        throw recoveryRequired(`manual rollback failed (${reason}) and no safe original release could be resolved to restore`, shaErr);
      }
      const begun = manager.begin({
        kind: 'automatic-recovery', targetSha: originalSha, targetRelease: originalCurrent, priorPointer: pointers.previous,
        effects: { ...CONSERVATIVE_EFFECTS }, parentOperationId: failedOperationId,
      });
      const identity = { operationId: begun.operationId, targetSha: originalSha };
      let observation;
      try {
        observation = manager.run(begun.handle, () => {
          phaseJournal(identity, { phase: 'manual-rollback-recovery', current: originalCurrent, previous: pointers.previous });
          return recoverFailedRollback(config, paths, originalCurrent, c, reason, originalSha);
        });
      } catch (err) {
        if (!isRuntimeFailure(err) || isPhaseWriteUncertain(err)) throw err;
        try {
          manager.abandon(begun.handle, 'UNKNOWN');
        } catch (abandonErr) {
          throw recoveryRequired('manual rollback recovery failed and abandon was not acknowledged; recovery assessment required', abandonErr);
        }
        throw recoveryRequired('manual rollback recovery failed and was abandoned UNKNOWN; manual recovery required', err);
      }
      manager.complete(begun.handle, observation);
      phaseJournal(identity, { phase: 'recovered', current: originalCurrent, previous: pointers.previous, sha: originalSha });
      log.success(`Restored the original release ${originalCurrent}`);
      throw new Error(`Rollback aborted: ${reason}; restored the original release ${originalCurrent}.`);
    }
  } finally {
    release();
  }
}

module.exports = {
  LAYOUT_VERSION,
  isReleaseLayout,
  releasePaths,
  deployRelease,
  rollbackRelease,
  verifyActivation,
  activateSymlink,
  prune,
  readPointers,
};
