import {timingSafeEqual} from "node:crypto"
import http from "node:http"

import {DaemonError} from "./errors.ts"
import type {DaemonStore} from "./store.ts"

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
export function createDaemonServer(input: {store: DaemonStore; port?: number; host?: string; startedAt?: number; now?: () => number; token?: string}): DaemonServer {
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
