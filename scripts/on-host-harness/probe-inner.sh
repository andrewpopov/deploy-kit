#!/bin/bash
# Runs as dkapp inside the container (piped by `harness.sh probe`). Checks 1-4 of the on-host
# design's container requirements; prints PASS/FAIL per check.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
D=/tmp/dk-probe; rm -rf $D; mkdir -p $D
fail=0
systemctl --user stop dk-pm2-test.scope 2>/dev/null
ok()  { echo "PASS $1: $2"; }
bad() { echo "FAIL $1: $2"; fail=1; }
waitfor() { for _ in $(seq ${2:-50}); do eval "$1" && return 0; sleep 0.2; done; return 1; }
echo "kernel: $(uname -r)"

# --- check 1: logind + linger + user manager
linger=$(loginctl show-user dkapp -p Linger --value 2>/dev/null)
if [ "$linger" = yes ] && systemctl --user show-environment >/dev/null 2>&1 \
   && [ "$(systemctl is-active systemd-logind)" = active ]; then
  ok 1 "logind active, Linger=$linger, systemctl --user works (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR)"
else bad 1 "Linger='$linger' logind=$(systemctl is-active systemd-logind)"; fi

# --- check 2: Delegate=yes + child cgroup + cgroup.kill reaps TERM-ignorer and setsid escapee
cat > $D/cg.sh <<'EOF'
#!/bin/bash
cg=/sys/fs/cgroup$(sed 's/^0:://' /proc/self/cgroup)
mkdir "$cg/step1" || { echo "mkdir-failed"; exit 1; }
# the "step": shell enters step1, leaves a TERM-ignoring grandchild (parent exits) and a setsid escapee
sh -c "echo \$\$ > $cg/step1/cgroup.procs; (trap '' TERM; exec sleep 311) & setsid sh -c \"trap '' TERM HUP; exec sleep 312\" & sleep 0.3; exit 0"
sleep 0.5
n=$(wc -l < "$cg/step1/cgroup.procs")
pop_before=$(awk '/populated/{print $2}' "$cg/step1/cgroup.events")
echo 1 > "$cg/step1/cgroup.kill"
for _ in $(seq 50); do [ "$(awk '/populated/{print $2}' "$cg/step1/cgroup.events")" = 0 ] && break; sleep 0.1; done
echo "cg=$cg members_before_kill=$n populated_before=$pop_before populated_after=$(awk '/populated/{print $2}' "$cg/step1/cgroup.events")"
echo "leftover_sleeps=$(pgrep -u dkapp -f 'sleep 31[12]' | wc -l)"
rmdir "$cg/step1"
EOF
chmod +x $D/cg.sh
systemd-run --user --quiet --collect --unit=dk-probe-cg -p Delegate=yes -p Type=exec \
  -p StandardOutput=file:$D/cg.out -p StandardError=file:$D/cg.out -- $D/cg.sh
waitfor '[ "$(systemctl --user is-active dk-probe-cg.service)" != active ] && grep -q leftover $D/cg.out' 100
out=$(cat $D/cg.out); echo "$out" | sed 's/^/  /'
if echo "$out" | grep -q 'members_before_kill=2' && echo "$out" | grep -q 'populated_before=1 populated_after=0' \
   && echo "$out" | grep -q 'leftover_sleeps=0'; then
  ok 2 "child cgroup under unit cgroup, TERM-ignorer + setsid escapee killed by cgroup.kill, populated 0"
else bad 2 "see output above"; fi

# --- check 3: systemd-run --scope from inside a unit lands outside it and survives its stop
cat > $D/scope.sh <<'EOF'
#!/bin/bash
systemd-run --user --scope --quiet --collect --unit=dk-pm2-test -- sleep 300 &
echo "unitcg=$(sed 's/^0:://' /proc/self/cgroup)" > /tmp/dk-probe/scope.out
sleep 600
EOF
chmod +x $D/scope.sh
systemd-run --user --quiet --collect --unit=dk-probe-scope -p Type=exec -- $D/scope.sh
waitfor 'systemctl --user is-active dk-pm2-test.scope >/dev/null 2>&1' 50
unitcg=$(systemctl --user show dk-probe-scope.service -p ControlGroup --value)
scopecg=$(systemctl --user show dk-pm2-test.scope -p ControlGroup --value)
spid=$(pgrep -u dkapp -f 'sleep 300' | head -1)
systemctl --user stop dk-probe-scope.service; sleep 1
alive=no; kill -0 "$spid" 2>/dev/null && alive=yes
scope_state=$(systemctl --user is-active dk-pm2-test.scope)
echo "  unit cgroup:  $unitcg"; echo "  scope cgroup: $scopecg"; echo "  after stop: scope=$scope_state sleep_pid=$spid alive=$alive"
case "$scopecg" in "$unitcg"*|"") bad 3 "scope is inside the unit cgroup (or missing)";;
  *) if [ "$alive" = yes ] && [ "$scope_state" = active ]; then ok 3 "scope outside unit cgroup, survived unit stop"; else bad 3 "scope did not survive"; fi;; esac
systemctl --user stop dk-pm2-test.scope 2>/dev/null

# --- check 4: ExecStopPost sees SERVICE_RESULT / EXIT_CODE / EXIT_STATUS
cat > $D/rec.sh <<'EOF'
#!/bin/sh
echo "$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS" > "$1"
EOF
rec() { # name expected -- cmd...
  local n=$1 want=$2; shift 2
  rm -f $D/r.$n
  systemd-run --user --quiet --collect --unit=dk-probe-$n -p Type=exec -p ExecStopPost="/bin/sh $D/rec.sh $D/r.$n" "$@"
}
rec exit0 x /bin/sh -c 'sleep 0.3; exit 0'
rec exit3 x /bin/sh -c 'sleep 0.3; exit 3'
printf '#!/bin/sh\nsleep 0.3\nkill -9 $$\n' > $D/k9.sh; chmod +x $D/k9.sh
rec kill9 x $D/k9.sh
rec stop  x /bin/sleep 300
sleep 0.5; systemctl --user stop dk-probe-stop.service
r4=1
for c in "exit0:success exited 0" "exit3:exit-code exited 3" "kill9:signal killed KILL" "stop:success killed TERM"; do
  n=${c%%:*}; want=${c#*:}
  waitfor "[ -s $D/r.$n ]" 50; got=$(cat $D/r.$n 2>/dev/null)
  if [ "$got" = "$want" ]; then echo "  $n: '$got'"; else echo "  $n: got '$got' want '$want'"; r4=0; fi
done
[ $r4 = 1 ] && ok 4 "ExecStopPost values correct for exit 0, exit 3, SIGKILL, systemctl stop" || bad 4 "see values above"
exit $fail
