#!/bin/bash
# TARX Self-Healing Health Check
# Runs every 60s via launchd. Checks Mind (:11435), Cognitive (:11438), Bridge (:11440).
# If a service is down, restarts the responsible launchd agent.
# Does NOT touch the Supercomputer broker — it is intentionally is_ready:false.

set -euo pipefail

LOG="$HOME/.tarx/logs/self-heal.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
  echo "[$TIMESTAMP] $*" >> "$LOG"
}

check_port() {
  curl -sf --max-time 3 "http://localhost:$1/health" > /dev/null 2>&1
}

restart_agent() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  log "RESTART: $label"
  launchctl unload "$plist" 2>/dev/null || true
  sleep 1
  launchctl load "$plist" 2>/dev/null || true
  log "RESTARTED: $label"
}

# ── Bridge :11440 ────────────────────────────────────────────────────────────
if check_port 11440; then
  log "OK: Bridge :11440"
else
  log "DOWN: Bridge :11440 — restarting com.tarx.bridge"
  restart_agent "com.tarx.bridge"
  sleep 5
fi

# ── Cognitive :11438 ─────────────────────────────────────────────────────────
# Cognitive runs inside the bridge process. If bridge is up but cognitive is
# down, the bridge needs a reload (TARX_BRIDGE_ENABLE_AGENTS may have been
# toggled off). We give it 3s after bridge check before declaring it dead.
if check_port 11438; then
  log "OK: Cognitive :11438"
else
  log "DOWN: Cognitive :11438 — restarting com.tarx.bridge"
  restart_agent "com.tarx.bridge"
  sleep 5
fi

# ── Mind :11435 (prime model compat proxy → Nemotron :11443) ─────────────────
if check_port 11435; then
  log "OK: Mind :11435"
else
  log "DOWN: Mind :11435 — restarting com.tarx.prime-model-compat-proxy"
  restart_agent "com.tarx.prime-model-compat-proxy"
  # Also check if the underlying llama-server (:11443) needs restart
  sleep 3
  if ! check_port 11435; then
    log "STILL DOWN: Mind :11435 — also restarting com.tarx.inference-chat (:11443)"
    restart_agent "com.tarx.inference-chat"
  fi
fi

# ── Gateway :11450 (OpenAI-compat broker front → compute.tarx.com origin) ────
if check_port 11450; then
  log "OK: Gateway :11450"
else
  log "DOWN: Gateway :11450 — restarting com.tarx.supercomputer.gateway"
  restart_agent "com.tarx.supercomputer.gateway"
  sleep 5
fi

# ── compute.tarx.com public ingress (ngrok → :11450) ─────────────────────────
# launchd KeepAlive restarts ngrok only on process death. This catches the case
# where ngrok is alive but the public URL fails (stale tunnel / 5xx). Only act
# if the local gateway is healthy, so we don't thrash during a gateway outage.
if check_port 11450; then
  if curl -sf --max-time 8 "https://compute.tarx.com/health" > /dev/null 2>&1; then
    log "OK: compute.tarx.com public ingress"
  else
    log "DOWN: compute.tarx.com public — gateway up, restarting com.tarx.supercomputer.compute-ngrok"
    restart_agent "com.tarx.supercomputer.compute-ngrok"
    sleep 5
  fi
fi

log "Health check complete."
