# Daemon runbook

## Health

```sh
daemon/bin/tarxd --check --state-dir "$HOME/.tarx/state/daemon"
curl -fsS http://127.0.0.1:3272/healthz
curl -fsS http://127.0.0.1:3272/readyz
curl -fsS http://127.0.0.1:3272/metrics
```

`healthz` reports process uptime and task/outbox counts. `readyz` is the database
check; it is not model readiness and not channel readiness. `metrics` is
Prometheus text, bounded to counters.

## Stuck queue

1. `stats.tasks.queued` rising and `running` zero: no worker claims. Check the
   worker adapter, not SQLite.
2. `running` with an old `lease_expires_at`: the worker is gone or stalled. Run
   `recoverExpired`; the row becomes `uncertain`. Do not edit the status by hand.
3. `task_owner_busy` on submit: the owner already has an active task. Read that
   task; do not create a second one.

## Stuck outbox

1. `outbox.pending` with `next_attempt_at` in the future: backoff. Wait or fix
   the channel.
2. `outbox.dead`: inspect `last_error`. The result is not lost; the row is
   terminal. A corrected channel can be retried with the same idempotency key by
   an operator tool, not by editing SQLite.
3. `delivering` with an expired lease: `recoverExpiredDeliveries` returns it to
   `pending` with the same key.

## Daemon will not start

- `daemon_already_running`: another process holds the SQLite exclusive lock in
  `<state>/daemon.lock.sqlite`. Do not delete the file while that process is
  alive. If the process was killed, the OS released the lock; retry the daemon.
  The file may remain on disk; it is not the ownership proof.
- `schema_newer`: the binary is older than the database. Upgrade the daemon; do
  not downgrade the file.
- `service_record_invalid` / `service_owner_changed`: a service record is unsafe
  or the PID was reused. Inspect the process; do not signal an unverified PID.
- Disk full: free space and retry. Do not delete WAL/SHM files while the daemon
  is running.

## Recovery

`tarxd --once` performs `recoverExpired`, `recoverExpiredDeliveries` and
`expireWorkers`, then exits. It is the only supported “run recovery now” command.
It never requeues an interrupted task.

## Stop

Send `SIGTERM` to the daemon. It stops the HTTP listener, closes SQLite and
releases the lock. A service supervisor record is removed only after its identity
is verified and the process has exited.

## Do not

- Do not run two daemons on one state directory.
- Do not edit `daemon.sqlite` with an external tool while the daemon is running.
- Do not treat an expired lease as proof that the worker did not act.
- Do not copy a pending outbox payload into a new delivery with a different
  idempotency key.
