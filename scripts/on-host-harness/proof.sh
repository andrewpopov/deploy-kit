#!/usr/bin/env bash
# PKG-187 live proof: runs the "Proof" list (docs/on-host-spec.md, items a-l) against the
# disposable Docker host (harness.sh) and prints `PASS <id>: <evidence>` or `FAIL <id>: <why>`
# per scenario. Exits non-zero if any scenario FAILs. Every scenario starts from a fresh container
# (harness.sh up) with v1 deployed over ssh; the on-host run then deploys v2.
#
# Usage: scripts/on-host-harness/proof.sh [scenario-id ...]   (default: a b c d e f g h h2 i j k l m)
# Env:   KEEP=1 leaves the container up at the end (default: harness.sh down).
#        PROOF_KEEP_LOGS=<dir> copies the per-scenario logs there (default: a fresh temp dir, printed).
#
# Receipts: the operator/attach have no receipts-path option, so every operator process runs with
# HOME=<scratch>/home and writes its receipts to <scratch>/home/.deploy-kit/on-host-runs.jsonl, never
# to the real ~/.deploy-kit.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_CLI="$HERE/../../src/cli.js"
H="$HERE/harness.sh"
SCRATCH="$(mktemp -d)"
RH="$SCRATCH/home"
RECEIPTS="$RH/.deploy-kit/on-host-runs.jsonl"
APP=/srv/dkapp
mkdir -p "$RH"

FAILS=0
BG_PIDS=()
S="" # v1 sha (deployed first), T="" v2 sha (the on-host target)
T=""

pass() { echo "PASS $1: $2"; }
fail() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); }
info() { echo "INFO $1: $2" >&2; }
clean() { sed 's/\x1b\[[0-9;]*m//g' "$@"; }

cleanup() {
  for pid in "${BG_PIDS[@]:-}"; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
  if [ "${KEEP:-0}" != 1 ]; then "$H" down >/dev/null 2>&1; fi
  echo "logs: $SCRATCH" >&2
}
trap cleanup EXIT

hssh() { "$H" ssh "$@"; }
hroot() { "$H" root "$@"; }
# The oom_score_adj a fresh user-manager unit gets (no --wait/--pipe: the user manager has no dbus here).
unit_oom() {
  local n="oomprobe-$RANDOM"
  usr "systemd-run --user --quiet --unit=$n -p Type=exec -p StandardOutput=file:/tmp/$n.out -- cat /proc/self/oom_score_adj" >/dev/null 2>&1
  sleep 1.5; hssh "cat /tmp/$n.out"
}
# A dkapp shell command with the user manager reachable.
usr() { hssh "export XDG_RUNTIME_DIR=/run/user/\$(id -u); $*"; }
health() { hssh curl -sf --max-time 3 localhost:3999/health 2>/dev/null; }

# dk <variant> <cli args...>: run deploy-kit from the variant dir with the scratch HOME.
dk() { local v=$1; shift; (cd "$HERE/app-variants/$v" && HOME="$RH" node "$KIT_CLI" "$@"); }
# dk_bg <variant> <logfile> <cli args...>: sets BGPID to the node process itself (exec).
dk_bg() {
  local v=$1 logf=$2; shift 2
  (cd "$HERE/app-variants/$v" && HOME="$RH" exec node "$KIT_CLI" "$@") >"$logf" 2>&1 &
  BGPID=$!
  BG_PIDS+=("$BGPID")
}

waitfor() { # <timeout-seconds> <command...>
  local t=$1; shift
  local end=$((SECONDS + t))
  while [ $SECONDS -lt $end ]; do "$@" && return 0; sleep 1; done
  return 1
}

last_run_id() { [ -f "$RECEIPTS" ] && tail -n 1 "$RECEIPTS" | jq -r .runId; }
run_dir() { echo "$APP/.deploy-kit/runs/$1"; }
unit_of() { tail -n 1 "$RECEIPTS" | jq -r .unit; }
have_runid() { [ -n "$(last_run_id)" ]; }
remote_file() { hssh "cat $1 2>/dev/null"; }
remote_has() { hssh "test -s $1" 2>/dev/null; }
build_running() { hssh "pgrep -x sleep >/dev/null" 2>/dev/null; }

