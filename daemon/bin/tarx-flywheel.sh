#!/bin/sh
# tarx-flywheel.sh — the observable surface + data flywheel for the TARX build loop.
#
# Every loop step (plan, apply, verify, commit, heal) is a structured JSONL event:
#   - APPENDED to ~/.tarx/always-on/flywheel.jsonl   (data flywheel: eval/training/metrics)
#   - printed to the live feed (watchable with: tarx flywheel)
# This is the Always On "Quiet Log" for the engineering loop — proof it worked
# without talking, and the dataset that feeds LLM-performance instrumentation.
#
# Usage:
#   tarx-flywheel.sh emit <stage> <ok|fail> <latency_ms> '<json-detail>'
#   tarx-flywheel.sh tail        # follow the live feed
#   tarx-flywheel.sh stats       # quick rollup (count, p50/p95 latency, success rate)

set -u
AO="$HOME/.tarx/always-on"
LOG="$AO/flywheel.jsonl"
mkdir -p "$AO"

cmd_emit() {
  stage="${1:-unknown}"; status="${2:-ok}"; latency="${3:-0}"; detail="${4:-{}}"
  STAGE="$stage" ST="$status" LAT="$latency" DET="$detail" python3 - "$LOG" <<'PY'
import json,os,sys,time
rec={
  "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "stage": os.environ["STAGE"],
  "status": os.environ["ST"],
  "latency_ms": int(os.environ["LAT"] or 0),
}
try: rec["detail"]=json.loads(os.environ["DET"])
except Exception: rec["detail"]={"raw": os.environ["DET"]}
open(sys.argv[1],"a").write(json.dumps(rec)+"\n")
# live line
mark = "✓" if rec["status"]=="ok" else "✗"
print(f'  {mark} {rec["ts"]}  {rec["stage"]:<10} {rec["latency_ms"]:>6}ms  {json.dumps(rec["detail"])[:80]}')
PY
  # Ship to Datadog (us5), non-blocking, key from file — never printed.
  _ddkf="$HOME/.tarx/.dd_api_key"; _ddsite="${DD_SITE:-us5.datadoghq.com}"
  if [ -r "$_ddkf" ]; then
    _k=$(cat "$_ddkf"); _now=$(date +%s)
    _tags="[\"stage:$stage\",\"status:$status\",\"env:prod\",\"service:tarx-flywheel\"]"
    ( curl -s -o /dev/null -m 5 -X POST "https://api.$_ddsite/api/v1/series" \
        -H "DD-API-KEY: $_k" -H "content-type: application/json" \
        -d "{\"series\":[{\"metric\":\"tarx.flywheel.latency_ms\",\"points\":[[$_now,$latency]],\"type\":\"gauge\",\"tags\":$_tags},{\"metric\":\"tarx.flywheel.event\",\"points\":[[$_now,1]],\"type\":\"count\",\"tags\":$_tags}]}" 2>/dev/null & ) 
  fi
}

cmd_tail() {
  echo "TARX flywheel · live activity (Ctrl-C to stop)"
  echo "─────────────────────────────────────────────"
  [ -f "$LOG" ] && tail -n 20 "$LOG" | _render
  tail -n 0 -f "$LOG" 2>/dev/null | _render
}

_render() {
  python3 -c "
import sys,json
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try:
        r=json.loads(line); m='✓' if r.get('status')=='ok' else '✗'
        print(f\"  {m} {r.get('ts','')}  {r.get('stage','?'):<10} {r.get('latency_ms',0):>6}ms  {json.dumps(r.get('detail',{}))[:80]}\")
    except Exception: pass
    sys.stdout.flush()
"
}

cmd_stats() {
  [ -f "$LOG" ] || { echo "no flywheel events yet"; return; }
  python3 - "$LOG" <<'PY'
import json,sys
recs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
n=len(recs); ok=sum(1 for r in recs if r.get("status")=="ok")
lats=sorted(r.get("latency_ms",0) for r in recs if r.get("latency_ms"))
def pct(p):
    if not lats: return 0
    return lats[min(len(lats)-1, int(len(lats)*p))]
print(f"events: {n}  success: {ok}/{n} ({100*ok//max(n,1)}%)")
print(f"latency p50={pct(0.5)}ms  p95={pct(0.95)}ms  max={lats[-1] if lats else 0}ms")
from collections import Counter
for stage,c in Counter(r.get('stage') for r in recs).most_common():
    print(f"  {stage}: {c}")
PY
}

case "${1:-tail}" in
  emit)  shift; cmd_emit "$@" ;;
  tail)  cmd_tail ;;
  stats) cmd_stats ;;
  *) echo "usage: tarx-flywheel.sh [emit <stage> <ok|fail> <ms> <json> | tail | stats]" >&2; exit 2 ;;
esac
