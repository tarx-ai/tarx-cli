/**
 * Local per-user learning controller (Node side).
 *
 * Owns owner-isolated durable state and the explicit learning actions. Launches
 * Root's fixed MLX runner with JSON stdin only. A running job returns HTTP 202
 * after a durable reservation. Personal chat asks this controller for a verified
 * active adapter directory; the browser never supplies that path.
 *
 * Owner namespace is sha256(subject_id + NUL + install_id), derived server-side.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createLocalJsonStore } from './local-json-store.ts'

export const MAX_EXAMPLES = 64
export const MAX_EXAMPLE_CHARS = 2000
/** Root's passing synthetic recipe is 128. 64 was not a personalization proof. */
export const TRAIN_ITERATIONS = 128
export const MAX_EXAMPLE_BYTES = 262144
const RUNNER_DEADLINE_MS = 30 * 60 * 1000
const MAX_RUNNER_OUTPUT = 65536

export const DENY_NETWORK_PROFILE = '(version 1)\n(allow default)\n(deny network*)\n'

export type LearningState = 'off' | 'ready' | 'training' | 'candidate' | 'active' | 'interrupted' | 'failed'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX64 = /^[a-f0-9]{64}$/

export function ownerNamespace(subject_id: string, install_id: string): string {
  return createHash('sha256').update(subject_id + '\u0000' + install_id).digest('hex')
}

export function denyNetworkArgv(argv: readonly string[]): string[] {
  return ['/usr/bin/sandbox-exec', '-p', DENY_NETWORK_PROFILE, ...argv]
}

type Example = { example_id: string; prompt: string; response: string }
type Version = { version: string; job_id: string; adapter_sha256: string; base_sha256: string; adapter_config_sha256: string }
type TrainingLease = { pid: number; namespace: string; job_id: string; nonce: string }
type JobPhase = 'training' | 'candidate' | 'failed' | 'interrupted'
type OwnerRecord = {
  namespace: string
  examples: Example[]
  state: LearningState
  job_id?: string
  active_version?: string
  versions: Version[]
  jobs?: Record<string, JobPhase>
}

export type RunnerRequest = {
  action: 'train'
  base_path: string
  state_root: string
  owner: string
  job_id: string
  examples_path: string
  adapter_path: string
  iterations: number
}
export type RunnerResult = {
  ok: boolean
  status: 'trained' | 'failed'
  adapter_sha256?: string
  adapter_config_sha256?: string
  base_sha256?: string
  base_control_passed?: boolean
  candidate_control_passed?: boolean
  error?: string
}

export type LearningConfig = {
  interpreter: string
  runnerScript: string
  basePath: string
  sandboxWrap?: (argv: string[]) => string[]
  deadlineMs?: number
}

export type RunnerLauncher = (
  config: LearningConfig,
  request: RunnerRequest,
  examplesJSONL: string,
  signal?: AbortSignal,
) => Promise<RunnerResult>

const OFFLINE_ENV: NodeJS.ProcessEnv = {
  HF_HUB_OFFLINE: '1',
  HF_DATASETS_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  WANDB_MODE: 'disabled',
  TOKENIZERS_PARALLELISM: 'false',
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => { hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', () => resolveHash())
  })
  return hash.digest('hex')
}

const baseDigestCache = new Map<string, { meta: string; digest: string }>()
let baseDigestFileReads = 0

/** Test observation for the active-adapter path. A hit is not a latency benchmark. */
export function baseDigestObservations(): { fileReads: number } {
  return { fileReads: baseDigestFileReads }
}

export function resetBaseDigestObservations(): void {
  baseDigestCache.clear()
  baseDigestFileReads = 0
}

function fileIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mtimeNs?: bigint; ctimeNs?: bigint }): string {
  const mtime = typeof info.mtimeNs === 'bigint' ? info.mtimeNs.toString() : String(info.mtimeMs)
  const ctime = typeof info.ctimeNs === 'bigint' ? info.ctimeNs.toString() : String(info.ctimeMs)
  return info.dev + ':' + info.ino + ':' + info.size + ':' + mtime + ':' + ctime
}

