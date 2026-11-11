import {createHash, randomUUID} from "node:crypto"

import {DaemonError} from "./errors.ts"
import {migrate} from "./schema.ts"
import {openSqlite, transaction, type SqliteDatabase} from "./sqlite.ts"

export type TaskStatus = "queued" | "leased" | "running" | "completed" | "failed" | "cancelled" | "uncertain"
export type DeliveryStatus = "pending" | "delivering" | "delivered" | "dead"

export type TaskInput = {
  taskId?: string
  ownerId: string
  installId: string
  channelId: string
  agentId: string
  kind: string
  request: unknown
  priority?: number
}

export type TaskRecord = {
  task_id: string
  owner_id: string
  install_id: string
  channel_id: string
  agent_id: string
  kind: string
  status: TaskStatus
  priority: number
  request: unknown
  result: unknown | null
  error_code: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
  lease_owner: string | null
  lease_expires_at: number | null
  fencing_token: number
  attempt: number
  delivery_id: string | null
}

export type DeliveryInput = {
  kind: string
  channelId?: string
  agentId?: string
  payload: unknown
  idempotencyKey?: string
  maxAttempts?: number
}

export type OutboxRecord = {
  delivery_id: string
  task_id: string
  owner_id: string
  channel_id: string
  agent_id: string
  kind: string
  idempotency_key: string
  payload: unknown
  status: DeliveryStatus
  attempts: number
  next_attempt_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  last_error: string | null
  created_at: number
  delivered_at: number | null
}

export type EventInput = {
  eventId: string
  taskId: string
  sequence: number
  type: string
  payload?: unknown
  workerId?: string
}

export type EventResult = {
  status: "stored" | "duplicate" | "filtered"
  reason?: "duplicate_id" | "duplicate_sequence" | "private_trace" | "unchanged_health"
}

export type WorkerInput = {
  workerId: string
  kind: string
  pid?: number | null
  capacity?: number
}

export type StoreStats = {
  schema: number
  tasks: Record<TaskStatus, number>
  outbox: Record<DeliveryStatus, number>
  workers: number
  oldest_queued_at: number | null
}

const TASK_ID = /^[A-Za-z0-9_-]{8,80}$/
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,79}$/
const MAX_REQUEST = 64 * 1024
const MAX_RESULT = 128 * 1024
const MAX_PAYLOAD = 96 * 1024
const MAX_EVENT = 32 * 1024
const MIN_LEASE_MS = 1_000
const MAX_LEASE_MS = 5 * 60_000
const MAX_DELIVERY_ATTEMPTS = 8
const MAX_LIMIT = 100
const PRIVATE_TRACE = /^(reasoning|thought|trace)\./

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function encoded(value: unknown, limit: number): string {
  const text = JSON.stringify(value)
  if (typeof text !== "string" || Buffer.byteLength(text) > limit) throw new DaemonError("payload_too_large", 413)
  return text
}

function assertId(value: unknown, re: RegExp, field: string): string {
  if (typeof value !== "string" || !re.test(value)) throw new DaemonError(`invalid_${field}`, 400)
  return value
}

function assertLease(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < MIN_LEASE_MS || (value as number) > MAX_LEASE_MS) throw new DaemonError("invalid_lease", 400)
  return value as number
}

function assertLimit(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) throw new DaemonError("invalid_limit", 400)
  return value as number
}

