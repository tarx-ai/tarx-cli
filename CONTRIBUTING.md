# Contributing

Thank you for improving the public TARX developer experience.

## Good contributions

- Reproducible CLI bugs on macOS or Linux
- Safer configuration merging and recovery
- Clearer diagnostics and health output
- Compatibility fixes for supported MCP clients
- Documentation that can be verified against the public CLI

Internal operations, proprietary orchestration, model weights, and production
infrastructure are intentionally outside this repository's public boundary.

## Before opening a pull request

1. Start from a focused issue or describe the user-visible problem.
2. Keep the change small and avoid unrelated formatting.
3. Run:

   ```sh
   sh -n tarx
   shellcheck -S warning tarx
   ./tarx version
   ./tarx help
   ```

4. Explain the behavior before and after the change.
5. Include platform details when the result differs by operating system.

Do not include credentials, local data, model files, customer information, or
private TARX implementation details in issues, logs, or pull requests.
