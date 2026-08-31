'use strict';

const { runOnTarget, buildHealthCommand, shQuote } = require('./exec');
const { acquireLock } = require('./lock');
const { log: defaultLog } = require('./log');
const { backupIdFromOutput, isSafeBackupId, backupReferenceFromId } = require('./backup-reference');
const { resolveBranch } = require('./branch');
const { buildPinCheckProgram, PIN_CHECK_COMMAND } = require('./pin-gate');
const { parsePm2List } = require('./pm2-state');
const { runAutoCutPreflight } = require('./auto-cut-call');
const { clearAutoCutPending } = require('./auto-cut');

// Bump when the on-host layout changes shape. The host migration writes this
// version into .deploy-kit-layout; a release deploy refuses a host whose marker
// is absent or a different version, so an out-of-date host can't be deployed to.
const LAYOUT_VERSION = 1;

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
  let running = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    running = capture(paths.root, config.layout.runningShaCommand, config, ctx);
    if (running && running.slice(0, 12) === expected) return { ok: true, running };
    if (attempt < attempts) ctx.sleep(delaySeconds);
  }
  return { ok: false, running };
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
  if (['post-deploy-failed', 'post-deploy-rollback'].includes(state.phase)) {
    throw new Error(
      `A previous deploy was interrupted mid-"${state.phase}" (release ${state.releaseId || '?'}, backup `
      + `${state.backupId || 'none'}). Resolve it by hand — verify the DB/schema and the running release — then `
      + `set "phase":"done" in ${paths.stateFile} (or remove it) before deploying again.`,
    );
  }
  return null;
}

