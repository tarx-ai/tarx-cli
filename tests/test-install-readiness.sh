#!/bin/sh
# Execute the real installer and installed CLI in a temp home. No network or services.
set -eu
ROOT=$(unset CDPATH; cd "$(dirname "$0")/.." && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/fake" "$STAGE/home"
cat > "$STAGE/fake/curl" <<'DOUBLE'
#!/bin/sh
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2;; *) url=$1; shift;; esac
done
case "$url" in
  */tarx)
    [ -n "$out" ] || exit 9
    if [ "${BAD_DOWNLOAD:-0}" = 1 ]; then printf '<html>not a CLI</html>' > "$out"; else cp "$CLI_SOURCE" "$out"; fi;;
  */health)
    case "$url" in *:11435/health) [ "${HEALTHY:-0}" = 1 ];; *) exit 1;; esac;;
  *) printf 'unexpected network request\n' >&2; exit 9;;
esac
DOUBLE
for name in launchctl systemctl sudo; do
  printf '#!/bin/sh\nprintf "forbidden service call\\n" >&2\nexit 99\n' > "$STAGE/fake/$name"
done
chmod 755 "$STAGE/fake/"*
export CLI_SOURCE="$ROOT/tarx"
# Scope environment to this test process and children, never the host user configuration.
export HOME="$STAGE/home" PATH="$STAGE/fake:$PATH"
export TARX_BIN="$STAGE/home/bin/tarx"
sh "$ROOT/install.sh" > "$STAGE/install.out"
cmp "$ROOT/tarx" "$TARX_BIN"
[ -x "$TARX_BIN" ]
grep -q 'No daemon or model was installed or started' "$STAGE/install.out"
"$TARX_BIN" version > "$STAGE/version"
grep -q '1.1.1' "$STAGE/version"
"$TARX_BIN" help | grep -q 'readiness'
if "$TARX_BIN" readiness > "$STAGE/fresh"; then printf 'empty install falsely ready\n' >&2; exit 1; fi
grep -q '^inference 11435 not-ready$' "$STAGE/fresh"
HEALTHY=1 "$TARX_BIN" readiness > "$STAGE/healthy"
grep -q '^inference 11435 health-reachable$' "$STAGE/healthy"
grep -q '^mesh 11436 not-ready$' "$STAGE/healthy"
if BAD_DOWNLOAD=1 sh "$ROOT/install.sh" > "$STAGE/bad" 2>&1; then printf 'invalid download accepted\n' >&2; exit 1; fi
cmp "$ROOT/tarx" "$TARX_BIN"
printf 'PASS: staged install -> installed version/help -> local health states; rejected download preserves existing CLI. No network/services/model/host install.\n'
