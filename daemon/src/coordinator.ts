import type {DaemonStore, DeliveryInput, OutboxRecord, TaskRecord} from "./store.ts"

export type TaskExecution = {result: unknown; delivery: DeliveryInput}

export type TaskExecutor = {
  execute(task: TaskRecord, context: {fencingToken: number; signal: AbortSignal; heartbeat: () => Promise<void>}): Promise<TaskExecution>
}

export type DeliveryAdapter = {
  deliver(delivery: OutboxRecord, context: {signal: AbortSignal}): Promise<void>
}

export type CoordinatorOptions = {
  store: DaemonStore
  executor: TaskExecutor
  delivery: DeliveryAdapter
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
  pollMs?: number
  deliveryBatch?: number
}

/** The only task runner. It claims one fenced task, heartbeats it, writes the
 * result and outbox atomically, then drains due deliveries. A failure after
 * dispatch is uncertain, never retried. */
export function createCoordinator(options: CoordinatorOptions) {
  const leaseMs = options.leaseMs ?? 30_000
  const heartbeatMs = options.heartbeatMs ?? 10_000
  const pollMs = options.pollMs ?? 250
  const batch = options.deliveryBatch ?? 10
  if (heartbeatMs >= leaseMs / 2) throw new Error("heartbeat must be shorter than half the lease")
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<unknown> | undefined
  let stopped = true
  let lastError: string | null = null
  const stats = {ticks: 0, tasks_completed: 0, tasks_failed: 0, tasks_uncertain: 0, deliveries_acknowledged: 0, deliveries_failed: 0}

  async function runTask(task: TaskRecord): Promise<void> {
    const controller = new AbortController()
    const fence = task.fencing_token
    const heartbeat = setInterval(() => {
      try {
        options.store.heartbeatTask(task.task_id, options.workerId, fence, leaseMs)
      } catch {
        // A lost fence is not recoverable here. Stop the local work; settlement
        // will be rejected and the task will expire into uncertainty.
        controller.abort()
      }
    }, heartbeatMs)
    heartbeat.unref?.()
    try {
      const execution = await options.executor.execute(task, {
        fencingToken: fence,
        signal: controller.signal,
        heartbeat: async () => { options.store.heartbeatTask(task.task_id, options.workerId, fence, leaseMs) },
      })
      options.store.completeTask({taskId: task.task_id, workerId: options.workerId, fencingToken: fence, result: execution.result, delivery: execution.delivery})
      stats.tasks_completed += 1
    } catch (error: any) {
      if (controller.signal.aborted) {
        try { options.store.settleTask({taskId: task.task_id, workerId: options.workerId, fencingToken: fence, status: "uncertain", errorCode: "lease_lost"}) } catch {}
        stats.tasks_uncertain += 1
        return
      }
      const uncertain = error?.uncertain === true
      try {
        options.store.settleTask({
          taskId: task.task_id,
          workerId: options.workerId,
          fencingToken: fence,
          status: uncertain ? "uncertain" : "failed",
          errorCode: typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : uncertain ? "execution_uncertain" : "execution_failed",
        })
        if (uncertain) stats.tasks_uncertain += 1
        else stats.tasks_failed += 1
      } catch {
        // Stale fence means another outcome already owns this task. Do not
        // overwrite it and do not retry.
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  async function drainDeliveries(): Promise<number> {
    const claimed = options.store.claimDeliveries(options.workerId, batch, leaseMs)
    let acknowledged = 0
    for (const delivery of claimed) {
      const controller = new AbortController()
      try {
        await options.delivery.deliver(delivery, {signal: controller.signal})
        options.store.ackDelivery(delivery.delivery_id, options.workerId)
        stats.deliveries_acknowledged += 1
        acknowledged += 1
      } catch (error: any) {
        options.store.failDelivery(delivery.delivery_id, options.workerId, typeof error?.code === "string" ? error.code : "delivery_failed")
        stats.deliveries_failed += 1
      }
    }
    return acknowledged
  }

  async function tick(): Promise<{task: string | null; delivered: number}> {
    if (inFlight) return inFlight as Promise<{task: string | null; delivered: number}>
    const flight = (async () => {
      stats.ticks += 1
      options.store.recoverExpired()
      options.store.recoverExpiredDeliveries()
      const task = options.store.claimTask(options.workerId, leaseMs)
      if (task) await runTask(task)
      const delivered = await drainDeliveries()
      return {task: task?.task_id ?? null, delivered}
    })().catch((error) => {
      lastError = typeof error?.code === "string" ? error.code : "coordinator_failed"
      throw error
    }).finally(() => {
      inFlight = undefined
    })
    inFlight = flight
    return flight
  }

  return {
    tick,
    start(): void {
      if (!stopped) return
      stopped = false
      timer = setInterval(() => {
        void tick().catch(() => {})
      }, pollMs)
      timer.unref?.()
      void tick().catch(() => {})
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      await inFlight?.catch(() => {})
    },
    get running(): boolean {
      return !stopped
    },
    get lastError(): string | null {
      return lastError
    },
    stats: () => ({...stats}),
  }
}