/** Same base fingerprint as Root's runner: config.json, then sorted safetensors.
 * Full file bytes are hashed when inode, size, mtime, or ctime change.
 * An unchanged identity reuses the process cache. */
export async function baseModelDigest(base: string): Promise<string | null> {
  try {
    if (!isAbsolute(base)) return null
    const linked = await lstat(base)
    if (!linked.isDirectory() || linked.isSymbolicLink()) return null
    const root = await realpath(base)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null
    const weights = (await readdir(root)).filter((name) => name.endsWith('.safetensors')).sort()
    if (!weights.length) return null
    const names = ['config.json', ...weights]
    const parts: string[] = [fileIdentity(rootInfo)]
    const files: { name: string; path: string }[] = []
    for (const name of names) {
      if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
      const path = join(root, name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return null
      parts.push(name + '@' + fileIdentity(info))
      files.push({ name, path })
    }
    const meta = parts.join('|')
    const cached = baseDigestCache.get(root)
    if (cached && cached.meta === meta) return cached.digest
    const hash = createHash('sha256')
    for (const file of files) {
      baseDigestFileReads += 1
      hash.update(file.name)
      hash.update(await sha256File(file.path))
    }
    const digest = hash.digest('hex')
    baseDigestCache.set(root, { meta, digest })
    return digest
  } catch {
    return null
  }
}

async function privateDir(path: string): Promise<boolean> {
  try {
    let info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (info?.isSymbolicLink()) return false
    if (!info) await mkdir(path, { mode: 0o700 })
    await chmod(path, 0o700)
    info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false
    if (info.mode & 0o077) return false
    return true
  } catch {
    return false
  }
}

/** Refuse a symlink on the target or any existing component down to the root. */
async function ownedPath(path: string, root: string): Promise<boolean> {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) return false
  let rootReal: string
  try { rootReal = await realpath(root) } catch { return false }
  let current = resolve(path)
  for (;;) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) return false
      const real = await realpath(current)
      if (real === rootReal) return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return false
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

async function prepareJobFiles(request: RunnerRequest, examplesJSONL: string): Promise<boolean> {
  if (!HEX64.test(request.owner) || !UUID.test(request.job_id)) return false
  const owner = join(request.state_root, request.owner)
  const examplesDir = join(owner, 'examples')
  const versionsDir = join(owner, 'versions')
  if (!await privateDir(request.state_root) || !await privateDir(owner) || !await privateDir(examplesDir) || !await privateDir(versionsDir)) return false
  if (!await ownedPath(request.examples_path, owner) || !await ownedPath(request.adapter_path, owner)) return false
  if (dirname(request.examples_path) !== examplesDir || dirname(request.adapter_path) !== versionsDir) return false
  try {
    const existing = await lstat(request.adapter_path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing) return false
    const handle = await open(request.examples_path, 'wx', 0o600)
    try { await handle.writeFile(examplesJSONL) } finally { await handle.close() }
    await chmod(request.examples_path, 0o600)
    const info = await lstat(request.examples_path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) return false
    return true
  } catch {
    return false
  }
}

function readRunner(value: unknown): RunnerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 'failed', error: 'runner_bad_output' }
  const row = value as Record<string, unknown>
  const trained = row.ok === true && row.status === 'trained'
  const hex = (item: unknown) => typeof item === 'string' && HEX64.test(item) ? item : undefined
  const error = typeof row.error === 'string' && /^[a-z0-9_]{1,64}$/.test(row.error) ? row.error : undefined
  return {
    ok: trained,
    status: trained ? 'trained' : 'failed',
    adapter_sha256: hex(row.adapter_sha256),
    adapter_config_sha256: hex(row.adapter_config_sha256),
    base_sha256: hex(row.base_sha256),
    base_control_passed: row.base_control_passed === true,
    candidate_control_passed: row.candidate_control_passed === true,
    ...(error ? { error } : {}),
  }
}

