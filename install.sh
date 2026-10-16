#!/bin/sh
# Place the TARX CLI. Inference is the supercomputer door, not a local port.
#   curl -fsSL https://raw.githubusercontent.com/tarx-ai/tarx-cli/main/install.sh | sh
set -eu

REPO="${TARX_INSTALL_REPO:-tarx-ai/tarx-cli}"
REF="${TARX_INSTALL_REF:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"
DEST="${TARX_BIN:-${HOME}/.tarx/bin/tarx}"

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
printf 'TARX inference: https://compute.tarx.com\n'