# reset: fresh container, v1 deployed over ssh, receipts emptied, S/T resolved.
reset() {
  "$H" down >/dev/null 2>&1
  "$H" up >"$SCRATCH/up.log" 2>&1 || { echo "FATAL: harness up failed, see $SCRATCH/up.log" >&2; exit 2; }
  S=$(hssh git -C /srv/upstream/dkapp.git rev-parse main~1)
  T=$(hssh git -C /srv/upstream/dkapp.git rev-parse main)
  dk base deploy --sha "$S" --no-auto-cut >"$SCRATCH/baseline-v1.log" 2>&1 || { echo "FATAL: baseline v1 deploy failed, see $SCRATCH/baseline-v1.log" >&2; exit 2; }
  [ "$(health)" = "$S" ] || { echo "FATAL: baseline health is not v1" >&2; exit 2; }
  waitfor 60 usr "systemctl --user show-environment >/dev/null 2>&1" || { echo "FATAL: dkapp user manager not reachable" >&2; exit 2; }
  mkdir -p "$RH/.deploy-kit"; : >"$RECEIPTS"
}

# Start a background on-host run and wait for its run id and for the slow hook to be running.
start_slow() { # <variant> <logfile>
  dk_bg "$1" "$2" deploy --on-host --sha "$T" --no-auto-cut
  OP=$BGPID
  waitfor 60 have_runid || return 1
  RID=$(last_run_id); RD=$(run_dir "$RID"); UNIT=$(unit_of)
  waitfor 90 build_running
}

# Wait (bounded) for the recorder's result.json.
wait_result() { waitfor "${1:-150}" remote_has "$RD/result.json"; }
wait_bg() { wait "$1" 2>/dev/null; WAITRC=$?; } # sets WAITRC; must not run in a subshell

# ------------------------------------------------------------------------------------------
sc_a() {
  reset
  start_slow slow-build "$SCRATCH/a.op.log" || { fail a "slow build never started (see $SCRATCH/a.op.log)"; return; }
  local kids; kids=$(pgrep -P "$OP" 2>/dev/null || true)
  kill -9 "$OP"; for k in $kids; do kill -9 "$k" 2>/dev/null; done
  wait "$OP" 2>/dev/null
  kill -0 "$OP" 2>/dev/null && { fail a "operator still alive after SIGKILL"; return; }
  wait_result 150 || { fail a "no result.json on host after operator was killed"; return; }
  local phase sha rc; phase=$(remote_file "$APP/.deploy-kit-state.json" | jq -r .phase); sha=$(health)
  dk slow-build attach "$RID" >"$SCRATCH/a.attach.log" 2>&1; rc=$?
  if [ "$phase" = done ] && [ "$sha" = "$T" ] && [ $rc -eq 0 ]; then
    pass a "operator SIGKILLed mid-build (pid $OP); host finished: journal phase=done, /health=${sha:0:12} (new), attach $RID exit 0"
  else fail a "phase=$phase health=${sha:0:12} (want ${T:0:12}) attach_exit=$rc (see $SCRATCH/a.attach.log)"; fi
}

sc_b() {
  reset
  dk base deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/b.op.log" 2>&1; local oprc=$?
  RID=$(last_run_id)
  dk base attach "$RID" >"$SCRATCH/b.attach.log" 2>&1; local rc=$?
  local replayed; replayed=$(clean "$SCRATCH/b.attach.log" | grep -c "Deployment completed successfully")
  if [ $oprc -eq 0 ] && [ $rc -eq 0 ] && [ "$replayed" -ge 1 ] && clean "$SCRATCH/b.attach.log" | grep -q "succeeded"; then
    pass b "operator exit 0; later attach $RID exit 0, replayed $(wc -l <"$SCRATCH/b.attach.log" | tr -d ' ') log lines incl. 'Deployment completed successfully'"
  else fail b "operator_exit=$oprc attach_exit=$rc replayed_completion_lines=$replayed (see $SCRATCH/b.attach.log)"; fi
}

