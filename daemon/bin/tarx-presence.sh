#!/bin/sh
# TARX Always On — Presence service (daemon layer, one state / many skins).
#
# Grounded in TARX_ALWAYS_ON_PRODUCT_LAW.md §5.1 (Presence), §9 (one Operating
# State, many skins), §16 (do-not-do), §17 (canonical copy).
#
# Presence is TARX's on-switch and vital signs. It is NOT a chat. This script
# only SENSES and reports; it never speaks, never invents urgency, never fills
# an empty state. Mode is user-set and persisted — default Asleep until the
# human explicitly arms (§9: explicit arming, no auto-speak on first launch).
#
# Usage:
#   tarx-presence.sh get          # compute + persist snapshot, print JSON
#   tarx-presence.sh set-mode M   # M = armed | asleep | dnd  (user intent only)
#
# Snapshot: ~/.tarx/always-on/presence.json  (read by CLI and, later, web via Bridge)

set -eu

AO_DIR="$HOME/.tarx/always-on"
SNAP="$AO_DIR/presence.json"
MODE_FILE="$AO_DIR/mode"            # persisted user intent (armed|asleep|dnd)
SCHEMA="tarx.always_on.presence.v1"

# Door + local ports (display/health only; set by their own launchd jobs).
GATEWAY_PORT=11450
MODEL_PORT=11448                    # resident model (Qwen3-8B). NOT 11445 (old base GGUF).
LEGACY_MODEL_PORT=11445            # must NOT be listening; its presence is a stress gate.
BRIDGE_PORT=11440
MIND_PORT=11435
COGNITIVE_PORT=11438
EVE_PORT=3000                      # Eve connectors; health at /eve/v1/health

mkdir -p "$AO_DIR"

_probe() { curl -sf --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1; }

# Eve exposes health at a non-standard path.
_probe_eve() { curl -sf --max-time 2 "http://127.0.0.1:$EVE_PORT/eve/v1/health" >/dev/null 2>&1; }

# True when something is LISTENING on the port (not a health check).
# Used for the 11445 stress gate: the old base GGUF must NOT be up.
_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

_read_mode() {
  if [ -r "$MODE_FILE" ]; then
    _m=$(tr -d ' \r\n' < "$MODE_FILE")
    case "$_m" in armed|asleep|dnd) printf '%s' "$_m"; return;; esac
  fi
  printf 'asleep'    # §9/§16: default Asleep. Never auto-arm.
}

cmd_set_mode() {
  case "${1:-}" in
    armed|asleep|dnd) printf '%s\n' "$1" > "$MODE_FILE" ;;
    *) echo "mode must be: armed | asleep | dnd" >&2; exit 2 ;;
  esac
}

cmd_get() {
  mode=$(_read_mode)

  # Runtime truth (§5.1): Computer up / degraded / offline. Honest, not theater.
  gw=offline; _probe "$GATEWAY_PORT" && gw=up
  md=offline; _probe "$MODEL_PORT"   && md=up
  br=offline; _probe "$BRIDGE_PORT"  && br=up
  mn=offline; _probe "$MIND_PORT"    && mn=up
  cg=offline; _probe "$COGNITIVE_PORT" && cg=up

  # Runtime rollup: up if Supercomputer door (gateway+model) healthy;
  # degraded if some local services up but door down; offline if nothing.
  runtime=offline
  if [ "$gw" = up ] && [ "$md" = up ]; then runtime=up
  elif [ "$br" = up ] || [ "$mn" = up ] || [ "$cg" = up ] || [ "$gw" = up ]; then runtime=degraded
  fi

  # Phase-1 watchers (§7, §12). A watcher is "live" only when its backing
  # service is actually running — never claim a sense we don't have.
  w_health=$([ "$br" = up ] && echo live || echo off)
  keepwarm=off
  launchctl list 2>/dev/null | grep -q "com.tarx.founder-brain-qwen-keepwarm" && keepwarm=live
  w_consolidation=$keepwarm   # keep-warm is the only live local-loop job today

  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # active_local_work: honest list of what the quiet loop is doing right now.
  work="[]"
  [ "$keepwarm" = live ] && work='["keep-warm model"]'

  # Standing stress (§5.1 honest reds). Each gate is a current, re-sensed fact —
  # never a hardcoded eternal red. Order: model, gateway, legacy port, Eve.
  _stress_items=""
  _add_stress() { _stress_items="${_stress_items:+$_stress_items,}\"$1\""; }
  [ "$md" = up ] || _add_stress "model:11448 health failing"
  [ "$gw" = up ] || _add_stress "gateway:11450 health failing"
  _listening "$LEGACY_MODEL_PORT" && _add_stress "legacy model:11445 is listening"
  _probe_eve || _add_stress "eve:3000 /eve/v1/health down"
  stress="[$_stress_items]"

  cat > "$SNAP" <<JSON
{
  "schema": "$SCHEMA",
  "mode": "$mode",
  "runtime": "$runtime",
  "services": { "gateway": "$gw", "model": "$md", "bridge": "$br", "mind": "$mn", "cognitive": "$cg" },
  "watchers": { "runtime_health": "$w_health", "memory_consolidation": "$w_consolidation" },
  "active_local_work": $work,
  "stress": $stress,
  "last_reassessment": "$now"
}
JSON

  cat "$SNAP"
}

case "${1:-get}" in
  get)      cmd_get ;;
  set-mode) shift 2>/dev/null || true; cmd_set_mode "${1:-}" ;;
  *) echo "usage: tarx-presence.sh [get | set-mode armed|asleep|dnd]" >&2; exit 2 ;;
esac
