/**
 * TARX Eve local session listener — executable loopback read/attach server.
 *
 * Consumes the corrected authorizeSessionAccess (tarx-eve-transport.ts) and the
 * REAL Eve Client (sessions.attach/stream), injected by the caller. It binds
 * loopback only, exposes scoped readiness + session read/attach, and NEVER:
 *  - trusts subject/install from an unsigned request body or Origin alone
 *    (identity comes from an injected trusted resolver),
 *  - creates a session, invokes a host tool, or runs deep dispatch,
 *  - re-executes a run on reload (attach reads durable events from the
 *    acknowledged cursor; delivery state only advances on client ack),
 *  - forwards reasoning/private trace fields to the client.
 *
 * It opens a socket (that is the point) but starts no host service, no model,
 * no tunnel. Owner bindings come from an injected store adapter; a disposable
 * on-disk fixture store is fine for tests and is explicitly not a production
 * grant. Production trust/pairing is still an explicit missing input.
 */

import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { authorizeSessionAccess, type SessionOwnership, type TransportReadiness } from './tarx-eve-transport.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Trusted identity resolver. Resolves the caller from the SIGNED session the
 *  daemon holds (cookie/bearer it already validated) — never from the body. */
export type IdentityResolver = (req: http.IncomingMessage) => Promise<{ subject_id: string; install_id: string } | null>

/** Persisted owner store. A real local store in production; a disposable
 *  on-disk fixture in tests. */
export type OwnerStore = {
  get(session_id: string): Promise<SessionOwnership | null>
  put(owner: SessionOwnership): Promise<void>
}

/** Minimal shape of the real Eve client the listener needs. */
export type EveSessionReader = {
  attach(session_id: string): { stream(opts: { follow: boolean }): AsyncIterable<{ type: string; [k: string]: unknown }> }
}

export type ListenerDeps = {
  handleRequest?: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => Promise<boolean>
  host?: string
  port?: number
  allowedOrigins: Set<string>
  resolveIdentity: IdentityResolver
  ownerStore: OwnerStore
  /** Returns the REAL Eve Client bound to the running worker. */
  eveClient: () => EveSessionReader
  /** Injected health probe for readiness. */
  readiness: () => Promise<TransportReadiness>
}

/** Presentation filter: drop reasoning/private trace fields; keep only the
 *  client-facing event envelope. No second capability catalog is emitted. */
const PRESENT_DROP = new Set(['reasoning', 'trace', 'private', 'thought', 'raw', 'tool_arguments'])
function scrub(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(scrub)
 if (!value || typeof value !== 'object') return value
 return Object.fromEntries(Object.entries(value).filter(([key])=>!PRESENT_DROP.has(key)).map(([key,v])=>[key,scrub(v)]))
}
function presentEvent(ev: {type:string;[key:string]:unknown}) {
 return ev.type.startsWith('reasoning.') ? null : scrub(ev) as {type:string;[key:string]:unknown}
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function createSessionListener(deps: ListenerDeps) {
  const host = deps.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('listener host must be loopback')
  const port = deps.port ?? 3270

  const server = http.createServer(async (req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    let url:URL
    try { url=new URL(req.url ?? '/', `http://${host}:${port}`) } catch {return send(res,400,{error:'invalid_url'})}
    if(deps.allowedOrigins.has(origin)){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');res.setHeader('access-control-allow-credentials','true')}
    if(req.method==='OPTIONS'){
      if(!deps.allowedOrigins.has(origin))return send(res,403,{error:'untrusted_origin'})
      res.setHeader('access-control-allow-methods','GET, POST');res.setHeader('access-control-allow-headers','authorization, content-type');res.writeHead(204);res.end();return
    }
    const path = url.pathname
    if(deps.handleRequest){try{if(await deps.handleRequest(req,res,path))return}catch{return send(res,500,{error:'request_failed'})}}

    // Scoped method/route surface. No creation, no host tools.
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })

    if (req.method === 'GET' && path === '/readiness') {
      // Readiness is ungated for reachability but reveals no session data.
      try { return send(res, 200, await deps.readiness()) } catch { return send(res,503,{error:'readiness_unavailable'}) }
    }

    if (path !== '/session/attach') return send(res, 404, { error: 'not_found' })

    // Identity comes ONLY from the trusted resolver, never the body/Origin.
    const identity = await deps.resolveIdentity(req).catch(() => null)
    if (!identity) return send(res, 401, { error: 'missing_identity' })

    const sessionId = url.searchParams.get('session_id') ?? ''
    const ackCursor = Number(url.searchParams.get('ack_cursor') ?? '0')

    const owner = await deps.ownerStore.get(sessionId).catch(() => null)
    const authz = authorizeSessionAccess({
      origin,
      allowedOrigins: deps.allowedOrigins,
      subject_id: identity.subject_id,
      install_id: identity.install_id,
      session_id: sessionId,
      owner,
    })
    if (!authz.ok) {
      const status = authz.error === 'untrusted_origin' ? 403 : authz.error === 'invalid_subject' || authz.error === 'invalid_session_id' ? 400 : authz.error === 'unknown_session' ? 404 : 403
      return send(res, status, { error: authz.error })
    }
    const ownerRec = owner as SessionOwnership

    // Reload = read/attach from the acknowledged cursor. Never re-execute.
    // Delivery state advances only after the client acknowledges (ack_cursor),
    // so a reload before ack re-reads the same durable events (no loss, no dup).
    const startCursor = Number.isInteger(ackCursor) && ackCursor >= 0 ? Math.min(ackCursor, ownerRec.cursor + 0) : ownerRec.cursor
    const effectiveFrom = Math.max(startCursor, 0)

    try {
      const stream = deps.eveClient().attach(sessionId).stream({ follow: false })
      const events: Array<{ type: string; [k: string]: unknown }> = []
      let index = 0
      for await (const ev of stream) {
        if (index >= effectiveFrom) { const shown=presentEvent(ev); if(shown)events.push(shown) }
        index += 1
      }
      if(Number.isInteger(ackCursor) && ackCursor>index)return send(res,400,{error:'invalid_cursor'})
      // Persist the acknowledged cursor only (client ack), not the read head.
      if (Number.isInteger(ackCursor) && ackCursor > ownerRec.cursor) {
        await deps.ownerStore.put({ ...ownerRec, cursor: ackCursor })
      }
      return send(res, 200, { mode: 'read_attach', session_id: sessionId, from_cursor: effectiveFrom, events, read_cursor:index })
    } catch (error) {
      return send(res, 502, { error: 'attach_failed' })
    }
  })

  return {
    server,
    listen: () => new Promise<{ host: string; port: number }>((resolve,reject) => { server.once('error',reject); server.listen(port, host, () => {
      const addr = server.address()
      const boundPort = addr && typeof addr === 'object' ? addr.port : port
      server.removeListener('error',reject)
      resolve({ host, port: boundPort })
    }) }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    host,
    port,
  }
}

/** Disposable on-disk owner store for tests. NOT a production identity grant. */
export function createFileOwnerStore(filePath: string): OwnerStore {
  async function readAll(): Promise<Record<string, SessionOwnership>> {
    try { return JSON.parse(await readFile(filePath, 'utf8')) } catch { return {} }
  }
  return {
    async get(session_id) {
      return (await readAll())[session_id] ?? null
    },
    async put(owner) {
      const all = await readAll()
      all[owner.session_id] = owner
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(all), 'utf8')
    },
  }
}
