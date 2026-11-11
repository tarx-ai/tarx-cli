import http from "node:http"

import type {DaemonStore} from "./store.ts"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

export type DaemonServer = {
  server: http.Server
  listen(): Promise<{host: string; port: number}>
  close(): Promise<void>
}

/** Internal only. The loopback listener exposes health, readiness and metrics;
 * task delivery remains on the existing authenticated paired listener. */
export function createDaemonServer(input: {store: DaemonStore; port?: number; host?: string; startedAt?: number; now?: () => number}): DaemonServer {
  const host = input.host ?? "127.0.0.1"
  if (!LOOPBACK.has(host)) throw new Error("daemon host must be loopback")
  const port = input.port ?? 3272
  const now = input.now ?? Date.now
  const startedAt = input.startedAt ?? now()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`)
    const send = (status: number, body: string, type = "application/json; charset=utf-8") => {
      res.writeHead(status, {"content-type": type, "cache-control": "no-store"})
      res.end(body)
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