export function createSubprocessRunner(): RunnerLauncher {
  return (config, request, examplesJSONL, signal) => new Promise((resolveRunner) => {
    let settled = false
    const finish = (result: RunnerResult) => {
      if (settled) return
      settled = true
      resolveRunner(result)
    }
    void (async () => {
      if (signal?.aborted) return finish({ ok: false, status: 'failed', error: 'interrupted' })
      if (!config.sandboxWrap) return finish({ ok: false, status: 'failed', error: 'unavailable' })
      if (!isAbsolute(config.interpreter) || /\s/.test(config.interpreter) || config.interpreter.includes('\0')) return finish({ ok: false, status: 'failed', error: 'unavailable' })
      try {
        // A venv interpreter is often a symlink. Validate the real file, then
        // execute the original path so pyvenv.cfg stays in effect.
        const info = await lstat(config.interpreter)
        if (!info.isFile() && !info.isSymbolicLink()) return finish({ ok: false, status: 'failed', error: 'unavailable' })
        const target = info.isSymbolicLink() ? await realpath(config.interpreter) : config.interpreter
        const bin = await lstat(target)
        if (!bin.isFile() || bin.isSymbolicLink() || (bin.mode & 0o111) === 0) return finish({ ok: false, status: 'failed', error: 'unavailable' })
      } catch {
        return finish({ ok: false, status: 'failed', error: 'unavailable' })
      }
      if (!await prepareJobFiles(request, examplesJSONL)) return finish({ ok: false, status: 'failed', error: 'state_write_failed' })
      const argv = config.sandboxWrap([config.interpreter, config.runnerScript])
      if (argv.length < 2 || argv.some((arg) => !arg || arg.includes('\0'))) return finish({ ok: false, status: 'failed', error: 'unavailable' })
      const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], env: OFFLINE_ENV, shell: false, windowsHide: true })
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, status: 'failed', error: 'interrupted' }) }, config.deadlineMs ?? RUNNER_DEADLINE_MS)
      const stop = () => { child.kill('SIGKILL'); finish({ ok: false, status: 'failed', error: 'interrupted' }) }
      signal?.addEventListener('abort', stop, { once: true })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.length > MAX_RUNNER_OUTPUT) { child.kill('SIGKILL'); finish({ ok: false, status: 'failed', error: 'runner_bad_output' }) }
      })
      child.on('error', () => finish({ ok: false, status: 'failed', error: 'runner_unavailable' }))
      child.stdin.on('error', () => {})
      child.on('close', () => {
        clearTimeout(timer)
        if (settled) return
        try { finish(readRunner(JSON.parse(out.trim().split('\n').pop() ?? ''))) }
        catch { finish({ ok: false, status: 'failed', error: 'runner_bad_output' }) }
      })
      child.stdin.end(JSON.stringify(request))
    })().catch(() => finish({ ok: false, status: 'failed', error: 'runner_unavailable' }))
  })
}

export type LearningResponse = { code: number; body: Record<string, unknown> }
export type LearningRequest =
  | { action: 'status' }
  | { action: 'add_example'; example_id: string; prompt: string; response: string }
  | { action: 'train'; request_id: string }
  | { action: 'activate'; version: string }
  | { action: 'pause' }
export type AdapterResolution = { kind: 'base' } | { kind: 'adapter'; path: string; model: string } | { kind: 'closed' }

function blank(ns: string): OwnerRecord {
  return { namespace: ns, examples: [], state: 'ready', versions: [], jobs: {} }
}

