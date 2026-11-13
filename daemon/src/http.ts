import {timingSafeEqual} from "node:crypto"
import http from "node:http"

import {DaemonError} from "./errors.ts"
import type {DaemonStore} from "./store.ts"
import {BROWSER_QA_KIND,browserQaCancelDelivery,browserQaDelivery,browserQaRequest,validateBrowserQaReceipt,validateBrowserQaSubmit} from "./browser-qa.ts"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

export type DaemonServer = {
  server: http.Server
  listen(): Promise<{host: string; port: number}>
  close(): Promise<void>
}

function sameToken(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearer(value: string | string[] | undefined): string {
  const text = Array.isArray(value) ? value[0] : value
  return typeof text === "string" && text.startsWith("Bearer ") ? text.slice("Bearer ".length).trim() : ""
}

async function jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) throw new DaemonError("json_required", 415)
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > 4096) throw new DaemonError("body_too_large", 413)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new DaemonError("invalid_json", 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DaemonError("invalid_json", 400)
  return body as Record<string, unknown>
}

/** Internal only. Health is loopback-public; receipt acknowledgement requires
 * the install-scoped daemon token held by the Electron main process. */
export function createDaemonServer(input: {store: DaemonStore; port?: number; host?: string; startedAt?: number; now?: () => number; token?: string; identity?: {ownerId: string; installId: string}}): DaemonServer {
  const host = input.host ?? "127.0.0.1"
  if (!LOOPBACK.has(host)) throw new Error("daemon host must be loopback")
  const port = input.port ?? 3272
  const now = input.now ?? Date.now
  const startedAt = input.startedAt ?? now()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`)
    const send = (status: number, body: string, type = "application/json; charset=utf-8") => {
      res.writeHead(status, {"content-type": type, "cache-control": "no-store"})
      res.end(body)
    }
    try {
      if (url.pathname.startsWith("/v1/")) {
        if (!input.token) return send(503, JSON.stringify({error: "receipt_delivery_unavailable"}))
        if (!sameToken(bearer(req.headers.authorization), input.token)) return send(401, JSON.stringify({error: "unauthorized"}))
        if (req.method !== "POST") return send(405, JSON.stringify({error: "method_not_allowed"}))
        if (url.pathname === "/v1/browser-qa/submit") {
          if (!input.identity) return send(503, JSON.stringify({error: "browser_qa_identity_required"}))
          const submit = validateBrowserQaSubmit(await jsonBody(req))
          const task = input.store.submitTask({
            ...(submit.task_id ? {taskId: submit.task_id} : {}),
            ownerId: input.identity.ownerId,
            installId: input.identity.installId,
            channelId: submit.channel_id,
            agentId: submit.agent_id,
            kind: BROWSER_QA_KIND,
            request: browserQaRequest(submit),
          })
          return send(201, JSON.stringify({ok: true, task_id: task.task_id, status: task.status}))
        }
        if (url.pathname === "/v1/browser-qa/claim") {
          const body = await jsonBody(req)
          if (Object.keys(body).join(",") !== "worker_id" || typeof body.worker_id !== "string") return send(400, JSON.stringify({error: "invalid_browser_qa_claim"}))
          const task = input.store.claimTask(body.worker_id, 30_000, BROWSER_QA_KIND)
          return send(200, JSON.stringify({ok: true, task: task ? {
            task_id: task.task_id, kind: task.kind, request: task.request,
            fencing_token: task.fencing_token, lease_expires_at: task.lease_expires_at,
          } : null}))
        }
        if (url.pathname === "/v1/browser-qa/heartbeat") {
          const body = await jsonBody(req)
          if (Object.keys(body).sort().join(",") !== "fencing_token,task_id,worker_id" || typeof body.task_id !== "string" ||
              typeof body.worker_id !== "string" || !Number.isInteger(body.fencing_token)) return send(400, JSON.stringify({error: "invalid_browser_qa_heartbeat"}))
          const task = input.store.heartbeatTask(body.task_id, body.worker_id, body.fencing_token as number, 30_000)
          return send(200, JSON.stringify({ok: true, task_id: task.task_id, lease_expires_at: task.lease_expires_at}))
        }
        if (url.pathname === "/v1/browser-qa/complete") {
          const body = await jsonBody(req)
          if (Object.keys(body).sort().join(",") !== "fencing_token,receipt,task_id,worker_id" || typeof body.task_id !== "string" ||
              typeof body.worker_id !== "string" || !Number.isInteger(body.fencing_token)) return send(400, JSON.stringify({error: "invalid_browser_qa_complete"}))
          const task = input.store.getTask(body.task_id)
          if (!task || task.kind !== BROWSER_QA_KIND) return send(404, JSON.stringify({error: "browser_qa_task_not_found"}))
          const request = task.request as {request_id?: string; channel_id?: string; agent_id?: string}
          if (typeof request?.request_id !== "string" || typeof request.channel_id !== "string" || typeof request.agent_id !== "string") return send(409, JSON.stringify({error: "browser_qa_request_invalid"}))
          const receipt = validateBrowserQaReceipt(body.receipt, {request_id: request.request_id, channel_id: request.channel_id, agent_id: request.agent_id, goal: "fixed public check"})
          const completed = input.store.completeTask({
            taskId: body.task_id,
            workerId: body.worker_id,
            fencingToken: body.fencing_token as number,
            result: receipt,
            delivery: browserQaDelivery(receipt, body.task_id),
          })
          return send(200, JSON.stringify({ok: true, task_id: completed.task.task_id, status: completed.task.status, delivery_id: completed.delivery.delivery_id, idempotency_key: completed.delivery.idempotency_key, deduplicated: completed.deduplicated}))
        }
        if (url.pathname === "/v1/browser-qa/cancel") {
          const body = await jsonBody(req)
          if (Object.keys(body).sort().join(",") !== "fencing_token,task_id,worker_id" || typeof body.task_id !== "string" ||
              typeof body.worker_id !== "string" || !Number.isInteger(body.fencing_token)) return send(400, JSON.stringify({error: "invalid_browser_qa_cancel"}))
          const task = input.store.getTask(body.task_id)
          if (!task || task.kind !== BROWSER_QA_KIND) return send(404, JSON.stringify({error: "browser_qa_task_not_found"}))
          const request = task.request as {request_id?: string; channel_id?: string; agent_id?: string}
          const settled = input.store.settleTask({
            taskId: body.task_id, workerId: body.worker_id, fencingToken: body.fencing_token as number,
            status: "cancelled", errorCode: "cancelled_by_request",
            ...(typeof request?.request_id === "string" && typeof request.channel_id === "string" && typeof request.agent_id === "string"
              ? {delivery: browserQaCancelDelivery(body.task_id, request.request_id, request.channel_id, request.agent_id)} : {}),
          })
          return send(200, JSON.stringify({ok: true, task_id: settled.task.task_id, status: settled.task.status, delivery_id: settled.delivery?.delivery_id ?? null}))
        }
        if (url.pathname === "/v1/receipts/ack") {
          const body = await jsonBody(req)
          if (Object.keys(body).sort().join(",") !== "agent_id,channel_id,request_id" || ["request_id", "channel_id", "agent_id"].some((key) => typeof body[key] !== "string")) {
            return send(400, JSON.stringify({error: "invalid_receipt_ack"}))
          }
          const delivery = input.store.ackReceipt({requestId: body.request_id as string, channelId: body.channel_id as string, agentId: body.agent_id as string})
          return send(200, JSON.stringify({ok: true, delivery_id: delivery.delivery_id, status: delivery.status, idempotency_key: delivery.idempotency_key}))
        }
        return send(404, JSON.stringify({error: "not_found"}))
      }
      if (req.method !== "GET") return send(405, JSON.stringify({error: "method_not_allowed"}))
      if (url.pathname === "/healthz") {
        const stats = input.store.stats()
        return send(200, JSON.stringify({ok: true, uptime_ms: now() - startedAt, schema: stats.schema, tasks: stats.tasks, outbox: stats.outbox}))
      }
      if (url.pathname === "/readyz") {
        const ready = input.store.ping()
        return send(ready ? 200 : 503, JSON.stringify({ready, database: ready ? "ok" : "unavailable"}))
      }
      if (url.pathname === "/metrics") {
        const stats = input.store.stats()
        const lines = [
          "# HELP tarx_daemon_tasks Tasks by status",
          "# TYPE tarx_daemon_tasks gauge",
          ...Object.entries(stats.tasks).map(([status, count]) => `tarx_daemon_tasks{status="${status}"} ${count}`),
          "# HELP tarx_daemon_outbox Outbox rows by status",
          "# TYPE tarx_daemon_outbox gauge",
          ...Object.entries(stats.outbox).map(([status, count]) => `tarx_daemon_outbox{status="${status}"} ${count}`),
          "# HELP tarx_daemon_workers Live worker records",
          "# TYPE tarx_daemon_workers gauge",
          `tarx_daemon_workers ${stats.workers}`,
          "# HELP tarx_daemon_uptime_seconds Process uptime",
          "# TYPE tarx_daemon_uptime_seconds gauge",
          `tarx_daemon_uptime_seconds ${Math.floor((now() - startedAt) / 1000)}`,
        ]
        return send(200, `${lines.join("\n")}\n`, "text/plain; version=0.0.4; charset=utf-8")
      }
      return send(404, JSON.stringify({error: "not_found"}))
    } catch (error) {
      const code = error instanceof DaemonError ? error.code : "daemon_unavailable"
      const status = error instanceof DaemonError ? error.status : 500
      return send(status, JSON.stringify({error: code}))
    }
  })

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        const address = server.address()
        const boundPort = address && typeof address === "object" ? address.port : port
        server.removeListener("error", reject)
        resolve({host, port: boundPort})
      })
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
