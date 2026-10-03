#!/bin/sh
# dd-create-dashboard.sh — build/update the TARX LLM + flywheel performance dashboard
# on Datadog (us5). Keys read from ~/.tarx/.dd_api_key / .dd_app_key — never printed.
#
# Metrics it visualizes:
#   tarx.flywheel.latency_ms / .event        (build loop: plan/apply/verify/commit)
#   tarx.supercomputer.gateway.*             (gateway inference telemetry, if emitted)
set -eu
SITE="${DD_SITE:-us5.datadoghq.com}"
K=$(cat "$HOME/.tarx/.dd_api_key"); A=$(cat "$HOME/.tarx/.dd_app_key")

payload=$(cat <<'JSON'
{
  "title": "TARX — LLM & Flywheel Performance",
  "description": "TARX Supercomputer inference + build-loop (flywheel) performance. Source: tarx-flywheel + gateway telemetry.",
  "layout_type": "ordered",
  "widgets": [
    {"definition": {"type": "note", "content": "TARX Supercomputer — sovereign inference. Flywheel = TARX plans -> Kiro applies -> verify -> commit.", "background_color": "blue", "font_size": "14", "text_align": "left"}},
    {"definition": {"type": "timeseries", "title": "Plan latency (ms) by stage",
      "requests": [{"q": "avg:tarx.flywheel.latency_ms{*} by {stage}", "display_type": "line"}]}},
    {"definition": {"type": "query_value", "title": "Loop events (last 1h)",
      "requests": [{"q": "sum:tarx.flywheel.event{*}.as_count()", "aggregator": "sum"}]}},
    {"definition": {"type": "query_value", "title": "Success rate",
      "requests": [{"q": "sum:tarx.flywheel.event{status:ok}.as_count() / sum:tarx.flywheel.event{*}.as_count() * 100", "aggregator": "avg"}],
      "precision": 1}},
    {"definition": {"type": "timeseries", "title": "Events by stage/status",
      "requests": [{"q": "sum:tarx.flywheel.event{*} by {stage,status}.as_count()", "display_type": "bars"}]}},
    {"definition": {"type": "timeseries", "title": "Gateway inference latency (if emitted)",
      "requests": [{"q": "avg:tarx.supercomputer.gateway.inference.latency_ms{*}", "display_type": "line"}]}}
  ]
}
JSON
)

echo "$payload" | curl -s -m 15 -X POST "https://api.$SITE/api/v1/dashboard" \
  -H "DD-API-KEY: $K" -H "DD-APPLICATION-KEY: $A" -H "content-type: application/json" \
  -d @- | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    if d.get('id'): print('Dashboard created:', 'https://'+'$SITE'.replace('api.','app.')+'/dashboard/'+d['id'])
    else: print('Response:', json.dumps(d)[:300])
except Exception as e: print('parse error', e)
"
