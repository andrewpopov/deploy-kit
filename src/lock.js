'use strict';

const { runOnTarget } = require('./exec');

// Handles minted by acquireOwnedLocks, with what releasing them needs. A copied or
// deserialized handle is not a key here, so it never validates.
const OWNED_LOCKS = new WeakMap();

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

// The lock shared by every app on one host (config.hostLock = { dir, key }).
function hostLockDir(config) {
  if (!config.hostLock) throw new Error('deploy-kit: no hostLock configured');
  return `${config.hostLock.dir}/${config.hostLock.key}.lock`;
}

// Directory and permanent guard of either the app lock or (scope 'host') the host lock.
function lockLocation(config, { suffix, scope } = {}) {
  const dir = scope === 'host' ? hostLockDir(config) : lockDir(config, suffix);
  return { dir, guard: `${dir}.guard` };
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
function heldError(message) {
  return Object.assign(new Error(message), { code: 'held' });
}

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

// `onHost.required` apps never have a held lock taken over by age or by
// --steal-lock: units run with KillMode=process, so a dead pid or an old
// timestamp proves nothing about whether the run is still alive. Breaking such a
// lock is a separate, evidence-checked operation (a later slice).
function lockRequiresOwnership(config) {
  return config.onHost != null && config.onHost.required === true;
}

// Permanent sibling of the lock directory. It is NEVER renamed or unlinked: the
// lock directory itself is renamed/removed, so an flock on it could not
// serialize two parties who each saw a different directory at the same path.
// Every acquire and release (and the future break) holds an exclusive flock on
// this one inode while it inspects or mutates the owner directory.
function guardFile(config, suffix) {
  return `${lockDir(config, suffix)}.guard`;
}

// Shell prelude that creates the guard (mode 600) and takes its exclusive flock
// on fd 9 for the rest of the script (the lock drops when the shell exits).
// flock(1) is util-linux, so stock macOS lacks it: apps that did not opt in keep
// working unguarded there (exactly the pre-guard behaviour); an opted-in app
// refuses (exit 2), because its safety rests on the guard.
function guardPrelude(config, guard) {
  const missing = lockRequiresOwnership(config)
    ? 'echo "deploy-kit: flock(1) is required for onHost.required apps" >&2; exit 2'
    : ':';
  return [
    `( umask 077; : >> "${guard}" ) 2>/dev/null || exit 2`,
    `exec 9>> "${guard}" || exit 2`,
    `if command -v flock >/dev/null 2>&1; then flock -x 9 || exit 2; else ${missing}; fi`,
  ].join('\n');
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]*$/;
const OWNER_KINDS = ['unit', 'session', 'legacy'];

function ownerFields({ kind = 'legacy', runId = '', purpose = '' } = {}) {
  if (!OWNER_KINDS.includes(kind)) throw new Error(`deploy-kit: invalid lock owner kind "${kind}"`);
  for (const [name, value] of [['runId', runId], ['purpose', purpose]]) {
    if (!SAFE_TOKEN.test(value)) throw new Error(`deploy-kit: lock owner ${name} must match ${SAFE_TOKEN}`);
  }
  return { kind, runId, purpose };
}

// Shell fragment that writes the lock's files: the legacy pid/ts/nonce plus the
// owner record. Must run inside the guard, right after the successful mkdir, so
// the record is atomic with acquisition. Fields that do not apply (no /proc on
// macOS, no systemd unit) are JSON null. Every interpolated value is a
// sanitized token, so the JSON needs no escaping.
function ownerWriter(dir, { kind, runId, purpose }) {
  return [
    'js() { if [ -n "$1" ]; then printf \'"%s"\' "$1"; else printf null; fi; }',
    'jn() { case "$1" in ""|*[!0-9]*) printf null ;; *) printf "%s" "$1" ;; esac; }',
    // Nonce generated ON THE TARGET, not in Node: /dev/urandom (falling back to
    // pid+timestamp), POSIX-portable (no bashisms, no $RANDOM).
    'nonce=$(head -c16 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -d " \\n"); '
      + '[ -n "$nonce" ] || nonce="$$-$(date +%s)"',
    `echo $$ > "${dir}/pid" 2>/dev/null; date +%s > "${dir}/ts" 2>/dev/null; echo "$nonce" > "${dir}/nonce" 2>/dev/null`,
    'boot=$(tr -cd "a-f0-9-" < /proc/sys/kernel/random/boot_id 2>/dev/null)',
    'st=$(sed "s/^.*) //" /proc/$$/stat 2>/dev/null)',
    'pstart=$(echo "$st" | cut -d" " -f20); sid=$(echo "$st" | cut -d" " -f4)',
    'inv=$(printf "%s" "${INVOCATION_ID:-}" | tr -cd "a-f0-9")',
    `unit=; kind='${kind}'`,
    'if [ -n "$inv" ]; then kind=unit; '
      + 'unit=$(sed -n "s|.*/\\([^/]*\\.service\\)\\$|\\1|p" /proc/self/cgroup 2>/dev/null | tail -1 | tr -cd "A-Za-z0-9_.@:-"); fi',
    `{ printf '{"kind":'; js "$kind"; printf ',"uid":'; jn "$(id -u)"; `
      + `printf ',"user":'; js "$(id -un | tr -cd "A-Za-z0-9_.-")"; `
      + `printf ',"bootId":'; js "$boot"; printf ',"unit":'; js "$unit"; `
      + `printf ',"invocationId":'; js "$inv"; printf ',"pid":'; jn "$$"; `
      + `printf ',"pstart":'; jn "$pstart"; printf ',"sid":'; jn "$sid"; `
      + `printf ',"runId":'; js '${runId}'; printf ',"nonce":'; js "$nonce"; `
      + `printf ',"purpose":'; js '${purpose}'; printf '}\\n'; } > "${dir}/owner.tmp" 2>/dev/null `
      + `&& mv "${dir}/owner.tmp" "${dir}/owner"`,
  ].join('\n');
}

// Take the target lock (atomic mkdir under the guard flock), recording an owner
// record (see ownerWriter) plus the legacy pid/ts/nonce files inside it.
// Staleness for apps that did not opt in is judged PURELY by the TTL clock
// (recorded ts vs now) -- never by the recorded pid: that pid is the ephemeral
// remote shell's own $$, which exits moments after writing it. The nonce is what
// lets release() below tell "a lock I still hold" from "a lock TTL-reclaimed out
// from under me while I was still running" -- see release() for why that
// matters. Returns a release fn. --steal-lock forces past a held lock (refused
// for onHost.required apps, which never lose a lock to anything but a break);
// config.lock:false disables locking entirely.
function acquireLock(config, ctx, {
  steal = false, suffix, kind, runId, purpose, scope,
} = {}) {
  const noop = () => {};
  if (config.lock === false) return noop;
  const { dir, guard } = lockLocation(config, { suffix, scope });
  const ttl = lockTtlSeconds(config);
  const stateDir = ensureStateDir(config);
  const owned = lockRequiresOwnership(config);
  const prelude = guardPrelude(config, guard);
  const writeOwner = ownerWriter(dir, ownerFields({ kind, runId, purpose }));

  if (steal && owned) {
    throw new Error(
      `--steal-lock is refused for onHost.required apps (${dir}): a held lock is only ever removed by `
      + '`deploy-kit lock break`, which proves the owner is gone. Inspect it with `deploy-kit lock inspect --json`.',
    );
  }

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
    const script = `${stateDir}\n${prelude}\n${disposeStale}\n`
      + `if mkdir -m 700 "${dir}" 2>/dev/null; then\n${writeOwner}\nelse exit 1; fi`;
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
    // Apps that opted in report the owner and refuse; everyone else may take a
    // lock over once it is older than the TTL (the backward-compatible default).
    const heldBranch = owned
      ? [
        `echo "deploy-kit: refused lock-held at ${dir}"`,
        `echo "owner: $(cat "${dir}/owner" 2>/dev/null || echo 'null (no owner record)')"`,
      ]
      : [
        `ts=$(cat "${dir}/ts" 2>/dev/null || echo 0)`,
        'case "$ts" in ""|*[!0-9]*) ts=0 ;; esac',
        'now=$(date +%s)',
        'age=$((now - ts))',
        `if [ "$age" -gt ${ttl} ]; then`,
        `  pid=$(cat "${dir}/pid" 2>/dev/null || echo '?')`,
        `  echo "deploy-kit: stale lock at ${dir} -- age $age seconds exceeds the ${ttl}s TTL (pid $pid) -- taking it over"`,
        `  ${disposeStale}`,
        `  if mkdir -m 700 "${dir}" 2>/dev/null; then`,
        writeOwner,
        '    exit 0',
        '  fi',
        'fi',
      ];
    const script = [
      stateDir,
      prelude,
      `if mkdir -m 700 "${dir}" 2>/dev/null; then`,
      writeOwner,
      '  exit 0',
      'fi',
      ...heldBranch,
      'exit 1',
    ].join('\n');
    const res = runOnTarget(script, config, { runtime: ctx.runtime, capture: owned });
    if (!res.ok) {
      if (isConfirmedScriptExit1(res)) {
        if (owned) throw heldError(`refused lock-held: ${(res.output || '').trim()}`);
        throw heldError(`Another deploy holds the lock (${dir}). Wait for it to finish, or pass --steal-lock.`);
      }
      throw new Error(lockCheckFailedMessage(res, dir, 'check'));
    }
  }
  // Read back the nonce THIS acquire just wrote (generated shell-side above, so
  // Node never invents the value itself) to bake into the release check below.
  const nonceRes = runOnTarget(`cat "${dir}/nonce" 2>/dev/null`, config, { capture: true, runtime: ctx.runtime });
  const nonce = (nonceRes.output || '').trim();

  // Only remove the lock dir if its nonce still matches the one we wrote at
  // acquire time, and only while holding the guard. Without the nonce check, an
  // unconditional `rm -rf "$dir"` here deletes whatever currently sits at that
  // path -- including another run's lock: a slow-but-still-alive run A that
  // exceeds the TTL gets reclaimed by run B, but A's eventual release() would
  // delete B's (not A's) lock, letting a third run C start while B still
  // believes it holds the lock.
  return () => removeIfNonce(config, ctx, { dir, guard }, nonce);
}

