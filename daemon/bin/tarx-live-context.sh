#!/bin/sh
# TARX live context — assembles CURRENT reality for a session so TARX engages
# from what is true NOW, not a frozen prompt. Printed as a plain-text block that
# is appended to the system prompt at session start.
#
# Honest only: real probes, real files, real recent work. No fabrication.

set -u
AO="$HOME/.tarx/always-on"
OPS="/Users/master/Desktop/TARX/Repos - active/tarx-ops/agent-workstream"

_probe() { curl -sf --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1 && echo up || echo down; }

printf 'LIVE STATE (as of %s) — reason from THIS, not from assumptions:\n' "$(date '+%Y-%m-%d %H:%M %Z')"

# Presence snapshot (real)
if [ -r "$AO/presence.json" ]; then
  python3 - "$AO/presence.json" <<'PY' 2>/dev/null
import json,sys
d=json.load(open(sys.argv[1]))
print(f"- Presence: mode={d['mode']} runtime={d['runtime']} watchers={d['watchers']} work={d['active_local_work']}")
PY
fi

# Services right now (real probes)
printf -- '- Services: gateway:11450=%s model:11445=%s bridge:11440=%s mind:11435=%s\n' \
  "$(_probe 11450)" "$(_probe 11445)" "$(_probe 11440)" "$(_probe 11435)"

# Public door
_pub=$(curl -sf --max-time 5 https://compute.tarx.com/health >/dev/null 2>&1 && echo live || echo down)
printf -- '- Public door compute.tarx.com: %s\n' "$_pub"

# What is already DONE (so TARX does not re-propose shipped work)
printf -- '- Already shipped (do NOT re-propose as new): compute.tarx.com door live+durable (launchd KeepAlive + ngrok); self-heal watchdog LIVE (60s, watches gateway+public door); keep-warm LIVE (5-min, cold-start cliff closed); gateway auth-forward committed (4844bb0); build door fix committed (2d49807); daemon CLI pushed to tarx-cli PR #6.\n'
printf -- '- Also shipped: TWO-TIER FAST PLANNING (a328a97) — plan drafts route to the RESIDENT fast model tarx-computer (:11435) via TARX_PLAN_FAST_BASE; measured 74s->29s. No new model required.\n'
printf -- '- HARD CONSTRAINT: disk is 99%% full (~7.5GB free). Do NOT propose downloading new models (no 7B/14B, no Qwen2.5-Coder, no HuggingFace pulls). Latency is now dominated by prompt size -> the fix is the context packer (8k window), NOT a new model.\n'

# Known open gaps (real, from packets)
printf -- '- Open gaps (candidates for next work): build/ask context packer exceeds 8k window on big repos; plan latency ~74s on cold 27B (needs warmed/smaller planning route); Operating State object + Dispatch loop + Quiet Log surface not built yet; web /agent skin of Presence not built; Supercomputer commits still local (await founder identity to push).\n'

# Most recent work-packet titles (real grounding)
if [ -d "$OPS" ]; then
  printf -- '- Recent work packets:\n'
  ls -t "$OPS"/PACKET_*.md 2>/dev/null | head -4 | while read -r f; do
    printf '    · %s\n' "$(basename "$f")"
  done
fi

printf 'Engage from this. If something here is stale, say so. Pick the highest-value open gap and push it forward.\n'
