/** Isolated Code Mode script runner. Model-written JavaScript runs in a forked
 * process with a fresh vm realm that exposes only allowlisted `tools`.
 *
 * Host-realm objects are never installed on the context. Tool functions are
 * created inside the realm and talk to the parent through JSON-only jobs.
 * The child is launched with V8 string-code generation disabled and Node's
 * permission model (runtime-dir reads only; no child_process, worker, net, or
 * fs-write). Timeout and oversized IPC kill the whole process group.
 *
 * Script text and tool output stay on this device. Nothing here opens a
 * remote socket, writes telemetry, or logs payload contents. */
import {fork,type ChildProcess} from 'node:child_process'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'

export const TRUNCATION_MARKER = '[truncated]'
export const SCRIPT_MAX_BYTES = 16 * 1024
export const CONTEXT_RESULT_MAX_BYTES = 8 * 1024
export const COMMAND_STDOUT_MAX_BYTES = 4 * 1024
export const COMMAND_STDERR_MAX_BYTES = 4 * 1024

export type CommandStatus = 'ok' | 'error' | 'denied' | 'timeout' | 'not_run' | 'unknown'

export type CommandResult = {
 tool: string
 status: CommandStatus
 exit_code: number | null
 stdout: string
 stderr: string
 truncated: boolean
}

export type SandboxLimits = {
 timeoutMs: number
 memoryMb: number
 resultMaxBytes: number
 stdoutMaxBytes: number
 maxToolCalls: number
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
 timeoutMs: 10_000,
 memoryMb: 64,
 resultMaxBytes: CONTEXT_RESULT_MAX_BYTES,
 stdoutMaxBytes: COMMAND_STDOUT_MAX_BYTES,
 maxToolCalls: 32,
}

export type SandboxProgress = {step: number; tool: string; phase: 'started' | 'completed' | 'failed' | 'not_run'}

export type SandboxRun = {
 script: string
 toolNames: string[]
 executeTool: (name: string, input: unknown, signal: AbortSignal) => Promise<CommandResult>
 limits?: Partial<SandboxLimits>
 signal?: AbortSignal
 onProgress?: (event: SandboxProgress) => void
}

export type SandboxOutcome = {
 status: CommandStatus
 value: unknown
 truncated: boolean
 error?: string
 calls: CommandResult[]
 in_flight: CommandResult[]
}

const SANDBOX_ROLE = 'sandbox'
const MAX_IPC_BYTES = 64 * 1024
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export function capText(text: string, maxBytes: number): {text: string; truncated: boolean} {
 const value = typeof text === 'string' ? text : ''
 if (maxBytes < 1) return {text: TRUNCATION_MARKER, truncated: true}
 const buf = Buffer.from(value, 'utf8')
 if (buf.length <= maxBytes) return {text: value, truncated: false}
 const marker = Buffer.from('\n' + TRUNCATION_MARKER, 'utf8')
 const keep = Math.max(0, maxBytes - marker.length)
 return {text: Buffer.concat([buf.subarray(0, keep), marker]).toString('utf8'), truncated: true}
}

/** Honest command envelope. A non-zero exit can never be reported as ok. */
export function createCommandResult(input: {
 tool: string
 status: CommandStatus
 exit_code: number | null
 stdout?: string
 stderr?: string
 truncated?: boolean
 stdoutMax?: number
 stderrMax?: number
}): CommandResult {
 const stdoutCap = capText(input.stdout ?? '', input.stdoutMax ?? COMMAND_STDOUT_MAX_BYTES)
 const stderrCap = capText(input.stderr ?? '', input.stderrMax ?? COMMAND_STDERR_MAX_BYTES)
 let status = input.status
 const exit = input.exit_code === null || Number.isInteger(input.exit_code) ? input.exit_code : null
 if (status === 'ok' && exit !== null && exit !== 0) status = 'error'
 return {
  tool: input.tool,
  status,
  exit_code: exit,
  stdout: stdoutCap.text,
  stderr: stderrCap.text,
  truncated: Boolean(input.truncated) || stdoutCap.truncated || stderrCap.truncated,
 }
}

