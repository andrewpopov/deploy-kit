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

// Shell fragment that ensures $HOME/.deploy-kit exists (mode 700) and carries a
// pre-upgrade /tmp prev-sha pointer forward into it, one time. This must NOT be
// a side effect of taking the lock: with `lock:false` (or config.lock === false)
// acquireLock returns a pure noop and never runs any shell at all, so a caller
// that needs the state dir/migration (e.g. deploy.js recording the prev-sha
// before pull) must run this fragment itself rather than relying on the lock
// path to have done it first.
function ensureStateDir(config) {
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
  return `${ensureBase}\n${migrate}`;
}

// The acquire scripts below (both branches) are pure POSIX shell that ALWAYS
// completes with `exit 0` (took/kept the lock) or `exit 1` (another deploy
// genuinely holds it, or --steal-lock lost the mkdir race) -- every branch in
// both scripts ends in one of those two exits, nothing else. So `runOnTarget`
// reporting !ok with anything OTHER than a confirmed exit status of 1 means the
// script never got to render a verdict at all: ssh failed to connect, auth was
// rejected, the run was killed by a timeout, or some other transport-level
// failure happened before the remote shell ever ran our mkdir logic. Before
// this fix (PKG-127) that case was folded into the SAME "Another deploy holds
// the lock" message the genuine case gets -- which is actively wrong (there is
// no lock) and actively dangerous (it recommends --steal-lock, which does
// nothing useful against an auth failure and IS destructive against a real
// one; a clipd deploy sat 19 commits behind because the real cause -- no
// authorized_keys for that account -- was hidden behind a fabricated
// lock-contention diagnosis). `res.error.status` is the exit code
// execFileSync's thrown error carries regardless of capture -- verified
// empirically: a real `exit 1` sets status:1, while a spawn failure (ENOENT)
// or a non-1 exit (ssh conventionally uses 255 for a connection/auth failure)
// leaves status anything else.
function isConfirmedScriptExit1(res) {
  return res.error != null && res.error.status === 1;
}

// Build the "could not even run the check" message shared by both branches
// below. Never claims a lock exists -- it says only what is true: the target
// could not be reached to find out.
function lockCheckFailedMessage(res, dir, action) {
  const detail = (res.error && res.error.message) || 'unknown error';
  return `Could not run the lock-${action} command against the target (${dir}). This is a connection or `
    + `authentication failure, NOT a confirmed held lock -- --steal-lock would not help and must not be used `
    + `here. Resolve connectivity/auth to the target, then retry. Underlying error: ${detail}`;
}

// Take the target lock (atomic mkdir), recording owner metadata (pid + start
// time, for operator visibility in the stale-lock log line) plus a random
// nonce inside it. Staleness is judged PURELY by the TTL clock (recorded ts vs
// now) -- never by the recorded pid: that pid is the ephemeral remote shell's
// own $$, which exits moments after writing it, so it is printed for a human
// but never checked as a liveness signal by this code. The nonce is what lets
// release() below tell "a lock I still hold" from "a lock TTL-reclaimed out
// from under me while I was still running" -- see release() for why that
// matters. Returns a release fn. --steal-lock forces past a held lock;
// config.lock:false disables locking entirely.
function acquireLock(config, ctx, { steal = false, suffix } = {}) {
  const noop = () => {};
  if (config.lock === false) return noop;
  const dir = lockDir(config, suffix);
  const ttl = lockTtlSeconds(config);
  const stateDir = ensureStateDir(config);
  // Generate the nonce ON THE TARGET, not in Node: /dev/urandom (falling back to
  // pid+timestamp if it's somehow unavailable) so it's a real per-acquire random
  // value in production, POSIX-portable (no bashisms, no $RANDOM).
  const genNonce = 'nonce=$(head -c16 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d " \\n"); '
    + '[ -n "$nonce" ] || nonce="$$-$(date +%s)"';
  const writeOwner = `${genNonce}; echo $$ > "${dir}/pid" 2>/dev/null; date +%s > "${dir}/ts" 2>/dev/null; `
    + `echo "$nonce" > "${dir}/nonce" 2>/dev/null`;

  // Dispose of a stale/held lock dir via RENAME, not `rm -rf`: `mv` of a
  // directory to a fresh, unique (pid-suffixed) name is a single rename(2), so
  // at most one concurrent disposer can ever win it -- the loser's `mv` fails
  // (its source is already gone) and it falls through to the ordinary `mkdir`
  // contest below, where it loses too. `rm -rf "$dir"` directly would defeat
  // that: two racers could each `rm` (racer B deleting the fresh dir racer A
  // just `mkdir`'d) then both `mkdir` and both believe they hold the lock.
  const disposeStale = `mv "${dir}" "${dir}.stale.$$" 2>/dev/null && rm -rf "${dir}.stale.$$"`;

  if (steal) {
    // Force past a held lock. Rename-based disposal (see disposeStale above)
    // then an ATOMIC mkdir (no -p) so two concurrent --steal-lock runs can't
    // both "succeed" silently: whichever loses the mkdir gets the normal
    // held-lock error instead of believing it owns a lock the other racer
    // just recreated.
    const script = `${stateDir}\n${disposeStale}\n`
      + `if mkdir -m 700 "${dir}" 2>/dev/null; then ${writeOwner}; else exit 1; fi`;
    const res = runOnTarget(script, config, { runtime: ctx.runtime });
    if (!res.ok) {
      if (isConfirmedScriptExit1(res)) {
        throw new Error(
          `--steal-lock lost a race for the lock (${dir}) to another concurrent deploy; try again.`,
        );
      }
      throw new Error(lockCheckFailedMessage(res, dir, 'takeover'));
    }
  } else {
    const script = [
      stateDir,
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
      `  ${disposeStale}`,
      `  if mkdir -m 700 "${dir}" 2>/dev/null; then`,
      `    ${writeOwner}`,
      '    exit 0',
      '  fi',
      'fi',
      'exit 1',
    ].join('\n');
    const res = runOnTarget(script, config, { runtime: ctx.runtime });
    if (!res.ok) {
      if (isConfirmedScriptExit1(res)) {
        throw new Error(
          `Another deploy holds the lock (${dir}). Wait for it to finish, or pass --steal-lock.`,
        );
      }
      throw new Error(lockCheckFailedMessage(res, dir, 'check'));
    }
  }
  // Read back the nonce THIS acquire just wrote (generated shell-side above, so
  // Node never invents the value itself) to bake into the release check below.
  const nonceRes = runOnTarget(`cat "${dir}/nonce" 2>/dev/null`, config, { capture: true, runtime: ctx.runtime });
  const nonce = (nonceRes.output || '').trim();

  // Only remove the lock dir if its nonce still matches the one we wrote at
  // acquire time. Without this check, an unconditional `rm -rf "$dir"` here
  // deletes whatever currently sits at that path -- including another run's
  // lock: a slow-but-still-alive run A that exceeds the TTL gets reclaimed by
  // run B, but A's eventual release() would delete B's (not A's) lock,
  // letting a third run C start while B still believes it holds the lock.
  return () => runOnTarget(
    `[ "$(cat "${dir}/nonce" 2>/dev/null)" = "${nonce}" ] && rm -rf "${dir}" 2>/dev/null || true`,
    config,
    { runtime: ctx.runtime },
  );
}

module.exports = {
  lockId, lockDir, prevShaFile, legacyPrevShaFile, lockTtlSeconds, ensureStateDir, acquireLock,
};
