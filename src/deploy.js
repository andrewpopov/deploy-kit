'use strict';

const {
  runOnTarget, buildHealthCommand, shQuote, normalizeRuntime,
} = require('./exec');
const { buildPinCheckProgram, PIN_CHECK_COMMAND } = require('./pin-gate');
const {
  lockDir, prevShaFile, ensureStateDir, acquireLock,
} = require('./lock');
const { log: defaultLog } = require('./log');
const { backupIdFromOutput, backupReferenceFromId } = require('./backup-reference');
const { resolveBranch } = require('./branch');
const { onlineAppNames } = require('./pm2-state');

function defaultSleep(seconds) {
  const ms = seconds * 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A syntactically plausible git SHA (abbreviated or full) -- what rollback()
// requires of a recorded pointer before it will reset to it (see rollback()
// below). deploy()'s own write-time gate no longer uses this: it compares the
// recorded pointer against a freshly-read HEAD directly (PKG-135 Finding C),
// which is a strictly stronger check that makes a length-based "plausible"
// regex unnecessary there. 7-64 covers both git object-hash formats git
// itself can emit: SHA-1 (40 hex chars, or an abbreviation down to 7) and the
// newer SHA-256 repository format (64 hex chars, PKG-135 Finding D) -- `git
// rev-parse HEAD` always returns the FULL, un-abbreviated form, but this
// regex is intentionally as permissive as "looks like a hex object id" gets,
// not narrowed to exactly 40-or-64.
const PLAUSIBLE_SHA_RE = /^[0-9a-f]{7,64}$/;

// Path to the host layout marker. A legacy deploy/rollback must refuse to run
// against a host that has been migrated to the release layout (SMH-112) — pulling
// and building in a bare/releases root would be destructive. Cheap single probe.
function layoutMarkerFile(config) {
  return `${config.projectDir}/.deploy-kit-layout`;
}

// Abort a legacy (non-release-layout) deploy/rollback if the host is already on
// the release layout but the config forgot its `layout` block. Fails closed.
function assertNotReleaseHost(config, ctx) {
  if (!config.projectDir) return;
  const res = runOnTarget(
    `test -f ${layoutMarkerFile(config)} && echo RELEASE || true`,
    config,
    { capture: true, runtime: ctx.runtime },
  );
  if ((res.output || '').trim() === 'RELEASE') {
    throw new Error(
      `Host ${config.projectDir} is on the release layout (found .deploy-kit-layout) but this config has no `
      + `"layout" block. Refusing to run a legacy in-place deploy against a release-layout host. Add the `
      + `layout config, or run against the correct target.`,
    );
  }
}

// The set of endpoints to health-gate: the scalar port/healthPath is always
// probed; healthChecks adds extra endpoints (app + worker fleets).
function healthEndpoints(config) {
  return [{}, ...(config.healthChecks || [])];
}

// Poll the app's health endpoint(s) on the target until each returns 200 or
// attempts are exhausted. In ssh mode curl runs on the remote (localhost:port).
function waitForHealth(config, ctx) {
  const { attempts, delaySeconds } = config.health;
  for (const check of healthEndpoints(config)) {
    const label = check.path || check.port ? ` (${check.port || config.port}${check.path || config.healthPath})` : '';
    const command = buildHealthCommand(config, check);
    let ok = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const res = runOnTarget(command, config, { capture: true, runtime: ctx.runtime });
      const code = (res.output || '').trim();
      if (code === '200') {
        ctx.log.success(`Application is healthy (HTTP 200)${label} after ${attempt} attempt(s)`);
        ok = true;
        break;
      }
      ctx.log.info(`Health not ready${label} (HTTP ${code || '000'}); retry in ${delaySeconds}s (${attempt}/${attempts})`);
      if (attempt < attempts) ctx.sleep(delaySeconds);
    }
    if (!ok) return false;
  }
  return true;
}