function deliveryId(taskId: string, kind: string, channelId: string, agentId: string): string {
  return `dly_${createHash("sha256").update([taskId, kind, channelId, agentId].join("\u0000")).digest("hex").slice(0, 32)}`
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

function mapTask(row: Record<string, any>): TaskRecord {
  return {
    task_id: row.task_id,
    owner_id: row.owner_id,
    install_id: row.install_id,
    channel_id: row.channel_id,
    agent_id: row.agent_id,
    kind: row.kind,
    status: row.status,
    priority: Number(row.priority),
    request: JSON.parse(row.request_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error_code: row.error_code ?? null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    started_at: row.started_at === null ? null : Number(row.started_at),
    finished_at: row.finished_at === null ? null : Number(row.finished_at),
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    fencing_token: Number(row.fencing_token),
    attempt: Number(row.attempt),
    delivery_id: row.delivery_id ?? null,
  }
}

function mapOutbox(row: Record<string, any>): OutboxRecord {
  return {
    delivery_id: row.delivery_id,
    task_id: row.task_id,
    owner_id: row.owner_id,
    channel_id: row.channel_id,
    agent_id: row.agent_id,
    kind: row.kind,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attempts: Number(row.attempts),
    next_attempt_at: Number(row.next_attempt_at),
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    last_error: row.last_error ?? null,
    created_at: Number(row.created_at),
    delivered_at: row.delivered_at === null ? null : Number(row.delivered_at),
  }
}

export function createDaemonStore(input: {file: string; now?: () => number; maxDeliveryAttempts?: number}) {
  const db: SqliteDatabase = openSqlite(input.file)
  migrate(db)
  const now = input.now ?? Date.now
  const maxAttempts = input.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) throw new DaemonError("invalid_delivery_attempts", 400)
  const cache = new Map<string, ReturnType<SqliteDatabase["prepare"]>>()
  const statement = (sql: string) => {
    let value = cache.get(sql)
    if (!value) {
      value = db.prepare(sql)
      cache.set(sql, value)
    }
    return value
  }
  const tx = <T>(work: () => T): T => transaction(db, work)
  const getTask = (taskId: string): TaskRecord | null => {
    const row = statement("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, any> | undefined
    return row ? mapTask(row) : null
  }
  const outboxFor = (id: string): OutboxRecord | null => {
    const row = statement("SELECT * FROM outbox WHERE delivery_id = ?").get(id) as Record<string, any> | undefined
    return row ? mapOutbox(row) : null
  }
  const nextSequence = (taskId: string): number => {
    const row = statement("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM events WHERE task_id = ?").get(taskId) as {next: number}
    return Number(row.next)
  }
  const insertEvent = (event: EventInput, payloadJson: string | null): void => {
    statement(`INSERT INTO events(event_id, task_id, sequence, type, digest, payload_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
      event.eventId,
      event.taskId,
      event.sequence,
      event.type,
      digest(event.payload ?? null),
      payloadJson,
      now(),
    )
  }
  const enqueue = (task: TaskRecord, delivery: DeliveryInput): OutboxRecord => {
    const channelId = delivery.channelId ?? task.channel_id
    const agentId = delivery.agentId ?? task.agent_id
    assertId(channelId, OPAQUE, "channel")
    assertId(agentId, OPAQUE, "agent")
    assertId(delivery.kind, KIND, "delivery_kind")
    const payloadJson = encoded(delivery.payload, MAX_PAYLOAD)
    const id = deliveryId(task.task_id, delivery.kind, channelId, agentId)
    const idempotencyKey = delivery.idempotencyKey ?? id
    assertId(idempotencyKey, OPAQUE, "idempotency_key")
    const existing = statement("SELECT * FROM outbox WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, any> | undefined
    if (existing) {
      if (existing.task_id !== task.task_id) throw new DaemonError("delivery_key_conflict", 409)
      return mapOutbox(existing)
    }
    const at = now()
    statement(`INSERT INTO outbox(
      delivery_id, task_id, owner_id, channel_id, agent_id, kind, idempotency_key,
      payload_json, status, attempts, next_attempt_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
      id,
      task.task_id,
      task.owner_id,
      channelId,
      agentId,
      delivery.kind,
      idempotencyKey,
      payloadJson,
      at,
      at,
    )
    return outboxFor(id) as OutboxRecord
  }

  return {
    db,
    close(): void {
      cache.clear()
      db.close()
    },

    ping(): boolean {
      try {
        statement("SELECT 1 AS ok").get()
        return true
      } catch {
        return false
      }
    },

    submitTask(input: TaskInput): TaskRecord {
      const ownerId = assertId(input.ownerId, OPAQUE, "owner")
      const installId = assertId(input.installId, OPAQUE, "install")
      const channelId = assertId(input.channelId, OPAQUE, "channel")
      const agentId = assertId(input.agentId, OPAQUE, "agent")
      const kind = assertId(input.kind, KIND, "kind")
      const requestJson = encoded(input.request, MAX_REQUEST)
      const taskId = assertId(input.taskId ?? randomUUID(), TASK_ID, "task")
      const priority = Number.isInteger(input.priority) ? (input.priority as number) : 0
      if (priority < -1000 || priority > 1000) throw new DaemonError("invalid_priority", 400)
      const at = now()
      return tx(() => {
        const existing = getTask(taskId)
        if (existing) return existing
        const active = statement("SELECT task_id FROM tasks WHERE owner_id = ? AND install_id = ? AND status IN ('queued','leased','running') LIMIT 1").get(ownerId, installId)
        if (active) throw new DaemonError("task_owner_busy", 409)
        try {
          statement(`INSERT INTO tasks(
            task_id, owner_id, install_id, channel_id, agent_id, kind, status, priority,
            request_json, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(
            taskId, ownerId, installId, channelId, agentId, kind, priority, requestJson, at, at,
          )
        } catch (error: any) {
          if (String(error?.message ?? "").includes("UNIQUE")) throw new DaemonError("task_owner_busy", 409)
          throw error
        }
        return getTask(taskId) as TaskRecord
      })
    },

    /** One-way import of an already-verified external completion (for example
     * the desktop computer-task ledger). The task row and its outbox row are
     * written together; an existing task/outbox is returned, never duplicated. */
    importCompletedTask(input: {taskId: string; ownerId: string; installId: string; channelId: string; agentId: string; kind: string; request: unknown; result: unknown; delivery: DeliveryInput}): {task: TaskRecord; delivery: OutboxRecord; imported: boolean} {
      const taskId = assertId(input.taskId, TASK_ID, "task")
      const ownerId = assertId(input.ownerId, OPAQUE, "owner")
      const installId = assertId(input.installId, OPAQUE, "install")
      const channelId = assertId(input.channelId, OPAQUE, "channel")
      const agentId = assertId(input.agentId, OPAQUE, "agent")
      const kind = assertId(input.kind, KIND, "kind")
      const requestJson = encoded(input.request, MAX_REQUEST)
      const resultJson = encoded(input.result, MAX_RESULT)
      const at = now()
      return tx(() => {
        const existing = getTask(taskId)
        if (existing) {
          if (existing.status !== "completed" || !existing.delivery_id) throw new DaemonError("task_exists", 409)
          const delivery = outboxFor(existing.delivery_id)
          if (!delivery) throw new DaemonError("outbox_missing", 503)
          return {task: existing, delivery, imported: false}
        }
        statement(`INSERT INTO tasks(
          task_id, owner_id, install_id, channel_id, agent_id, kind, status, priority,
          request_json, result_json, created_at, updated_at, started_at, finished_at, delivery_id
        ) VALUES(?, ?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, ?, ?, NULL)`).run(
          taskId, ownerId, installId, channelId, agentId, kind, requestJson, resultJson, at, at, at, at,
        )
        const task = getTask(taskId) as TaskRecord
        const delivery = enqueue(task, input.delivery)
        statement("UPDATE tasks SET delivery_id = ?, updated_at = ? WHERE task_id = ?").run(delivery.delivery_id, at, taskId)
        insertEvent({
          eventId: `task.imported:${taskId}`,
          taskId,
          sequence: nextSequence(taskId),
          type: "task.imported",
          payload: {task_id: taskId, delivery_id: delivery.delivery_id},
        }, JSON.stringify({task_id: taskId, delivery_id: delivery.delivery_id}))
        return {task: getTask(taskId) as TaskRecord, delivery, imported: true}
      })
    },

    claimTask(workerId: string, leaseMs: number): TaskRecord | null {
      assertId(workerId, OPAQUE, "worker")
      const lease = assertLease(leaseMs)
      const at = now()
      return tx(() => {
        const next = statement("SELECT task_id FROM tasks WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1").get() as {task_id: string} | undefined
        if (!next) return null
        const row = statement(`UPDATE tasks SET
          status = 'running', lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1,
          attempt = attempt + 1, started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE task_id = ? AND status = 'queued'
          RETURNING *`).get(workerId, at + lease, at, at, next.task_id) as Record<string, any> | undefined
        return row ? mapTask(row) : null
      })
    },

    heartbeatTask(taskId: string, workerId: string, fencingToken: number, leaseMs: number): TaskRecord {
      assertId(taskId, TASK_ID, "task")
      assertId(workerId, OPAQUE, "worker")
      if (!Number.isInteger(fencingToken) || fencingToken < 1) throw new DaemonError("invalid_fencing_token", 400)
      const lease = assertLease(leaseMs)
      const at = now()
      const row = statement(`UPDATE tasks SET lease_expires_at = ?, updated_at = ?
        WHERE task_id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
        RETURNING *`).get(at + lease, at, taskId, workerId, fencingToken) as Record<string, any> | undefined
      if (!row) throw new DaemonError("stale_fence", 409)
      return mapTask(row)
    },

    completeTask(input: {taskId: string; workerId: string; fencingToken: number; result: unknown; delivery: DeliveryInput}): {task: TaskRecord; delivery: OutboxRecord; deduplicated: boolean} {
      const taskId = assertId(input.taskId, TASK_ID, "task")
      const workerId = assertId(input.workerId, OPAQUE, "worker")
      if (!Number.isInteger(input.fencingToken) || input.fencingToken < 1) throw new DaemonError("invalid_fencing_token", 400)
      const resultJson = encoded(input.result, MAX_RESULT)
      return tx(() => {
        const task = getTask(taskId)
        if (!task) throw new DaemonError("task_not_found", 404)
        if (task.status === "completed") {
          const existing = task.delivery_id ? outboxFor(task.delivery_id) : null
          if (!existing) throw new DaemonError("task_already_completed", 409)
          return {task, delivery: existing, deduplicated: true}
        }
        if (task.status !== "running" && task.status !== "leased") throw new DaemonError("task_not_running", 409)
        if (task.lease_owner !== workerId || task.fencing_token !== input.fencingToken) throw new DaemonError("stale_fence", 409)
        const delivery = enqueue(task, input.delivery)
        const at = now()
        const row = statement(`UPDATE tasks SET
          status = 'completed', result_json = ?, delivery_id = ?, finished_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL
          WHERE task_id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
          RETURNING *`).get(resultJson, delivery.delivery_id, at, at, taskId, workerId, input.fencingToken) as Record<string, any> | undefined
        if (!row) throw new DaemonError("stale_fence", 409)
        insertEvent({
          eventId: `task.completed:${taskId}`,
          taskId,
          sequence: nextSequence(taskId),
          type: "task.completed",
          payload: {task_id: taskId, delivery_id: delivery.delivery_id},
        }, JSON.stringify({task_id: taskId, delivery_id: delivery.delivery_id}))
        return {task: mapTask(row), delivery, deduplicated: false}
      })
    },

    settleTask(input: {taskId: string; workerId: string; fencingToken: number; status: "failed" | "cancelled" | "uncertain"; errorCode?: string; delivery?: DeliveryInput}): {task: TaskRecord; delivery: OutboxRecord | null} {
      const taskId = assertId(input.taskId, TASK_ID, "task")
      const workerId = assertId(input.workerId, OPAQUE, "worker")
      if (!Number.isInteger(input.fencingToken) || input.fencingToken < 1) throw new DaemonError("invalid_fencing_token", 400)
      if (!["failed", "cancelled", "uncertain"].includes(input.status)) throw new DaemonError("invalid_status", 400)
      const errorCode = input.errorCode ? assertId(input.errorCode, KIND, "error_code") : null
      return tx(() => {
        const task = getTask(taskId)
        if (!task) throw new DaemonError("task_not_found", 404)
        if (task.status !== "running" && task.status !== "leased") throw new DaemonError("task_not_running", 409)
        if (task.lease_owner !== workerId || task.fencing_token !== input.fencingToken) throw new DaemonError("stale_fence", 409)
        const delivery = input.status === "cancelled" && input.delivery ? enqueue(task, input.delivery) : null
        const at = now()
        const row = statement(`UPDATE tasks SET
          status = ?, error_code = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE task_id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ?
          RETURNING *`).get(input.status, errorCode, at, at, taskId, workerId, input.fencingToken) as Record<string, any> | undefined
        if (!row) throw new DaemonError("stale_fence", 409)
        insertEvent({
          eventId: `task.${input.status}:${taskId}`,
          taskId,
          sequence: nextSequence(taskId),
          type: `task.${input.status}`,
          payload: {task_id: taskId, error_code: errorCode},
        }, JSON.stringify({task_id: taskId, error_code: errorCode}))
        return {task: mapTask(row), delivery}
      })
    },

    /** Expire every lease that outlived its worker. An expired assignment is
     * uncertain, never re-queued: the worker may have executed before it died. */
    recoverExpired(nowMs = now()): {count: number; task_ids: string[]} {
      return tx(() => {
        const rows = statement(`UPDATE tasks SET
          status = 'uncertain', error_code = 'lease_expired', finished_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL
          WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          RETURNING *`).all(nowMs, nowMs, nowMs) as Record<string, any>[]
        for (const row of rows) {
          insertEvent({
            eventId: `task.uncertain:${row.task_id}`,
            taskId: row.task_id,
            sequence: nextSequence(row.task_id),
            type: "task.uncertain",
            payload: {task_id: row.task_id, reason: "lease_expired"},
          }, JSON.stringify({task_id: row.task_id, reason: "lease_expired"}))
        }
        return {count: rows.length, task_ids: rows.map((row) => row.task_id)}
      })
    },

    recordEvent(event: EventInput): EventResult {
      const eventId = assertId(event.eventId, EVENT_ID, "event")
      const taskId = assertId(event.taskId, TASK_ID, "task")
      if (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > 1_000_000_000) throw new DaemonError("invalid_sequence", 400)
      const type = assertId(event.type, EVENT_TYPE, "event_type")
      const payloadJson = PRIVATE_TRACE.test(type) ? null : encoded(event.payload ?? null, MAX_EVENT)
      const workerId = event.workerId ? assertId(event.workerId, OPAQUE, "worker") : null
      return tx(() => {
        if (!getTask(taskId)) throw new DaemonError("task_not_found", 404)
        const duplicateId = statement("SELECT 1 AS found FROM events WHERE event_id = ?").get(eventId)
        if (duplicateId) return {status: "duplicate", reason: "duplicate_id"}
        const duplicateSequence = statement("SELECT 1 AS found FROM events WHERE task_id = ? AND sequence = ?").get(taskId, event.sequence)
        if (duplicateSequence) return {status: "duplicate", reason: "duplicate_sequence"}
        if (PRIVATE_TRACE.test(type)) {
          insertEvent(event, null)
          return {status: "filtered", reason: "private_trace"}
        }
        if (type === "health" && workerId) {
          const next = digest(event.payload ?? null)
          const previous = statement("SELECT digest FROM health_state WHERE worker_id = ?").get(workerId) as {digest: string} | undefined
          if (previous?.digest === next) {
            statement("UPDATE health_state SET updated_at = ? WHERE worker_id = ?").run(now(), workerId)
            return {status: "filtered", reason: "unchanged_health"}
          }
          statement("INSERT INTO health_state(worker_id, digest, updated_at) VALUES(?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at").run(workerId, next, now())
        }
        insertEvent(event, payloadJson)
        return {status: "stored"}
      })
    },

    /** Delivery acknowledgement from the owning conversation host. The task
     * must still belong to the same channel/agent; a repeated ack is idempotent. */
    ackReceipt(input: {requestId: string; channelId: string; agentId: string}): OutboxRecord {
      const requestId = assertId(input.requestId, TASK_ID, "task")
      const channelId = assertId(input.channelId, OPAQUE, "channel")
      const agentId = assertId(input.agentId, OPAQUE, "agent")
      return tx(() => {
        const task = getTask(requestId)
        if (!task || task.status !== "completed" || !task.delivery_id) throw new DaemonError("receipt_not_found", 404)
        if (task.channel_id !== channelId || task.agent_id !== agentId) throw new DaemonError("receipt_identity_mismatch", 403)
        const delivery = outboxFor(task.delivery_id)
        if (!delivery) throw new DaemonError("receipt_not_found", 404)
        if (delivery.status === "delivered") return delivery
        if (delivery.status === "dead") throw new DaemonError("receipt_dead", 409)
        const at = now()
        const updated = statement(`UPDATE outbox SET status = 'delivered', delivered_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error = NULL WHERE delivery_id = ? AND status IN ('pending','delivering')
          RETURNING *`).get(at, delivery.delivery_id) as Record<string, any> | undefined
        return updated ? mapOutbox(updated) : (outboxFor(delivery.delivery_id) as OutboxRecord)
      })
    },

    getTask(taskId: string): TaskRecord | null {
      return getTask(assertId(taskId, TASK_ID, "task"))
    },

    listTasks(input: {status?: TaskStatus; limit?: number; ownerId?: string; installId?: string} = {}): TaskRecord[] {
      const limit = assertLimit(input.limit ?? 50)
      const clauses: string[] = []
      const params: unknown[] = []
      if (input.status) {
        if (!["queued", "leased", "running", "completed", "failed", "cancelled", "uncertain"].includes(input.status)) throw new DaemonError("invalid_status", 400)
        clauses.push("status = ?")
        params.push(input.status)
      }
      if (input.ownerId) {
        clauses.push("owner_id = ?")
        params.push(assertId(input.ownerId, OPAQUE, "owner"))
      }
      if (input.installId) {
        clauses.push("install_id = ?")
        params.push(assertId(input.installId, OPAQUE, "install"))
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
      const rows = statement(`SELECT * FROM tasks ${where} ORDER BY created_at ASC LIMIT ?`).all(...params, limit) as Record<string, any>[]
      return rows.map(mapTask)
    },

    claimDeliveries(workerId: string, limit: number, leaseMs: number): OutboxRecord[] {
      assertId(workerId, OPAQUE, "worker")
      const max = assertLimit(limit)
      const lease = assertLease(leaseMs)
      const at = now()
      return tx(() => {
        const due = statement("SELECT delivery_id FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?").all(at, max) as {delivery_id: string}[]
        const claimed: OutboxRecord[] = []
        for (const row of due) {
          const updated = statement(`UPDATE outbox SET status = 'delivering', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
            WHERE delivery_id = ? AND status = 'pending'
            RETURNING *`).get(workerId, at + lease, row.delivery_id) as Record<string, any> | undefined
          if (updated) claimed.push(mapOutbox(updated))
        }
        return claimed
      })
    },

    ackDelivery(deliveryId: string, workerId: string): OutboxRecord {
      assertId(deliveryId, OPAQUE, "delivery")
      assertId(workerId, OPAQUE, "worker")
      const at = now()
      const row = statement(`UPDATE outbox SET status = 'delivered', delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE delivery_id = ? AND status = 'delivering' AND lease_owner = ?
        RETURNING *`).get(at, deliveryId, workerId) as Record<string, any> | undefined
      if (row) return mapOutbox(row)
      const existing = outboxFor(deliveryId)
      if (existing?.status === "delivered") return existing
      throw new DaemonError("stale_delivery_lease", 409)
    },

    failDelivery(deliveryId: string, workerId: string, error: string): OutboxRecord {
      assertId(deliveryId, OPAQUE, "delivery")
      assertId(workerId, OPAQUE, "worker")
      if (typeof error !== "string" || error.length > 300) throw new DaemonError("invalid_error", 400)
      return tx(() => {
        const row = statement("SELECT * FROM outbox WHERE delivery_id = ?").get(deliveryId) as Record<string, any> | undefined
        if (!row) throw new DaemonError("delivery_not_found", 404)
        if (row.status === "delivered") return mapOutbox(row)
        if (row.status !== "delivering" || row.lease_owner !== workerId) throw new DaemonError("stale_delivery_lease", 409)
        const attempts = Number(row.attempts)
        const status = attempts >= maxAttempts ? "dead" : "pending"
        const next = status === "dead" ? Number(row.next_attempt_at) : now() + backoffMs(attempts)
        const updated = statement(`UPDATE outbox SET status = ?, next_attempt_at = ?, last_error = ?,
          lease_owner = NULL, lease_expires_at = NULL WHERE delivery_id = ? RETURNING *`).get(status, next, error, deliveryId) as Record<string, any>
        return mapOutbox(updated)
      })
    },

    recoverExpiredDeliveries(nowMs = now()): number {
      return tx(() => {
        const dead = statement(`UPDATE outbox SET status = 'dead', lease_owner = NULL, lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'delivery_lease_expired')
          WHERE status = 'delivering' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempts >= ?
          RETURNING delivery_id`).all(nowMs, maxAttempts) as unknown[]
        const pending = statement(`UPDATE outbox SET status = 'pending', next_attempt_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error = COALESCE(last_error, 'delivery_lease_expired')
          WHERE status = 'delivering' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempts < ?
          RETURNING delivery_id`).all(nowMs, nowMs, maxAttempts) as unknown[]
        return dead.length + pending.length
      })
    },

    getDelivery(deliveryId: string): OutboxRecord | null {
      return outboxFor(assertId(deliveryId, OPAQUE, "delivery"))
    },

    listDeliveries(input: {status?: DeliveryStatus; limit?: number} = {}): OutboxRecord[] {
      const limit = assertLimit(input.limit ?? 50)
      if (input.status && !["pending", "delivering", "delivered", "dead"].includes(input.status)) throw new DaemonError("invalid_status", 400)
      const rows = input.status
        ? statement("SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC LIMIT ?").all(input.status, limit)
        : statement("SELECT * FROM outbox ORDER BY created_at ASC LIMIT ?").all(limit)
      return (rows as Record<string, any>[]).map(mapOutbox)
    },

    registerWorker(input: WorkerInput): void {
      const workerId = assertId(input.workerId, OPAQUE, "worker")
      const kind = assertId(input.kind, KIND, "kind")
      const capacity = input.capacity ?? 1
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) throw new DaemonError("invalid_capacity", 400)
      const at = now()
      statement(`INSERT INTO workers(worker_id, kind, pid, state, capacity, started_at, heartbeat_at)
        VALUES(?, ?, ?, 'starting', ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET kind = excluded.kind, pid = excluded.pid, state = 'starting',
          capacity = excluded.capacity, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`).run(workerId, kind, input.pid ?? null, capacity, at, at)
    },

    heartbeatWorker(workerId: string, state: "ready" | "busy" | "draining" | "stopped" = "ready"): void {
      assertId(workerId, OPAQUE, "worker")
      if (!["ready", "busy", "draining", "stopped"].includes(state)) throw new DaemonError("invalid_worker_state", 400)
      statement("UPDATE workers SET state = ?, heartbeat_at = ? WHERE worker_id = ?").run(state, now(), workerId)
    },

    expireWorkers(nowMs = now(), maxAgeMs = 30_000): number {
      if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1_000) throw new DaemonError("invalid_worker_age", 400)
      const rows = statement("UPDATE workers SET state = 'stopped' WHERE state != 'stopped' AND heartbeat_at < ? RETURNING worker_id").all(nowMs - maxAgeMs)
      return rows.length
    },

    stats(): StoreStats {
      const taskRows = statement("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all() as {status: TaskStatus; count: number}[]
      const outboxRows = statement("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as {status: DeliveryStatus; count: number}[]
      const tasks = {queued: 0, leased: 0, running: 0, completed: 0, failed: 0, cancelled: 0, uncertain: 0} as Record<TaskStatus, number>
      for (const row of taskRows) tasks[row.status] = Number(row.count)
      const outbox = {pending: 0, delivering: 0, delivered: 0, dead: 0} as Record<DeliveryStatus, number>
      for (const row of outboxRows) outbox[row.status] = Number(row.count)
      const worker = statement("SELECT COUNT(*) AS count FROM workers WHERE state != 'stopped'").get() as {count: number}
      const oldest = statement("SELECT MIN(created_at) AS at FROM tasks WHERE status = 'queued'").get() as {at: number | null}
      return {schema: 1, tasks, outbox, workers: Number(worker.count), oldest_queued_at: oldest.at === null ? null : Number(oldest.at)}
    },
  }
}

export type DaemonStore = ReturnType<typeof createDaemonStore>
