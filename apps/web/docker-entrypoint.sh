#!/bin/sh
# Starts the relay as the unprivileged `bun` user. A Railway volume mounts at
# /data owned by root, so when started as root this hands the data dir to
# `bun` first, then drops privileges; started as any other user it just runs.
set -eu
data="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data"
  # -h: change a symlink itself, never what it points at, so a link planted in
  # the volume cannot hand a system file to `bun`.
  find "$data" ! -user bun -exec chown -h bun:bun {} +
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
fi
exec "$@"