sc_c() {
  reset
  dk fail-build deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/c.op.log" 2>&1; local rc=$?
  RID=$(last_run_id); RD=$(run_dir "$RID")
  local outcome ok phase sha attach_rc
  outcome=$(remote_file "$RD/outcome.json"); ok=$(echo "$outcome" | jq -r .ok 2>/dev/null)
  phase=$(remote_file "$APP/.deploy-kit-state.json" | jq -r .phase); sha=$(health)
  dk fail-build attach "$RID" >/dev/null 2>&1; attach_rc=$?
  if [ $rc -eq 1 ] && [ "$ok" = false ] && [ "$sha" = "$S" ] && [ $attach_rc -eq 1 ]; then
    pass c "failing build hook: operator exit 1, attach exit 1, outcome.json ok:false ($(echo "$outcome" | jq -r .error | cut -c1-60)), journal phase=$phase (build failed before the disruptive window), /health=${sha:0:12} (previous)"
  else fail c "exit=$rc attach=$attach_rc ok=$ok phase=$phase health=${sha:0:12} (want ${S:0:12}) (see $SCRATCH/c.op.log)"; fi
}

sc_d() {
  reset
  start_slow slow-build "$SCRATCH/d.op1.log" || { fail d "slow build never started"; return; }
  dk slow-build deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/d.op2.log" 2>&1; local rc2=$?
  dk base deploy --sha "$T" --no-auto-cut >"$SCRATCH/d.ssh.log" 2>&1; local rc3=$?
  wait_bg "$OP"; local rc1=$WAITRC
  local runs; runs=$(hssh "ls $APP/.deploy-kit/runs | wc -l" | tr -d ' ')
  local sha; sha=$(health)
  local why2 why3
  why2=$(clean "$SCRATCH/d.op2.log" | grep -o "ONHOST_ALREADY_RUNNING" | head -1)
  why3=$(clean "$SCRATCH/d.ssh.log" | grep -o "Another deploy holds the lock" | head -1)
  if [ $rc2 -ne 0 ] && [ -n "$why2" ] && [ $rc3 -ne 0 ] && [ -n "$why3" ] && [ "$rc1" = 0 ] && [ "$sha" = "$T" ] && [ "$runs" = 1 ]; then
    pass d "2nd --on-host refused ($why2, exit $rc2); ssh-mode deploy refused ('$why3', exit $rc3); first run completed (exit $rc1, /health=${sha:0:12}, 1 run dir)"
  else fail d "on-host2 exit=$rc2 '$why2'; ssh exit=$rc3 '$why3'; first exit=$rc1; health=${sha:0:12}; run dirs=$runs"; fi
}

sc_e() {
  reset
  # migrate-slow opens the disruptive window (dbBoundApps + backup + migrate), so the journal is written.
  start_slow migrate-slow "$SCRATCH/e.op.log" || { fail e "slow migrate never started"; return; }
  local pid; pid=$(usr "systemctl --user show -p MainPID --value $UNIT")
  [ -n "$pid" ] && [ "$pid" != 0 ] || { fail e "no MainPID for $UNIT"; return; }
  hssh "kill -9 $pid"
  wait_bg "$OP"; local rc=$WAITRC
  remote_has "$RD/result.json" || { fail e "no result.json after SIGKILL of host-run pid $pid"; return; }
  local result phase sr es
  result=$(remote_file "$RD/result.json"); sr=$(echo "$result" | jq -r .serviceResult); es=$(echo "$result" | jq -r .exitStatus)
  phase=$(remote_file "$APP/.deploy-kit-state.json" | jq -r .phase)
  # What the next deploy attempt says (lock first; then with --steal-lock, to reach readInterruptedDeploy).
  dk base deploy --sha "$T" --no-auto-cut >"$SCRATCH/e.next1.log" 2>&1; local n1=$?
  dk base deploy --sha "$T" --no-auto-cut --steal-lock >"$SCRATCH/e.next2.log" 2>&1; local n2=$?
  local m1 m2
  m1=$(clean "$SCRATCH/e.next1.log" | grep -m1 -E "Another deploy|MANUAL RECOVERY|rror" | cut -c1-110)
  m2=$(clean "$SCRATCH/e.next2.log" | grep -m1 -E "MANUAL RECOVERY|rror" | cut -c1-200)
  if [ "$sr/$es" = "signal/KILL" ] && [ "$rc" = 1 ] && [ "$phase" != done ] && [ $n1 -ne 0 ] && [ $n2 -ne 0 ]; then
    pass e "SIGKILL host-run pid $pid mid-migrate: result.json $sr/$es, operator exit $rc, journal phase=$phase (non-terminal); next deploy exit $n1: '$m1'; with --steal-lock exit $n2: readInterruptedDeploy says '$m2'"
  else fail e "result=$sr/$es operator_exit=$rc phase=$phase next=$n1/$n2 '$m1' | '$m2'"; fi
}

