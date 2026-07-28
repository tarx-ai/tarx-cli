# MCP host adapter fixtures

These fixtures capture the same portable TARX server definitions translated
into the configuration envelopes used by four MCP hosts.

| Host | Root key | Remote transport | Local transport |
| --- | --- | --- | --- |
| Claude Desktop | `mcpServers` | URL, implicit type | command and args, implicit stdio |
| Claude Code | `mcpServers` | URL, implicit type | command and args, implicit stdio |
| Cursor | `mcpServers` | URL, implicit type | command and args, implicit stdio |
| VS Code | `servers` | `type: "http"` | `type: "stdio"` |

Each `*.initial.json` file contains unrelated host settings and a third-party
server. Its corresponding `*.expected.json` file is the complete expected
result after `tarx mcp add`.

The fixtures enforce four adapter invariants:

1. Select the host-specific envelope and transport fields.
2. Preserve unrelated settings and third-party server definitions exactly.
3. Materialize no credentials while translating server definitions.
4. Reject invalid existing configuration instead of replacing it.

`__TARX_HOME__` is a test-only placeholder for the installation directory.
