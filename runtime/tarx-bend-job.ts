/**
 * Opt-in local Bend 2 job type. Off the inference path: this module does not
 * touch model serving, personal-turn routing, Code Mode, or the supercomputer
 * gateway. Enable with TARX_BEND_JOBS=1. Default is off.
 *
 * Bend 2 backends (from Bend 2.0.40 docs / `bend --help` / native `+RTS --help`):
 *   - There is no `bend --backend metal` compiler flag.
 *   - Native binaries from programs that use `!` build the GPU lane when the
 *     host can: Metal on macOS (`-DBEND_METAL=1`), CUDA on Linux.
 *   - Runtime: `+RTS --gpu off` keeps `!` on CPU threads; `+RTS --gpu on`
 *     uses the GPU (Metal on Darwin). Linux has no Metal backend.
 */
import {spawn, type ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod, lstat, mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, isAbsolute, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export const BEND_JOB_KIND = 'bend' as const
export const BEND_JOBS_FLAG = 'TARX_BEND_JOBS'
export const BEND_BACKENDS = ['cpu', 'metal'] as const
export type BendBackend = (typeof BEND_BACKENDS)[number]

export type BendJobRequest = {
  program: string
  backend: BendBackend
  timeout_ms?: number
  threads?: number
}

export type BendSpawnResult = {
  stdout: string
  stderr: string
  exit_code: number | null
  signal: NodeJS.Signals | null
  killed: boolean
  wall_time_ms: number
  pid: number | null
  missing: boolean
}

export type BendJobResult = {
  ok: boolean
  kind: typeof BEND_JOB_KIND
  backend: BendBackend | null
  stdout: string
  stderr: string
  exit_code: number | null
  signal: string | null
  wall_time_ms: number
  checksum: string | null
  killed: boolean
  pid: number | null
  error?: string
  detail?: string
}

export type LocalJobTask = {kind: string; request: unknown}
export type LocalJobExecution = {result: BendJobResult; delivery: {kind: 'result'; payload: BendJobResult}}
export type LocalJobExecutor = {
  execute(task: LocalJobTask, context: {signal: AbortSignal}): Promise<LocalJobExecution>
}

export type BendJobOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  bendBin?: string
  spawn?: BendSpawner
  now?: () => number
  workDir?: string
  signal?: AbortSignal
}

export type BendSpawner = (command: string, args: readonly string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}) => Promise<BendSpawnResult>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_PROGRAM_BYTES = 256 * 1024
const MAX_OUTPUT = 65_536
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'USER', 'LOGNAME',
  'CC', 'CUDA_HOME', 'CUDA_PATH', 'BEND_HOME',
] as const

export function bendJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BEND_JOBS_FLAG] === '1'
}

export function codedError(code: string, detail?: string): Error & {code: string} {
  const error = new Error(detail ?? code) as Error & {code: string}
  error.code = code
  return error
}

