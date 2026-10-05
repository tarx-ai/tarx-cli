#!/bin/bash
# launchd entry for tarxd — prevents KeepAlive thrash when singleton already up.
set -euo pipefail
TARX_HOME="${TARX_HOME:-$HOME/.tarx}"
PID_FILE="$TARX_HOME/daemon.pid"
BIN="$TARX_HOME/bin/tarxd"

if [[ -f "$PID_FILE" ]]; then
  opid="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if [[ -n "${opid:-}" ]] && kill -0 "$opid" 2>/dev/null; then
    cmd=$(ps -p "$opid" -o command= 2>/dev/null || true)
    case "$cmd" in
      *'/bin/tarxd'*)
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] tarxd already running (PID $opid) — wrapper idle-wait" >> "$TARX_HOME/logs/daemon-error.log"
        while kill -0 "$opid" 2>/dev/null; do sleep 60; done
        exit 0
        ;;
    esac
  fi
  rm -f "$PID_FILE"
fi

exec "$BIN" --menu-bar
