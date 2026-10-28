#!/bin/sh
# Truthful `start` + version/help aliases. No live credentials, no host
# services: isolated HOME, fake llama-server, isolated high ports, and a fake
# health responder. Covers missing engine, already-running, startup failure,
# platform-aware guidance, and side-effect-free aliases.
set -eu
ROOT=$(unset CDPATH; cd "$(dirname "$0")/.." && pwd)
TARX="$ROOT/tarx"
FAKE=$(mktemp -d)
HOME_BASE=$(mktemp -d)
HP=''
trap '[ -z "$HP" ] || kill "$HP" 2>/dev/null || true; rm -rf "$FAKE" "$HOME_BASE"' EXIT

# Isolated ports nothing is listening on, so check_port fails deterministically.
export TARX_INFERENCE_PORT=59991 TARX_EMBED_PORT=59992 TARX_MESH_PORT=59993 TARX_COGNITIVE_PORT=59994
# Fast launch probe so the suite stays quick.
export TARX_START_PROBE_SECONDS=0.3

# A fake curl: /health returns success only when TARX_FAKE_HEALTH=yes.
cat > "$FAKE/curl" << 'EOF'
#!/bin/sh
url=""
for arg in "$@"; do url=$arg; done
case "$url" in
  */health) [ "${TARX_FAKE_HEALTH:-no}" = "yes" ] ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$FAKE/curl"

run_start() {
  # Force no llama-server unless a test overrides TARX_LLAMA_SERVER.
  HOME="$HOME_BASE" PATH="$FAKE:$PATH" "$TARX" start
}

os=$(uname -s)

# ── 1. Missing engine: never a false success, nonzero exit, browser alt ──
set +e
out=$(TARX_FAKE_HEALTH=no TARX_LLAMA_SERVER='' run_start 2>&1)
code=$?
set -e
[ "$code" -ne 0 ] || { printf 'missing engine must exit nonzero\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'All services already running' && { printf 'false "already running" with nothing running\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'cannot start' || { printf 'did not report cannot-start\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'tarx.com/agent' || { printf 'did not offer browser alternative\n%s\n' "$out" >&2; exit 1; }

# Platform-aware guidance: no brew on Linux; brew allowed on macOS.
case "$os" in
  Linux)
    printf '%s\n' "$out" | grep -qi 'brew' && { printf 'brew suggested on Linux\n%s\n' "$out" >&2; exit 1; }
    printf '%s\n' "$out" | grep -q 'llama.cpp' || { printf 'no llama.cpp guidance on Linux\n%s\n' "$out" >&2; exit 1; }
    ;;
  Darwin)
    printf '%s\n' "$out" | grep -qi 'brew install llama.cpp' || { printf 'no brew guidance on macOS\n%s\n' "$out" >&2; exit 1; }
    ;;
esac
# Never suggest the dead update endpoint as the model fix.
printf '%s\n' "$out" | grep -q 'tarx update --models' && { printf 'suggested dead model-update endpoint\n%s\n' "$out" >&2; exit 1; }

# ── 2. Already running: report truthfully, exit 0, start nothing ──
# Spawn the fake health server DIRECTLY in the background (no command
# substitution) and capture its pid with $!. Command substitution around a
# backgrounded job can block until the job's stdout closes; spawning directly
# avoids that class of hang entirely. stdout/stderr are redirected regardless.
start_health_bg() {  # $1 = port; sets HP to the fixture pid
  python3 - "$1" >/dev/null 2>&1 <<'PY' &
import http.server, socketserver, sys
port=int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/health': self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        else: self.send_response(404); self.end_headers()
    def log_message(self,*a): pass
class S(socketserver.TCPServer):
    allow_reuse_address = True
with S(("127.0.0.1",port),H) as s: s.serve_forever()
PY
  HP=$!
}
start_health_bg 59991
# wait (bounded) for it to actually listen; fail loudly if it never does.
i=0; ready=0
while [ $i -lt 100 ]; do
  if curl -sf "http://127.0.0.1:59991/health" >/dev/null 2>&1; then ready=1; break; fi
  i=$((i+1)); sleep 0.1
done
[ "$ready" = "1" ] || { printf 'health fixture did not come up on 59991\n' >&2; kill "$HP" 2>/dev/null || true; exit 1; }
set +e
out=$(HOME="$HOME_BASE" PATH="$PATH" TARX_LLAMA_SERVER='' "$TARX" start 2>&1)
code=$?
set -e
kill "$HP" 2>/dev/null || true
HP=''
[ "$code" -eq 0 ] || { printf 'already-running inference must exit 0\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'Inference  (59991): already running' || { printf 'did not report inference already running\n%s\n' "$out" >&2; exit 1; }

# ── 3. Startup failure: engine present + models present, but launch exits ──
cat > "$FAKE/fake-llama-fail" << 'EOF'
#!/bin/sh
exit 1
EOF
chmod 755 "$FAKE/fake-llama-fail"
# Models must exist so start reaches the launch step (not the model-missing one).
if [ "$os" = "Darwin" ]; then
  model_dir="$HOME_BASE/Library/Application Support/tarx/models"
else
  model_dir="$HOME_BASE/.tarx/models"
fi
mkdir -p "$model_dir"
: > "$model_dir/tarx-qwen2.5-7b-deep-Q4_K_M.gguf"
: > "$model_dir/nomic-embed-text-v1.5-f16.gguf"
set +e
out=$(TARX_FAKE_HEALTH=no TARX_LLAMA_SERVER="$FAKE/fake-llama-fail" run_start 2>&1)
code=$?
set -e
rm -f "$model_dir/tarx-qwen2.5-7b-deep-Q4_K_M.gguf" "$model_dir/nomic-embed-text-v1.5-f16.gguf"
[ "$code" -ne 0 ] || { printf 'failed launch must exit nonzero\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'failed to launch' || { printf 'did not report launch failure\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'All services already running' && { printf 'false success on failed launch\n%s\n' "$out" >&2; exit 1; }

# ── 4. Version/help aliases: truthful, no network/auth/service effects ──
expected=$(HOME="$HOME_BASE" PATH="$FAKE:$PATH" "$TARX" version)
for alias in --version -V; do
  got=$(HOME="$HOME_BASE" PATH="$FAKE:$PATH" "$TARX" "$alias")
  [ "$got" = "$expected" ] || { printf '%s did not match version output\n' "$alias" >&2; exit 1; }
done
# An alias must not perform health/network calls: our fake curl would be the
# only way to reach a service, and version does not use it. Confirm output is
# exactly the version string (no extra service/auth lines).
lines=$(printf '%s\n' "$got" | wc -l | tr -d ' ')
[ "$lines" = "1" ] || { printf 'version alias produced extra output\n%s\n' "$got" >&2; exit 1; }

for alias in --help -h help; do
  HOME="$HOME_BASE" PATH="$FAKE:$PATH" "$TARX" "$alias" >/dev/null || { printf '%s help alias failed\n' "$alias" >&2; exit 1; }
done

printf 'start-truth tests passed\n'
