# Bounded task integration — not enabled in public serve

The new controller and HTTP routes are an integration candidate. The default CLI listener still has no registered task executor and returns503 for paired task requests. This source does not turn pairing into permission to run work.

A trusted caller may compose `createBoundedTaskController` with an accepted dedicated public-fixture Eve profile, then pass it to `createPairedSessionListener`. The SDK adapter creates an idle session, persists account/install/session ownership, records dispatch intent, then sends one fixed message. A separate CLI approval `--task read_launch_note` is required; read-only pairings cannot submit. A browser cannot supply its subject, install, file path, prompt, tool name or profile proof.

POST `/tasks` accepts exactly `{request_id,task:"read_launch_note"}` with a pinned origin and scoped bearer. An identical request returns its existing record and does not dispatch again. GET `/tasks/REQUEST_ID` reads only owned durable state. The stable idempotency boundary is account+install+request id. One in-flight task per account/install; an uncertain dispatch is retained and never automatically retried.

A success receipt requires a completed turn and exactly one successful, matching tool result containing the known public fixture. A completion event or model text alone cannot mark success. Receipts state `not_a_charge`; no billing/energy event is emitted. Failed, private or unexpected tool results never become a successful public receipt.

## Acceptance remaining

The profile verifier cannot just return true in production. It must prove the dedicated worker has only the reviewed fixture tool, no private context, no default tools or delegation, and authenticated inbound routes. Public serve does not supply that proof or executor. Next: real authenticated scoped-worker integration using a mock model, then actual conversation task/read/reload acceptance. Prior native-model tool proof remains separate and must not be repeated from a monitor.

Tests here exercise real local persistence/HTTP with executor doubles. They are not real Eve task or production account acceptance. No worker/model/service is started by the test suite.