sc_f() {
  reset
  # A systemd-run wrapper earlier on dkapp's ssh PATH: the real unit is created, then the ssh call "fails".
  hroot sh -c "printf '#!/bin/sh\n/usr/bin/systemd-run \"\$@\"\nexit 255\n' > /usr/local/bin/systemd-run && chmod 755 /usr/local/bin/systemd-run"
  [ "$(hssh command -v systemd-run)" = /usr/local/bin/systemd-run ] || { fail f "wrapper is not first on dkapp's ssh PATH"; return; }
  dk slow-build deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/f.op.log" 2>&1; local rc=$?
  RID=$(last_run_id); RD=$(run_dir "$RID")
  hroot rm -f /usr/local/bin/systemd-run
  local units hint
  units=$(usr "systemctl --user list-units --all --no-legend --plain 'deploy-kit-*' | wc -l" | tr -d ' ')
  hint=$(clean "$SCRATCH/f.op.log" | grep -c "do NOT redeploy; run: deploy-kit attach $RID")
  dk slow-build attach "$RID" >"$SCRATCH/f.attach.log" 2>&1; local arc=$?
  local dirs receipts sha
  dirs=$(hssh "ls $APP/.deploy-kit/runs | wc -l" | tr -d ' '); receipts=$(wc -l <"$RECEIPTS" | tr -d ' '); sha=$(health)
  if [ $rc -eq 75 ] && [ "$hint" -ge 1 ] && [ "$units" = 1 ] && [ "$dirs" = 1 ] && [ "$receipts" = 1 ] && [ $arc -eq 0 ] && [ "$sha" = "$T" ]; then
    pass f "submit ssh exit 255 after unit creation: operator exit 75 with attach hint; attach $RID found the same run (exit $arc, /health=${sha:0:12}); units=$units run dirs=$dirs receipts=$receipts"
  else fail f "op_exit=$rc hint=$hint units=$units dirs=$dirs receipts=$receipts attach_exit=$arc health=${sha:0:12}"; fi
}

sc_g() {
  reset
  dk base deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/g.op.log" 2>&1; local oprc=$?
  RID=$(last_run_id); RD=$(run_dir "$RID")
  local before after
  before=$(hssh "cd $RD && sha256sum result.json outcome.json started")
  # Replay: same run dir, a NEW transient unit, so a fresh INVOCATION_ID, same env contract as the original.
  # (no --wait: without dbus-user-session the user manager has no bus, and --wait needs one; poll instead)
  local cmd
  cmd="export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemd-run --user --quiet --unit=dk-replay-test -p Type=exec -p KillMode=process -p StandardOutput=file:/tmp/replay.log -p StandardError=file:/tmp/replay.log -p ExecStopPost='/bin/sh $RD/kit/src/on-host/record.sh $RD' -- /usr/bin/env -i PATH=\$PATH HOME=\$HOME USER=\$USER INVOCATION_ID=\\\${INVOCATION_ID} \$(readlink -f \$(command -v node)) $RD/kit/src/cli.js host-run $RD"
  hssh "$cmd" >"$SCRATCH/g.replay.out" 2>&1
  replay_done() { [ "$(usr "systemctl --user show -p ActiveState --value dk-replay-test")" != active ]; }
  waitfor 30 replay_done
  local rrc; rrc=$(usr "systemctl --user show -p ExecMainStatus --value dk-replay-test")
  local replog; replog=$(hssh "cat /tmp/replay.log" | sed 's/\x1b\[[0-9;]*m//g')
  after=$(hssh "cd $RD && sha256sum result.json outcome.json started")
  if [ $oprc -eq 0 ] && [ $rrc -eq 1 ] && echo "$replog" | grep -q ONHOST_REPLAY && [ "$before" = "$after" ]; then
    pass g "replay of finished $RID as new unit: exit $rrc, ONHOST_REPLAY logged; result.json/outcome.json/started sha256 identical before/after ($(echo "$before" | head -1 | cut -c1-12)…)"
  else fail g "op_exit=$oprc replay_exit=$rrc log='$(echo "$replog" | head -2 | tr '\n' ' ')' identical=$([ "$before" = "$after" ] && echo yes || echo no) (see $SCRATCH/g.replay.out)"; fi
}

