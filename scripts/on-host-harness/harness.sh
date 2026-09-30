#!/usr/bin/env bash
# Disposable bigpi-like host (Debian 12, systemd PID 1, node 24, system-level PM2 as dkapp).
# Usage: harness.sh up|ssh <cmd>|root <cmd>|probe|down|status
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HERE/.state"
NAME=dk-onhost-host
IMAGE=dk-onhost-image
PORT=2299
SSH=(ssh -F "$STATE/ssh_config" dkapp-harness)

up() {
  mkdir -p "$STATE"
  [ -f "$STATE/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C dk-onhost -f "$STATE/id_ed25519"
  sed "s#@STATE@#$STATE#g" "$HERE/ssh_config" > "$STATE/ssh_config"
  docker build -q -t "$IMAGE" "$HERE" >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --privileged --cgroupns=host \
    --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -p "127.0.0.1:$PORT:22" "$IMAGE" >/dev/null
  for _ in $(seq 60); do
    state=$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)
    [ "$state" = running ] || [ "$state" = degraded ] && break
    sleep 1
  done
  docker exec -i "$NAME" sh -c "install -m 600 -o dkapp -g dkapp /dev/stdin /srv/dkapp/.ssh/authorized_keys" < "$STATE/id_ed25519.pub"
  for _ in $(seq 30); do
    [ "$(docker exec "$NAME" systemctl is-active pm2-dkapp 2>/dev/null || true)" = active ] && break
    sleep 1
  done
  rm -f "$STATE/known_hosts"
  for _ in $(seq 30); do "${SSH[@]}" true 2>/dev/null && break; sleep 1; done
  status
}

status() {
  docker ps -a --filter "name=^$NAME$" --format '{{.Names}} {{.Status}}'
  docker exec "$NAME" sh -c 'echo "systemd: $(systemctl is-system-running)"; echo "pm2-dkapp: $(systemctl is-active pm2-dkapp)"; node -v'
}

case "${1:-}" in
  up) up ;;
  ssh) shift; "${SSH[@]}" "$@" ;;
  root) shift; docker exec "$NAME" "$@" ;;
  status) status ;;
  probe) "${SSH[@]}" bash -s < "$HERE/probe-inner.sh" ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|ssh <cmd>|root <cmd>|probe|status|down" >&2; exit 2 ;;
esac
