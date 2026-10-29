/**
 * Model-independent context cache v1.
 *
 * Facts are data. A pack quotes selected facts for one server-selected
 * recipient. It does not grant model authority, import founder history, or
 * open a remote route. The encryption key is supplied by the operator.
 * /personal-turn does not mount this module.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { createLocalJsonStore } from './local-json-store.ts'

const ID = /^[A-Za-z0-9_-]{1,80}$/
const HEX64 = /^[a-f0-9]{64}$/
const KINDS = new Set(['goal', 'decision', 'constraint', 'evidence', 'next_action', 'summary'])
const FACT_KEYS = ['schema_version', 'fact_id', 'scope', 'kind', 'revision', 'source_version', 'classification', 'body', 'expires_at', 'deleted_at']
const SCOPE_KEYS = ['owner_namespace', 'workspace_id', 'channel_id', 'purpose', 'grant_revision']
const REQUEST_KEYS = ['schema_version', 'scope', 'recipient', 'policy_version', 'prompt_version', 'fact_ids', 'max_bytes']
const MAX_FACTS = 256
const MAX_GRANTS = 64
const MAX_PACKS = 64
const AAD = Buffer.from('tarx-context-cache-v1')

export type Classification = 'private_local' | 'export_eligible'
export type FactKind = 'goal' | 'decision' | 'constraint' | 'evidence' | 'next_action' | 'summary'
export type CacheError = 'invalid_fact' | 'invalid_request' | 'owner_mismatch' | 'export_grant_required' | 'context_key_rejected' | 'context_unavailable' | 'store_bound'

export type ContextScope = {
  owner_namespace: string
  workspace_id: string
  channel_id: string
  purpose: string
  grant_revision: string
}

export type ContextFact = {
  schema_version: 1
  fact_id: string
  scope: ContextScope
  kind: FactKind
  revision: number
  source_version: string
  classification: Classification
  body: string
  expires_at: string
  deleted_at: string | null
}

export type ContextRecipient = {
  location: 'this_computer' | 'supercomputer'
  provider_id: string
  model_id: string
}

export type PackRequest = {
  schema_version: 1
  scope: ContextScope
  recipient: ContextRecipient
  policy_version: string
  prompt_version: string
  fact_ids: string[]
  max_bytes: number
}

export type QuotedFact = {
  fact_id: string
  kind: FactKind
  revision: number
  source_version: string
  body: string
}

export type ContextPacket = {
  schema_version: 1
  authority: 'data'
  quoted: true
  recipient: ContextRecipient
  facts: QuotedFact[]
  omitted_count: number
  complete: boolean
  serialized_bytes: number
  token_estimate: number
}

export type PackResult = { ok: true; cache: 'hit' | 'rebuilt'; cache_key: string; packet: ContextPacket } | { ok: false; error: CacheError }

type GrantRecord = ContextScope & { provider_id: string; model_id: string; revoked_at: string | null }
type CachedPack = { key: string; owner_namespace: string; scope: ContextScope; fingerprints: string[]; packet: ContextPacket }
type State = { facts: ContextFact[]; grants: GrantRecord[]; packs: CachedPack[] }
type Seal = { v: 1; nonce: string; tag: string; ciphertext: string }

function emptyState(): State {
  return { facts: [], grants: [], packs: [] }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every((key) => present.includes(key))
}

function scopeOf(value: unknown): ContextScope | null {
  const row = record(value)
  if (!row || !sameKeys(row, SCOPE_KEYS)) return null
  const scope = row as ContextScope
  if (!HEX64.test(scope.owner_namespace)) return null
  if (![scope.workspace_id, scope.channel_id, scope.purpose, scope.grant_revision].every((item) => ID.test(item))) return null
  return {
    owner_namespace: scope.owner_namespace,
    workspace_id: scope.workspace_id,
    channel_id: scope.channel_id,
    purpose: scope.purpose,
    grant_revision: scope.grant_revision,
  }
}

function sameScope(left: ContextScope, right: ContextScope): boolean {
  return SCOPE_KEYS.every((key) => left[key as keyof ContextScope] === right[key as keyof ContextScope])
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

/** A summary stays at least as private as every source it cites. */
export function restrictClassification(requested: Classification, sources: Classification[]): Classification {
  if (requested === 'private_local' || sources.includes('private_local')) return 'private_local'
  return 'export_eligible'
}

