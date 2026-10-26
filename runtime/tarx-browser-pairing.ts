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
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
  filePath=resolve(filePath)
  async function transaction<T>(operation:(all:Record<string,PairRecord>)=>Promise<T>):Promise<T>{
    await mkdir(dirname(filePath),{recursive:true,mode:0o700})
    let lock:Awaited<ReturnType<typeof open>>|undefined
    for(let i=0;i<200;i++){
      try{lock=await open(filePath+'.lock','wx',0o600);break}
      catch(e:any){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,5))}
    }
    if(!lock)throw new Error('pair_store_busy')
    try{
      let all:Record<string,PairRecord>={}
      try{all=JSON.parse(await readFile(filePath,'utf8'));if(!all||typeof all!=='object'||Array.isArray(all))throw Error('invalid_pair_store')}
      catch(e:any){if(e.code!=='ENOENT')throw e}
      return await operation(all)
    }finally{await lock.close();await unlink(filePath+'.lock')}
  }
  async function persist(all:Record<string,PairRecord>){
    const temp=filePath+'.'+randomBytes(12).toString('hex')+'.tmp'
    try{await writeFile(temp,JSON.stringify(all),{mode:0o600,flag:'wx'});await rename(temp,filePath)}
    finally{await unlink(temp).catch((e:any)=>{if(e.code!=='ENOENT')throw e})}
  }
  return {
    get(h){return transaction(async all=>all[h]??null)},
    put(rec){return transaction(async all=>{all[rec.challenge_hash]=rec;await persist(all)})},
    byPairingHash(ph){return transaction(async all=>Object.values(all).find(r=>r.pairing_hash===ph)??null)},
    mutate(h,update){return transaction(async all=>{const next=update(all[h]??null);if(next.record){all[h]=next.record;await persist(all)}return next.result})},
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
 *  can never be claimed. */
export async function approvePairingChallenge(challenge: string, store: PairStore, now = Date.now()): Promise<boolean> {
  return store.mutate(sha256(challenge),rec=>{
    if(!rec||rec.revoked||rec.claimed||now>=rec.expires_at)return {result:false}
    return {record:{...rec,approved:true},result:true}
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
