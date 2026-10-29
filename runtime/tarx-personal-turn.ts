import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {isAbsolute} from 'node:path'
/**
 * Personal-turn bridge — paired browser -> owned local personal runtime.
 *
 * A paired browser may send a bounded conversational turn to the user's OWN
 * personal local model through the loopback runtime listener. It NEVER:
 *  - sends private prompt/history to a hosted endpoint or any remote fallback,
 *  - accepts a browser-supplied model URL/id/key (the worker is server-bound),
 *  - exposes the local model key to the browser,
 *  - runs extra/supercomputer compute (that stays the explicit task route).
 * It fails closed when the personal runtime is unavailable, and returns only
 * sanitized ordinary assistant text.
 */

export const MAX_TURN_CHARS = 8000
export const MAX_HISTORY_TURNS = 12

export type PersonalTurnRole = 'user' | 'assistant'
export type PersonalTurnMessage = { role: PersonalTurnRole; content: string }

export type PersonalTurnRequest = {
  /** Bounded conversation the browser sends. No system prompt, no model/url/key. */
  messages: PersonalTurnMessage[]
}

export type PersonalTurnResult =
  | { ok: true; content: string }
  | { ok: false; error: 'invalid_turn' | 'personal_runtime_unavailable' | 'empty_reply' }

/** The owned personal client, bound by the entrypoint to the local worker. It
 * is given the already-validated messages; it must not be handed a URL/key by
 * the caller of /personal-turn. Returns raw assistant text or null on failure. */
/** Server-owned local options. The browser cannot set these. */
export type PersonalLocalOptions = { adapters?: string; model?: string }

export type PersonalClient = ((messages: PersonalTurnMessage[], local?: PersonalLocalOptions) => Promise<string | null>) & { readonly contextModelId?: string }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Validate the bounded typed body. Rejects anything beyond {messages:[{role,content}]}. */
export function validatePersonalTurn(body: unknown): { ok: true; messages: PersonalTurnMessage[] } | { ok: false } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const keys = Object.keys(body as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'messages') return { ok: false }
  const raw = (body as { messages: unknown }).messages
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_HISTORY_TURNS) return { ok: false }
  const messages: PersonalTurnMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false }
    const mk = Object.keys(m as Record<string, unknown>)
    if (mk.length !== 2 || !mk.includes('role') || !mk.includes('content')) return { ok: false }
    const role = (m as { role: unknown }).role
    const content = (m as { content: unknown }).content
    if (role !== 'user' && role !== 'assistant') return { ok: false }
    if (typeof content !== 'string' || content.length === 0 || content.length > MAX_TURN_CHARS) return { ok: false }
    messages.push({ role, content })
  }
  if (messages[messages.length - 1].role !== 'user') return { ok: false }
  return { ok: true, messages }
}

/** Sanitize assistant text before it reaches the browser: strip control chars,
 * cap length. Never passes through tool/trace/raw structures. */
export function sanitizeAssistant(text: string): string {
  return text.replace(CONTROL, '').slice(0, MAX_TURN_CHARS).trim()
}

/** Run a validated personal turn against the owned client. Fail-closed. */
export async function runPersonalTurn(client: PersonalClient, req: PersonalTurnRequest, local?: PersonalLocalOptions): Promise<PersonalTurnResult> {
  let raw: string | null
  try { raw = await client(req.messages, local?.adapters ? { adapters: local.adapters, model: local.model } : undefined) } catch { return { ok: false, error: 'personal_runtime_unavailable' } }
  if (raw == null) return { ok: false, error: 'personal_runtime_unavailable' }
  const content = sanitizeAssistant(raw)
  if (!content) return { ok: false, error: 'empty_reply' }
  return { ok: true, content }
}

/** Build the owned personal client bound to a loopback OpenAI-compatible
 * runtime. The URL/key are fixed at wire time by the entrypoint — NOT by the
 * browser. The key never leaves this closure. No remote fallback. */
export function createLoopbackPersonalClient(input: {
  baseURL: string
  model: string
  apiKey?: string
  fetcher?: typeof fetch
}): PersonalClient {
  const parsed = new URL(input.baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port === '0'
      || !['', '/', '/v1', '/v1/', '/v1/chat/completions'].includes(parsed.pathname))
    throw new Error('personal_runtime_must_be_loopback')
  if (!input.model || input.model.length > 200 || /[\x00-\x1f\x7f]/.test(input.model + (input.apiKey ?? '')))
    throw new Error('invalid_personal_configuration')
  parsed.pathname = '/v1/chat/completions'
  const endpoint = parsed.href
  // Native HTTP does not follow redirects or inherit environment proxy settings.
  // A browser can never select this URL, model, key or transport.
  const doFetch: typeof fetch = input.fetcher ?? (async (url, init) => {
    const target = new URL(String(url))
    return new Promise<Response>((resolve, reject) => {
      const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'POST', agent: false, headers: init?.headers as Record<string,string>, signal: init?.signal ?? undefined,
      }, res => {
        const chunks: Buffer[] = []; let bytes = 0
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { req.destroy(); reject(Error('reply_too_large')) } else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: res.statusCode ?? 502})))
      })
      req.on('error', reject); req.end(init?.body as string)
    })
  })
  const client:PersonalClient = async (messages, local) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (input.apiKey) headers.authorization = 'Bearer ' + input.apiKey // stays server-side
    const payload: Record<string, unknown> = { model: input.model, messages, stream: false, max_tokens: 768, temperature: 0 }
    // Only a server-verified absolute adapter directory. Never a browser path.
    if (local?.adapters) {
      if (!isAbsolute(local.adapters) || local.adapters.includes('\0') || local.adapters.split(/[\\/]/).includes('..')) return null
      if (!local.model || !isAbsolute(local.model) || local.model.includes('\0') || local.model.split(/[\\/]/).includes('..')) return null
      payload.model = local.model
      payload.adapters = local.adapters
    }
    let res: Response
    try {
      res = await doFetch(endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(70_000) })
    } catch { return null }
    if (!res.ok) return null
    let body: any
    try { body = await res.json() } catch { return null }
    const content = body?.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : null
  }
  Object.defineProperty(client, 'contextModelId', {value: input.model})
  return client
}
