#!/bin/sh

set -eu

TASK_MCP_DIR="$(mktemp -d)"
trap 'rm -rf "$TASK_MCP_DIR"' EXIT
export TARX_MCP_CONFIG_DIR="$TASK_MCP_DIR"

# A third-party Cursor entry must survive the TARX merge unchanged.
printf '%s\n' \
  '{"mcpServers":{"other":{"type":"custom","url":"https://example.com/mcp"}}}' \
  > "$TASK_MCP_DIR/cursor.json"

./tarx mcp add claude >/dev/null
./tarx mcp add cc >/dev/null
./tarx mcp add cursor >/dev/null
./tarx mcp add vscode >/dev/null

python3 <<'PYEOF'
import json
import os
from pathlib import Path

root = Path(os.environ["TARX_MCP_CONFIG_DIR"])

for client in ("claude", "claude-code", "cursor"):
    config = json.loads((root / f"{client}.json").read_text())
    servers = config["mcpServers"]
    assert servers["tarx"]["url"] == "https://mcp.tarx.com/mcp"
    assert servers["tarx-core"]["command"] == "node"

cursor = json.loads((root / "cursor.json").read_text())
assert cursor["mcpServers"]["other"] == {
    "type": "custom",
    "url": "https://example.com/mcp",
}

vscode = json.loads((root / "vscode.json").read_text())
assert "mcpServers" not in vscode
assert vscode["servers"]["tarx"]["type"] == "http"
assert vscode["servers"]["tarx-core"]["type"] == "stdio"
PYEOF

# Invalid existing JSON must not be replaced.
printf '%s\n' '{invalid' > "$TASK_MCP_DIR/claude.json"
if ./tarx mcp add claude >/dev/null 2>&1; then
  echo "expected invalid JSON to stop the merge" >&2
  exit 1
fi
test -f "$TASK_MCP_DIR/claude.json.bak"
grep -q '{invalid' "$TASK_MCP_DIR/claude.json"

echo "MCP config tests passed"
