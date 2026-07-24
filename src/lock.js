'use strict';

const { runOnTarget } = require('./exec');

// Stable per-target id from the projectDir (falls back to appNames/host).
// Sanitized to a filesystem-safe token so two deploys of the same target
// contend for the same lock but different targets don't. Also keeps the
// interpolated paths below free of shell metacharacters.
function lockId(config) {
  const raw = config.projectDir || config.appNames.join('-') || config.host || 'default';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

// All deploy-kit state lives here on the TARGET, not /tmp: /tmp is world-writable
// (any local user could pre-create a lock dir to block every deploy, or seed a
// prev-sha file with an arbitrary commit for `rollback` to `git reset --hard`
// to) and is wiped on reboot, silently destroying legacy rollback ability.
// `$HOME` is a literal token left for the remote (or local, in mode:'local')
// shell to expand at EXECUTION time — Node never resolves it — so this always
// resolves to the target's home directory, never the orchestrator's.
// Deliberately NOT `config.projectDir`: see prevShaFile below, that would put
// lock/rollback state back into the tracked repo working tree.
const BASE_DIR = '$HOME/.deploy-kit';

function lockDir(config, suffix) {
  return `${BASE_DIR}/deploy-kit-${lockId(config)}${suffix ? `-${suffix}` : ''}.lock`;
}

// Where the pre-pull SHA is recorded for legacy `rollback`. Kept outside the
// worktree so it never shows as an untracked file or collides with a repo path.
function prevShaFile(config) {
  return `${BASE_DIR}/deploy-kit-${lockId(config)}.prev-sha`;
}

// Pre-PKG-82 location of prevShaFile. Read exactly once, by acquireLock's
// migration step below, to carry an in-flight rollback pointer forward across
// the upgrade. Never written to again after this change.
function legacyPrevShaFile(config) {
  return `/tmp/deploy-kit-${lockId(config)}.prev-sha`;
}

// A deploy run holds the lock across the WHOLE pipeline (backup, stop, pull/
// build, migrate, start, health-check, ...), not just one step, so the
// staleness TTL must clear a full run, not a single step's bound. 4x the
// per-step bound gives headroom for several full-length steps in one run while
// still bounding how long a crashed run (e.g. `monitor` wedged mid-run on a
// cron) can hold the lock without a human: 2 hours by default (4 * the 1800s
// default), not forever. Scales with a caller's own stepTimeoutSeconds so a
// target configured with a longer per-step bound still gets a TTL longer than
// its own legitimate deploys.
function lockTtlSeconds(config) {
  return (config.stepTimeoutSeconds || 1800) * 4;
}

// Take the target lock (atomic mkdir), recording owner metadata (pid + start
// time) inside it so a later acquire can tell a live lock from an abandoned
// one and reclaim it instead of wedging forever. Returns a release fn.
// --steal-lock forces past a held lock; config.lock:false disables locking
// entirely.
function acquireLock(config, ctx, { steal = false, suffix } = {}) {
  const noop = () => {};
  if (config.lock === false) return noop;
  const dir = lockDir(config, suffix);
  const ttl = lockTtlSeconds(config);
  const newPrevSha = prevShaFile(config);
  const legacyPrevSha = legacyPrevShaFile(config);

  // Ensure the state dir exists and is not world-writable/readable (mode 700)
  // before anything else. -p makes repeat calls a no-op; it does not repair the
  // mode of a dir that somehow predates us (an accepted, narrow gap).
  const ensureBase = `mkdir -m 700 -p "${BASE_DIR}" 2>/dev/null`;
  // One-time forward migration: copy a pre-upgrade /tmp prev-sha pointer into
  // the new home the first time we see it, so an in-flight `rollback` still
  // works after the upgrade. Only copies when the new file doesn't already
  // exist, so it can never clobber a prev-sha written post-upgrade; the /tmp
  // original is left alone (harmless -- it disappears on the next reboot
  // either way).
  const migrate = `if [ ! -f "${newPrevSha}" ] && [ -f "${legacyPrevSha}" ]; then `
    + `cp "${legacyPrevSha}" "${newPrevSha}" 2>/dev/null || true; fi`;
  const writeOwner = `echo $$ > "${dir}/pid" 2>/dev/null; date +%s > "${dir}/ts" 2>/dev/null`;

  if (steal) {
    // Force past a held lock. rm -rf then an ATOMIC mkdir (no -p) so two
    // concurrent --steal-lock runs can't both "succeed" silently: whichever
    // loses the mkdir gets the normal held-lock error instead of believing it
    // owns a lock the other racer just recreated.
    const script = `${ensureBase}\n${migrate}\n`
      + `rm -rf "${dir}" 2>/dev/null\n`
      + `if mkdir -m 700 "${dir}" 2>/dev/null; then ${writeOwner}; else exit 1; fi`;
    const res = runOnTarget(script, config, { runtime: ctx.runtime });
    if (!res.ok) {
      throw new Error(
        `--steal-lock lost a race for the lock (${dir}) to another concurrent deploy; try again.`,
      );
    }
  } else {
    const script = [
      ensureBase,
      migrate,
      `if mkdir -m 700 "${dir}" 2>/dev/null; then`,
      `  ${writeOwner}`,
      '  exit 0',
      'fi',
      `ts=$(cat "${dir}/ts" 2>/dev/null || echo 0)`,
      'case "$ts" in ""|*[!0-9]*) ts=0 ;; esac',
      'now=$(date +%s)',
      'age=$((now - ts))',
      `if [ "$age" -gt ${ttl} ]; then`,
      `  pid=$(cat "${dir}/pid" 2>/dev/null || echo '?')`,
      `  echo "deploy-kit: stale lock at ${dir} -- age $age seconds exceeds the ${ttl}s TTL (pid $pid) -- taking it over"`,
      `  rm -rf "${dir}" 2>/dev/null`,
      `  if mkdir -m 700 "${dir}" 2>/dev/null; then`,
      `    ${writeOwner}`,
      '    exit 0',
      '  fi',
      'fi',
      'exit 1',
    ].join('\n');
    const res = runOnTarget(script, config, { runtime: ctx.runtime });
    if (!res.ok) {
      throw new Error(
        `Another deploy holds the lock (${dir}). Wait for it to finish, or pass --steal-lock.`,
      );
    }
  }
  return () => runOnTarget(`rm -rf "${dir}" 2>/dev/null || true`, config, { runtime: ctx.runtime });
}

module.exports = {
  lockId, lockDir, prevShaFile, legacyPrevShaFile, lockTtlSeconds, acquireLock,
};
