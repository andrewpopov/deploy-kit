'use strict';

const { runScriptOnTarget, shQuote } = require('./exec');
const { lockLocation } = require('./lock');

// `deploy-kit lock break`: remove a held lock only after proving its owner is gone.
// Everything runs as ONE shell script on the target, under the lock's permanent guard
// flock, so no other acquirer, releaser or breaker can change the lock directory
// between the proof and the rename. The expected nonce is re-read under the guard and
// a mismatch refuses before anything is renamed; only the proven owner is moved aside
// (to a unique archive name) and there is no move-back step.
//
// Exit codes of the script: 0 broken, 3 refused (reason printed), anything else is a
// failure to run (2 = no flock / guard unusable / evidence write failed).
//
// Test-only environment (read by the script on the target, never set in production;
// they exist so tests can aim the proofs at a fake /proc, cgroup tree and boot id):
//   DEPLOY_KIT_TEST_PROC_ROOT      replaces /proc
//   DEPLOY_KIT_TEST_CGROUP_ROOT    replaces /sys/fs/cgroup
//   DEPLOY_KIT_TEST_BOOT_ID_FILE   replaces /proc/sys/kernel/random/boot_id
//   DEPLOY_KIT_TEST_BREAK_HOLD     path prefix; after the unguarded first look the script
//                                  creates <prefix>.reached and waits for <prefix>.go

const NONCE_RE = /^[A-Za-z0-9_.-]+$/;
const REFUSED_EXIT = 3;

const SCRIPT_HELPERS = `
PROC=\${DEPLOY_KIT_TEST_PROC_ROOT:-/proc}
CGROOT=\${DEPLOY_KIT_TEST_CGROUP_ROOT:-/sys/fs/cgroup}
BOOTF=\${DEPLOY_KIT_TEST_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
refuse() { echo "refused: $*"; exit ${REFUSED_EXIT}; }
# Value of a key in the flat one-line owner/result JSON (the empty string for null or absent).
jget() { tr '{},' '\\n\\n\\n' < "$1" | sed -n "s/^\\"$2\\":\\"\\{0,1\\}\\([^\\"]*\\)\\"\\{0,1\\}\\$/\\1/p" | head -1 | sed 's/^null$//'; }
# Field N (as numbered by proc(5), N >= 3) of a /proc/<pid>/stat file.
statfield() { sed 's/^.*) //' "$1" | cut -d' ' -f$(($2 - 2)); }
`;