# h: $1 = id, $2 = norestart (pm2-dkapp stays down after the kill) | default
sc_h_run() {
  local id=$1 mode=$2
  reset
  if [ "$mode" = norestart ]; then
    hroot sh -c "mkdir -p /etc/systemd/system/pm2-dkapp.service.d && printf '[Service]\nRestart=no\n' > /etc/systemd/system/pm2-dkapp.service.d/norestart.conf && systemctl daemon-reload"
  fi
  start_slow slow-build "$SCRATCH/$id.op.log" || { fail "$id" "slow build never started"; return; }
  local pm2pid; pm2pid=$(hroot systemctl show -p MainPID --value pm2-dkapp.service)
  [ -n "$pm2pid" ] && [ "$pm2pid" != 0 ] || { fail "$id" "pm2-dkapp has no MainPID"; return; }
  hroot kill -9 "$pm2pid"
  wait_bg "$OP"; local rc=$WAITRC
  wait_result 60 >/dev/null
  local sha status warned owner_pid main_pid cg
  sha=$(health)
  status=$(hssh "PM2_HOME=$APP/.pm2 pm2 jlist 2>/dev/null" | jq -r '.[] | select(.name=="dkapp-web") | .pm2_env.status' 2>/dev/null)
  warned=$(remote_file "$RD/log" | clean /dev/stdin | grep -c PM2_DAEMON_NOT_SYSTEM_SERVICE)
  owner_pid=$(hssh "cat $APP/.pm2/pm2.pid"); main_pid=$(hroot systemctl show -p MainPID --value pm2-dkapp.service)
  cg=$(hroot sh -c "sed 's/^0:://' /proc/$owner_pid/cgroup" 2>/dev/null)
  local ustate; ustate=$(usr "systemctl --user show -p ActiveState -p SubState --value $UNIT" | tr '\n' '/')
  local verdict="deploy unit ${ustate%/}; daemon pid $owner_pid in cgroup '$cg' (pm2-dkapp.service MainPID now $main_pid -> $([ "$owner_pid" = "$main_pid" ] && echo 'system-managed daemon owns the app' || echo 'a daemon outside pm2-dkapp.service owns the app'))"
  if [ "$rc" = 0 ] && [ "$status" = online ] && [ "$sha" = "$T" ]; then
    if [ "$mode" = norestart ]; then
      if [ "$warned" -ge 1 ]; then
        pass "$id" "killed system PM2 daemon pid $pm2pid mid-build (Restart=no): unit finished (operator exit $rc), dkapp-web $status, /health=${sha:0:12}, PM2_DAEMON_NOT_SYSTEM_SERVICE warned ($warned); $verdict"
      else fail "$id" "app survived but the PM2_DAEMON_NOT_SYSTEM_SERVICE warning is missing; $verdict"; fi
    else
      pass "$id" "killed system PM2 daemon pid $pm2pid mid-build (systemd Restart=on-failure): unit finished (exit $rc), dkapp-web $status, /health=${sha:0:12}; warning lines=$warned; $verdict"
    fi
  else fail "$id" "operator_exit=$rc dkapp-web=$status health=${sha:0:12} (want ${T:0:12}) warned=$warned; $verdict"; fi
}
sc_h() { sc_h_run h norestart; }
sc_h2() { sc_h_run h2 default; }