function limitsOf(partial?: Partial<SandboxLimits>): SandboxLimits {
 const next = {...DEFAULT_SANDBOX_LIMITS, ...partial}
 if (!Number.isFinite(next.timeoutMs) || next.timeoutMs < 20 || next.timeoutMs > 60_000) throw Error('invalid_sandbox_limits')
 if (!Number.isFinite(next.memoryMb) || next.memoryMb < 16 || next.memoryMb > 256) throw Error('invalid_sandbox_limits')
 if (!Number.isFinite(next.resultMaxBytes) || next.resultMaxBytes < 32 || next.resultMaxBytes > 64 * 1024) throw Error('invalid_sandbox_limits')
 if (!Number.isFinite(next.stdoutMaxBytes) || next.stdoutMaxBytes < 32 || next.stdoutMaxBytes > 32 * 1024) throw Error('invalid_sandbox_limits')
 if (!Number.isInteger(next.maxToolCalls) || next.maxToolCalls < 1 || next.maxToolCalls > 64) throw Error('invalid_sandbox_limits')
 return next
}

export function boundContextValue(value: unknown, maxBytes: number): {value: unknown; truncated: boolean} {
 let raw: string
 try { raw = JSON.stringify(value) ?? 'null' } catch { return {value: {error: 'unserializable_result'}, truncated: false} }
 if (Buffer.byteLength(raw, 'utf8') <= maxBytes) {
  try { return {value: JSON.parse(raw), truncated: false} } catch { return {value: null, truncated: false} }
 }
 const capped = capText(raw, maxBytes)
 return {value: capped.text, truncated: true}
}

function ipcSize(value: unknown): number {
 try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') } catch { return MAX_IPC_BYTES + 1 }
}

function sandboxEnv(): NodeJS.ProcessEnv {
 return {
  TARX_CODE_MODE_ROLE: SANDBOX_ROLE,
  LANG: 'en_US.UTF-8',
  PATH: '/usr/bin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
 }
}

export function sandboxRuntimeDir(): string {
 return dirname(fileURLToPath(import.meta.url))
}

/** Child argv. No child_process, worker, net, or fs-write. fs-read is the
 * runtime directory so this module can load; the isolate still cannot write. */
export function sandboxChildExecArgv(memoryMb: number, runtimeDir = sandboxRuntimeDir()): string[] {
 return [
  '--experimental-strip-types',
  `--max-old-space-size=${memoryMb}`,
  '--disallow-code-generation-from-strings',
  '--permission',
  `--allow-fs-read=${runtimeDir}`,
 ]
}

