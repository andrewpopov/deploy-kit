#!/bin/sh
# ExecStopPost hook for `deploy --on-host` (PKG-187). Records how the unit ended.
# Usage: record.sh <runDir>; reads INVOCATION_ID, SERVICE_RESULT, EXIT_CODE, EXIT_STATUS.
#
#  - started exists and holds exactly $INVOCATION_ID, no result.json -> result.json
#  - started absent, no result-unstarted.json                         -> result-unstarted.json
#  - anything else (a replayed invocation)                             -> no-op
# Existing evidence is never overwritten.

run_dir=$1
[ -n "$run_dir" ] && [ -d "$run_dir" ] || exit 0
run_id=$(basename "$run_dir")

# Strict allowlist: anything outside [A-Za-z0-9_-] (or empty) becomes "invalid".
clean() {
  case $1 in
    '' | *[!A-Za-z0-9_-]*) printf '%s' invalid ;;
    *) printf '%s' "$1" ;;
  esac
}

write_record() {
  target=$1
  tmp="$run_dir/.$(basename "$target").tmp.$$"
  printf '{"runId":"%s","invocationId":"%s","serviceResult":"%s","exitCode":"%s","exitStatus":"%s","finishedAt":%s}\n' \
    "$(clean "$run_id")" "$(clean "$INVOCATION_ID")" "$(clean "$SERVICE_RESULT")" \
    "$(clean "$EXIT_CODE")" "$(clean "$EXIT_STATUS")" "$(date +%s)" > "$tmp" || { rm -f "$tmp"; exit 0; }
  # mv would replace a file that appeared meanwhile; ln fails if the target exists.
  ln "$tmp" "$target" 2>/dev/null
  rm -f "$tmp"
}

if [ -e "$run_dir/started" ]; then
  if [ "$(cat "$run_dir/started")" = "$INVOCATION_ID" ] && [ ! -e "$run_dir/result.json" ]; then
    write_record "$run_dir/result.json"
  fi
elif [ ! -e "$run_dir/result-unstarted.json" ]; then
  write_record "$run_dir/result-unstarted.json"
fi
exit 0