// Build the PM2 (re)start command for one or more process names. With an
// `ecosystemFile`, start from the file when a process isn't registered yet (first
// deploy) and fall back to `pm2 restart` when it is — the proven
// `pm2 start <file> --only <name> --update-env || pm2 restart <name> --update-env`
// idiom from the
// hand-rolled deploy.sh (sano). Without a file, plain `pm2 restart <names>`
// (requires the processes to already exist, matching the original default).
function pm2StartOrRestart(names, config) {
  const list = Array.isArray(names) ? names : [names];
  const restart = `pm2 restart ${list.join(' ')} --update-env`;
  if (!config.ecosystemFile) return restart;
  return `pm2 start ${config.ecosystemFile} --only ${list.join(',')} --update-env 2>/dev/null || ${restart}`;
}

// Bounded retry around a `pm2 jlist` read that guards the migration window. A
// single unreadable read (a pm2/ssh hiccup) must not immediately fail closed —
// that would make the deploy flaky against a perfectly healthy host — but
// genuinely unknown state must never be treated as safe either (PTRY-510 Part
// 2). 3 attempts, short delay between via the existing `ctx.sleep` (same
// retry/backoff idiom `waitForHealth` already uses).
const DB_STATE_READ_ATTEMPTS = 3;
const DB_STATE_READ_RETRY_DELAY_SECONDS = 2;
// `pm2 jlist` is a fast local probe, so it gets its OWN short bound instead of
// inheriting `stepTimeoutSeconds` (default 1800s, and `null` means no timeout
// at all). Inheriting it would let three retries hold the deploy lock for ~90
// minutes, or hang forever on a `stepTimeoutSeconds: null` consumer — turning a
// safety check into an availability risk. A jlist that cannot answer in 30s is
// unreadable for our purposes, which is exactly what the retry/fail-closed
// path is for.
const DB_STATE_READ_TIMEOUT_SECONDS = 30;

function readOnlineDbBoundApps(names, config, ctx) {
  for (let attempt = 1; attempt <= DB_STATE_READ_ATTEMPTS; attempt += 1) {
    const online = onlineAppNames(names, config, ctx, { timeoutSeconds: DB_STATE_READ_TIMEOUT_SECONDS });
    if (online !== null) return online;
    if (attempt < DB_STATE_READ_ATTEMPTS) {
      ctx.log.warning(
        `\`pm2 jlist\` was unreadable (attempt ${attempt}/${DB_STATE_READ_ATTEMPTS}); `
        + `retrying in ${DB_STATE_READ_RETRY_DELAY_SECONDS}s...`,
      );
      ctx.sleep(DB_STATE_READ_RETRY_DELAY_SECONDS);
    }
  }
  return null;
}

// A step that must succeed or the whole deploy aborts. onFail runs first
// (e.g. restart the apps we paused) so we never leave services stopped.
function gate(step, config, ctx, { onFail, capture = false } = {}) {
  ctx.log.step(step.message);
  const res = runOnTarget(step.command, config, { runtime: ctx.runtime, capture });
  if (!res.ok) {
    if (onFail) onFail();
    throw new Error(`Deploy aborted: ${step.message} failed`);
  }
  return res;
}