function removeIfNonce(config, ctx, { dir, guard }, nonce) {
  return runOnTarget(
    `${guardPrelude(config, guard)}\n[ "$(cat "${dir}/nonce" 2>/dev/null)" = "${nonce}" ] && rm -rf "${dir}" 2>/dev/null || true`,
    config,
    { runtime: ctx.runtime },
  );
}

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function lateError(dir, notAfter) {
  return Object.assign(
    new Error(`late: lock ${dir} was still held at notAfter ${notAfter}`),
    { code: 'late' },
  );
}

// Take one lock, polling while another run holds it, until `notAfter` (unix
// seconds). Only a confirmed "held" outcome is retried; any other failure throws.
function acquireWithin(config, ctx, options, { notAfter, now, sleep }) {
  for (;;) {
    try {
      return acquireLock(config, ctx, options);
    } catch (error) {
      if (error.code !== 'held') throw error;
      if (now() >= notAfter) throw lateError(lockLocation(config, options).dir, notAfter);
      sleep(1);
    }
  }
}

// Canonical path (symlinks resolved on the target) and parsed owner record of a
// lock directory, or null when it does not exist or cannot be read.
function readLockIdentity(config, ctx, dir) {
  const res = runOnTarget(
    `cd "${dir}" 2>/dev/null || exit 3\npwd -P\ncat owner 2>/dev/null`,
    config,
    { capture: true, runtime: ctx.runtime, readOnly: true },
  );
  if (!res.ok) return null;
  const [canonical, ...rest] = res.output.split('\n');
  let owner = null;
  try { owner = JSON.parse(rest.join('\n')); } catch { return null; }
  return { path: canonical, owner };
}