export function parseBendJobRequest(value: unknown): {ok: true; request: BendJobRequest} | {ok: false; error: string; detail: string} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {ok: false, error: 'bend_invalid_request', detail: 'request must be an object'}
  }
  const body = value as Record<string, unknown>
  const extra = Object.keys(body).filter((key) => !['program', 'backend', 'timeout_ms', 'threads'].includes(key))
  if (extra.length) return {ok: false, error: 'bend_invalid_request', detail: `unknown fields: ${extra.join(',')}`}
  if (typeof body.program !== 'string' || !body.program || body.program.includes('\0')) {
    return {ok: false, error: 'bend_invalid_request', detail: 'program must be a non-empty path'}
  }
  if (body.backend !== 'cpu' && body.backend !== 'metal') {
    return {ok: false, error: 'bend_invalid_request', detail: 'backend must be cpu or metal'}
  }
  let timeout_ms: number | undefined
  if (body.timeout_ms !== undefined) {
    if (typeof body.timeout_ms !== 'number' || !Number.isInteger(body.timeout_ms) || body.timeout_ms < 1 || body.timeout_ms > MAX_TIMEOUT_MS) {
      return {ok: false, error: 'bend_invalid_request', detail: 'timeout_ms out of range'}
    }
    timeout_ms = body.timeout_ms
  }
  let threads: number | undefined
  if (body.threads !== undefined) {
    if (typeof body.threads !== 'number' || !Number.isInteger(body.threads) || body.threads < 1 || body.threads > 128) {
      return {ok: false, error: 'bend_invalid_request', detail: 'threads must be 1..128'}
    }
    threads = body.threads
  }
  return {ok: true, request: {program: body.program, backend: body.backend, timeout_ms, threads}}
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {BEND_NO_TELEMETRY: '1'}
  for (const key of ENV_ALLOWLIST) {
    const value = env[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

function fail(partial: Partial<BendJobResult> & {error: string; detail?: string}): BendJobResult {
  return {
    ok: false,
    kind: BEND_JOB_KIND,
    backend: partial.backend ?? null,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    exit_code: partial.exit_code ?? null,
    signal: partial.signal ?? null,
    wall_time_ms: partial.wall_time_ms ?? 0,
    checksum: null,
    killed: partial.killed ?? false,
    pid: partial.pid ?? null,
    error: partial.error,
    detail: partial.detail,
  }
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') }
  catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

export const spawnBendProcess: BendSpawner = (command, args, options) => new Promise((resolveSpawn) => {
  const started = performance.now()
  let settled = false
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const finish = (result: Omit<BendSpawnResult, 'stdout' | 'stderr' | 'wall_time_ms'> & {stdout?: string; stderr?: string}) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    resolveSpawn({
      stdout: result.stdout ?? stdout,
      stderr: result.stderr ?? stderr,
      exit_code: result.exit_code,
      signal: result.signal,
      killed: result.killed,
      wall_time_ms: Math.round((performance.now() - started) * 1000) / 1000,
      pid: result.pid,
      missing: result.missing,
    })
  }
  let child: ChildProcess
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
      windowsHide: true,
    })
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    finish({exit_code: null, signal: null, killed: false, pid: null, missing, stderr: missing ? '' : String(error)})
    return
  }
  const onAbort = () => { timedOut = true; killTree(child) }
  const timer = setTimeout(() => { timedOut = true; killTree(child) }, options.timeoutMs)
  options.signal?.addEventListener('abort', onAbort, {once: true})
  if (options.signal?.aborted) onAbort()
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    if (stdout.length > MAX_OUTPUT) killTree(child)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    if (stderr.length > MAX_OUTPUT) killTree(child)
  })
  child.on('error', (error) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    finish({exit_code: null, signal: null, killed: false, pid: child.pid ?? null, missing})
  })
  child.on('close', (code, signal) => {
    finish({
      exit_code: code,
      signal,
      killed: timedOut,
      pid: child.pid ?? null,
      missing: false,
    })
  })
})

async function resolveBendBin(env: NodeJS.ProcessEnv, explicit?: string): Promise<{ok: true; path: string} | {ok: false; detail: string}> {
  const named = explicit || env.TARX_BEND_BIN || 'bend'
  if (!named || named.includes('\0') || /\s/.test(named)) return {ok: false, detail: 'bend binary path is invalid'}
  if (named.includes('/') || isAbsolute(named)) {
    try {
      const path = await realpath(named)
      const info = await lstat(path)
      if (!info.isFile() || (info.mode & 0o111) === 0) return {ok: false, detail: `bend binary is not executable: ${named}`}
      return {ok: true, path}
    } catch {
      return {ok: false, detail: `bend binary not found: ${named}`}
    }
  }
  const pathEnv = env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    const candidate = join(dir, named)
    try {
      const info = await lstat(candidate)
      if (info.isFile() && (info.mode & 0o111) !== 0) return {ok: true, path: candidate}
    } catch { /* try next */ }
  }
  return {ok: false, detail: `bend binary not found on PATH: ${named}`}
}