// Run the full pipeline on the target. Returns a structured summary. Throws on
// any gated failure (caller/CLI maps that to a non-zero exit).
//
// Sequence (faithful to the hand-rolled bewks/kira/smarthome deploy.sh):
//   lock → checks → stash → record-SHA → fetch → pull --ff-only → drop-stash →
//   install → BACKUP(gate) → stop db-bound apps (release SQLite lock) →
//   migrate(gate, restart on fail) → build → restart apps → health(gate)
function deploy(config, options = {}, ctx = {}) {
  // Artifact-first release layout (SMH-112) is a separate pipeline. Lazy-require to
  // avoid a top-level cycle (release.js pulls shared helpers, not this module).
  if (config.layout && config.layout.type === 'releases') {
    return require('./release').deployRelease(config, options, ctx);
  }
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const runtime = ctx.runtime;
  const c = { ...ctx, log, sleep, runtime };
  const {
    skipDeps = false,
    skipBuild = false,
    skipMigrate = false,
    stash = config.mode !== 'local',
    stealLock = false,
    // Build while apps are still UP, before the backup/stop/migrate block, to keep
    // the app-paused window down to just migration (some repos, e.g. stoki, build
    // first then stop only for the DB work). Default false = build after migrate,
    // while apps are paused (bewks' model). Option or config both work.
    buildBeforeMigrate = config.buildBeforeMigrate === true,
    // `--skip-pin-check` (options) overrides `verifyPins: false` (config); with
    // neither, the gate is on.
    verifyPins = config.verifyPins !== false,
  } = options;

  const run = (message, command, opts) => {
    log.step(message);
    const res = runOnTarget(command, config, { runtime, input: opts?.input });
    if (!res.ok && !opts?.tolerate) throw new Error(`Deploy aborted: ${message} failed`);
    return res.ok;
  };

  log.header(`🚀 Deploying (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const branch = resolveBranch(config, c);
  const steps = [];
  let backupId = null;

  // Once the DB-bound apps are paused for migration, EVERY subsequent step
  // (backup, migrate, build) must bring them back up on failure — otherwise a
  // failure leaves production stopped. Matches deploy.sh, which `pm2 start`s the
  // paused apps on every post-stop failure before aborting. Declared before the
  // lock/signal handlers below so a SIGINT/SIGTERM mid-deploy can resume them too.
  let dbAppsPaused = false;
  // The exact set of apps OBSERVED RUNNING before the pause (PTRY-510 Part 3) —
  // recovery resumes only these, never every configured dbBoundApp, so an app
  // that was already stopped before this deploy (e.g. under manual maintenance)
  // stays stopped through a failed-and-recovered deploy. This is deliberately
  // set to the FULL observed-online set (never left to "empty means fall back
  // to everything") — an empty set here legitimately means nothing was running,
  // so resumeDbApps below must resume nothing, not the whole configured list.
  // Only the dry-run path (which never reads real pm2 state, so there is no
  // "observed" set to speak of) sets this to every configured dbBoundApp.
  let pausedApps = [];
  const resumeDbApps = () => {
    if (!dbAppsPaused) return;
    if (!pausedApps.length) { dbAppsPaused = false; return; }
    const toResume = pausedApps;
    runOnTarget(`pm2 start ${toResume.join(' ')} 2>/dev/null || true`, config, { runtime });
    // A zero-exit `pm2 start` is not proof anything actually came back online
    // (release.js's `resumePrevious` models the same distrust) — verify before
    // clearing the paused-state bookkeeping. Skipped under --dry-run: pm2 state
    // is never real there (the dry-run fake always reads back empty), so a
    // verification read would always spuriously report "could not confirm".
    if (normalizeRuntime(runtime).dryRun) { dbAppsPaused = false; return; }
    const after = onlineAppNames(toResume, config, c, { timeoutSeconds: DB_STATE_READ_TIMEOUT_SECONDS });
    const notConfirmed = after === null ? toResume : toResume.filter((name) => !after.has(name));
    if (notConfirmed.length) {
      // Loud and SEPARATE from the original failure: the caller (gate()/
      // safeStep()) throws its own "Deploy aborted: ..." error right after this
      // returns, and that original cause must not be masked by a recovery
      // problem — so this only logs, never throws. Bookkeeping is deliberately
      // left uncleared (dbAppsPaused stays true) — this resume was NOT confirmed,
      // so it must not be recorded as though it were.
      log.error(
        `RECOVERY INCOMPLETE: DB-bound app(s) (${notConfirmed.join(', ')}) did not come back online after `
        + `resume${after === null ? ' (`pm2 jlist` unreadable, could not verify)' : ''}. The failure above is `
        + 'the ORIGINAL cause of this deploy aborting — this is a SEPARATE, additional problem. Check `pm2 '
        + 'status` on the target by hand.',
      );
      return;
    }
    dbAppsPaused = false;
  };
  // A gated step that, on failure, first resumes any paused apps, then aborts.
  const safeStep = (message, command) => {
    gate({ message, command }, config, c, { onFail: resumeDbApps });
  };

  const release = acquireLock(config, c, { steal: stealLock });
  // DO NOT DELETE THIS AS DEAD CODE. `onSignal`'s body is in fact unreachable
  // for a signal that arrives mid-deploy -- but merely REGISTERING it is what
  // makes the `finally` below run at all, and that is the whole point.
  //
  // Why: this function is entirely synchronous (execFileSync everywhere,
  // Atomics.wait in defaultSleep), so it never yields to the event loop and Node
  // can never dispatch a queued signal until after `finally` has already removed
  // these listeners. With NO listener registered, the default disposition kills
  // the process instantly at the signal -- `finally` never runs, paused
  // DB-bound apps stay stopped, and the lock is held forever. That was the bug.
  // With a listener registered, Node suppresses the default death, the
  // synchronous run reaches `finally`, and cleanup happens there. Verified
  // empirically: sync-block + SIGINT exits 130 with no cleanup when unregistered,
  // and completes cleanly when registered (the body never runs either way).
  //
  // The body is kept as a correct safety net for the day any of this becomes
  // async. It re-raises rather than calling process.exit(1) so an embedder
  // calling deploy() programmatically keeps control of its own shutdown.
  const onSignal = (sig) => {
    log.error(`Received ${sig} mid-deploy — resuming any paused apps and releasing the lock`);
    try { resumeDbApps(); } catch (e) { log.error(e.message); }
    try { release(); } catch (e) { log.error(e.message); }
    process.removeListener(sig, sigHandlers[sig]);
    process.kill(process.pid, sig);
  };
  const sigHandlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
  process.on('SIGINT', sigHandlers.SIGINT);
  process.on('SIGTERM', sigHandlers.SIGTERM);
  try {
    // Fail closed if the host was migrated to the release layout but this config
    // still asks for a legacy in-place deploy.
    assertNotReleaseHost(config, c);
    // Pre-deploy checks: user-defined gates run BEFORE anything is touched (no stash,
    // fetch, or pull yet). Each is a command on the target; a non-zero exit aborts the
    // deploy with nothing changed. Use for preconditions — free disk, DB reachable,
    // a required env var present. Generic: the kit runs them, the consumer supplies them.
    for (const check of config.preDeployChecks) {
      gate({ message: `Pre-deploy check: ${check.name}`, command: check.command }, config, c);
      steps.push(`check:${check.name}`);
    }

    if (stash) {
      // Tracked-only stash: never sweep untracked .ssh/.cloudflared into a stash —
      // that would break the tunnel and lose the key mid-deploy.
      run('Stashing local tracked changes', `git stash push -m "deploy-kit $(date -u +%FT%TZ)" || true`, { tolerate: true });
      steps.push('stash');
    }

    // Record the current SHA before pulling so `deploy-kit rollback` can reset to
    // the exact code that was live before this deploy. $HOME/.deploy-kit is
    // normally created as a side effect of acquireLock, but with `lock: false`
    // acquireLock never runs any shell at all -- so this step must ensure the
    // state dir (and carry the legacy /tmp migration forward) itself, or the
    // `git rev-parse HEAD >` redirect below fails with no directory to write
    // into, silently (this step is tolerated) breaking `rollback` later.
    run(
      'Recording current revision',
      `${ensureStateDir(config)}\ngit rev-parse HEAD > ${prevShaFile(config)} 2>/dev/null || true`,
      { tolerate: true },
    );

    // The write above is tolerated (its OWN `|| true` makes `res.ok` true even
    // when `git rev-parse HEAD` or the redirect itself failed), so a green
    // `res.ok` is not proof anything usable actually landed -- and merely
    // reading the file back and checking it LOOKS like a SHA (PKG-135 Finding
    // 1) is not enough either (Finding C): a write that fails to overwrite an
    // EXISTING, readable file (read-only fs, permissions, a full disk
    // stopping the `>` redirect from truncating) leaves the OLD sha in place,
    // which still passes a bare "looks plausible" check while being silently
    // STALE. The only check that actually proves the recorded pointer
    // reflects THIS run is comparing it against HEAD, read independently,
    // right now.
    //
    // Skipped under --dry-run: the write above never really happened there
    // either (the dry-run fake always reads back empty), so this would
    // otherwise abort every dry run on its own fakery rather than a real
    // failure -- same rationale as the DB-bound pause verification skip below.
    if (!normalizeRuntime(runtime).dryRun) {
      const headRes = runOnTarget('git rev-parse HEAD', config, { runtime, capture: true });
      const head = (headRes.output || '').trim();
      // Empty HEAD (PKG-135 Finding D2) is NOT a recording failure -- it's an
      // unborn branch / a freshly-initialized repo with no commits yet, a
      // legitimate first deploy (the `git pull` right after this establishes
      // the initial checkout). There is genuinely no prior revision to roll
      // back to, so there is nothing to gate: `deploy-kit rollback` already
      // reports that honestly ("No recorded previous revision") if it's ever
      // run before a first successful deploy. Gate ONLY the case where a
      // prior revision DOES exist but we could not prove it got recorded.
      if (head) {
        const recorded = runOnTarget(`cat ${prevShaFile(config)} 2>/dev/null || true`, config, { runtime, capture: true });
        if ((recorded.output || '').trim() !== head) {
          throw new Error(
            `Deploy aborted: could not establish a rollback pointer at ${prevShaFile(config)} -- the recorded `
            + `revision does not match HEAD (${head.slice(0, 12)}). \`deploy-kit rollback\` would reset to the `
            + 'wrong (or no) revision. Check that the target can write to $HOME/.deploy-kit (not read-only, not '
            + 'full), then retry.',
          );
        }
      }
    }

    run('Fetching latest', `git fetch ${shQuote(config.remote)} --prune`);
    run(`Pulling ${config.remote}/${branch} (--ff-only)`, `git pull --ff-only ${shQuote(config.remote)} ${shQuote(branch)}`);
    steps.push(`pull:${branch}`);

    if (stash) {
      // Drop the stash we just created (matched by our marker) so tracked-change
      // stashes don't pile up on the target across deploys. Only ever drops a
      // deploy-kit stash; a hand-made stash is left untouched.
      run('Dropping deploy stash (if any)',
        `ref=$(git stash list --format='%gd %gs' | grep -m1 'deploy-kit' | awk '{print $1}'); if [ -n "$ref" ]; then git stash drop "$ref"; fi`,
        { tolerate: true });
    }

    if (!skipDeps) {
      run('Installing dependencies', config.hooks.install);
      steps.push('install');
      // Always run right after install, never folded into `hooks.build` — see
      // config.js's `hooks.generate` comment (PKG-127) for why a build tool's
      // own cache (Nx/Turbo) can silently skip a generator baked into the
      // build script, shipping a tree that installed cleanly but can't run.
      if (config.hooks.generate) {
        run('Running post-install generation', config.hooks.generate);
        steps.push('generate');
      }
    }

    // Gate the deploy on the installed tree matching what package.json asserts.
    // Placed IMMEDIATELY after install and before the backup/stop/migrate/build
    // block: a failure here aborts with every service still running and no
    // schema touched, so it costs a deploy rather than an outage.
    //
    // It is NOT a clean rollback point, and the changelog should not claim one.
    // By now the legacy pipeline has already pulled the live worktree and run
    // the install hook in it, so source and node_modules have changed underneath
    // the running processes — a later crash or manual restart would pick up the
    // unverified tree. Aborting here bounds the damage to that, which is the
    // best a legacy in-place deploy can offer; the release layout does better
    // (its gate runs inside a candidate that is never activated).
    //
    // Runs even under --skip-deps: the question it answers is "is the code on
    // this host the code the manifest claims", and skipping the install makes a
    // stale tree MORE likely, not less. See pin-gate.js for why the checker is
    // shipped to the target rather than invoked there.
    if (verifyPins) {
      run('Verifying dependency pins', PIN_CHECK_COMMAND, { input: buildPinCheckProgram() });
      steps.push('verify-pins');
    }

    const doBuild = !skipBuild && config.hooks.build;

    if (buildBeforeMigrate && doBuild) {
      // Build with apps still up — no pause yet, so a build failure aborts without
      // any service having been stopped.
      run('Building', config.hooks.build);
      steps.push('build');
    }

    if (!skipMigrate) {
      if (config.dbBoundApps.length) {
        // Stop DB-bound processes BEFORE the backup — matches release.js
        // (:488-494): a writer left online during the snapshot can produce an
        // inconsistent backup, defeating the entire reason the backup gate exists.
        //
        // The stop itself is tolerant twice over (`|| true` AND `tolerate: true`
        // below) because `pm2 stop` legitimately errors when an app isn't
        // running or isn't registered yet — that must never fail a deploy. But
        // a tolerant stop is not proof anything actually stopped, so verify it:
        // snapshot which dbBoundApps are online BEFORE the attempt, then assert
        // none of THOSE are still online after. Scoped to apps we observed
        // online — one that was already stopped, or was never registered, is
        // not this deploy's problem and must not turn into a spurious abort.
        //
        // --dry-run never actually pauses anything (the fake runtime always
        // reads back empty), so verifying the pause is meaningless there — a
        // dry run must never abort on it. Skip the whole verification and fall
        // back to resuming every configured dbBoundApp if something downstream
        // still manages to fail during the dry run.
        const dryRun = normalizeRuntime(runtime).dryRun;
        if (dryRun) {
          log.warning('--dry-run: skipping DB-bound pause verification (pm2 state is never real under a dry run).');
          run(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`,
            `pm2 stop ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, { tolerate: true });
          dbAppsPaused = true;
          pausedApps = config.dbBoundApps;
        } else {
          // Unknown state must never be treated as safe (PTRY-510 Part 2): a
          // bounded retry absorbs a one-off pm2/ssh hiccup, but if `pm2 jlist`
          // is STILL unreadable after retrying, abort — nothing has been
          // stopped yet, so this is a clean abort with nothing to recover.
          const onlineBeforePause = readOnlineDbBoundApps(config.dbBoundApps, config, c);
          if (onlineBeforePause === null) {
            throw new Error(
              `Deploy aborted: could not determine which DB-bound app(s) (${config.dbBoundApps.join(', ')}) were `
              + `running — \`pm2 jlist\` was unreadable after ${DB_STATE_READ_ATTEMPTS} attempts. Nothing has been `
              + 'paused; refusing to proceed into the migration window with unknown state.',
            );
          }

          run(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`,
            `pm2 stop ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, { tolerate: true });
          dbAppsPaused = true;
          // Resume only the apps we actually observed running before the pause
          // (PTRY-510 Part 3) — an app that was already stopped stays stopped.
          pausedApps = [...onlineBeforePause];

          if (onlineBeforePause.size) {
            const onlineAfterPause = readOnlineDbBoundApps(config.dbBoundApps, config, c);
            if (onlineAfterPause === null) {
              // Still unreadable after retrying, and apps we observed running
              // are now paused with no way to confirm it took — fail closed:
              // resume, then abort. Unlike the pre-pause case, something HAS
              // been stopped by now, so this is not a no-op abort.
              resumeDbApps();
              throw new Error(
                `Deploy aborted: could not confirm DB-bound app(s) (${[...onlineBeforePause].join(', ')}) stopped `
                + `— \`pm2 jlist\` was unreadable after ${DB_STATE_READ_ATTEMPTS} attempts following the pause `
                + 'attempt. Resumed the apps observed running before the pause; unknown state must not be '
                + 'treated as safe.',
              );
            }
            const stillOnline = [...onlineBeforePause].filter((name) => onlineAfterPause.has(name));
            if (stillOnline.length) {
              // Same recovery contract as every other gate in this window: resume
              // whatever we paused before aborting, so a failure here never
              // leaves production stopped.
              resumeDbApps();
              throw new Error(
                `Deploy aborted: DB-bound app(s) still running after the pause step (${stillOnline.join(', ')}) — `
                + 'a writer left online during the pre-migration backup can produce an inconsistent backup. '
                + 'A resume was attempted for the apps observed running before the pause.',
              );
            }
          }
        }
      }
      if (config.hooks.backup) {
        // Backup BEFORE migrating, AFTER writers are stopped. A failed backup must
        // still abort before any schema change — apps are already paused by now,
        // so (unlike before this fix) resume them on failure, same as every other
        // gate in this window.
        const backup = gate(
          { message: 'Pre-migration database backup', command: config.hooks.backup },
          config,
          c,
          { capture: true, onFail: resumeDbApps },
        );
        // Capture is required to correlate the backup with the delivery event.
        // Replay stdout so legacy hooks retain their operator-visible output.
        for (const line of (backup.output || '').split('\n').filter(Boolean)) log.info(line);
        backupId = backupIdFromOutput(backup.output, { log });
        steps.push('backup');
      }
      if (config.hooks.migrate) {
        safeStep('Running database migrations', config.hooks.migrate);
        steps.push('migrate');
      }
    }

    if (!buildBeforeMigrate && doBuild) {
      // Default: build while apps are paused (bewks' model); resume-on-failure so a
      // broken build never leaves the fleet stopped.
      safeStep('Building', config.hooks.build);
      steps.push('build');
    }

    // Pre-restart checks: gated, run IMMEDIATELY BEFORE the restart step — after
    // build, with any dbBoundApps still paused. A failure here resumes paused apps
    // first (safeStep), same contract as a failed build in this window. Generic:
    // the kit runs them, the consumer supplies them (e.g. a port-conflict guard
    // against the freshly-built candidate before it takes over the port).
    for (const check of config.preRestartChecks) {
      safeStep(`Pre-restart check: ${check.name}`, check.command);
      steps.push(`pre-restart-check:${check.name}`);
    }

    if (config.appNames.length) {
      const restartCmd = config.hooks.restart || pm2StartOrRestart(config.appNames, config);
      // safeStep, not run: this is still inside the paused window. A failed
      // restart used to abort straight through `run()`, leaving apps we paused
      // for the migration stopped with nothing attempting to bring them back.
      safeStep(`Restarting apps (${config.appNames.join(', ')})`, restartCmd);
      steps.push('restart');

      // Ensure auxiliary PM2 processes are up after the main restart — a cloudflared
      // tunnel, a sidecar worker, anything that isn't the health-gated app. Generic
      // and tolerant: a process that's already running, or briefly flaps, must never
      // fail an otherwise-healthy deploy. Not a tunnel-specific concept.
      for (const name of config.ensureApps) {
        run(`Ensuring ${name}`, pm2StartOrRestart(name, config), { tolerate: true });
      }
      if (config.ensureApps.length) steps.push('ensure');

      run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
    }

    // A dbBoundApp we paused above is only brought back if something else happens
    // to cover it: appNames restarts, or the ensureApps loop. One covered by
    // neither was left stopped while the deploy reported success (PKG-82 Bug 3).
    // ensureApps only runs when appNames is non-empty, so it counts as coverage
    // only under that same condition — otherwise a stranded app would be missed
    // again whenever appNames is empty.
    if (dbAppsPaused) {
      const ensured = config.appNames.length ? config.ensureApps : [];
      const stranded = config.dbBoundApps.filter(
        (name) => !config.appNames.includes(name) && !ensured.includes(name),
      );
      if (stranded.length) {
        run(`Restarting DB-bound apps (${stranded.join(', ')})`, pm2StartOrRestart(stranded, config));
      }
      dbAppsPaused = false;
    }

    const healthy = waitForHealth(config, c);
    if (!healthy) {
      throw new Error(
        'Deploy completed but the application is unhealthy: the new code is now live and failing health '
        + 'checks. Legacy deploys have no previous release to auto-flip back to — run `deploy-kit rollback` '
        + 'to restore the previous revision.',
      );
    }
    steps.push('health');

    for (const check of config.postDeployChecks) {
      gate({ message: `Post-deploy check: ${check.name}`, command: check.command }, config, c);
      steps.push(`post-check:${check.name}`);
    }

    let deliveryEvent;
    if (config.deliveryEvent?.command) {
      const backupReference = backupReferenceFromId(backupId);
      const payload = JSON.stringify({
        event: 'deployment', status: 'succeeded', branch,
        revision: runOnTarget('git rev-parse HEAD', config, { runtime, capture: true }).output.trim(),
        deployedAt: new Date().toISOString(),
        ...(backupReference ? { backupReference } : {}),
      });
      // Non-gating by design (tolerate: true) -- a broken announcement must
      // never turn a healthy deploy into a failure. But "reported" has to mean
      // something observable: before this, a failure here was a silent sink --
      // no warning, no trace in the result. Surface it both ways so an operator
      // (or a caller reading DeployResult) can actually tell delivery failed.
      const delivered = run('Emitting delivery event', config.deliveryEvent.command, { tolerate: true, input: payload });
      steps.push('delivery-event');
      if (!delivered) {
        log.warning(
          'Delivery event command failed (deliveryEvent.command); the event was NOT delivered. This does not '
          + 'fail the deploy, but the receiving system never heard about this deployment.',
        );
      }
      deliveryEvent = { delivered };
    }

    log.success('Deployment completed successfully');
    return {
      branch, mode: config.mode, host: config.host, steps, healthy, ...(deliveryEvent ? { deliveryEvent } : {}),
    };
  } finally {
    // Remove the signal handlers on every exit path (success or thrown) so they
    // never leak across calls — matches release.js's own SIGINT/SIGTERM cleanup.
    process.removeListener('SIGINT', sigHandlers.SIGINT);
    process.removeListener('SIGTERM', sigHandlers.SIGTERM);
    release();
  }
}