// Take the host lock (when configured) and then the app lock, both with the owner
// record, and return a handle the pipeline accepts in place of taking them again.
// Both waits are bounded by `notAfter`; past it the refusal is `late`.
function acquireOwnedLocks(config, ctx, {
  notAfter, runId, purpose, kind, now = () => Date.now() / 1000, sleep = sleepSync,
} = {}) {
  if (config.lock === false) throw new Error('deploy-kit: owned locks require locking to be enabled');
  if (!Number.isFinite(notAfter)) throw new Error('deploy-kit: acquireOwnedLocks needs a numeric notAfter (unix seconds)');
  const wait = { notAfter, now, sleep };
  const common = { kind, runId, purpose };
  const releases = [];
  const releaseAll = () => { while (releases.length) releases.pop()(); };
  try {
    if (config.hostLock) releases.push(acquireWithin(config, ctx, { ...common, scope: 'host' }, wait));
    releases.push(acquireWithin(config, ctx, common, wait));
    const host = config.hostLock ? readLockIdentity(config, ctx, hostLockDir(config)) : null;
    const app = readLockIdentity(config, ctx, lockDir(config));
    if ((config.hostLock && !host) || !app) throw new Error('deploy-kit: could not read back the lock owner records just written');
    const handle = {
      hostPath: host ? host.path : null,
      appPath: app.path,
      runId: runId || null,
      pid: process.pid,
      hostNonce: host ? host.owner.nonce : null,
      appNonce: app.owner.nonce,
      released: false,
    };
    OWNED_LOCKS.set(handle, { config, ctx });
    return handle;
  } catch (error) {
    releaseAll();
    throw error;
  }
}

function rejectHandle(reason) {
  return new Error(`deploy-kit: owned lock handle rejected: ${reason}`);
}