export function parseContextFact(value: unknown, sources: Classification[] = []): ContextFact | null {
  const row = record(value)
  if (!row || !sameKeys(row, FACT_KEYS)) return null
  const scope = scopeOf(row.scope)
  if (row.schema_version !== 1 || !scope || typeof row.fact_id !== 'string' || !ID.test(row.fact_id)) return null
  if (typeof row.kind !== 'string' || !KINDS.has(row.kind)) return null
  if (typeof row.revision !== 'number' || !Number.isInteger(row.revision) || row.revision < 1) return null
  if (typeof row.source_version !== 'string' || row.source_version.length < 1 || row.source_version.length > 128) return null
  if (row.classification !== 'private_local' && row.classification !== 'export_eligible') return null
  if (typeof row.body !== 'string' || row.body.length < 1 || row.body.length > 8192 || row.body.includes('\u0000')) return null
  const expires = iso(row.expires_at)
  if (!expires) return null
  if (row.deleted_at !== null && !iso(row.deleted_at)) return null
  const classification = row.kind === 'summary' ? restrictClassification(row.classification, sources) : row.classification
  if (row.kind === 'summary' && sources.length === 0) return null
  return {
    schema_version: 1,
    fact_id: row.fact_id,
    scope,
    kind: row.kind as FactKind,
    revision: row.revision,
    source_version: row.source_version,
    classification,
    body: row.body,
    expires_at: expires,
    deleted_at: row.deleted_at === null ? null : iso(row.deleted_at),
  }
}