function runtimeArgs(backend: BendBackend, threads?: number): string[] {
  const args = ['+RTS', '--gpu', backend === 'metal' ? 'on' : 'off']
  if (threads !== undefined) args.push('--threads', String(threads))
  return args
}

async function resolveProgram(path: string): Promise<{ok: true; path: string} | {ok: false; detail: string}> {
  try {
    const program = await realpath(resolve(path))
    const info = await lstat(program)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PROGRAM_BYTES) {
      return {ok: false, detail: 'program must be a regular .bend file'}
    }
    if (!program.endsWith('.bend')) return {ok: false, detail: 'program must end with .bend'}
    return {ok: true, path: program}
  } catch {
    return {ok: false, detail: `program not found: ${path}`}
  }
}

function fromSpawn(backend: BendBackend, compile: BendSpawnResult, run: BendSpawnResult): BendJobResult {
  if (run.missing) return fail({backend, error: 'bend_compile_failed', detail: 'compiled binary missing', pid: run.pid, wall_time_ms: run.wall_time_ms, stdout: compile.stdout, stderr: compile.stderr + run.stderr})
  if (run.killed) {
    return fail({
      backend,
      error: 'bend_timeout',
      detail: 'bend run timed out; process killed',
      killed: true,
      pid: run.pid,
      stdout: run.stdout,
      stderr: compile.stderr + run.stderr,
      wall_time_ms: run.wall_time_ms,
      signal: run.signal,
    })
  }
  if (run.exit_code !== 0) {
    return fail({
      backend,
      error: 'bend_run_failed',
      detail: `program exited ${run.exit_code ?? run.signal}`,
      exit_code: run.exit_code,
      signal: run.signal,
      stdout: run.stdout,
      stderr: compile.stderr + run.stderr,
      pid: run.pid,
      wall_time_ms: run.wall_time_ms,
    })
  }
  return {
    ok: true,
    kind: BEND_JOB_KIND,
    backend,
    stdout: run.stdout,
    stderr: compile.stderr + run.stderr,
    exit_code: 0,
    signal: null,
    wall_time_ms: run.wall_time_ms,
    checksum: checksum(run.stdout),
    killed: false,
    pid: run.pid,
  }
}

