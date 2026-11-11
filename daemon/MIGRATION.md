# Daemon v2 migration

The new core is `daemon/`. It does not replace the product runtime in one jump.
The old modules still carry principal, consent, computer-action and paired
listener behavior that must move through tests, not a folder rename.

## Mapping

| Existing | Responsibility | v2 replacement | Migration gate |
| --- | --- | --- | --- |
| `runtime/tarx-bounded-task.ts` | JSON reservation, status, one-in-flight, dispatch uncertainty | `daemon/src/store.ts` (`submitTask`, `claimTask`, `settleTask`, `completeTask`) | Existing bounded-task tests pass against the store; receipt and event mapping preserved |
| `runtime/tarx-computer-task.ts` | Computer-task ledger, Stop, execution-exit proof, recovery authority | `daemon/src/store.ts` task row + event table; proof remains in the adapter | Existing computer-task tests pass; no replay on recovery; proof is not exposed |
| `runtime/tarx-eve-listener.ts` | Paired loopback read/attach and owner cursor | `daemon/src/store.ts` outbox + the existing listener as delivery adapter | Read cursor and ack semantics preserved; outbox key is used for dedup |
| `runtime/tarx-runtime-entry.ts` | Composition root and foreground serving | `daemon/src/main.ts` plus the existing runtime entry | One process owner; no second daemon; CLI start/stop remains explicit |
| shell `service_owner` in `tarx` | PID record + identity + start/stop | `daemon/src/supervisor.ts` | Start/stop/recover tests pass on the target macOS/Linux hosts |
| ad-hoc health checks | reachability only | `daemon/src/http.ts` `/healthz`, `/readyz`, `/metrics` | Readiness includes DB; it does not claim model responsiveness |

## Deletion criteria

Delete an old module only when all are true:

1. The replacement has parity tests for its current public behavior.
2. The product runtime imports the replacement, not a parallel path.
3. A packaged app run has exercised restart, cancellation and uncertain
   dispatch against the replacement.
4. No rollback plan depends on the old file.

Until then, the old modules are adapters, not competing daemons. The v2 core is
the only writer of the SQLite ledger; adapters call it.

## What not to copy from the research prototype

- Workers running with full OS-user access without an isolation boundary.
- Automatic resume of an interrupted assignment after uncertain dispatch.
- A general-purpose effect/plugin system before TARX has one owner and one
  receipt contract.
- Unbounded event/task retention.

TARX keeps its existing principal, consent, Stop, execution-exit proof and
cancellation semantics.