function buildBreakScript(config, { nonce, reason, host = false, legacyOwnerGone = false, suffix }) {
  if (!NONCE_RE.test(nonce || '')) throw new Error('deploy-kit: --nonce must match [A-Za-z0-9_.-]+');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('deploy-kit: lock break needs a non-empty --reason');
  if (host && !config.hostLock) throw new Error('deploy-kit: --host needs a hostLock in the config');
  const { dir, guard } = lockLocation(config, { suffix, scope: host ? 'host' : undefined });
  const dirQ = `"${dir}"`;
  return `
DIR=${dirQ}
GUARD="${guard}"
NONCE=${shQuote(nonce)}
REASONJSON=${shQuote(JSON.stringify(reason))}
LEGACY_GONE=${legacyOwnerGone ? 1 : 0}
${SCRIPT_HELPERS}
command -v flock >/dev/null 2>&1 || { echo "deploy-kit: flock(1) is required to break a lock" >&2; exit 2; }

# First look, before the guard: cheap early refusal only. Nothing below trusts it.
[ -d "$DIR" ] || refuse "no lock at $DIR"
if [ -n "$DEPLOY_KIT_TEST_BREAK_HOLD" ]; then
  : > "$DEPLOY_KIT_TEST_BREAK_HOLD.reached"
  while [ ! -e "$DEPLOY_KIT_TEST_BREAK_HOLD.go" ]; do sleep 0.05; done
fi

( umask 077; : >> "$GUARD" ) 2>/dev/null || exit 2
exec 9>> "$GUARD" || exit 2
flock -x 9 || exit 2

# From here the guard is held: acquire, release and break of this lock are all excluded.
[ -d "$DIR" ] || refuse "lock at $DIR is gone"
OWNER="$DIR/owner"
[ -r "$OWNER" ] || refuse "owner record $OWNER is missing or unreadable"
cur=$(jget "$OWNER" nonce)
[ "$cur" = "$NONCE" ] || refuse "lock owner nonce is '$cur', not '$NONCE' (it changed hands since you looked)"

kind=$(jget "$OWNER" kind); ouid=$(jget "$OWNER" uid); obt=$(jget "$OWNER" bootId)
case "$ouid" in ""|*[!0-9]*) refuse "owner record has no numeric uid" ;; esac
[ "$(id -u)" = "$ouid" ] || refuse "running as uid $(id -u), the lock owner is uid $ouid"
curboot=$({ tr -cd 'a-f0-9-' < "$BOOTF"; } 2>/dev/null) || curboot=""
[ -n "$curboot" ] || refuse "cannot read the current boot id ($BOOTF)"

proof=""
note() { proof="$proof$* ; "; }

if [ -n "$obt" ] && [ "$obt" != "$curboot" ]; then
  note "boot differs: owner boot $obt, now $curboot"
else
  case "$kind" in
    unit)
      unit=$(jget "$OWNER" unit); inv=$(jget "$OWNER" invocationId); runid=$(jget "$OWNER" runId)
      case "$unit" in ""|*[!A-Za-z0-9_.@:-]*|-*) refuse "owner record has no usable unit name" ;; esac
      case "$inv" in ""|*[!a-f0-9]*) refuse "owner record has no usable invocation id" ;; esac
      show=$(systemctl --user show "$unit" -p LoadState,ActiveState,SubState,InvocationID,Job 2>/dev/null) \\
        || refuse "systemctl --user show $unit failed"
      sv() { printf '%s\\n' "$show" | sed -n "s/^$1=//p" | head -1; }
      load=$(sv LoadState); active=$(sv ActiveState); sub=$(sv SubState); sinv=$(sv InvocationID); job=$(sv Job)
      [ -z "$job" ] || refuse "unit $unit has a pending job ($job)"
      resultmatch=no
      case "$runid" in ""|*[!A-Za-z0-9_-]*) runok=no ;; *) runok=yes ;; esac
      if [ "$runok" = yes ]; then
        for rf in result.json result-unstarted.json; do
          f="$HOME/.deploy-kit/runs/$runid/$rf"
          if [ -e "$f" ]; then
            [ -r "$f" ] || refuse "run result $f is unreadable"
            [ "$(jget "$f" invocationId)" = "$inv" ] && resultmatch=yes
          fi
        done
      fi
      if [ "$load" = "not-found" ]; then
        [ "$resultmatch" = yes ] || refuse "unit $unit is not loaded and the run has no result for invocation $inv"
        note "unit $unit unloaded, run result carries invocation $inv"
      else
        [ "$load" = "loaded" ] || refuse "unit $unit LoadState is '$load'"
        [ "$sinv" = "$inv" ] || refuse "unit $unit InvocationID is '$sinv', the owner's is '$inv'"
        case "$active" in inactive|failed) ;; *) refuse "unit $unit ActiveState is '$active'" ;; esac
        note "unit $unit invocation $inv $active/$sub, no job"
      fi
      base="$CGROOT/user.slice/user-$ouid.slice/user@$ouid.service"
      found=""
      if [ -d "$base" ]; then
        found=$(find "$base" -type d -name "$unit" 2>/dev/null) || refuse "cannot search $base for the unit cgroup"
      fi
      if [ -n "$found" ]; then
        for cg in $found; do
          [ -r "$cg/cgroup.events" ] || refuse "$cg/cgroup.events is unreadable"
          grep -q '^populated 0$' "$cg/cgroup.events" || refuse "cgroup $cg is still populated"
          note "cgroup $cg populated 0"
        done
      else
        [ "$resultmatch" = yes ] || refuse "no cgroup for $unit and no run result for invocation $inv"
        note "cgroup gone, run result carries invocation $inv"
      fi
      ;;
    session)
      pid=$(jget "$OWNER" pid); pstart=$(jget "$OWNER" pstart); sid=$(jget "$OWNER" sid)
      for n in "$pid" "$pstart" "$sid"; do
        case "$n" in ""|*[!0-9]*) refuse "owner record lacks a numeric pid, pstart and sid" ;; esac
      done
      [ -d "$PROC" ] || refuse "$PROC is not readable"
      if [ -e "$PROC/$pid/stat" ]; then
        st=$(statfield "$PROC/$pid/stat" 22) || refuse "$PROC/$pid/stat is unreadable"
        [ -n "$st" ] || refuse "$PROC/$pid/stat is unreadable"
        [ "$st" != "$pstart" ] || refuse "owner pid $pid is still running (start time $pstart)"
        note "pid $pid reused (start $st, owner $pstart)"
      else
        note "pid $pid gone"
      fi
      for f in "$PROC"/[0-9]*/stat; do
        [ -e "$f" ] || continue
        s=$(statfield "$f" 6 2>/dev/null)
        if [ -z "$s" ]; then [ -e "$f" ] && refuse "$f is unreadable"; continue; fi
        [ "$s" != "$sid" ] || refuse "process $f is still in session $sid"
      done
      note "no process in session $sid"
      ;;
    legacy)
      [ "$LEGACY_GONE" = 1 ] || refuse "legacy owner has no recorded identity to check; pass --legacy-owner-gone once you have verified it is gone"
      note "legacy owner asserted gone by the operator"
      ;;
    *) refuse "owner record kind '$kind' is not one of unit, session, legacy" ;;
  esac
fi

ts=$(date +%s)
archive="$DIR.broken.$NONCE.$ts"
[ ! -e "$archive" ] || archive="$archive.$$"
owner_json=$(cat "$OWNER")
mv "$DIR" "$archive" || { echo "deploy-kit: could not move $DIR aside" >&2; exit 2; }
evid="$HOME/.deploy-kit/lock-breaks"
mkdir -m 700 -p "$evid" 2>/dev/null
safe_proof=$(printf '%s' "$proof" | tr -cd 'A-Za-z0-9_.:=;/@, -')
{ printf '{"lockPath":"%s","owner":%s,"proof":"%s","reason":%s,"by":%s,"at":%s,"archive":"%s"}\\n' \\
  "$DIR" "$owner_json" "$safe_proof" "$REASONJSON" "$(id -u)" "$ts" "$archive"; } > "$evid/$ts-$NONCE.json.tmp" \\
  && mv "$evid/$ts-$NONCE.json.tmp" "$evid/$ts-$NONCE.json" \\
  || { echo "deploy-kit: lock moved to $archive but the break evidence could not be written to $evid" >&2; exit 2; }
echo "proof: $safe_proof"
echo "broken: $DIR -> $archive"
echo "evidence: $evid/$ts-$NONCE.json"
exit 0
`;
}

// Returns { broken, output }. `broken: false` is a refusal and `output` says why;
// a failure to run the script at all throws.
function breakLock(config, ctx, options) {
  const res = runScriptOnTarget(buildBreakScript(config, options), config, { capture: true, runtime: ctx.runtime });
  const output = (res.output || '').trim();
  if (res.ok) return { broken: true, output };
  if (res.error && res.error.status === REFUSED_EXIT) return { broken: false, output };
  const detail = res.stderr || (res.error && res.error.message) || 'unknown error';
  throw new Error(`deploy-kit: could not run lock break on the target: ${detail.trim()}`);
}

module.exports = { breakLock, buildBreakScript, REFUSED_EXIT };
