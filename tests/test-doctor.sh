#!/bin/sh
# Doctor states: missing, present, and unknown. No live credentials.
set -eu
ROOT=$(unset CDPATH; cd "$(dirname "$0")/.." && pwd)
TARX="$ROOT/tarx"
FAKE=$(mktemp -d)
trap 'rm -rf "$FAKE"' EXIT
HOME_BASE=$(mktemp -d)
trap 'rm -rf "$FAKE" "$HOME_BASE"' EXIT

cat > "$FAKE/curl" << 'EOF'
#!/bin/sh
url=""
for arg in "$@"; do url=$arg; done
case "$url" in
  */health)
    [ "${TARX_FAKE_HEALTH:-no}" = "yes" ]
    ;;
  */v1/models)
    if [ -n "${TARX_FAKE_MODEL:-}" ]; then
      printf '{"data":[{"id":"%s"}]}\n' "$TARX_FAKE_MODEL"
      exit 0
    fi
    exit 1
    ;;
  *) exit 1 ;;
esac
EOF
cat > "$FAKE/sysctl" << 'EOF'
#!/bin/sh
if [ "${TARX_FAKE_RAM:-ok}" = "fail" ]; then
  exit 1
fi
if [ "$1" = "-n" ] && [ "$2" = "hw.memsize" ]; then
  printf '34359738368\n'
  exit 0
fi
exit 1
EOF
cat > "$FAKE/df" << 'EOF'
#!/bin/sh
if [ "$1" = "-h" ]; then
  printf 'Filesystem Size Used Avail Capacity\n'
  printf 'disk 100Gi 10Gi 80Gi 10%%\n'
  exit 0
fi
printf 'Filesystem 512-blocks Used Available\n'
printf 'disk 100 10 80000000\n'
EOF
cat > "$FAKE/lsof" << 'EOF'
#!/bin/sh
exit 1
EOF
cat > "$FAKE/pgrep" << 'EOF'
#!/bin/sh
exit 1
EOF
cat > "$FAKE/system_profiler" << 'EOF'
#!/bin/sh
if [ "${TARX_FAKE_GPU:-ok}" = "fail" ]; then
  exit 1
fi
printf 'Chipset Model: Test GPU\n'
EOF
chmod 755 "$FAKE"/*

run_doctor() {
  HOME="$HOME_BASE" PATH="$FAKE:$PATH" "$TARX" doctor
}

out=$(TARX_FAKE_HEALTH=no TARX_DOCTOR_RAM_BYTES=34359738368 TARX_FAKE_GPU=ok run_doctor)
printf '%s\n' "$out" | grep -q 'Inference model missing:' || { printf 'missing inference not reported\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'Embedding model missing:' || { printf 'missing embedding not reported\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'RAM: 32 GB' || { printf 'measured ram not reported\n%s\n' "$out" >&2; exit 1; }

if [ "$(uname -s)" = "Darwin" ]; then
  model_dir="$HOME_BASE/Library/Application Support/tarx/models"
else
  model_dir="$HOME_BASE/.tarx/models"
fi
mkdir -p "$model_dir"
: > "$model_dir/tarx-qwen2.5-7b-deep-Q4_K_M.gguf"
: > "$model_dir/nomic-embed-text-v1.5-f16.gguf"
out=$(TARX_FAKE_HEALTH=no TARX_DOCTOR_RAM_BYTES=34359738368 TARX_FAKE_GPU=ok run_doctor)
printf '%s\n' "$out" | grep -q '\[OK\] Inference: .*/tarx-qwen2.5-7b-deep-Q4_K_M.gguf' || { printf 'present inference not reported\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q '\[OK\] Embedding: .*/nomic-embed-text-v1.5-f16.gguf' || { printf 'present embedding not reported\n%s\n' "$out" >&2; exit 1; }
rm -rf "$model_dir"

out=$(TARX_FAKE_HEALTH=yes TARX_FAKE_MODEL=tarx-sc-qwen3-8b TARX_DOCTOR_RAM_BYTES= TARX_FAKE_GPU=fail run_doctor)
printf '%s\n' "$out" | grep -q 'Inference weight unknown; service reports tarx-sc-qwen3-8b' || { printf 'unknown weight not reported\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'Inference model missing:' && { printf 'unknown weight was called missing\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'RAM: unknown' || { printf 'unknown ram not reported\n%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" | grep -q 'RAM: 0 GB' && { printf 'false zero ram\n%s\n' "$out" >&2; exit 1; }
if [ "$(uname -s)" = "Darwin" ]; then
  printf '%s\n' "$out" | grep -q 'GPU: unknown' || { printf 'unknown gpu not reported\n%s\n' "$out" >&2; exit 1; }
else
  printf '%s\n' "$out" | grep -q 'no NVIDIA GPU detected' || { printf 'linux gpu result not reported\n%s\n' "$out" >&2; exit 1; }
fi

printf 'doctor states passed\n'
