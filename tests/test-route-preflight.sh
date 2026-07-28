#!/bin/sh

set -eu

TASK_ROUTE_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TASK_ROUTE_DIR"
}

trap cleanup EXIT

cat > "$TASK_ROUTE_DIR/server.py" <<'PYEOF'
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        model = payload.get("model")

        if model == "slow":
            time.sleep(1)
        if model == "missing":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"model not found"}}')
            return
        if model == "unavailable":
            self.send_response(503)
            self.end_headers()
            return
        if model == "malformed":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if model == "remote-ok" and self.headers.get("Authorization") != "Bearer test-secret":
            self.send_response(401)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"choices":[{"message":{"content":"OK"}}]}')

    def log_message(self, *_args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(os.environ["TASK_ROUTE_PORT_FILE"], "w", encoding="utf-8") as port_file:
    port_file.write(str(server.server_port))
server.serve_forever()
PYEOF

TASK_ROUTE_PORT_FILE="$TASK_ROUTE_DIR/port" python3 "$TASK_ROUTE_DIR/server.py" &
SERVER_PID=$!

_attempt=0
while [ ! -s "$TASK_ROUTE_DIR/port" ]; do
  _attempt=$((_attempt + 1))
  [ "$_attempt" -lt 50 ] || {
    echo "route test server did not start" >&2
    exit 1
  }
  sleep 0.1
done

PORT="$(cat "$TASK_ROUTE_DIR/port")"
BASE_URL="http://127.0.0.1:${PORT}/v1"

TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
TARX_LOCAL_INFERENCE_MODEL="local" \
  ./tarx route check local | grep -q "target=local"

if TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
   TARX_LOCAL_INFERENCE_MODEL="missing" \
   ./tarx route check local >"$TASK_ROUTE_DIR/missing.out" 2>&1; then
  echo "expected missing model to fail" >&2
  exit 1
fi
grep -q "model-access" "$TASK_ROUTE_DIR/missing.out"

if TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
   TARX_LOCAL_INFERENCE_MODEL="unavailable" \
   ./tarx route check local >"$TASK_ROUTE_DIR/unavailable.out" 2>&1; then
  echo "expected unavailable provider to fail" >&2
  exit 1
fi
grep -q "provider-availability" "$TASK_ROUTE_DIR/unavailable.out"

if TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
   TARX_LOCAL_INFERENCE_MODEL="malformed" \
   ./tarx route check local >"$TASK_ROUTE_DIR/malformed.out" 2>&1; then
  echo "expected malformed provider response to fail" >&2
  exit 1
fi
grep -q "provider-response" "$TASK_ROUTE_DIR/malformed.out"

if TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
   TARX_LOCAL_INFERENCE_MODEL="remote-ok" \
   ./tarx route check local >"$TASK_ROUTE_DIR/auth.out" 2>&1; then
  echo "expected missing local credential to fail" >&2
  exit 1
fi
grep -q "authentication" "$TASK_ROUTE_DIR/auth.out"

TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
TARX_LOCAL_INFERENCE_MODEL="remote-ok" \
TARX_LOCAL_INFERENCE_API_KEY="test-secret" \
  ./tarx route check local | grep -q "target=local"

if TARX_LOCAL_INFERENCE_URL="$BASE_URL" \
   TARX_LOCAL_INFERENCE_MODEL="slow" \
   TARX_ROUTE_PREFLIGHT_TIMEOUT_SECONDS="0.1" \
   ./tarx route check local >"$TASK_ROUTE_DIR/timeout.out" 2>&1; then
  echo "expected timeout to fail" >&2
  exit 1
fi
grep -q "timeout" "$TASK_ROUTE_DIR/timeout.out"

if TARX_ALLOW_REMOTE_INFERENCE=0 \
   ./tarx route check remote >"$TASK_ROUTE_DIR/denied.out" 2>&1; then
  echo "expected unapproved remote route to fail" >&2
  exit 1
fi
grep -q "Remote inference is disabled" "$TASK_ROUTE_DIR/denied.out"

TARX_ALLOW_REMOTE_INFERENCE=1 \
TARX_REMOTE_INFERENCE_URL="https://example.invalid/v1" \
TARX_REMOTE_INFERENCE_MODEL="remote-ok" \
TARX_REMOTE_INFERENCE_API_KEY="test-secret" \
  ./tarx route check remote --offline | grep -q "remote inference remains disabled"

# The test server is HTTP, so use a loopback URL only to verify secret-safe
# authentication behavior. Remote policy separately rejects non-HTTPS routes.
if TARX_ALLOW_REMOTE_INFERENCE=1 \
   TARX_REMOTE_INFERENCE_URL="$BASE_URL" \
   TARX_REMOTE_INFERENCE_MODEL="remote-ok" \
   TARX_REMOTE_INFERENCE_API_KEY="test-secret" \
   ./tarx route check remote >"$TASK_ROUTE_DIR/https.out" 2>&1; then
  echo "expected remote HTTP endpoint to fail closed" >&2
  exit 1
fi
grep -q "approved remote inference requires HTTPS" "$TASK_ROUTE_DIR/https.out"
if grep -q "test-secret" "$TASK_ROUTE_DIR/https.out"; then
  echo "remote credential leaked into output" >&2
  exit 1
fi

echo "Route preflight tests passed"
