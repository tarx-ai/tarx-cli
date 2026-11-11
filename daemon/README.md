# TARX daemon v2

The local coordination core for TARX tasks. One daemon per installation. It owns
durable task state, one execution owner per task, a transactional outbox, event
deduplication and service supervision.

This is **not** a port of DeepSeek's research prototype. It adopts the durable
coordination pattern — one coordinator, isolated workers, filtered events,
durable state, an outbox written with the result — while keeping TARX's existing
principal, consent, cancellation and uncertain-dispatch rules. The prototype's
workers run as the operating-system user and its recovery resumes interrupted
assignments; TARX does not copy either behavior. See
[DeepSeek architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)
for the reference pattern and its explicit research-code boundary.

## Invariants

1. **One active task per `(owner_id, install_id)`.** Enforced by a partial unique
   index, not only by a read-then-write check.
2. **One execution owner per task.** `claimTask` returns a monotonically
   increasing `fencing_token`; heartbeat, completion and settlement require the
   same `(worker_id, fencing_token)`.
3. **Completion and outbox are one transaction.** A completed task cannot exist
   without its queued result, and a result cannot be queued twice.
4. **Expired work is uncertain, never replayed.** A lease that expires marks the
   task `uncertain`, clears the lease, and records an event. The task is not
   returned to the queue.
5. **Delivery is idempotent.** Every outbox row has a deterministic
   `delivery_id` and a unique `idempotency_key`. Retry uses the same key.
6. **Events are filtered before model/tool work.** Duplicate ids and sequences,
   private reasoning traces, and unchanged health payloads do not create new
   work.
7. **Service ownership is PID + process-instance identity.** A recycled PID does
   not authorize a signal or a restart.

## Layout

```
daemon/
  bin/tarxd              entrypoint shim
  src/
    main.ts              composition root, SQLite lock, recovery loop, coordinator, loopback HTTP
    lock.ts              crash-safe exclusive startup lock (SQLite transaction)
    coordinator.ts       one-owner task loop and outbox drain
    adapters/
      computer-receipts.ts  read-only import of the existing computer-task ledger
    store.ts             SQLite/WAL task ledger, leases, outbox, events
    schema.ts            schema v1 and migration guard
    sqlite.ts            node:sqlite adapter and IMMEDIATE transaction helper
    supervisor.ts        service start/stop/recover with identity checks
    http.ts              /healthz, /readyz, /metrics on loopback
    errors.ts            stable error codes
  test/
    store.test.ts        leases, fences, outbox, dedup, recovery
    http.test.ts         health/readiness/metrics
    supervisor.test.ts   idempotent start, owned stop, PID reuse refusal
```

`daemon/bin/tarxd --state-dir DIR --once` opens the store, recovers expired
leases, runs one coordinator tick when adapters are supplied, and exits.
`--check` does the same without serving. The default run binds
`127.0.0.1:3272`; the listener exposes health only.

The launcher owns one `createCoordinator` when both an executor and a delivery
adapter are supplied (`DaemonOptions.executor` and `DaemonOptions.delivery`).
`--receipt-ledger FILE` imports completed rows from the existing desktop
`computer-tasks.json` into the transactional outbox. The import is read-only,
validates the execution-exit proof, and uses a deterministic idempotency key; a
second import is an `existing` result, not a second delivery.

## State

`<state>/daemon.sqlite` is the only state file. WAL mode gives one writer and
concurrent readers. `PRAGMA synchronous=NORMAL`, `foreign_keys=ON` and
`busy_timeout=5000` are set at open. Schema version 1 is refused if the file is
newer.

| Table | Purpose |
| --- | --- |
| `tasks` | Durable task row, status, priority, request/result JSON, lease, fence, attempt |
| `outbox` | Result/cancellation payload, idempotency key, delivery state, backoff |
| `events` | Deduplicated event metadata; private reasoning payloads are not stored |
| `workers` | Live worker record, capacity, heartbeat |
| `health_state` | Last health digest per worker for unchanged-health filtering |
| `meta` | Schema version |

The request body is bounded to 64 KiB, a result to 128 KiB, an outbox payload to
96 KiB, and an event payload to 32 KiB. The outbox is not a general message
store.

## Task lifecycle

```
queued -> running -> completed -> outbox(pending -> delivering -> delivered)
                  -> failed
                  -> cancelled -> outbox(cancelled)
                  -> uncertain  (lease expired; no replay)
```

`claimTask` picks the oldest queued row (priority first), increments
`fencing_token`, sets the lease and returns the row. A worker that loses its
lease can still finish its local process, but its completion is rejected as
`stale_fence`. This is the same fencing rule a distributed queue uses, applied
to one local SQLite writer.