// Check a handle against the registry, this process, the config's canonical lock
// paths and the owner records on disk. Throws on anything but a live, whole,
// own handle.
function validateOwnedLocks(config, ctx, handle) {
  if (handle == null || typeof handle !== 'object' || !OWNED_LOCKS.has(handle)) {
    throw rejectHandle('not issued by acquireOwnedLocks in this process (copied or deserialized)');
  }
  if (handle.released) throw rejectHandle('already released');
  if (handle.pid !== process.pid) throw rejectHandle(`issued to pid ${handle.pid}, not ${process.pid}`);
  if (config.lock === false) throw rejectHandle('locking is disabled in this config');
  const wantsHost = Boolean(config.hostLock);
  if (!handle.appPath || (wantsHost && !handle.hostPath)) throw rejectHandle('partial handle: a configured lock is missing');
  if (!wantsHost && handle.hostPath) throw rejectHandle('handle holds a host lock this config does not configure');
  const checks = [['app', lockDir(config), handle.appPath, handle.appNonce]];
  if (wantsHost) checks.unshift(['host', hostLockDir(config), handle.hostPath, handle.hostNonce]);
  for (const [name, dir, path, nonce] of checks) {
    const found = readLockIdentity(config, ctx, dir);
    if (!found) throw rejectHandle(`${name} lock ${dir} is not held`);
    if (found.path !== path) throw rejectHandle(`${name} lock path ${path} is not the config's ${found.path}`);
    if (found.owner.nonce !== nonce || found.owner.runId !== handle.runId) {
      throw rejectHandle(`${name} lock owner on disk is not this handle`);
    }
  }
}

// Release the app lock, then the host lock, each only if its nonce still matches.
function releaseOwnedLocks(handle) {
  const held = OWNED_LOCKS.get(handle);
  if (!held || handle.released) return;
  handle.released = true;
  const { config, ctx } = held;
  removeIfNonce(config, ctx, { dir: handle.appPath, guard: `${handle.appPath}.guard` }, handle.appNonce);
  if (handle.hostPath) {
    removeIfNonce(config, ctx, { dir: handle.hostPath, guard: `${handle.hostPath}.guard` }, handle.hostNonce);
  }
}

// Read-only view of the app lock for `deploy-kit lock inspect --json`: owner
// record, age, and guard state. Mutates nothing -- it never creates the guard
// (a missing one is reported as absent) and only probes it with a non-blocking
// shared flock on a read-only descriptor.
function inspectLock(config, ctx, { suffix } = {}) {
  const dir = lockDir(config, suffix);
  const guard = guardFile(config, suffix);
  const script = [
    `echo "lockDir=${dir}"`,
    `echo "guard=${guard}"`,
    `if [ -e "${guard}" ]; then`,
    '  echo "guardPresent=yes"',
    `  echo "guardInode=$(stat -c %i "${guard}" 2>/dev/null || stat -f %i "${guard}" 2>/dev/null)"`,
    '  if command -v flock >/dev/null 2>&1; then',
    `    if ( flock -n -s 8 ) 8< "${guard}" 2>/dev/null; then echo "guardHeld=no"; else echo "guardHeld=yes"; fi`,
    '  else echo "guardHeld=unknown"; fi',
    'else echo "guardPresent=no"; fi',
    `if [ -d "${dir}" ]; then`,
    '  echo "lockPresent=yes"',
    `  echo "ts=$(cat "${dir}/ts" 2>/dev/null)"`,
    '  echo "now=$(date +%s)"',
    `  echo "owner=$(cat "${dir}/owner" 2>/dev/null)"`,
    'else echo "lockPresent=no"; fi',
  ].join('\n');
  const res = runOnTarget(script, config, { capture: true, runtime: ctx.runtime, readOnly: true });
  if (!res.ok) throw new Error(lockCheckFailedMessage(res, dir, 'inspect'));
  const kv = {};
  for (const line of res.output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  let owner = null;
  let ownerError = null;
  if (kv.owner) {
    try { owner = JSON.parse(kv.owner); } catch (error) { ownerError = error.message; }
  }
  const held = kv.lockPresent === 'yes';
  const ts = Number(kv.ts);
  const heldState = { yes: true, no: false };
  return {
    lockDir: kv.lockDir,
    held,
    owner,
    ownerError,
    ageSeconds: held && ts > 0 ? Number(kv.now) - ts : null,
    guard: {
      path: kv.guard,
      present: kv.guardPresent === 'yes',
      inode: kv.guardInode ? Number(kv.guardInode) : null,
      held: heldState[kv.guardHeld] ?? null,
    },
    requiresOwnership: lockRequiresOwnership(config),
  };
}

module.exports = {
  lockId, lockDir, prevShaFile, legacyPrevShaFile, lockTtlSeconds, ensureStateDir, acquireLock,
  inspectLock, guardFile, lockRequiresOwnership, hostLockDir,
  acquireOwnedLocks, validateOwnedLocks, releaseOwnedLocks,
};

// Shell building blocks for callers that take the lock inside their own single
// script (BRAIN-636 D3: target-state.js), so the owner protocol has one definition.
Object.assign(module.exports, { guardPrelude, ownerWriter, ownerFields });