export function createLearningController(input: {
  file: string
  stateRoot: string
  config?: LearningConfig
  runner?: RunnerLauncher
}) {
  const store = createLocalJsonStore<OwnerRecord>(input.file)
  const runner = input.runner ?? createSubprocessRunner()
  const configured = Boolean(input.config)
  const stateRoot = resolve(input.stateRoot)
  const inflight = new Set<string>()
  const cancels = new Map<string, AbortController>()

  function view(rec: OwnerRecord | null, forced?: { state: LearningState; version?: string; job_id?: string }): Record<string, unknown> {
    const state = forced?.state ?? rec?.state ?? 'ready'
    const candidate = rec?.versions.length ? rec.versions[rec.versions.length - 1] : undefined
    const showCandidate = !forced && state !== 'training' && state !== 'failed' && state !== 'interrupted' && candidate && candidate.version !== rec?.active_version
    const version = forced?.version ?? (showCandidate ? candidate.version : state === 'active' ? rec?.active_version : undefined)
    const job_id = forced?.job_id ?? (state === 'training' ? rec?.job_id : undefined)
    return {
      ok: true,
      state: showCandidate ? 'candidate' : state,
      configured,
      approved_examples: rec?.examples.length ?? 0,
      ...(version && UUID.test(version) ? { version } : {}),
      ...(job_id && UUID.test(job_id) ? { job_id } : {}),
    }
  }

  const leasePath = join(stateRoot, 'training-lease.json')

  function pidLiveness(pid: number): 'alive' | 'dead' | 'uncertain' {
    if (!Number.isInteger(pid) || pid <= 0) return 'uncertain'
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'uncertain'
    }
  }

  type LeaseView = { kind: 'absent' } | { kind: 'uncertain'; raw: string } | { kind: 'lease'; raw: string; lease: TrainingLease }

  function parseLease(raw: string): TrainingLease | null {
    try {
      const row = JSON.parse(raw) as Record<string, unknown>
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null
      if (Object.keys(row).some((key) => !['pid', 'namespace', 'job_id', 'nonce'].includes(key))) return null
      if (typeof row.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(row.nonce)) return null
      if (typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 1) return null
      if (typeof row.namespace !== 'string' || !HEX64.test(row.namespace)) return null
      if (typeof row.job_id !== 'string' || !UUID.test(row.job_id)) return null
      return { pid: row.pid, namespace: row.namespace, job_id: row.job_id, nonce: row.nonce }
    } catch {
      return null
    }
  }

  async function readLease(): Promise<LeaseView> {
    try {
      const info = await lstat(leasePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return { kind: 'uncertain', raw: '' }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return { kind: 'uncertain', raw: '' }
      if (info.mode & 0o022) return { kind: 'uncertain', raw: '' }
      const raw = await readFile(leasePath, 'utf8')
      const lease = parseLease(raw)
      return lease ? { kind: 'lease', raw, lease } : { kind: 'uncertain', raw }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
      return { kind: 'uncertain', raw: '' }
    }
  }

  function markInterrupted(rec: OwnerRecord, jobId: string): void {
    rec.jobs = { ...rec.jobs, [jobId]: 'interrupted' }
    if (rec.job_id === jobId) rec.job_id = undefined
    if (rec.state === 'training') rec.state = rec.active_version ? 'active' : 'interrupted'
  }

  /** A missing, live, or uncertain lease is not a reason to steal a job or delete the lock.
   * Only a parsed lease whose pid is confirmed dead can be marked interrupted, and only
   * the unchanged file is removed. */
  async function recover(): Promise<void> {
    const held = await readLease()
    if (held.kind !== 'lease') return
    if (pidLiveness(held.lease.pid) !== 'dead') return
    if (inflight.has(held.lease.namespace + ':' + held.lease.job_id)) return
    await store.transact((all) => {
      const rec = all[held.lease.namespace]
      if (!rec || rec.state !== 'training' || rec.job_id !== held.lease.job_id) return { result: undefined }
      markInterrupted(rec, held.lease.job_id)
      return { result: undefined, write: true }
    })
    const again = await readLease()
    if (again.kind !== 'lease' || again.raw !== held.raw || pidLiveness(again.lease.pid) !== 'dead') return
    const info = await lstat(leasePath).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) return
    await unlink(leasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') return undefined
    })
  }

  async function leaseBlocks(exceptJob?: string): Promise<boolean> {
    const held = await readLease()
    if (held.kind === 'absent') return false
    if (held.kind === 'uncertain') return true
    if (exceptJob && held.lease.job_id === exceptJob && held.lease.pid === process.pid) return false
    return pidLiveness(held.lease.pid) !== 'dead'
  }

  async function claimLease(ns: string, jobId: string): Promise<string | null> {
    if (await leaseBlocks()) return null
    const nonce = randomBytes(16).toString('hex')
    const body = JSON.stringify({ pid: process.pid, namespace: ns, job_id: jobId, nonce } satisfies TrainingLease)
    try {
      if (!await privateDir(stateRoot)) return null
      const handle = await open(leasePath, 'wx', 0o600)
      try { await handle.writeFile(body) } finally { await handle.close() }
      await chmod(leasePath, 0o600)
      return nonce
    } catch {
      return null
    }
  }

  async function releaseLease(nonce: string): Promise<void> {
    const held = await readLease()
    if (held.kind !== 'lease' || held.lease.nonce !== nonce || held.lease.pid !== process.pid) return
    const again = await readLease()
    if (again.kind !== 'lease' || again.raw !== held.raw) return
    const info = await lstat(leasePath).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink()) return
    await unlink(leasePath).catch(() => undefined)
  }

  async function ownedAdapterFile(path: string, ownerRoot: string, digest: string): Promise<boolean> {
    if (!HEX64.test(digest) || !await ownedPath(path, ownerRoot)) return false
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return false
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false
      if (info.mode & 0o077) return false
      return await sha256File(path) === digest
    } catch {
      return false
    }
  }

  async function verifyActive(rec: OwnerRecord, version: string): Promise<string | null> {
    if (!input.config || !UUID.test(version)) return null
    const stored = rec.versions.find((item) => item.version === version)
    if (!stored || !HEX64.test(stored.adapter_sha256) || !HEX64.test(stored.base_sha256) || !HEX64.test(stored.adapter_config_sha256)) return null
    const ownerRoot = join(stateRoot, rec.namespace)
    const dir = join(ownerRoot, 'versions', version)
    try {
      const dirInfo = await lstat(dir)
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return null
      if (typeof process.getuid === 'function' && dirInfo.uid !== process.getuid()) return null
      if (dirInfo.mode & 0o022) return null
      for (const name of await readdir(dir)) {
        if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
        const child = await lstat(join(dir, name))
        if (child.isSymbolicLink()) return null
      }
    } catch {
      return null
    }
    if (!await ownedAdapterFile(join(dir, 'adapters.safetensors'), ownerRoot, stored.adapter_sha256)) return null
    if (!await ownedAdapterFile(join(dir, 'adapter_config.json'), ownerRoot, stored.adapter_config_sha256)) return null
    if (await baseModelDigest(input.config.basePath) !== stored.base_sha256) return null
    return dir
  }

  async function apply(ns: string, requestId: string, result: RunnerResult, stillAuthorized?: () => Promise<boolean>): Promise<void> {
    const allowed = stillAuthorized ? await stillAuthorized().catch(() => false) : true
    const artifact = result.ok && result.status === 'trained' && result.candidate_control_passed === true
      && typeof result.adapter_sha256 === 'string' && typeof result.base_sha256 === 'string' && typeof result.adapter_config_sha256 === 'string'
      ? await verifyStored(ns, requestId, result.adapter_sha256, result.base_sha256, result.adapter_config_sha256)
      : false
    await store.transact((all) => {
      const rec = all[ns]
      if (!rec || rec.job_id !== requestId || rec.jobs?.[requestId] !== 'training') return { result: undefined }
      rec.job_id = undefined
      if (!allowed || !artifact) {
        rec.jobs = { ...rec.jobs, [requestId]: allowed ? 'failed' : 'interrupted' }
        rec.state = rec.active_version ? 'active' : (allowed ? 'failed' : 'interrupted')
        return { result: undefined, write: true }
      }
      rec.versions.push({
        version: requestId,
        job_id: requestId,
        adapter_sha256: result.adapter_sha256!,
        base_sha256: result.base_sha256!,
        adapter_config_sha256: result.adapter_config_sha256!,
      })
      rec.jobs = { ...rec.jobs, [requestId]: 'candidate' }
      rec.state = 'candidate'
      return { result: undefined, write: true }
    })
  }

  async function verifyStored(ns: string, version: string, adapter: string, base: string, configHash: string): Promise<boolean> {
    if (!input.config) return false
    const probe = await verifyActive({
      ...blank(ns),
      versions: [{ version, job_id: version, adapter_sha256: adapter, base_sha256: base, adapter_config_sha256: configHash }],
    }, version)
    return probe !== null
  }

  function start(ns: string, requestId: string, request: RunnerRequest, jsonl: string, nonce: string, stillAuthorized?: () => Promise<boolean>) {
    const key = ns + ':' + requestId
    const abort = new AbortController()
    inflight.add(key)
    cancels.set(key, abort)
    const watch = stillAuthorized ? setInterval(() => {
      void stillAuthorized().then((ok) => { if (!ok) abort.abort() }).catch(() => abort.abort())
    }, 50) : undefined
    watch?.unref()
    void (async () => {
      let result: RunnerResult
      try { result = await runner(input.config!, request, jsonl, abort.signal) }
      catch { result = { ok: false, status: 'failed', error: 'runner_unavailable' } }
      try { await apply(ns, requestId, result, stillAuthorized) }
      catch { /* the reservation remains training until the next process recovers it */ }
      finally {
        if (watch) clearInterval(watch)
        inflight.delete(key)
        cancels.delete(key)
        await releaseLease(nonce)
      }
    })()
  }

  return {
    async resolveAdapter(ns: string): Promise<AdapterResolution> {
      if (!configured || !HEX64.test(ns)) return { kind: 'base' }
      await recover()
      const rec = await store.get(ns)
      if (!rec?.active_version) return { kind: 'base' }
      const path = await verifyActive(rec, rec.active_version)
      return path && input.config ? { kind: 'adapter', path, model: input.config.basePath } : { kind: 'closed' }
    },
    async handle(ns: string, scopes: string[], body: unknown, opts?: { stillAuthorized?: () => Promise<boolean> }): Promise<LearningResponse> {
      try {
        if (!HEX64.test(ns)) return { code: 400, body: { ok: false, error: 'malformed' } }
        await recover()
        const request = parseLearningRequest(body)
        if (!request) return { code: 400, body: { ok: false, error: 'malformed' } }
        if (request.action === 'status') {
          if (!scopes.includes('personal_chat') && !scopes.includes('personal_learning')) return { code: 403, body: { ok: false, error: 'scope_required' } }
          if (!configured) return { code: 200, body: { ok: true, state: 'off', configured: false, approved_examples: 0 } }
          return { code: 200, body: view(await store.get(ns)) }
        }
        if (!scopes.includes('personal_learning')) return { code: 403, body: { ok: false, error: 'scope_required' } }
        if (!configured || !input.config) return { code: 503, body: { ok: false, error: 'not_configured' } }

        if (request.action === 'add_example') {
          return store.transact((all) => {
            const rec = all[ns] ?? blank(ns)
            if (rec.state === 'training') return { result: { code: 409, body: { ok: false, error: 'busy' } } }
            if (rec.examples.some((item) => item.example_id === request.example_id)) return { result: { code: 200, body: view(rec) } }
            if (rec.examples.length >= MAX_EXAMPLES) return { result: { code: 400, body: { ok: false, error: 'malformed' } } }
            const next = rec.examples.reduce((sum, item) => sum + Buffer.byteLength(item.prompt) + Buffer.byteLength(item.response), 0) + Buffer.byteLength(request.prompt) + Buffer.byteLength(request.response)
            if (next > MAX_EXAMPLE_BYTES) return { result: { code: 400, body: { ok: false, error: 'malformed' } } }
            rec.examples.push({ example_id: request.example_id, prompt: request.prompt, response: request.response })
            all[ns] = rec
            return { result: { code: 200, body: view(rec) }, write: true }
          })
        }

        if (request.action === 'train') {
          const preview = await store.get(ns)
          const phase = preview?.jobs?.[request.request_id]
          if (phase === 'training' || (preview?.state === 'training' && preview.job_id === request.request_id)) {
            return { code: 202, body: view(preview, { state: 'training', job_id: request.request_id }) }
          }
          if (phase && preview) {
            const outcome: LearningState = phase === 'candidate' ? 'candidate' : phase
            return { code: 200, body: view(preview, { state: outcome, version: phase === 'candidate' ? request.request_id : undefined }) }
          }
          if (await leaseBlocks(request.request_id)) return { code: 409, body: { ok: false, error: 'busy' } }
          const reserved = await store.transact<
            { kind: 'start'; rec: OwnerRecord } | { kind: 'replay'; code: number; rec: OwnerRecord; phase: JobPhase } | { kind: 'busy' } | { kind: 'empty' }
          >((all) => {
            const rec = all[ns] ?? blank(ns)
            const phase = rec.jobs?.[request.request_id]
            if (phase === 'training' || (rec.state === 'training' && rec.job_id === request.request_id)) {
              return { result: { kind: 'replay', code: 202, rec, phase: 'training' } }
            }
            if (phase) return { result: { kind: 'replay', code: 200, rec, phase } }
            if (Object.values(all).some((item) => item.state === 'training') || inflight.size > 0) return { result: { kind: 'busy' } }
            if (rec.examples.length < 1) return { result: { kind: 'empty' } }
            rec.state = 'training'
            rec.job_id = request.request_id
            rec.jobs = { ...rec.jobs, [request.request_id]: 'training' }
            all[ns] = rec
            return { result: { kind: 'start', rec }, write: true }
          })
          if (reserved.kind === 'busy') return { code: 409, body: { ok: false, error: 'busy' } }
          if (reserved.kind === 'empty') return { code: 400, body: { ok: false, error: 'malformed' } }
          if (reserved.kind === 'replay') {
            const outcome: LearningState = reserved.phase === 'candidate' ? 'candidate' : reserved.phase
            const version = reserved.phase === 'candidate' ? request.request_id : undefined
            return { code: reserved.code, body: view(reserved.rec, { state: outcome, version, job_id: reserved.phase === 'training' ? request.request_id : undefined }) }
          }
          const nonce = await claimLease(ns, request.request_id)
          if (!nonce) {
            await store.transact((all) => {
              const rec = all[ns]
              if (!rec || rec.job_id !== request.request_id) return { result: undefined }
              markInterrupted(rec, request.request_id)
              return { result: undefined, write: true }
            })
            return { code: 409, body: { ok: false, error: 'busy' } }
          }
          const ownerDir = join(stateRoot, ns)
          const versionDir = join(ownerDir, 'versions', request.request_id)
          const examplesPath = join(ownerDir, 'examples', request.request_id + '.jsonl')
          const jsonl = reserved.rec.examples.map((item) => JSON.stringify({ prompt: item.prompt, response: item.response })).join('\n') + '\n'
          const launched: RunnerRequest = {
            action: 'train', base_path: input.config.basePath, state_root: stateRoot, owner: ns,
            job_id: request.request_id, examples_path: examplesPath, adapter_path: versionDir, iterations: TRAIN_ITERATIONS,
          }
          start(ns, request.request_id, launched, jsonl, nonce, opts?.stillAuthorized)
          return { code: 202, body: view(reserved.rec) }
        }

        if (request.action === 'activate') {
          const rec = await store.get(ns)
          if (!rec || !rec.versions.some((item) => item.version === request.version)) return { code: 404, body: { ok: false, error: 'malformed' } }
          const path = await verifyActive(rec, request.version)
          if (!path) return { code: 503, body: { ok: false, error: 'unavailable' } }
          return store.transact((all) => {
            const current = all[ns]
            if (!current || current.state === 'training') return { result: { code: 409, body: { ok: false, error: 'busy' } } }
            if (!current.versions.some((item) => item.version === request.version)) return { result: { code: 404, body: { ok: false, error: 'malformed' } } }
            current.active_version = request.version
            current.state = 'active'
            all[ns] = current
            return { result: { code: 200, body: view(current) }, write: true }
          })
        }

        const pausing = await store.get(ns)
        if (pausing?.state === 'training' && pausing.job_id && !cancels.has(ns + ':' + pausing.job_id)) {
          return { code: 409, body: { ok: false, error: 'busy' } }
        }
        if (pausing?.state === 'training' && pausing.job_id) cancels.get(ns + ':' + pausing.job_id)?.abort()
        return store.transact((all) => {
          const rec = all[ns]
          if (!rec) return { result: { code: 200, body: { ok: true, state: 'ready', configured, approved_examples: 0 } } }
          if (rec.state === 'training' && rec.job_id) {
            if (!cancels.has(ns + ':' + rec.job_id)) return { result: { code: 409, body: { ok: false, error: 'busy' } } }
            rec.jobs = { ...rec.jobs, [rec.job_id]: 'interrupted' }
            rec.job_id = undefined
          }
          rec.active_version = undefined
          rec.state = rec.versions.length ? 'candidate' : 'ready'
          all[ns] = rec
          return { result: { code: 200, body: view(rec) }, write: true }
        })
      } catch {
        return { code: 503, body: { ok: false, error: 'unavailable' } }
      }
    },
    ownerNamespace,
  }
}