/** Kill a detached sandbox leader and every process in its group. */
export function killSandboxGroup(pid: number): void {
 if (!Number.isInteger(pid) || pid <= 0) return
 try { process.kill(-pid, 'SIGKILL') } catch { /* group may already be gone */ }
 try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

function sandboxChild(memoryMb: number): ChildProcess {
 const runtimeDir = sandboxRuntimeDir()
 return fork(fileURLToPath(new URL(import.meta.url)), [], {
  execPath: process.execPath,
  execArgv: sandboxChildExecArgv(memoryMb, runtimeDir),
  cwd: runtimeDir,
  env: sandboxEnv(),
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  serialization: 'json',
  detached: true,
 })
}

/** Run model-written JavaScript in a child isolate. The parent keeps the real
 * tool implementations; the child can only name allowlisted tools. */
export function runSandboxedScript(input: SandboxRun): Promise<SandboxOutcome> {
 const limits = limitsOf(input.limits)
 const script = typeof input.script === 'string' ? input.script : ''
 if (!script.trim() || Buffer.byteLength(script, 'utf8') > SCRIPT_MAX_BYTES) {
  return Promise.resolve({
   status: 'error',
   value: null,
   truncated: false,
   error: script.trim() ? 'script_too_large' : 'empty_script',
   calls: [],
   in_flight: [],
  })
 }
 const allow = new Set(input.toolNames)
 if (input.signal?.aborted) {
  return Promise.resolve({
   status: 'not_run',
   value: null,
   truncated: false,
   error: 'aborted',
   calls: [],
   in_flight: [],
  })
 }

 return new Promise<SandboxOutcome>((resolve) => {
  let settled = false, step = 0, killing = false, started = false
  const calls: CommandResult[] = []
  const pending = new Map<number, {tool: string}>()
  const child = sandboxChild(limits.memoryMb)

  const finish = (outcome: SandboxOutcome) => {
   if (settled) return
   settled = true
   clearTimeout(timer)
   input.signal?.removeEventListener('abort', onAbort)
   const inFlight: CommandResult[] = []
   for (const [id, waiter] of pending) {
    pending.delete(id)
    const result = createCommandResult({
     tool: waiter.tool,
     status: killing ? 'timeout' : 'unknown',
     exit_code: null,
     stdout: '',
     stderr: killing ? 'killed' : 'isolate_exited',
    })
    inFlight.push(result)
   }
   try { if (child.connected) child.disconnect() } catch { /* isolate is exiting */ }
   if (child.pid) killSandboxGroup(child.pid)
   resolve({...outcome, in_flight: inFlight})
  }

  const kill = (status: CommandStatus, error: string) => {
   killing = true
   if (child.pid) killSandboxGroup(child.pid)
   finish({status, value: null, truncated: false, error, calls: calls.slice(), in_flight: []})
  }

  const onAbort = () => {
   if (!started && pending.size === 0 && calls.length === 0) kill('not_run', 'aborted')
   else kill('timeout', 'aborted')
  }
  const timer = setTimeout(() => kill('timeout', 'deadline'), limits.timeoutMs)
  input.signal?.addEventListener('abort', onAbort, {once: true})

  child.on('error', () => kill('unknown', 'isolate_spawn_failed'))
  child.on('exit', () => {
   if (settled) return
   finish({
    status: 'unknown',
    value: null,
    truncated: false,
    error: 'isolate_exit_without_result',
    calls: calls.slice(),
    in_flight: [],
   })
  })
  child.on('message', (message: unknown) => {
   if (settled || !message || typeof message !== 'object' || Array.isArray(message)) return
   if (ipcSize(message) > MAX_IPC_BYTES) { kill('error', 'ipc_too_large'); return }
   const msg = message as {kind?: string; id?: number; name?: string; input?: unknown; value?: unknown; error?: string}
   if (msg.kind === 'tool_call' && Number.isInteger(msg.id) && typeof msg.name === 'string') {
    const name = msg.name
    const id = msg.id as number
    if (!allow.has(name) || pending.has(id) || calls.length + pending.size >= limits.maxToolCalls) {
     const denied = createCommandResult({tool: name, status: 'denied', exit_code: null, stdout: '', stderr: allow.has(name) ? 'tool_budget' : 'tool_denied'})
     calls.push(denied)
     input.onProgress?.({step: ++step, tool: name, phase: 'failed'})
     if (child.connected) child.send({kind: 'tool_result', id, result: denied})
     return
    }
    input.onProgress?.({step: ++step, tool: name, phase: 'started'})
    const localStep = step
    pending.set(id, {tool: name})
    void Promise.resolve()
     .then(() => input.executeTool(name, msg.input, input.signal ?? new AbortController().signal))
     .then((result) => createCommandResult({...result, tool: name}))
     .catch(() => createCommandResult({tool: name, status: 'error', exit_code: null, stdout: '', stderr: 'tool_threw'}))
     .then((result) => {
      if (settled) return
      pending.delete(id)
      calls.push(result)
      input.onProgress?.({step: localStep, tool: name, phase: result.status === 'ok' ? 'completed' : 'failed'})
      if (child.connected) child.send({kind: 'tool_result', id, result})
     })
    return
   }
   if (msg.kind === 'result') {
    const bounded = boundContextValue(msg.value, limits.resultMaxBytes)
    finish({
     status: msg.error ? 'error' : 'ok',
     value: msg.error ? null : bounded.value,
     truncated: bounded.truncated,
     error: typeof msg.error === 'string' && msg.error.length <= 200 ? msg.error : msg.error ? 'script_error' : undefined,
     calls: calls.slice(),
     in_flight: [],
    })
    return
   }
   kill('unknown', 'unexpected_isolate_message')
  })

  if (input.signal?.aborted) { onAbort(); return }
  started = true
  child.send({kind: 'start', script, tools: [...allow]})
 })
}

async function runSandboxChild() {
 let serial = 0
 const pending = new Map<number, {resolve: (result: CommandResult) => void}>()
 const callTool = (name: string, input: unknown) => new Promise<CommandResult>((resolve) => {
  const id = ++serial
  pending.set(id, {resolve})
  process.send?.({kind: 'tool_call', id, name, input})
 })
 process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  const msg = message as {kind?: string; script?: string; tools?: string[]; id?: number; result?: CommandResult}
  if (msg.kind === 'tool_result' && Number.isInteger(msg.id) && pending.has(msg.id as number)) {
   const waiter = pending.get(msg.id as number)!
   pending.delete(msg.id as number)
   waiter.resolve(msg.result as CommandResult)
   return
  }
  if (msg.kind !== 'start' || typeof msg.script !== 'string' || !Array.isArray(msg.tools)) return
  void executeInVm(msg.script, msg.tools.filter((n): n is string => typeof n === 'string'), callTool)
   .then((value) => process.send?.({kind: 'result', value}, () => process.exit(0)))
   .catch((error: unknown) => {
    process.send?.({kind: 'result', value: null, error: sandboxErrorText(error)}, () => process.exit(1))
   })
 })
 process.on('disconnect', () => process.exit(1))
}

