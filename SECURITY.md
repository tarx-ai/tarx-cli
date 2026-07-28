# Security

## Reporting

Do not report suspected vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting for this repository when
available. Otherwise, contact the maintainers through the security channel
listed at [tarx.com](https://tarx.com).

Include:

- The affected command and TARX CLI version
- Operating system and architecture
- Reproduction steps with credentials and personal data removed
- Expected impact
- A minimal proof of concept, when safe

## Scope

The public security boundary includes this CLI, its handling of local files and
processes, MCP configuration writes, update behavior, and the public health
schema. Proprietary TARX services and production infrastructure are managed
outside this repository.

## Safe defaults

- Runtime services bind to `127.0.0.1` by default.
- MCP configuration is backed up before editing and validated before success.
- Internal operations servers and credentials must never be shipped by this
  public CLI.
- Uninstall asks for confirmation before removing the TARX data directory.
