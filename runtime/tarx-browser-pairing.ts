/**
 * TARX browser pairing — executable loopback pairing module.
 *
 * Bridges a browser to the local Eve session listener WITHOUT giving the browser
 * the saved CLI credential, the HMAC root key, or any private context. Flow:
 *   1. CLI (local, trusted) requests a pairing challenge: a high-entropy,
 *      short-lived, one-time code. The stable subject is resolved SERVER-SIDE
 *      via resolveCliPrincipal (the existing CLI principal helper) — never from
 *      the browser. The CLI binds an install_id.
 *   2. The browser, on the pinned production origin, claims the challenge once
 *      (atomic). On success it receives a SCOPED pairing credential only.
 *   3. The pairing credential resolves to {subject_id, install_id} for the
 *      listener's trusted resolver, scoped to attach/read of owned sessions.
 *
 * Persists pair records with 0600 perms and only HASHED bearer material.
 * Rejects wrong origin, browser-supplied subject/install, Origin-only trust,
 * stolen/replayed/expired/revoked challenges. A challenge cannot grant session
 * or tool creation. User consent (explicit CLI approval) cannot be bypassed.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {createLocalJsonStore} from './local-json-store.ts'

import { resolveCliPrincipal, type CliPrincipalResult } from './cli-principal.ts'
import type { IdentityResolver } from './tarx-eve-listener.ts'

const STABLE_SUBJECT = /^tvs_[0-9a-f]{32}$/
const CHALLENGE_TTL_MS = 2 * 60 * 1000 // short-lived
const PAIR_TTL_MS = 24 * 60 * 60 * 1000

function sha256(v: string) { return createHash('sha256').update(v).digest('hex') }
function hashEq(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** On disk: only hashes + metadata, never raw challenge or pairing credential. */
export type PairRecord = {
  challenge_hash: string
  subject_id: string
  install_id: string
  created_at: number
  expires_at: number
  task_scopes?: string[]
  approved: boolean
  claimed: boolean
  revoked: boolean
  /** Set only after an atomic claim; hash of the issued pairing credential. */
  pairing_hash?: string
  pairing_expires_at?: number
}

export type PairStore = {
  mutate<T>(hash: string, update: (record: PairRecord | null) => { record?: PairRecord; result: T }): Promise<T>
  get(challenge_hash: string): Promise<PairRecord | null>
  put(rec: PairRecord): Promise<void>
  byPairingHash(pairing_hash: string): Promise<PairRecord | null>
}

/** Disposable on-disk pair store (0600). NOT a production grant. */
export function createFilePairStore(filePath: string): PairStore {
 const store=createLocalJsonStore<PairRecord>(filePath)
 return {
  get:store.get,
  put:rec=>store.put(rec.challenge_hash,rec),
  byPairingHash:async hash=>(await store.values()).find(rec=>rec.pairing_hash===hash)??null,
  mutate:(hash,update)=>store.transact(all=>{const next=update(all[hash]??null);if(next.record)all[hash]=next.record;return {result:next.result,write:Boolean(next.record)}}),
 }
}

/** CLI-side, local/trusted. Resolves the subject server-side and binds install. */
export async function createPairingChallenge(input: {
  loadCredential: () => Promise<string>
  install_id: string
  store: PairStore
  fetcher?: typeof fetch
  now?: number
}): Promise<{ ok: true; challenge: string; expires_at: number } | { ok: false; error: string }> {
  const install = input.install_id?.trim()
  if (!install) return { ok: false, error: 'invalid_install' }
  const principal = await resolveCliPrincipal({ loadCredential: input.loadCredential, fetcher: input.fetcher })
  if (!principal.ok) return { ok: false, error: principal.error }
  const now = input.now ?? Date.now()
  const challenge = randomBytes(32).toString('hex') // high entropy
  await input.store.put({
    challenge_hash: sha256(challenge),
    subject_id: principal.subject_id,
    install_id: install,
    created_at: now,
    expires_at: now + CHALLENGE_TTL_MS,
    approved: false,
    claimed: false,
    revoked: false,
  })
  return { ok: true, challenge, expires_at: now + CHALLENGE_TTL_MS }
}

/** Explicit CLI approval. Consent cannot be bypassed: an unapproved challenge
 *  can never be claimed. A scope may be a single string (back-compat) or an
 *  explicit combination, e.g. ['personal_chat','personal_learning']. */