// Roll the target back to the revision recorded before the last deploy:
// `git reset --hard <prev SHA>` + reinstall + rebuild + restart. Data is NOT
// touched — we print the matching `db-backup restore` command instead of
// auto-restoring, since a schema rollback is the operator's call.
function rollback(config, options = {}, ctx = {}) {
  // Release-layout rollback is a symlink flip to the previous release, not a git
  // reset — a different pipeline. Legacy rollback must refuse a release-layout host.
  if (config.layout && config.layout.type === 'releases') {
    return require('./release').rollbackRelease(config, options, ctx);
  }
  const log = ctx.log || defaultLog;
  const runtime = ctx.runtime;
  const c = { ...ctx, log, sleep: ctx.sleep || defaultSleep, runtime };

  log.header(`⏪ Rolling back (${config.mode}${config.host ? ` → ${config.host}` : ''})`);

  // Lock first, THEN read the recorded SHA — otherwise a concurrent deploy could
  // rewrite the file between our read and the lock, resetting to the wrong SHA.
  const release = acquireLock(config, c, { steal: options.stealLock === true });
  try {
    // Fail closed if the host is on the release layout (legacy git-reset rollback
    // would be destructive there).
    assertNotReleaseHost(config, c);
    const prev = runOnTarget(`cat ${prevShaFile(config)} 2>/dev/null || true`, config, { capture: true, runtime });
    const sha = (prev.output || '').trim();
    if (!PLAUSIBLE_SHA_RE.test(sha)) {
      throw new Error(`No recorded previous revision (${prevShaFile(config)}); cannot roll back automatically.`);
    }

    const run = (message, command, opts) => {
      log.step(message);
      const res = runOnTarget(command, config, { runtime });
      if (!res.ok && !opts?.tolerate) throw new Error(`Rollback aborted: ${message} failed`);
      return res.ok;
    };

    run(`Resetting to ${sha.slice(0, 12)}`, `git reset --hard ${sha}`);
    if (!options.skipDeps) {
      run('Installing dependencies', config.hooks.install);
      // Same rationale as the forward deploy (PKG-127): a generator baked into
      // `hooks.build` can be skipped by a build tool's cache, so it must run
      // as its own always-invoked step, never folded into build.
      if (config.hooks.generate) run('Running post-install generation', config.hooks.generate);
    }
    if (!options.skipBuild && config.hooks.build) run('Building', config.hooks.build);
    // Same gate as the forward deploy, immediately before restart — a rollback
    // restart is just as capable of colliding with a squatting process as a
    // forward one, so the guard must cover both.
    for (const check of config.preRestartChecks) {
      run(`Pre-restart check: ${check.name}`, check.command);
    }
    if (config.appNames.length) {
      run(`Restarting apps (${config.appNames.join(', ')})`, config.hooks.restart || pm2StartOrRestart(config.appNames, config));
      for (const name of config.ensureApps) {
        run(`Ensuring ${name}`, pm2StartOrRestart(name, config), { tolerate: true });
      }
      run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
    }

    const healthy = waitForHealth(config, c);
    if (!healthy) throw new Error('Rollback completed but the application is unhealthy');

    log.success(`Rolled back to ${sha.slice(0, 12)}`);
    if (config.hooks.backup) {
      log.warning('Code rolled back. If the failed deploy ran a migration, restore data with your db-backup restore command (e.g. `npx db-backup restore --prod`).');
    }
    return { sha, mode: config.mode, host: config.host, healthy };
  } finally {
    release();
  }
}

module.exports = { deploy, rollback, resolveBranch, waitForHealth, lockDir, prevShaFile };
