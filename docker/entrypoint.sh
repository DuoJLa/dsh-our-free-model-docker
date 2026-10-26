#!/bin/sh
set -eu

DATA="${OFM_HOME:-/data}"
PORT="${OFM_PORT:-18900}"

# The service writes only under OFM_HOME. HOME lives there too, so workbench /
# client config writes stay inside the volume rather than the read-only root.
mkdir -p "$DATA/home"

# service.lock is only reclaimed when process.kill(pid, 0) returns ESRCH. In a
# container a new process can reuse the old PID (especially PID 1), which would
# make the service refuse to start forever. Only clear the lock when this data
# directory's own health endpoint is not answering; the single-writer volume is
# the invariant behind this cleanup.
if [ "${OFM_CLEAR_STALE_LOCK:-1}" = "1" ] && [ -f "$DATA/service.lock" ]; then
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[ofm] health endpoint already answers; keeping service.lock" >&2
  else
    echo "[ofm] removing stale service.lock (health probe failed)" >&2
    rm -f "$DATA/service.lock"
  fi
fi

exec "$@"