sc_i() {
  reset
  dk_bg oom-hook "$SCRATCH/i.op.log" deploy --on-host --sha "$T" --no-auto-cut; OP=$BGPID
  waitfor 60 have_runid || { fail i "no run id"; return; }
  RID=$(last_run_id); RD=$(run_dir "$RID"); UNIT=$(unit_of)
  waitfor 60 remote_has "$RD/started" || { fail i "host-run never started"; return; }
  # Real OOM: cap the unit's cgroup. The hook sleeps 8 s first, so the cap is in force before it allocates.
  local cap; cap=$(usr "systemctl --user set-property --runtime $UNIT MemoryMax=200M MemorySwapMax=0 2>&1; echo set=\$?")
  local cgdir events="" kills=0 i
  cgdir=$(usr "systemctl --user show -p ControlGroup --value $UNIT")
  for i in $(seq 40); do
    events=$(hssh "cat /sys/fs/cgroup$cgdir/memory.events 2>/dev/null")
    kills=$(echo "$events" | awk '/^oom_kill /{print $2}'); kills=${kills:-0}
    [ "$kills" -gt 0 ] && break
    sleep 1
  done
  local mode=real
  if [ "$kills" -eq 0 ]; then
    # Fallback proxy: the memory controller is not usable here; kill -9 the hog process instead.
    mode=PROXY
    local hog; hog=$(hssh "pgrep -f '[B]uffer.alloc' | head -1")
    [ -n "$hog" ] && hssh "kill -9 $hog"
  fi
  wait_bg "$OP"; local rc=$WAITRC
  wait_result 90 >/dev/null
  local result outcome ok sr es
  result=$(remote_file "$RD/result.json"); outcome=$(remote_file "$RD/outcome.json")
  ok=$(echo "$outcome" | jq -r .ok 2>/dev/null); sr=$(echo "$result" | jq -r .serviceResult); es=$(echo "$result" | jq -r .exitStatus)
  # host-run survived iff it wrote outcome.json itself and exited normally (not a signal).
  if [ "$ok" = false ] && [ "$sr" = exit-code ]; then
    if [ "$mode" = real ] && [ "$rc" = 1 ]; then
      pass i "REAL cgroup OOM (MemoryMax=200M on the unit; memory.events oom_kill=$kills) killed the step child; host-run survived: outcome.json ok:false, result $sr/exited, operator exit $rc, /health=$(health | cut -c1-12) (previous=${S:0:12})"
    elif [ "$rc" = 1 ]; then
      pass i "PROXY (kill -9 of the hog child; memory controller not usable, oom_kill=0 cap='${cap//$'\n'/ }'): host-run survived, outcome.json ok:false, result $sr, operator exit $rc"
    else fail i "mode=$mode outcome ok=$ok result=$sr/$es operator_exit=$rc"; fi
  else fail i "mode=$mode oom_kill=$kills outcome ok=$ok result=$sr/$es operator_exit=$rc (see $SCRATCH/i.op.log)"; fi
}

sc_j() {
  reset
  dk bash-hook deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/j.op.log" 2>&1; local rc=$?
  local shell sha; shell=$(hssh "getent passwd dkapp | cut -d: -f7"); sha=$(health)
  if [ $rc -eq 0 ] && clean "$SCRATCH/j.op.log" | grep -q "bash-only-ok" && [ "$sha" = "$T" ]; then
    pass j "hook '[[ -n x ]]' ran under dkapp's login shell $shell: operator exit 0, hook output 'bash-only-ok', /health=${sha:0:12}"
  else fail j "exit=$rc shell=$shell health=${sha:0:12} (see $SCRATCH/j.op.log)"; fi
}

sc_k() {
  reset
  # ssh umask 027 via ~/.bashrc (prepended, ahead of Debian's non-interactive early return).
  hroot sh -c "sed -i '1i umask 027' $APP/.bashrc && chown dkapp:dkapp $APP/.bashrc"
  local sshumask; sshumask=$(hssh umask)
  dk umask-hook deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/k.op.log" 2>&1; local rc=$?
  local hookumask mode; hookumask=$(remote_file "$APP/umask.out"); mode=$(remote_file "$APP/umask-mode.out")
  if [ $rc -eq 0 ] && [ "$sshumask" = 0027 ] && [ "$mode" = 640 ]; then
    pass k "ssh umask $sshumask captured; hook saw umask $hookumask and its file has mode $mode (not 644)"
  else fail k "exit=$rc ssh_umask=$sshumask hook_umask=$hookumask file_mode=$mode (see $SCRATCH/k.op.log)"; fi
}