`completeTask` verifies the fence, writes the task result and the outbox row in
one `BEGIN IMMEDIATE` transaction, then records `task.completed`. A repeated
completion with the same task/fence/delivery is idempotent and returns the
existing outbox row.

`recoverExpired` is the only recovery path. It marks expired leases `uncertain`,
records `task.uncertain`, and frees the owner slot. It never requeues the task.
A new explicit request is required to try the work again.

## Outbox and delivery

A delivery row carries the result payload, the originating channel/agent, a
deterministic `delivery_id` and a unique `idempotency_key`. `claimDeliveries`
leases a bounded page to a delivery worker. `ackDelivery` marks it delivered;
`failDelivery` applies exponential backoff (1s doubling to 60s) and moves the row
to `dead` after the configured attempts. `recoverExpiredDeliveries` returns an
expired delivery lease to `pending` with the same key, so a lost acknowledgement
does not create a second logical message.

The outbox is intentionally not the product channel. The paired listener or the
desktop channel adapter reads the row and performs the existing authenticated
write. Deduplication at that adapter uses the same `idempotency_key`.

## Receipt recovery

A completed result is not only a task row. `completeTask` writes the task result
and its outbox row in one transaction. The outbox row carries the originating
channel/agent, a bounded payload, a deterministic `delivery_id` and an
`idempotency_key`.

That is the durable half of the desktop receipt problem:

- the result survives a daemon or Electron restart;
- the channel adapter can read the row without replaying the task;
- a repeated delivery uses the same key, so a lost acknowledgement does not
  produce a second message;
- a task that was interrupted before completion becomes `uncertain` and has no
  outbox row. It cannot be presented as a completed receipt.

The outbox is not a generic ledger read. A receipt reader must still verify the
account, install, channel, agent and request identity before returning the
payload, and must not expose raw execution proof.

## Events

`recordEvent` accepts an event id, task id, sequence, type and bounded payload.
It filters before any model or tool call:

- duplicate `event_id` or `(task_id, sequence)` → `duplicate`;
- `reasoning.*`, `thought.*`, `trace.*` → metadata stored, payload dropped;
- `health` with the same digest as the last health event for that worker →
  `unchanged_health`.

A stored event is an audit fact, not an instruction. It does not grant a task,
scope or delivery.

## Supervisor

The supervisor owns long-lived local services (inference, embeddings, mesh, or a
future worker host). It records `{name, pid, identity, startedAt}` in
`<state>/services/<name>.json` with mode 0600. `identity` is a hash of the PID
and the OS process start/command. `stop` refuses a record whose identity no
longer matches; a PID reused by an unrelated process cannot be killed. `start`
is idempotent while the owned process is alive.

The supervisor does not run workers as root, does not install an OS service, and
does not create a login item. Those are packaging decisions outside this core.

## Capacity model for the first million users

The first-million target is a **per-install** model, not one central SQLite
file:

- Each install has its own daemon and database. There is no global write lock,
  no shared task table and no cross-user queue.
- A daemon handles one owner/install pair. The unique active-task index makes
  overload visible as `task_owner_busy`, not as duplicate execution.
- WAL readers keep `/healthz`, `/readyz` and metrics available while a writer
  commits a task/outbox transaction.
- Outbox and event retention must be bounded by age and count. A million installs
  do not justify unbounded local tables.
- The cloud control plane, if added, owns aggregate counters and account-level
  quotas. It does not own local task leases or local receipts.

The daemon does not claim global throughput from a local benchmark. Capacity
work still needs: a concurrent claim/complete benchmark on the target Mac, a
1M-install aggregate model, disk/retention limits, and a crash/power-loss test on
the packaged Node runtime.

## Migration from the existing runtime

The existing `runtime/tarx-bounded-task.ts` and `tarx-computer-task.ts` remain
the execution adapters. They already enforce one-in-flight work and uncertain
dispatch for their specific task types. The v2 store is the durable core they
can write through next:

1. Replace the JSON `tasks.json` reservation/transition with `submitTask`,
   `claimTask`, `completeTask` and `settleTask`.
2. Move their terminal receipt into the same transaction as the outbox row.
3. Have the paired listener claim deliveries and acknowledge by
   `idempotency_key`.
4. Retire the shell `service_owner` path after the supervisor is wired to
   `tarx start/stop`.

The old modules are not deleted in this change. Removing them before the adapter
exists would create two half-daemons; the migration is deliberately staged.

## Test

```sh
cd daemon
node --test --experimental-strip-types test/*.test.ts
node --experimental-strip-types src/main.ts --check --state-dir /tmp/tarx-daemon-check
```
