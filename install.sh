#!/bin/sh
# Place the TARX CLI and make sure the local bridge is listening on :11440.
#   curl -fsSL https://raw.githubusercontent.com/tarx-ai/tarx-cli/main/install.sh | sh
set -eu

REPO="${TARX_INSTALL_REPO:-tarx-ai/tarx-cli}"
REF="${TARX_INSTALL_REF:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"
DEST="${TARX_BIN:-${HOME}/.tarx/bin/tarx}"
BRIDGE_URL="http://127.0.0.1:11440/health"

bridge_up() {
  curl -sf -m 2 "$BRIDGE_URL" >/dev/null 2>&1
}

mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "${RAW}/tarx" -o "$tmp"
# A real CLI is a shell script with the TARX header. Refuse an HTML error page.
head -n 1 "$tmp" | grep -q '^#!' || {
  printf 'ERROR: downloaded tarx is not a script\n' >&2
  exit 1
}
install -m 755 "$tmp" "$DEST"
printf 'installed %s\n' "$DEST"

if bridge_up; then
  printf 'bridge listening on 127.0.0.1:11440\n'
  exit 0
fi

uid="$(id -u)"
label="gui/${uid}/com.tarx.bridge"
plist="${HOME}/Library/LaunchAgents/com.tarx.bridge.plist"
if [ -f "$plist" ]; then
  launchctl bootstrap "gui/${uid}" "$plist" >/dev/null 2>&1 || true
  launchctl kickstart "$label" >/dev/null 2>&1 || true
elif [ -x "${HOME}/.tarx/bin/start-tarx-bridge.sh" ]; then
  "${HOME}/.tarx/bin/start-tarx-bridge.sh" >/dev/null 2>&1 &
fi

i=0
while [ "$i" -lt 20 ]; do
  if bridge_up; then
    printf 'bridge listening on 127.0.0.1:11440\n'
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

printf 'ERROR: tarx is installed, bridge is not listening on 127.0.0.1:11440\n' >&2
exit 1