function parseLearningRequest(body: unknown): LearningRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const row = body as Record<string, unknown>
  const action = row.action
  const keys = Object.keys(row)
  const allowed: Record<string, string[]> = {
    status: ['action'],
    pause: ['action'],
    add_example: ['action', 'example_id', 'prompt', 'response'],
    train: ['action', 'request_id'],
    activate: ['action', 'version'],
  }
  if (typeof action !== 'string' || !allowed[action] || keys.some((key) => !allowed[action].includes(key))) return null
  if (action === 'status') return { action: 'status' }
  if (action === 'pause') return { action: 'pause' }
  if (action === 'train') return typeof row.request_id === 'string' && UUID.test(row.request_id) ? { action: 'train', request_id: row.request_id } : null
  if (action === 'activate') return typeof row.version === 'string' && UUID.test(row.version) ? { action: 'activate', version: row.version } : null
  const prompt = typeof row.prompt === 'string' ? row.prompt : ''
  const response = typeof row.response === 'string' ? row.response : ''
  if (typeof row.example_id !== 'string' || !UUID.test(row.example_id) || prompt.length < 1 || prompt.length > MAX_EXAMPLE_CHARS || response.length < 1 || response.length > MAX_EXAMPLE_CHARS) return null
  return { action: 'add_example', example_id: row.example_id, prompt, response }
}

export async function trustedInstalledRunner(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    if (info.size <= 8192 || info.size > 2_000_000) return false
    if (info.mode & 0o022) return false
    if ((info.mode & 0o444) === 0) return false
    const text = await readFile(path, 'utf8')
    return text.includes('def train(') && text.includes('candidate_control_passed')
  } catch {
    return false
  }
}