async function compileBend(input: {
  bendBin: string
  program: string
  binary: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  spawn: BendSpawner
}): Promise<{ok: true; result: BendSpawnResult} | {ok: false; result: BendJobResult}> {
  const compile = await input.spawn(input.bendBin, [input.program, '-o', input.binary], {
    cwd: dirname(input.program),
    env: childEnv(input.env),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
  if (compile.missing) return {ok: false, result: fail({error: 'bend_binary_missing', detail: `bend binary not found: ${input.bendBin}`, pid: compile.pid, stderr: compile.stderr, wall_time_ms: compile.wall_time_ms})}
  if (compile.killed) return {ok: false, result: fail({error: 'bend_timeout', detail: 'bend compile timed out; process killed', killed: true, pid: compile.pid, stdout: compile.stdout, stderr: compile.stderr, wall_time_ms: compile.wall_time_ms, signal: compile.signal})}
  if (compile.exit_code !== 0) {
    return {ok: false, result: fail({
      error: 'bend_compile_failed',
      detail: `bend -o exited ${compile.exit_code ?? compile.signal}`,
      exit_code: compile.exit_code,
      signal: compile.signal,
      stdout: compile.stdout,
      stderr: compile.stderr,
      pid: compile.pid,
      wall_time_ms: compile.wall_time_ms,
    })}
  }
  try { await chmod(input.binary, 0o755) } catch { /* bend usually already sets +x */ }
  return {ok: true, result: compile}
}

export async function runBendJob(raw: unknown, options: BendJobOptions = {}): Promise<BendJobResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const spawner = options.spawn ?? spawnBendProcess
  if (!bendJobsEnabled(env)) return fail({error: 'bend_jobs_disabled', detail: 'set TARX_BEND_JOBS=1 to enable Bend jobs'})
  const parsed = parseBendJobRequest(raw)
  if (!parsed.ok) return fail({error: parsed.error, detail: parsed.detail})
  const request = parsed.request
  if (request.backend === 'metal' && platform !== 'darwin') {
    return fail({backend: 'metal', error: 'bend_metal_requires_macos', detail: 'Bend 2 Metal is macOS-only; Linux GPU is CUDA, not Metal'})
  }
  const timeoutMs = request.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const bin = await resolveBendBin(env, options.bendBin)
  if (!bin.ok) return fail({backend: request.backend, error: 'bend_binary_missing', detail: bin.detail})
  const program = await resolveProgram(request.program)
  if (!program.ok) return fail({backend: request.backend, error: 'bend_invalid_request', detail: program.detail})

  const work = options.workDir ?? await mkdtemp(join(tmpdir(), 'tarx-bend-job-'))
  const ownedWork = !options.workDir
  const binary = join(work, 'program')
  try {
    const compiled = await compileBend({bendBin: bin.path, program: program.path, binary, timeoutMs, env, signal: options.signal, spawn: spawner})
    if (!compiled.ok) return {...compiled.result, backend: request.backend}
    const remaining = Math.max(1, timeoutMs - compiled.result.wall_time_ms)
    const run = await spawner(binary, runtimeArgs(request.backend, request.threads), {
      cwd: work,
      env: childEnv(env),
      timeoutMs: remaining,
      signal: options.signal,
    })
    return fromSpawn(request.backend, compiled.result, run)
  } finally {
    if (ownedWork) await rm(work, {recursive: true, force: true})
  }
}

/** Job-type dispatcher used by the daemon coordinator. Unknown kinds are refused. */
export function createBendJobExecutor(options: BendJobOptions = {}): LocalJobExecutor {
  return {
    async execute(task, context) {
      if (!task || task.kind !== BEND_JOB_KIND) throw codedError('unknown_job_kind', `unsupported job kind: ${String(task?.kind)}`)
      const result = await runBendJob(task.request, {...options, signal: context.signal})
      if (!result.ok) throw codedError(result.error ?? 'bend_run_failed', result.detail)
      return {result, delivery: {kind: 'result', payload: result}}
    },
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]!
}

export function median(values: readonly number[]): number {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

export type BendBenchReport = {
  program: string
  n: number
  host: {platform: NodeJS.Platform; arch: string}
  compile_ms: number | null
  backends: Record<string, {
    status: 'ok' | 'pending: needs a Mac run' | 'failed'
    median_ms?: number
    p95_ms?: number
    checksum?: string | null
    error?: string
    detail?: string
    runs?: number[]
  }>
}

export async function benchBendJob(input: {
  program: string
  backends: BendBackend[]
  n: number
  options?: BendJobOptions
}): Promise<BendBenchReport> {
  const options = input.options ?? {}
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const spawner = options.spawn ?? spawnBendProcess
  const report: BendBenchReport = {
    program: input.program,
    n: input.n,
    host: {platform, arch: process.arch},
    compile_ms: null,
    backends: {},
  }
  const runnable = input.backends.filter((backend) => !(backend === 'metal' && platform !== 'darwin'))
  for (const backend of input.backends) {
    if (backend === 'metal' && platform !== 'darwin') {
      report.backends.metal = {status: 'pending: needs a Mac run', detail: 'Bend 2 Metal cannot run on Linux'}
    }
  }
  if (!runnable.length) return report
  if (!bendJobsEnabled(env)) {
    for (const backend of runnable) report.backends[backend] = {status: 'failed', error: 'bend_jobs_disabled', detail: 'set TARX_BEND_JOBS=1 to enable Bend jobs'}
    return report
  }
  const bin = await resolveBendBin(env, options.bendBin)
  if (!bin.ok) {
    for (const backend of runnable) report.backends[backend] = {status: 'failed', error: 'bend_binary_missing', detail: bin.detail}
    return report
  }
  const program = await resolveProgram(input.program)
  if (!program.ok) {
    for (const backend of runnable) report.backends[backend] = {status: 'failed', error: 'bend_invalid_request', detail: program.detail}
    return report
  }
  const work = options.workDir ?? await mkdtemp(join(tmpdir(), 'tarx-bend-bench-'))
  const ownedWork = !options.workDir
  const binary = join(work, 'program')
  try {
    const compiled = await compileBend({
      bendBin: bin.path,
      program: program.path,
      binary,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env,
      signal: options.signal,
      spawn: spawner,
    })
    if (!compiled.ok) {
      for (const backend of runnable) report.backends[backend] = {status: 'failed', error: compiled.result.error, detail: compiled.result.detail}
      return report
    }
    report.compile_ms = compiled.result.wall_time_ms
    for (const backend of runnable) {
      const runs: number[] = []
      let checksumValue: string | null = null
      let failed: BendJobResult | undefined
      for (let i = 0; i < input.n; i++) {
        const run = await spawner(binary, runtimeArgs(backend), {
          cwd: work,
          env: childEnv(env),
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: options.signal,
        })
        const result = fromSpawn(backend, compiled.result, run)
        if (!result.ok) { failed = result; break }
        runs.push(result.wall_time_ms)
        checksumValue = result.checksum
      }
      if (failed) {
        report.backends[backend] = {status: 'failed', error: failed.error, detail: failed.detail, runs}
        continue
      }
      report.backends[backend] = {
        status: 'ok',
        median_ms: median(runs),
        p95_ms: percentile(runs, 95),
        checksum: checksumValue,
        runs,
      }
    }
    return report
  } finally {
    if (ownedWork) await rm(work, {recursive: true, force: true})
  }
}

function parseCli(argv: string[]): {command: string; options: Record<string, string>} {
  const command = argv[0] ?? 'help'
  const options: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw codedError('bend_invalid_request', 'invalid arguments')
    options[flag.slice(2)] = value
  }
  return {command, options}
}

export async function runBendJobCli(argv: string[], options: BendJobOptions = {}): Promise<{ok: boolean; [key: string]: unknown}> {
  const {command, options: flags} = parseCli(argv)
  if (command === 'help' || command === '--help') {
    return {
      ok: true,
      usage: 'tarx-bend-job run|bench --program FILE [--backend cpu|metal] [--backends cpu,metal] [--n N]',
      flag: `${BEND_JOBS_FLAG}=1`,
      kind: BEND_JOB_KIND,
    }
  }
  const program = flags.program
  if (!program) return {ok: false, error: 'bend_invalid_request', detail: '--program is required'}
  if (command === 'run') {
    const result = await runBendJob({program, backend: flags.backend ?? 'cpu', timeout_ms: flags.timeout_ms ? Number(flags.timeout_ms) : undefined, threads: flags.threads ? Number(flags.threads) : undefined}, options)
    return result
  }
  if (command === 'bench') {
    const n = flags.n ? Number(flags.n) : 11
    if (!Number.isInteger(n) || n < 1 || n > 100) return {ok: false, error: 'bend_invalid_request', detail: '--n must be 1..100'}
    const backends = (flags.backends ?? flags.backend ?? 'cpu,metal').split(',').filter(Boolean) as BendBackend[]
    if (backends.some((backend) => backend !== 'cpu' && backend !== 'metal')) return {ok: false, error: 'bend_invalid_request', detail: 'backends must be cpu and/or metal'}
    return {ok: true, ...(await benchBendJob({program, backends, n, options}))}
  }
  return {ok: false, error: 'bend_invalid_request', detail: `unknown command: ${command}`}
}

const invoked = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  try {
    const result = await runBendJobCli(process.argv.slice(2))
    console.log(JSON.stringify(result, null, 2))
    if (result.ok === false) process.exitCode = 1
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : 'bend_cli_failed'
    console.error(JSON.stringify({ok: false, error: code}))
    process.exitCode = 1
  }
}
