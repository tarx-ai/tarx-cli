# Bounded local tool check

`tarx runtime install` installs pinned dependencies and starts nothing. Node24+, npm and Python are required. Existing `tarx runtime serve --worker-url URL` stays read-only.

The opt-in `serve-check` command builds and starts one authenticated loopback Eve0.83.2 worker. It exposes only `read_launch_note`, which returns a fixed public test sentence. No private files, arbitrary prompts/paths, default tools, delegation, sandbox, model startup or billing. This is a connectivity check, not a general always-on agent.

After existing CLI sign-in, request a challenge and explicitly approve the task:

```
tarx runtime challenge
tarx runtime approve --challenge CODE --task read_launch_note
tarx runtime serve-check --worker-root NEW_DIRECTORY --model-url http://127.0.0.1:PORT/v1 --model-id MODEL --worker-port WORKER_PORT
```

Choose an existing model endpoint and an unused worker port. The browser claims the approved code once. Approval without `--task` grants read-only pairing. The worker authentication remains inside the local bridge; the browser gets only a scoped pairing credential. Installation/page load never starts the worker.

GET `/task-capabilities` requires the pinned Origin and valid unrevoked pairing bearer. Its separate `available_tasks` and `permitted_tasks` arrays come from actual trusted worker discovery intersected with stored approval. No executor yields empty arrays, missing/revoked bearer401, discovery failure503. Health does not prove model responsiveness.

POST `/tasks` accepts exactly `{request_id,task:"read_launch_note"}`. The browser saves its request id before sending. The controller reserves account/install/request ownership before idle session creation and dispatch intent before the fixed message. Repeated requests return the original record. GET `/tasks/REQUEST_ID` reads owned durable outcomes. Uncertain dispatch is retained and never automatically repeated. One in-flight task per account/install is allowed.

Completion requires one exact successful tool result and completed turn; model text alone cannot create a receipt. Receipts state `not_a_charge`. No balance, energy or payment is emitted.

For clean reopening, repeat the same serve-check arguments with `--resume true`. Sources/model/dependency link must match. A held `.runtime.lock` prevents another owner and is never forcibly taken over. Clean shutdown releases it only after its owned listener closes; failure preserves the lock. Build output is regenerated from validated sources, and durable Eve/owner/task/pair state is reused. Abrupt process death, stale-lock operator recovery and OS reboot are not yet accepted. There is no installed background service.

Validation: normal tests cover stores/auth/discovery/HTTP/idempotency. Opt-in actual worker test:

```
TARX_TEST_WORKER=1 node --experimental-strip-types --test tarx-public-worker.integration.test.ts
```

That test uses disposable identity and a loopback mock model, actual production build/start, CLI commands/pairing/tool receipt, worker restart and clean entry recreation. A separate browser test used the real paired Eve listener/mock model: one POST, one tool result, same receipt after reload, no extra model calls, revocation preserves receipt. These are local fixture acceptance, not production email identity, arbitrary tools, real OS lifecycle or throughput certification. A separate one-shot native-model compatibility trial is recorded privately; do not rerun it from monitoring.

## Safari-compatible private browser transport

`tarx runtime serve-personal` explicitly starts the paired listener on127.0.0.1:3270 and its browser transport on127.0.0.1:3271, using the existing owner-only personal runtime profile. No model, Eve worker or OS service starts. Leave this foreground command running. `serve-browser` starts only the transport for an already-running listener.

Safari blocks the public HTTPS page's direct HTTP fetch to loopback. The shared private-chat card therefore opens a local transport tab on an explicit click. That tab uses same-origin local HTTP and a pinned-opener MessageChannel; approvals and text remain in the main conversational UI. The helper accepts only claim/personal RPCs, not arbitrary URLs/tools/remote compute. It keeps model keys server-side; existing explicit personal_chat approval and revoke enforcement remain authoritative. No browser security setting or certificate trust is changed.