function sandboxErrorText(error: unknown): string {
 if (error instanceof Error) return error.message
 if (error && typeof error === 'object' && 'message' in error) {
  const message = (error as {message: unknown}).message
  if (typeof message === 'string' && message.trim()) return message.slice(0, 200)
 }
 const text = typeof error === 'string' ? error : ''
 return text.trim() ? text.slice(0, 200) : 'script_error'
}

function bootstrapRealm(context: vm.Context, toolNames: string[]) {
 const names = toolNames.filter((name) => TOOL_NAME.test(name))
 vm.runInContext(
  `'use strict';
  var __tarx = {jobs: [], waiters: Object.create(null), seq: 0};
  Object.defineProperty(globalThis, '__tarx', {value: __tarx, writable: false, configurable: false, enumerable: false});
  function enqueue(name, input) {
    var id = ++__tarx.seq;
    return new Promise(function(resolve) {
      __tarx.waiters[id] = resolve;
      __tarx.jobs.push({id: id, name: name, input: input});
    });
  }
  var target = Object.create(null);
  var listed = ${JSON.stringify(names)};
  for (var i = 0; i < listed.length; i++) {
    (function(name) {
      target[name] = function(input) { return enqueue(name, input); };
    })(listed[i]);
  }
  Object.freeze(target);
  var tools = new Proxy(target, {
    get: function(obj, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(prop)) return undefined;
      return function(input) { return enqueue(prop, input); };
    },
    getPrototypeOf: function() { return null; },
    has: function(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); },
    ownKeys: function(obj) { return Object.keys(obj); },
    set: function() { return false; },
    defineProperty: function() { return false; },
    deleteProperty: function() { return false; }
  });
  Object.defineProperty(globalThis, 'tools', {value: tools, writable: false, configurable: false, enumerable: false});
  var console = Object.freeze({
    log: function(){}, warn: function(){}, error: function(){}, info: function(){}, debug: function(){}
  });
  Object.defineProperty(globalThis, 'console', {value: console, writable: false, configurable: false, enumerable: false});
  `,
  context,
 )
}

async function drainJobs(context: vm.Context, callTool: (name: string, input: unknown) => Promise<CommandResult>) {
 const raw = vm.runInContext(`JSON.stringify(__tarx.jobs.splice(0))`, context)
 let jobs: Array<{id?: unknown; name?: unknown; input?: unknown}>
 try { jobs = JSON.parse(typeof raw === 'string' ? raw : '[]') } catch { return }
 if (!Array.isArray(jobs) || !jobs.length) return
 for (const job of jobs) {
  const name = typeof job.name === 'string' ? job.name : ''
  const id = job.id
  if (!Number.isInteger(id) || !name) continue
  const result = await callTool(name, job.input)
  vm.runInContext(
   `(function(id, payload) {
      var w = __tarx.waiters[id];
      delete __tarx.waiters[id];
      if (w) w(JSON.parse(payload));
    })(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(result))})`,
   context,
  )
 }
}

const denyDynamicImport = (async () => { throw Error('import_denied') }) as never

async function executeInVm(script: string, toolNames: string[], callTool: (name: string, input: unknown) => Promise<CommandResult>) {
 if (Buffer.byteLength(script, 'utf8') > SCRIPT_MAX_BYTES) throw Error('script_too_large')
 const allow = new Set(toolNames.filter((name) => TOOL_NAME.test(name)))
 const context = vm.createContext(undefined, {
  name: 'tarx-code-mode',
  origin: 'tarx-code-mode',
  codeGeneration: {strings: false, wasm: false},
  importModuleDynamically: denyDynamicImport,
 })
 bootstrapRealm(context, [...allow])
 const wrapped = `'use strict';\n(async () => {\n${script}\n})()`
 const pending = vm.runInContext(wrapped, context, {
  timeout: 8_000,
  displayErrors: false,
  filename: 'code-mode-script.js',
  breakOnSigint: true,
  importModuleDynamically: denyDynamicImport,
 })
 let settled = false
 const finished = Promise.resolve(pending).then(
  (value) => { settled = true; return {ok: true as const, value} },
  (error: unknown) => { settled = true; return {ok: false as const, error} },
 )
 while (!settled) {
  await drainJobs(context, callTool)
  await Promise.race([finished, new Promise<void>((resolve) => setImmediate(resolve))])
 }
 await drainJobs(context, callTool)
 const end = await finished
 if (!end.ok) throw end.error
 return end.value
}

if (process.env.TARX_CODE_MODE_ROLE === SANDBOX_ROLE) {
 void runSandboxChild()
}