export function parsePackRequest(value: unknown): PackRequest | null {
  const row = record(value)
  if (!row || !sameKeys(row, REQUEST_KEYS) || row.schema_version !== 1) return null
  const scope = scopeOf(row.scope)
  const recipient = record(row.recipient)
  if (!scope || !recipient || Object.keys(recipient).length !== 3) return null
  if (recipient.location !== 'this_computer' && recipient.location !== 'supercomputer') return null
  if (typeof recipient.provider_id !== 'string' || !ID.test(recipient.provider_id)) return null
  if (typeof recipient.model_id !== 'string' || recipient.model_id.length < 1 || recipient.model_id.length > 128 || recipient.model_id.includes('\u0000')) return null
  if (typeof row.policy_version !== 'string' || !ID.test(row.policy_version)) return null
  if (typeof row.prompt_version !== 'string' || !ID.test(row.prompt_version)) return null
  if (!Array.isArray(row.fact_ids) || row.fact_ids.length > 64 || new Set(row.fact_ids).size !== row.fact_ids.length) return null
  if (!row.fact_ids.every((id) => typeof id === 'string' && ID.test(id))) return null
  if (typeof row.max_bytes !== 'number' || !Number.isInteger(row.max_bytes) || row.max_bytes < 256 || row.max_bytes > 32768) return null
  return {
    schema_version: 1,
    scope,
    recipient: { location: recipient.location, provider_id: recipient.provider_id, model_id: recipient.model_id },
    policy_version: row.policy_version,
    prompt_version: row.prompt_version,
    fact_ids: [...row.fact_ids],
    max_bytes: row.max_bytes,
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function factFingerprint(fact: ContextFact): string {
  return digest(JSON.stringify({
    fact_id: fact.fact_id,
    revision: fact.revision,
    source_version: fact.source_version,
    classification: fact.classification,
    body: fact.body,
  }))
}

function quote(fact: ContextFact): QuotedFact {
  return { fact_id: fact.fact_id, kind: fact.kind, revision: fact.revision, source_version: fact.source_version, body: fact.body }
}

/** Byte length of the quoted fact array. The estimate is ceil(bytes / 4), not an upper bound or a provider token count. */
export function measureQuoted(facts: QuotedFact[]): { serialized_bytes: number; token_estimate: number } {
  const serialized_bytes = Buffer.byteLength(JSON.stringify(facts))
  return { serialized_bytes, token_estimate: Math.ceil(serialized_bytes / 4) }
}

function live(fact: ContextFact, nowMs: number): boolean {
  return fact.deleted_at === null && Date.parse(fact.expires_at) > nowMs
}

function grantCurrent(grant: GrantRecord, request: PackRequest): boolean {
  return grant.revoked_at === null
    && sameScope(grant, request.scope)
    && grant.provider_id === request.recipient.provider_id
    && grant.model_id === request.recipient.model_id
}

function cacheKey(request: PackRequest, fingerprints: string[], digestKey: Buffer): string {
  return createHmac('sha256', digestKey).update(JSON.stringify({
    owner: request.scope.owner_namespace,
    workspace: request.scope.workspace_id,
    channel: request.scope.channel_id,
    purpose: request.scope.purpose,
    grant: request.scope.grant_revision,
    location: request.recipient.location,
    provider: request.recipient.provider_id,
    model: request.recipient.model_id,
    policy: request.policy_version,
    prompt: request.prompt_version,
    budget: request.max_bytes,
    requested_facts: [...request.fact_ids].sort(),
    sources: [...fingerprints].sort(),
  })).digest('hex')
}

function selectFacts(facts: ContextFact[], request: PackRequest, nowMs: number): { chosen: QuotedFact[]; omitted: number; fingerprints: string[] } {
  const visible = facts.filter((fact) => sameScope(fact.scope, request.scope))
  const ordered = [...request.fact_ids].sort().map((id) => visible.find((fact) => fact.fact_id === id) ?? null)
  const eligible = ordered.map((fact) => {
    if (!fact || !live(fact, nowMs)) return null
    if (request.recipient.location === 'supercomputer' && fact.classification !== 'export_eligible') return null
    return fact
  })
  const chosen: QuotedFact[] = []
  let omitted = 0
  const fingerprints: string[] = []
  for (let index = 0; index < eligible.length; index += 1) {
    const fact = eligible[index]
    if (!fact) {
      omitted += 1
      continue
    }
    const next = [...chosen, quote(fact)]
    if (measureQuoted(next).serialized_bytes > request.max_bytes) {
      omitted += 1
      continue
    }
    chosen.push(quote(fact))
    fingerprints.push(factFingerprint(ordered[index] as ContextFact))
  }
  return { chosen, omitted, fingerprints }
}

function packetCurrent(item: CachedPack, facts: ContextFact[], nowMs: number): boolean {
  if (!item.scope || !item.packet || item.packet.authority !== 'data' || item.packet.quoted !== true || !Array.isArray(item.packet.facts)) return false
  return item.packet.facts.every((quoted) => {
    const fact = facts.find((row) => row.fact_id === quoted.fact_id && sameScope(row.scope, item.scope))
    if (!fact || !live(fact, nowMs)) return false
    if (item.packet.recipient.location === 'supercomputer' && fact.classification !== 'export_eligible') return false
    return fact.kind === quoted.kind && fact.revision === quoted.revision && fact.source_version === quoted.source_version && fact.body === quoted.body
  })
}

function encrypt(key: Buffer, state: State): Seal {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ v: 1, state }), 'utf8'), cipher.final()])
  return { v: 1, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
}