// The full artifact-first release deploy. See the failure-phase table in the ticket:
// every phase records enough state that recover() can restore a known-good running
// release, and the ONLY disruptive window is stop → backup → migrate → flip.
function deployRelease(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const c = { ...ctx, log, sleep, runtime: ctx.runtime };
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
    migrated: false, failedCheck: null, failurePolicy: null, recoveryOutcome: null,
  });
  const st = freshState();
  let recoveringInterrupted = false;

  // Durably journal the disruptive-phase state BEFORE each irreversible op, so a
  // process/SSH/power loss leaves an on-host record of whether the DB was migrated
  // and which backup restores it (recovery on the next invocation is a follow-up;
  // this at least makes the truth recoverable instead of lost in process memory).
  const journal = () => persistState(config, paths, {
    phase: st.phase, releaseId: st.releaseId, sha: st.sha, backupId: st.backupId,
    migrated: st.migrated, flipped: st.flipped, prevTarget: st.prevTarget,
    failedCheck: st.failedCheck, failurePolicy: st.failurePolicy,
    recoveryOutcome: st.recoveryOutcome,
  }, c);

  // After a SUCCESSFUL recovery, overwrite the journaled disruptive phase so the
  // next deploy isn't blocked by assertNoInterruptedDeploy — only a HARD interruption
  // (no recovery ran) leaves a stopped/migrated/flipped phase on disk. Best-effort:
  // a metadata write failing here must not mask the recovery that just succeeded.
  const markRecovered = () => {
    st.phase = 'recovered';
    try { journal(); } catch { /* best effort */ }
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

  const resumePrevious = () => {
    // Bring the previous release's apps back and verify it is actually healthy —
    // a zero-exit `pm2 start` is not proof (Codex).
    runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
    return verifyActivation(config, paths, null, `${paths.root}/${st.prevTarget}`, c);
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

  const rollbackToPrevious = (fail) => {
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
    if (!resumePrevious().ok) fail('the previous release did not come back healthy after DB/symlink recovery');
  };

  // Phase-appropriate recovery. Returns nothing; throws a distinct MANUAL RECOVERY
  // error if it cannot restore a known-good running release (never a routine abort).
  const recover = (err) => {
    const fail = (msg) => { throw new Error(`MANUAL RECOVERY REQUIRED — ${msg}. Original: ${err && err.message}`); };
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
          journal();
          emitDeliveryEvent('failed', {
            failedCheck: st.failedCheck,
            activeRelease: st.prevTarget,
            recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: true },
          });
        } catch (recoveryError) {
          st.phase = 'post-deploy-rollback-failed';
          st.recoveryOutcome = 'rollback-failed';
          try { journal(); } catch { /* original recovery error remains primary */ }
          emitDeliveryEvent('failed', {
            ...eventBase,
            recovery: { policy: st.failurePolicy, outcome: st.recoveryOutcome, verified: false },
          });
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
    log.error(`Received ${sig} mid-deploy — running recovery for phase "${st.phase}"`);
    try { recover(new Error(`interrupted by ${sig}`)); } catch (e) { log.error(e.message); }
    process.removeListener(sig, sigHandlers[sig]);
    process.kill(process.pid, sig);
  };
  const sigHandlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };

  const release = acquireLock(config, c, { steal: stealLock });
  process.on('SIGINT', sigHandlers.SIGINT);
  process.on('SIGTERM', sigHandlers.SIGTERM);
  try {
    preflight(config, paths, c);
    recoverInterruptedDeploy();
    for (const check of config.preDeployChecks) {
      st.phase = 'preflight';
      const res = runInDir(paths.root, check.command, config, c, { tolerate: true });
      if (!res.ok) throw new Error(`Pre-deploy check failed: ${check.name}`);
    }

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
    }

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
          `Deploy aborted: fetched ${config.remote} into ${paths.repoGit} for auto-cut release ${R.slice(0, 12)}, `
          + `but \`git cat-file -e ${R}^{commit}\` still fails -- the commit is not actually present there. `
          + 'Refusing to materialize a release from a commit the bare repo does not have.',
        );
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
      log.step('Backing up the database (writers stopped)');
      const res = runInDir(st.releaseDir, config.hooks.backup, config, c, { capture: true });
      if (!res.ok) throw new Error('Pre-migration database backup failed');
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
    if (!skipMigrate && config.hooks.migrate) {
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
    st.phase = 'done';
    persistState(config, paths, { phase: 'done', current: `releases/${releaseId}`, previous: st.prevTarget, sha: st.sha, backupId: st.backupId, migrated: st.migrated, ts }, c);
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

    log.success(`Deployment completed successfully (release ${releaseId})`);
    return {
      branch, mode: config.mode, host: config.host, sha: st.sha, release: releaseId, steps, healthy: true,
      ...(deliveryEvent ? { deliveryEvent } : {}),
    };
  } catch (err) {
    if (recoveringInterrupted) throw err;
    recover(err);
    throw err;
  } finally {
    process.removeListener('SIGINT', sigHandlers.SIGINT);
    process.removeListener('SIGTERM', sigHandlers.SIGTERM);
    release();
  }
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
  const json = JSON.stringify({ ...state, layoutVersion: LAYOUT_VERSION }).replace(/'/g, "'\\''");
  const tmp = `${paths.stateFile}.tmp.$$`;
  const cmd = `printf '%s' '${json}' > ${tmp} && mv -f ${tmp} ${paths.stateFile}`;
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
function recoverFailedRollback(config, paths, originalCurrent, c, reason) {
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
  const back = verifyActivation(config, paths, null, `${paths.root}/${originalCurrent}`, c);
  if (!back.ok) {
    throw new Error(`MANUAL RECOVERY REQUIRED — ${reason} AND the original release did not come back (${back.reason}).`);
  }
  throw new Error(`Rollback aborted: ${reason}; restored the original release ${originalCurrent}.`);
}

// Release-layout rollback: flip `current` back to the recorded previous release and
// restart. NO reinstall/rebuild (the previous release is already built). Data is NOT
// touched — a schema rollback is a data-loss decision the operator makes explicitly.
function rollbackRelease(config, options = {}, ctx = {}) {
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
  const release = acquireLock(config, c, { steal: options.stealLock === true });
  try {
    preflight(config, paths, c);
    const pointers = readPointers(config, paths, c);
    if (!pointers.previous) throw new Error(`No previous release recorded (${paths.previousLink}); cannot roll back.`);
    assertSafeTarget(pointers.previous, 'previous');
    // Remember what current pointed at so a failed rollback can flip back to it
    // instead of leaving a broken `previous` release serving traffic.
    const originalCurrent = pointers.current;

    log.step(`Flipping current back to ${pointers.previous}`);
    activateSymlink(config, paths, pointers.previous, c);
    // Pre-restart checks: gated, run IMMEDIATELY BEFORE the pm2 restart, same as
    // the forward deploy — a rollback restart is just as capable of colliding
    // with a squatting process as a forward one. `current` has ALREADY been
    // flipped by this point, so a failing check here must not be allowed to
    // throw straight out of this function (PKG-135 Finding 5) — that would
    // leave `current` pointing at the rollback target while the original
    // process (never restarted) is still what's actually running. Route the
    // failure through the same post-flip recovery the unhealthy-verification
    // path below uses.
    for (const check of config.preRestartChecks) {
      log.step(`Pre-restart check: ${check.name}`);
      try {
        runInDir(paths.root, check.command, config, c);
      } catch (err) {
        recoverFailedRollback(config, paths, originalCurrent, c, `Pre-restart check "${check.name}" failed during rollback (${err.message})`);
      }
    }
    runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
    runInDir(paths.root, 'pm2 save 2>/dev/null || true', config, c, { tolerate: true });

    const v = verifyActivation(config, paths, null, `${paths.root}/${pointers.previous}`, c);
    if (!v.ok) {
      // The target release did not come up. Restore the release that WAS running.
      recoverFailedRollback(config, paths, originalCurrent, c, `Rollback target ${pointers.previous} was unhealthy (${v.reason})`);
    }

    log.success(`Rolled back to ${pointers.previous}`);
    if (config.hooks.backup) {
      log.warning('Code rolled back to the previous release. If the failed deploy ran a migration, the previous '
        + 'code may not run against the migrated schema — restore the pre-migration DB backup explicitly if needed.');
    }
    return { release: pointers.previous, mode: config.mode, host: config.host, healthy: true };
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