export async function approvePairingChallenge(challenge: string, store: PairStore, now = Date.now(), taskScope?: string | string[]): Promise<boolean> {
  const requested = taskScope == null ? [] : Array.isArray(taskScope) ? taskScope : [taskScope]
  const allowed = new Set(['read_launch_note', 'personal_chat', 'personal_learning'])
  if (requested.some(s => !allowed.has(s))) return false
  // personal_learning is only grantable alongside personal_chat (mutations need
  // the fresh combined grant; a read-only/chat-only pair can never train).
  if (requested.includes('personal_learning') && !requested.includes('personal_chat')) return false
  return store.mutate(sha256(challenge),rec=>{
    if(!rec||rec.revoked||rec.claimed||now>=rec.expires_at)return {result:false}
    return {record:{...rec,approved:true,task_scopes:requested},result:true}
  })
}

export type ClaimResult =
  | { ok: true; pairing_credential: string; subject_id: string; expires_at: number }
  | { ok: false; error: 'untrusted_origin' | 'invalid_challenge' | 'not_approved' | 'expired' | 'revoked' | 'already_claimed' }

/** Browser-side claim, atomic + one-time. The browser presents the challenge on
 *  the PINNED production origin; it supplies NO subject/install. Returns a scoped
 *  pairing credential only — never the CLI credential or any key. */
export async function claimPairing(input: {
  challenge: string
  origin: string
  allowedOrigins: Set<string>
  store: PairStore
  now?: number
}): Promise<ClaimResult> {
  if (!input.origin || !input.allowedOrigins.has(input.origin)) return { ok: false, error: 'untrusted_origin' }
  const now = input.now ?? Date.now()
  return input.store.mutate<ClaimResult>(sha256(input.challenge),rec=>{
    if(!rec)return {result:{ok:false,error:'invalid_challenge'}}
    if(rec.revoked)return {result:{ok:false,error:'revoked'}}
    if(rec.claimed)return {result:{ok:false,error:'already_claimed'}}
    if(now>=rec.expires_at)return {result:{ok:false,error:'expired'}}
    if(!rec.approved)return {result:{ok:false,error:'not_approved'}}
    const pairing=`tpc_${randomBytes(32).toString('hex')}`
    return {record:{...rec,claimed:true,pairing_hash:sha256(pairing),pairing_expires_at:now+PAIR_TTL_MS},result:{ok:true,pairing_credential:pairing,subject_id:rec.subject_id,expires_at:now+PAIR_TTL_MS}}
  })
}

export async function revokePairing(challenge_hash: string, store: PairStore): Promise<void> {
  await store.mutate(challenge_hash,rec=>({record:rec?{...rec,revoked:true}:undefined,result:undefined}))
}

/** Build the listener's trusted IdentityResolver from a presented pairing
 *  credential. Reads the Authorization: Bearer tpc_... header ONLY; never trusts
 *  a body/Origin-supplied subject or install. Returns null on any failure. */
export function pairingIdentityResolver(store: PairStore, now: () => number = Date.now): IdentityResolver {
  return async (req) => {
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    if (!auth.startsWith('Bearer tpc_')) return null
    const presented = auth.slice('Bearer '.length).trim()
    if (!/^tpc_[0-9a-f]{64}$/.test(presented)) return null
    const rec = await store.byPairingHash(sha256(presented))
    if (!rec || rec.revoked || !rec.approved || !rec.claimed || !rec.pairing_hash) return null
    if (!hashEq(rec.pairing_hash, sha256(presented))) return null
    if (!Number.isFinite(rec.pairing_expires_at) || now() >= rec.pairing_expires_at!) return null
    if (!STABLE_SUBJECT.test(rec.subject_id) || !rec.install_id) return null
    return { subject_id: rec.subject_id, install_id: rec.install_id }
  }
}

/** Authorization to execute is separate from paired read access. */
export async function pairingTaskAccess(req:Parameters<IdentityResolver>[0],store:PairStore){
 const identity=await pairingIdentityResolver(store)(req)
 if(!identity)return null
 const auth=String(req.headers.authorization??'').slice('Bearer '.length).trim()
 const record=await store.byPairingHash(sha256(auth))
 if(!record||record.revoked)return null
 return {...identity,task_scopes:record.task_scopes??[]}
}