function decrypt(key: Buffer, seal: Seal): State {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(seal.nonce, 'base64url'))
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(seal.tag, 'base64url'))
    const plain = Buffer.concat([decipher.update(Buffer.from(seal.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plain) as { v?: number; state?: State }
    if (parsed.v !== 1 || !parsed.state || !Array.isArray(parsed.state.facts) || !Array.isArray(parsed.state.grants) || !Array.isArray(parsed.state.packs)) {
      throw new Error('context_key_rejected')
    }
    return parsed.state
  } catch {
    throw Object.assign(new Error('context_key_rejected'), { code: 'context_key_rejected' })
  }
}

export function createContextCache(input: { file: string; key: Buffer; now?: () => number }) {
  if (input.key.length !== 32) throw new Error('context_key_required')
  const key = Buffer.from(input.key)
  const digestKey = Buffer.from(hkdfSync('sha256', key, AAD, Buffer.from('pack-cache-key'), 32))
  const now = input.now ?? (() => Date.now())
  const store = createLocalJsonStore<Seal>(input.file)
  async function update<T>(change: (state: State) => { result: T; write: boolean }): Promise<T> {
    try {
      return await store.transact((all) => {
        const state = all.seal ? decrypt(key, all.seal) : emptyState()
        const outcome = change(state)
        if (!outcome.write) return { result: outcome.result }
        all.seal = encrypt(key, state)
        return { result: outcome.result, write: true }
      })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'context_key_rejected') throw error
      throw Object.assign(new Error('context_unavailable'), { code: 'context_unavailable' })
    }
  }
  return {
    async putFact(ownerNamespace: string, value: unknown, sources: Classification[] = []): Promise<{ ok: true } | { ok: false; error: CacheError }> {
      const fact = parseContextFact(value, sources)
      if (!fact) return { ok: false, error: 'invalid_fact' }
      if (fact.scope.owner_namespace !== ownerNamespace) return { ok: false, error: 'owner_mismatch' }
      try {
        return await update<{ ok: true } | { ok: false; error: 'store_bound' | 'invalid_fact' }>((state) => {
          const index = state.facts.findIndex((item) => item.scope.owner_namespace === ownerNamespace && item.fact_id === fact.fact_id)
          if (index < 0 && state.facts.length >= MAX_FACTS) return { result: { ok: false as const, error: 'store_bound' as const }, write: false }
          if (index >= 0 && fact.revision < state.facts[index].revision) return { result: { ok: false as const, error: 'invalid_fact' as const }, write: false }
          if (index >= 0) state.facts[index] = fact
          else state.facts.push(fact)
          state.packs = []
          return { result: { ok: true as const }, write: true }
        })
      } catch {
        return { ok: false, error: 'context_key_rejected' }
      }
    },
    async deleteFact(ownerNamespace: string, factId: string, deletedAt: string): Promise<{ ok: true } | { ok: false; error: CacheError }> {
      const stamp = iso(deletedAt)
      if (!HEX64.test(ownerNamespace) || !ID.test(factId) || !stamp) return { ok: false, error: 'invalid_fact' }
      try {
        return await update<{ ok: true } | { ok: false; error: 'invalid_fact' }>((state) => {
          const fact = state.facts.find((item) => item.scope.owner_namespace === ownerNamespace && item.fact_id === factId)
          if (!fact) return { result: { ok: false as const, error: 'invalid_fact' as const }, write: false }
          fact.deleted_at = stamp
          state.packs = []
          return { result: { ok: true as const }, write: true }
        })
      } catch {
        return { ok: false, error: 'context_key_rejected' }
      }
    },
    async putGrant(ownerNamespace: string, grant: Omit<GrantRecord, 'revoked_at'>): Promise<{ ok: true } | { ok: false; error: CacheError }> {
      const scope = scopeOf({
        owner_namespace: grant.owner_namespace,
        workspace_id: grant.workspace_id,
        channel_id: grant.channel_id,
        purpose: grant.purpose,
        grant_revision: grant.grant_revision,
      })
      if (!scope || scope.owner_namespace !== ownerNamespace) return { ok: false, error: 'owner_mismatch' }
      if (typeof grant.provider_id !== 'string' || !ID.test(grant.provider_id)) return { ok: false, error: 'invalid_request' }
      if (typeof grant.model_id !== 'string' || grant.model_id.length < 1 || grant.model_id.length > 128 || grant.model_id.includes('\u0000')) return { ok: false, error: 'invalid_request' }
      const next: GrantRecord = { ...scope, provider_id: grant.provider_id, model_id: grant.model_id, revoked_at: null }
      try {
        return await update<{ ok: true } | { ok: false; error: 'store_bound' }>((state) => {
          const index = state.grants.findIndex((item) => sameScope(item, next) && item.provider_id === next.provider_id && item.model_id === next.model_id)
          if (index < 0 && state.grants.length >= MAX_GRANTS) return { result: { ok: false as const, error: 'store_bound' as const }, write: false }
          if (index >= 0) state.grants[index] = next
          else state.grants.push(next)
          return { result: { ok: true as const }, write: true }
        })
      } catch {
        return { ok: false, error: 'context_key_rejected' }
      }
    },
    async revokeGrant(ownerNamespace: string, grant: Omit<GrantRecord, 'revoked_at'>, revokedAt: string): Promise<{ ok: true } | { ok: false; error: CacheError }> {
      const stamp = iso(revokedAt)
      if (!stamp || grant.owner_namespace !== ownerNamespace) return { ok: false, error: 'invalid_request' }
      try {
        return await update<{ ok: true } | { ok: false; error: 'invalid_request' }>((state) => {
          const found = state.grants.find((item) => sameScope(item, grant) && item.provider_id === grant.provider_id && item.model_id === grant.model_id)
          if (!found) return { result: { ok: false as const, error: 'invalid_request' as const }, write: false }
          found.revoked_at = stamp
          state.packs = state.packs.filter((item) => !(item.owner_namespace === ownerNamespace && item.packet.recipient.location === 'supercomputer' && item.packet.recipient.provider_id === grant.provider_id && item.packet.recipient.model_id === grant.model_id))
          return { result: { ok: true as const }, write: true }
        })
      } catch {
        return { ok: false, error: 'context_key_rejected' }
      }
    },
    async pack(ownerNamespace: string, value: unknown): Promise<PackResult> {
      const request = parsePackRequest(value)
      if (!request) return { ok: false, error: 'invalid_request' }
      if (request.scope.owner_namespace !== ownerNamespace) return { ok: false, error: 'owner_mismatch' }
      const nowMs = now()
      try {
        return await update<PackResult>((state) => {
          if (request.recipient.location === 'supercomputer' && !state.grants.some((grant) => grantCurrent(grant, request))) {
            return { result: { ok: false as const, error: 'export_grant_required' as const }, write: false }
          }
          const kept = state.packs.filter((item) => packetCurrent(item, state.facts, nowMs))
          const dropped = kept.length !== state.packs.length
          state.packs = kept
          const selected = selectFacts(state.facts, request, nowMs)
          const keyHex = cacheKey(request, selected.fingerprints, digestKey)
          const cached = state.packs.find((item) => item.key === keyHex)
          const fresh = cached && cached.fingerprints.length === selected.fingerprints.length && cached.fingerprints.every((item, index) => item === selected.fingerprints[index])
          if (cached && fresh) return { result: { ok: true as const, cache: 'hit' as const, cache_key: keyHex, packet: cached.packet }, write: dropped }
          const measured = measureQuoted(selected.chosen)
          const packet: ContextPacket = {
            schema_version: 1,
            authority: 'data',
            quoted: true,
            recipient: request.recipient,
            facts: selected.chosen,
            omitted_count: selected.omitted,
            complete: selected.omitted === 0,
            serialized_bytes: measured.serialized_bytes,
            token_estimate: measured.token_estimate,
          }
          state.packs = [{ key: keyHex, owner_namespace: request.scope.owner_namespace, scope: request.scope, fingerprints: selected.fingerprints, packet }, ...state.packs.filter((item) => item.key !== keyHex)].slice(0, MAX_PACKS)
          return { result: { ok: true as const, cache: 'rebuilt' as const, cache_key: keyHex, packet }, write: true }
        })
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        return { ok: false, error: code === 'context_key_rejected' ? 'context_key_rejected' : 'context_unavailable' }
      }
    },
  }
}
