# Optional local connection runtime

Install with `tarx runtime install` after installing Node.js24 or newer. The ordinary CLI install remains independent of Node.

The runtime package uses Eve0.83.2 and a lockfile. Setup resolves one GitHub source commit, validates the source archive, installs dependencies with lifecycle scripts disabled, and atomically activates the completed version. It does not start or register a background service, worker or model. User identity/pair records live separately under `~/.tarx/state/eve`.

## Connect this computer

1. Run `tarx`, then `/signin`, and finish the browser sign-in.
2. Run `tarx runtime challenge` to request a short-lived code using that saved account.
3. Explicitly approve it with `tarx runtime approve --challenge CODE`.
4. Run `tarx runtime serve --worker-url http://127.0.0.1:PORT` against an existing pinned Eve worker.
5. Ask TARX in the browser to connect this computer and enter the approved code.

The browser receives a scoped connection credential, never the saved CLI credential. The listener accepts only approved production origins and owned session reads. Codes expire after two minutes and can be claimed once; repeat the challenge/approval if needed. Use `tarx runtime revoke --challenge CODE` to revoke its connection.

This increment exposes pairing and read/attach only. It does not submit tasks or create session ownership. Worker health is not model responsiveness; readiness stays not-ready until that proof is integrated. Do not treat configuration, pairing, or an empty tool list as successful task execution. Keep using the browser for ordinary conversation.

## Verification

`npm ci --ignore-scripts --omit=dev --no-audit --no-fund` then `node --test --experimental-strip-types *.test.ts` in this directory. `python3 tests/test-runtime-package.py` from the repository root tests real staged install commands with fake network/dependency processes and disposable storage. No production sign-in, grant, inference or service is used.
