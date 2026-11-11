# Daemon capacity and failure model

## Unit of scale

One daemon owns one installation. The first-million target is therefore **one
million independent local ledgers**, not one million rows in a shared table.

```
1,000,000 installs
  -> 1,000,000 daemon processes (idle daemons may be stopped)
  -> 1,000,000 SQLite files on their own disks
  -> no global task lock, no cross-user queue, no shared claim latency
```

The cloud control plane, if added, owns account quotas, aggregate counters and
release metadata. It must not own local leases, receipts or outbox rows.

## Per-daemon limits

| Resource | Limit | Why |
| --- | --- | --- |
| Active task per owner/install | 1 | Partial unique index; prevents duplicate execution |
| Request body | 64 KiB | Bounded task intent |
| Result body | 128 KiB | Bounded receipt/result |
| Outbox payload | 96 KiB | Channel write, not a file store |
| Event payload | 32 KiB | Audit metadata; private traces dropped |
| Delivery claim page | 100 | Bounded transaction |
| Delivery attempts | 1–32 (default 8) | Bounded retry, then dead |
| Task lease | 1–300 s | Short enough to recover, long enough to heartbeat |
| Event/task retention | **not yet bounded** | Must be added before long-lived installs |

## Throughput assumptions

These are design constraints, not measured TARX throughput:

- A local daemon handles one user's serial work; the one-active-task fence
  deliberately caps concurrent execution for that owner.
- Claim/complete transactions are short and serialized by SQLite. WAL readers do
  not block the writer.
- At 1M installs, the aggregate request rate is the sum of independent local
  rates. There is no per-claim global round trip.
- A 1% daily-active cohort is 10,000 daemons with work. The control plane must
  size auth/telemetry for that aggregate; it must not proxy task claims.

## Storage growth

Worst case per install:

- one task row per completed request;
- one outbox row per channel result;
- events per task are bounded by the adapter, not by the store.

A 100-task/day install creates 36,500 tasks/year. At ~2 KiB per task row and
~1 KiB per outbox row, that is under 150 MiB/year before events. Events dominate
only if an adapter writes an event per token; it must not. Add a retention job
before the first long-lived release:

- delete `delivered` outbox rows older than 30 days after the channel receipt is
  durable;
- delete terminal task rows and their events after 90 days, keeping only a daily
  aggregate counter;
- run `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM` on a maintenance command,
  never in the request path.

## SLOs to measure

| SLO | Target | Measurement |
| --- | --- | --- |
| `submitTask` p99 | < 20 ms local | SQLite transaction timing |
| `claimTask` p99 | < 20 ms local | transaction timing |
| completion + outbox atomicity | 100% | no completed row without outbox; invariant test |
| uncertain recovery | no replay | `recoverExpired` never returns a task to `queued` |
| delivery retry | bounded, idempotent | same `idempotency_key` across attempts |
| health endpoint | 200 while DB open | WAL reader |
| ready endpoint | 503 on DB failure | `ping` |

No latency percentile is claimed here. Measure on the target Mac and the
supported Linux hosts before publishing an SLO.

## Failure domains

| Failure | Behavior |
| --- | --- |
| Worker dies mid-task | Lease expires; task becomes `uncertain`; no replay. A new explicit request is needed. |
| Worker stalls but is alive | Heartbeat expires the lease; completion is rejected as `stale_fence`. |
| Daemon dies after completion, before delivery | Outbox row survives; next daemon claims it. |
| Delivery ack lost | Lease expires; row returns to `pending`; same idempotency key; channel dedups. |
| Duplicate completion | Returns the existing outbox row. |
| Duplicate event | Dedup by event id and `(task, sequence)`. |
| Reasoning/private trace | Payload dropped; metadata only. |
| Unchanged health | Filtered; no new work. |
| Disk full | SQLite write fails; health/ready fail closed; no receipt is invented. |
| Corrupt DB | Daemon refuses to start; operator restores or starts a new state dir. |
| PID reuse | Supervisor refuses to signal; record is not treated as ownership. |
| Clock jump forward | Leases expire early; tasks become uncertain, never replay. |
| Clock jump backward | Leases last longer; a live worker's heartbeat still fences. |

## Security boundaries

- SQLite file mode 0600; state directory 0700.
- Loopback HTTP only; no remote task submission.
- Outbox payloads contain bounded result metadata, not credentials or raw native
  evidence.
- Events do not store private reasoning traces.
- The daemon does not grant account, computer or model authority. Those remain
  with the existing principal, consent and cancellation paths.
- Workers run as the daemon's OS user until a separate isolation boundary is
  implemented. Do not copy the research prototype's full-access worker model and
  call it production isolation.

## Rollout

1. Ship the core with adapter tests; no old path removed.
2. Run one packaged install with a bounded task, kill the daemon mid-task, and
   prove `uncertain` plus no replay.
3. Kill after completion but before delivery; prove the outbox row is delivered
   once with the same idempotency key.
4. Add retention and a maintenance command.
5. Only then delete the JSON task controller.
