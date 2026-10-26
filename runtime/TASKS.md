# Bounded task integration — not enabled in public serve

The new controller and HTTP routes are an integration candidate. The default CLI listener still has no registered task executor and returns503 for paired task requests. This source does not turn pairing into permission to run work.

A trusted caller may compose `createBoundedTaskController` with an accepted dedicated public-fixture Eve profile, then pass it to `createPairedSessionListener`. The SDK adapter creates an idle session, persists account/install/session ownership, records dispatch intent, then sends one fixed message. A separate CLI approval `--task read_launch_note` is required; read-only pairings cannot submit. A browser cannot supply its subject, install, file path, prompt, tool name or profile proof.

POST `/tasks` accepts exactly `{request_id,task:"read_launch_note"}` with a pinned origin and scoped bearer. An identical request returns its existing record and does not dispatch again. GET `/tasks/REQUEST_ID` reads only owned durable state. The stable idempotency boundary is account+install+request id. One in-flight task per account/install; an uncertain dispatch is retained and never automatically retried.

A success receipt requires a completed turn and exactly one successful, matching tool result containing the known public fixture. A completion event or model text alone cannot mark success. Receipts state `not_a_charge`; no billing/energy event is emitted. Failed, private or unexpected tool results never become a successful public receipt.

## Acceptance remaining

The profile verifier cannot just return true in production. It must prove the dedicated worker has only the reviewed fixture tool, no private context, no default tools or delegation, and authenticated inbound routes. Public serve does not supply that proof or executor. Next: real authenticated scoped-worker integration using a mock model, then actual conversation task/read/reload acceptance. Prior native-model tool proof remains separate and must not be repeated from a monitor.

Tests here exercise real local persistence/HTTP with executor doubles. They are not real Eve task or production account acceptance. No worker/model/service is started by the test suite.

Protected profile integration now has an opt-in actual Eve test:
`TARX_TEST_WORKER=1 node --experimental-strip-types --test tarx-public-worker.integration.test.ts`.
It uses a disposable mock model and child worker, verifies unauthenticated session creation cannot invoke the model, then actual SDK idle/create/send, fixed-tool receipt, worker restart and durable session replay with no duplicate call. This is not browser/production account acceptance. The profile denies sandbox opening and disables optional sandbox auto-install. Eve0.83.2 accepts `queue`/`steer`, not `reject`; this adapter uses queue only for a newly created, exclusively owned idle session behind the persistent no-resubmit ledger.
Public serve remains executor-free. Profile file verification alone does not attest an arbitrary remote worker or provide OS isolation; enabling a production executor still requires a trusted owned-worker lifecycle binding.

Owned lifecycle now uses `eve build --skip-sandbox-prewarm` once, then `eve start --no-schedules` on loopback. It checks authenticated runtime discovery contains exactly the one reviewed static tool and zero dynamic tools before becoming trusted. The actual mock test exercises this production build/start path and same-build restart. No Docker/sandbox/model is started; the authored sandbox still refuses opening. The production public CLI entry and task-capability/approval discovery are not yet registered.

Candidate explicit command (not released):
`tarx runtime serve-check --worker-root NEW_DIRECTORY --model-url http://127.0.0.1:PORT/v1 --model-id MODEL --worker-port PORT`
The installed wrapper supplies eve-root. This builds/starts only the dedicated scoped worker, not the model, and exposes the paired listener. Existing `serve` remains read-only. Use a new worker-root; reusing an existing root fails rather than replacing files. Same-process worker recovery is tested; reopening a worker profile after CLI exit/OS restart is not implemented yet, so this is not an always-on service claim.

`GET /task-capabilities` requires the pinned Origin and valid unrevoked pairing bearer. Returns `{available_tasks:string[],permitted_tasks:string[]}` from actual trusted worker discovery intersected with stored task scopes; no executor yields empty lists, revoked bearer401, discovery failure503. Merely pairing does not grant execution. Approve separately with `tarx runtime approve --challenge CODE --task read_launch_note`. Model responsiveness stays false until an actual outcome; inventory is not a model-performance claim.

Candidate saved-profile reopening: repeat the same serve-check arguments with `--resume true`. Exact authored content/model configuration and dependency link must match; changes fail without overwriting files. A held `.runtime.lock` rejects another owner; no stale-lock forcing. Fresh worker authentication is generated for each owner. Build output is regenerated from validated sources; durable `.eve` workflow state, owner/task ledger and scoped pairing state are reused. Clean entry teardown/recreation and fresh worker-object recovery are tested with a mock model. Abrupt CLI crash/stale-lock recovery and actual OS reboot remain unproved; an orphan/held lock requires operator recovery, not automatic deletion.