sc_l() {
  reset
  local uid; uid=$(hroot id -u dkapp)
  local before; before=$(unit_oom)
  hroot sh -c "rm -f /etc/systemd/system/user@.service.d/oom-parity.conf /etc/systemd/user.conf.d/oom-parity.conf && systemctl daemon-reload && systemctl restart user@$uid.service"
  waitfor 30 usr "systemctl --user show-environment >/dev/null 2>&1"
  local after sshadj
  after=$(unit_oom); sshadj=$(hssh cat /proc/self/oom_score_adj)
  dk base deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/l.op.log" 2>&1; local rc=$?
  RID=$(last_run_id)
  dk base attach "$RID" >"$SCRATCH/l.attach.log" 2>&1; local arc=$?
  local named sha; named=$(clean "$SCRATCH/l.op.log" | grep -c ONHOST_OOM_SCORE); sha=$(health)
  # Restore the parity drop-ins and prove the restore took effect.
  hroot sh -c "printf '[Service]\nOOMScoreAdjust=0\n' > /etc/systemd/system/user@.service.d/oom-parity.conf && printf '[Manager]\nDefaultOOMScoreAdjust=0\n' > /etc/systemd/user.conf.d/oom-parity.conf && systemctl daemon-reload && systemctl restart user@$uid.service"
  waitfor 30 usr "systemctl --user show-environment >/dev/null 2>&1"
  local restored; restored=$(unit_oom)
  if [ $rc -eq 1 ] && [ $arc -eq 1 ] && [ "$named" -ge 1 ] && [ "$sha" = "$S" ] && [ "$restored" = "$sshadj" ]; then
    pass l "drop-ins removed (unit oom_score_adj $before -> $after vs ssh $sshadj): ONHOST_OOM_SCORE refusal, operator exit $rc, attach exit $arc, /health still ${sha:0:12} (previous); drop-ins restored (unit adj back to $restored)"
  else fail l "unit_adj before=$before after=$after ssh=$sshadj op_exit=$rc attach_exit=$arc named=$named health=${sha:0:12} restored=$restored (see $SCRATCH/l.op.log)"; fi
}

sc_m() {
  reset
  # Values with %, $, ${}, quotes, and (DK_NL) a newline plus a forged protocol line, exported from the
  # ssh environment (~/.bashrc, prepended ahead of Debian's non-interactive early return). DK_EMPTY is present but empty.
  hroot sh -c "printf '%s' 'a%40b\$c\${d}%n '\\''q'\\'' \"dq\"' > $APP/probe.val && chown dkapp:dkapp $APP/probe.val"
  hssh "cat > $APP/rc.add" <<'RC'
export DK_PROBE="$(cat /srv/dkapp/probe.val)"
export DK_NL=$'x\nENV_PM2_HOME=/tmp/x'
export DK_EMPTY=
RC
  hssh "cat $APP/rc.add $APP/.bashrc > $APP/.bashrc.new && mv $APP/.bashrc.new $APP/.bashrc"
  local want got empty
  want=$(hssh "cat $APP/probe.val"); [ "$(hssh 'printf %s "$DK_PROBE"')" = "$want" ] || { fail m "ssh env does not hold the probe value"; return; }
  # (1) A forwarded value holding a newline (+ a forged KEY=VALUE line) is refused by name; nothing is submitted.
  dk env-nl deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/m.nl.log" 2>&1; local nlrc=$?
  local nlnamed; nlnamed=$(clean "$SCRATCH/m.nl.log" | grep -c 'ENV_DK_NL holds control characters')
  # (2) Every other hostile byte arrives in the hook unchanged; a present-but-empty value is still present.
  dk env-hook deploy --on-host --sha "$T" --no-auto-cut >"$SCRATCH/m.op.log" 2>&1; local rc=$?
  got=$(hssh "cat $APP/env-probe.out; echo x"); got=${got%x}; empty=$(hssh "cat $APP/env-empty.out 2>/dev/null")
  if [ $nlrc -eq 1 ] && [ "$nlnamed" -ge 1 ] && [ $rc -eq 0 ] && [ "$got" = "$want" ] && [ "$empty" = set ]; then
    pass m "hook saw byte-identical value ${#got} bytes [$got] (hex $(printf %s "$got" | od -An -tx1 | tr -d ' \n')); empty value present; newline+forged-key value refused by name, exit $nlrc"
  else fail m "nl_exit=$nlrc nl_named=$nlnamed exit=$rc probe=[$got] want=[$want] empty=[$empty] (see $SCRATCH/m.op.log)"; fi
}

ALL="a b c d e f g h h2 i j k l m"
for id in ${*:-$ALL}; do
  "sc_$id" || fail "$id" "scenario function crashed"
done

echo "---"
if [ "$FAILS" -eq 0 ]; then echo "proof: all scenarios PASS"; else echo "proof: $FAILS scenario(s) FAILED"; fi
[ -n "${PROOF_KEEP_LOGS:-}" ] && mkdir -p "$PROOF_KEEP_LOGS" && cp -R "$SCRATCH/." "$PROOF_KEEP_LOGS/"
[ "$FAILS" -eq 0 ]
