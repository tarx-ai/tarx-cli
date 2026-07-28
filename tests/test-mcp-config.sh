#!/bin/sh

set -eu

TASK_MCP_DIR="$(mktemp -d)"
trap 'rm -rf "$TASK_MCP_DIR"' EXIT
TASK_FIXTURES_DIR="$(CDPATH='' cd "$(dirname "$0")/fixtures/mcp" && pwd)"
export TARX_MCP_CONFIG_DIR="$TASK_MCP_DIR"
export TARX_HOME="$TASK_MCP_DIR/tarx-home"
export TASK_MCP_FIXTURES_DIR="$TASK_FIXTURES_DIR"

for client in claude claude-code cursor vscode; do
  cp "$TASK_FIXTURES_DIR/$client.initial.json" "$TASK_MCP_DIR/$client.json"
done

./tarx mcp add claude >/dev/null
./tarx mcp add cc >/dev/null
./tarx mcp add cursor >/dev/null
./tarx mcp add vscode >/dev/null

# Repeating the merge must be idempotent.
./tarx mcp add claude >/dev/null
./tarx mcp add cc >/dev/null
./tarx mcp add cursor >/dev/null
./tarx mcp add vscode >/dev/null

python3 <<'PYEOF'
import json
import os
from pathlib import Path

root = Path(os.environ["TARX_MCP_CONFIG_DIR"])
fixtures = Path(os.environ["TASK_MCP_FIXTURES_DIR"])
tarx_home = os.environ["TARX_HOME"]

for client in ("claude", "claude-code", "cursor"):
    assert "mcpServers" in json.loads((root / f"{client}.json").read_text())

for client in ("claude", "claude-code", "cursor", "vscode"):
    actual = json.loads((root / f"{client}.json").read_text())
    expected_text = (fixtures / f"{client}.expected.json").read_text()
    expected = json.loads(expected_text.replace("__TARX_HOME__", tarx_home))
    assert actual == expected, f"{client} output differs from its host fixture"
    assert not (root / f"{client}.json.bak").exists()
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
