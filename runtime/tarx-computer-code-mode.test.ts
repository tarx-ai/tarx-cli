import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
 CODE_MODE_ENV,
 createCodeModePlanner,
 createCommandResult,
 createCommandTool,
 createComputerCodeModeRegistry,
 createToolRegistry,
 filterContextPayload,
 generateToolBindingSource,
 isCodeModeEnabled,
 codeModeWorkerEnv,
 notRunResult,
 parseCodeModePlannerOutput,
 runCodeModeTurn,
 runLocalCodeModeLoop,
 shouldUseCodeMode,
 TRUNCATION_MARKER,
 type CodeModeEvent,
 type CodeModeTool,
} from './tarx-computer-code-mode.ts'
import {killSandboxGroup,sandboxChildExecArgv,sandboxRuntimeDir} from './tarx-computer-code-mode-sandbox.ts'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function tool(name: string, execute: CodeModeTool['execute'], extra: Partial<CodeModeTool> = {}): CodeModeTool {
 return {name, description: extra.description ?? name, inputSchema: extra.inputSchema ?? {type: 'object', properties: {}}, network: extra.network, execute}
}

function registry(tools: CodeModeTool[]) {
 return createToolRegistry(tools)
}

const alive = (pid: number) => {
 try { process.kill(pid, 0); return true } catch (error: unknown) {
  if ((error as {code?: string}).code === 'ESRCH') return false
  throw error
 }
}

const tight = {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4}

test('Code Mode stays off unless TARX_CODE_MODE is exactly 1', () => {
 assert.equal(CODE_MODE_ENV, 'TARX_CODE_MODE')
 assert.equal(isCodeModeEnabled({}), false)
 assert.equal(isCodeModeEnabled({TARX_CODE_MODE: '0'}), false)
 assert.equal(isCodeModeEnabled({TARX_CODE_MODE: 'true'}), false)
 assert.equal(isCodeModeEnabled({TARX_CODE_MODE: 'yes'}), false)
 assert.equal(isCodeModeEnabled({TARX_CODE_MODE: '1 '}), false)
 assert.equal(isCodeModeEnabled({TARX_CODE_MODE: '1'}), true)
 assert.equal(shouldUseCodeMode('local_model', {TARX_CODE_MODE: '1'}), true)
 assert.equal(shouldUseCodeMode('supercomputer', {TARX_CODE_MODE: '1'}), false)
 assert.equal(shouldUseCodeMode('local_model', {TARX_CODE_MODE: 'true'}), false)
 assert.equal(shouldUseCodeMode('deterministic_actuator', {TARX_CODE_MODE: '1'}), false)
 assert.deepEqual(codeModeWorkerEnv({}), {})
 assert.deepEqual(codeModeWorkerEnv({TARX_CODE_MODE: '1', OPENROUTER_API_KEY: 'secret'}), {TARX_CODE_MODE: '1'})
 assert.equal('OPENROUTER_API_KEY' in codeModeWorkerEnv({TARX_CODE_MODE: '1', OPENROUTER_API_KEY: 'secret'}), false)
})

test('typed bindings are generated from the registry and skip reserved names', () => {
 const source = generateToolBindingSource([
  tool('click', async () => null, {description: 'Click a handle', inputSchema: {type: 'object', required: ['handle'], properties: {handle: {type: 'integer'}}}}),
  tool('run', async () => null, {inputSchema: {type: 'object', properties: {file: {type: 'string'}, args: {type: 'array', items: {type: 'string'}}}}}),
 ])
 assert.match(source, /click: \(input: \{ handle: number \}\) => Promise<CommandResult>/)
 assert.match(source, /run:/)
 const created = createToolRegistry([
  tool('constructor', async () => null),
  tool('click', async () => null),
  tool('click', async () => null),
  tool('__proto__', async () => null),
 ])
 assert.deepEqual([...created.names], ['click'])
})

test('sandbox times out a hanging script and does not report success', async () => {
 const result = await runCodeModeTurn({
  script: 'await new Promise(() => {})',
  registry: registry([]),
  limits: {timeoutMs: 1500, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 assert.equal(result.status, 'timeout')
 assert.equal(result.context, null)
 assert.notEqual(result.status, 'ok')
 assert.equal(result.events.at(-1)?.type, 'final')
})

test('sandbox caps oversized return values with a truncation marker', async () => {
 const result = await runCodeModeTurn({
  script: 'return "x".repeat(20000)',
  registry: registry([]),
  limits: {timeoutMs: 4000, resultMaxBytes: 128, memoryMb: 64, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 assert.equal(result.status, 'ok')
 assert.equal(result.truncated, true)
 assert.equal(typeof result.context, 'string')
 assert.match(String(result.context), new RegExp(TRUNCATION_MARKER.replace(/[[\]]/g, '\\$&')))
 assert.ok(Buffer.byteLength(String(result.context), 'utf8') <= 128)
})

test('a denied tool cannot run and is reported as denied, not success', async () => {
 const result = await runCodeModeTurn({
  script: 'return await tools.secret({key: "x"})',
  registry: registry([tool('public', async () => ({ok: true}))]),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 8},
 })
 assert.equal(result.status, 'ok')
 const denied = result.calls.find((c) => c.tool === 'secret')
 assert.ok(denied)
 assert.equal(denied!.status, 'denied')
 assert.equal(denied!.exit_code, null)
 assert.notEqual(denied!.status, 'ok')
 assert.equal((result.context as {status?: string} | null)?.status, 'denied')
})

test('a thrown script error is an error, never synthesized success', async () => {
 const result = await runCodeModeTurn({
  script: 'throw new Error("boom")',
  registry: registry([]),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 assert.equal(result.status, 'error')
 assert.equal(result.context, null)
 assert.match(result.error ?? '', /boom/)
 assert.notEqual(result.status, 'ok')
})

test('only the script return value enters context; intermediate tool output is filtered', async () => {
 const bulky = {items: Array.from({length: 50}, (_, i) => ({id: i, blob: 'private-intermediate-' + i}))}
 const result = await runCodeModeTurn({
  script: 'const noisy = await tools.scan({}); const items = JSON.parse(noisy.stdout).items; return {count: items.length}',
  registry: registry([tool('scan', async () => bulky)]),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 2048, stdoutMaxBytes: 4096, maxToolCalls: 4},
 })
 assert.equal(result.status, 'ok')
 assert.deepEqual(result.context, {count: 50})
 assert.doesNotMatch(JSON.stringify(result.context), /private-intermediate/)
 assert.match(result.calls[0]!.stdout, /private-intermediate/)
 const filtered = filterContextPayload(result.context)
 assert.equal(filtered.truncated, false)
 assert.deepEqual(filtered.value, {count: 50})
})

test('a failing command surfaces as failure with the real exit code, stdout and stderr', async () => {
 const run = createCommandTool({allowedFiles: [process.execPath], timeoutMs: 4000})
 const script = `return await tools.run({file:${JSON.stringify(process.execPath)},args:['-e','process.stdout.write("out-data");process.stderr.write("err-data");process.exit(2)']})`
 const result = await runCodeModeTurn({
  script,
  registry: registry([run]),
  limits: {timeoutMs: 5000, memoryMb: 64, resultMaxBytes: 4096, stdoutMaxBytes: 4096, maxToolCalls: 4},
 })
 assert.equal(result.status, 'ok', 'the script ran; the command inside it failed')
 const command = result.calls.find((c) => c.tool === 'run')
 assert.ok(command)
 assert.equal(command!.status, 'error')
 assert.equal(command!.exit_code, 2)
 assert.match(command!.stdout, /out-data/)
 assert.match(command!.stderr, /err-data/)
 assert.notEqual(command!.status, 'ok')
 assert.equal((result.context as {exit_code?: number; status?: string}).exit_code, 2)
 assert.equal((result.context as {status?: string}).status, 'error')
})

test('createCommandResult never reports ok for a non-zero exit code', () => {
 const forged = createCommandResult({tool: 'run', status: 'ok', exit_code: 1, stdout: 'nope', stderr: ''})
 assert.equal(forged.status, 'error')
 assert.equal(forged.exit_code, 1)
 assert.equal(createCommandResult({tool: 'run', status: 'ok', exit_code: 0, stdout: '', stderr: ''}).status, 'ok')
 assert.equal(notRunResult('run').status, 'not_run')
 assert.equal(notRunResult('run').exit_code, null)
})

test('an aborted run before start is not_run, not success', async () => {
 const signal = AbortSignal.abort()
 const result = await runCodeModeTurn({
  script: 'return 1',
  registry: registry([]),
  signal,
  limits: {timeoutMs: 1000, memoryMb: 64, resultMaxBytes: 256, stdoutMaxBytes: 256, maxToolCalls: 2},
 })
 assert.equal(result.status, 'not_run')
 assert.equal(result.context, null)
 assert.notEqual(result.status, 'ok')
})

test('streaming emits assistant text and progress while a command runs; final is last', async () => {
 const events: CodeModeEvent[] = []
 const assistantText: AsyncIterable<string> = (async function* () {
  yield 'Working'
  await delay(30)
  yield ' still'
 })()
 const result = await runCodeModeTurn({
  script: 'return await tools.slow({})',
  registry: registry([tool('slow', async () => { await delay(80); return {status: 'ok', exit_code: null, stdout: 'done', stderr: ''} })]),
  assistantText,
  onEvent: (event) => events.push(event),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 assert.equal(result.status, 'ok')
 assert.deepEqual(result.events, events)
 assert.equal(events.at(-1)?.type, 'final')
 assert.equal(events.filter((e) => e.type === 'final').length, 1)
 const texts = events.filter((e) => e.type === 'assistant_text')
 assert.ok(texts.length >= 1)
 assert.equal((texts[0] as {text: string}).text, 'Working')
 const started = events.findIndex((e) => e.type === 'progress' && e.phase === 'started')
 const completed = events.findIndex((e) => e.type === 'progress' && e.phase === 'completed')
 const firstText = events.findIndex((e) => e.type === 'assistant_text')
 const finalAt = events.findIndex((e) => e.type === 'final')
 assert.ok(started >= 0 && completed > started)
 assert.ok(firstText >= 0 && firstText < finalAt)
 assert.ok(started < finalAt)
 assert.equal(events[finalAt]!.type, 'final')
})

test('the isolate cannot see process, fetch, or inherited secrets', async () => {
 const result = await runCodeModeTurn({
  script: `let processHidden = typeof process === "undefined";
let fetchHidden = typeof fetch === "undefined";
let envHidden = typeof process === "undefined" || !process.env;
let escaped = false;
try { (function(){}).constructor("return process")(); escaped = true } catch {}
return {processHidden, fetchHidden, envHidden, escaped, home: (typeof process !== "undefined" && process.env && process.env.HOME) || null}`,
  registry: registry([]),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 2},
 })
 assert.equal(result.status, 'ok')
 assert.deepEqual(result.context, {processHidden: true, fetchHidden: true, envHidden: true, escaped: false, home: null})
})

test('sandbox child argv is permission-restricted to runtime-dir reads', () => {
 const dir = sandboxRuntimeDir()
 const argv = sandboxChildExecArgv(64, dir)
 assert.ok(argv.includes('--disallow-code-generation-from-strings'))
 assert.ok(argv.includes('--permission'))
 assert.ok(argv.includes('--allow-fs-read=' + dir))
 assert.equal(argv.some((flag) => flag.includes('allow-child-process')), false)
 assert.equal(argv.some((flag) => flag.includes('allow-worker')), false)
 assert.equal(argv.some((flag) => flag.includes('allow-fs-write')), false)
 assert.equal(argv.some((flag) => flag.includes('allow-net')), false)
})

function closedProbe(report: unknown) {
 const value = report && typeof report === 'object' && !Array.isArray(report) ? report as Record<string, unknown> : {}
 assert.equal(value.escaped, false)
 assert.equal(value.processType, 'undefined')
 assert.equal(value.generated, false)
 assert.equal(value.imported, false)
}

test('host-object constructor chains cannot generate code or reach process', async () => {
 const result = await runCodeModeTurn({
  script: `const report = {escaped:false, generated:false, imported:false, processType: typeof process};
const objects = [Object, Array, Promise, JSON, Math, Date, Number, String, Boolean, Error, console, globalThis];
for (const obj of objects) {
  try {
    const F = obj.constructor.constructor;
    F("return 1")();
    report.generated = true;
  } catch {}
  try {
    const F = obj.constructor.constructor;
    const got = F("return typeof process")();
    if (got !== "undefined") report.escaped = true;
  } catch {}
}
return report;`,
  registry: registry([]),
  limits: tight,
 })
 assert.equal(result.status, 'ok')
 closedProbe(result.context)
})

test('tool-bridge constructor cannot generate code or reach process', async () => {
 const result = await runCodeModeTurn({
  script: `const report = {escaped:false, generated:false, imported:false, processType: typeof process, frozen:false};
try { report.frozen = Object.isFrozen(tools); } catch {}
try {
  tools.click.constructor("return 1")();
  report.generated = true;
} catch {}
try {
  const got = tools.click.constructor.constructor("return typeof process")();
  if (got !== "undefined") report.escaped = true;
} catch {}
try {
  const proto = Object.getPrototypeOf(tools);
  if (proto && proto.constructor && proto.constructor.constructor) {
    proto.constructor.constructor("return 1")();
    report.generated = true;
  }
} catch {}
return report;`,
  registry: registry([tool('click', async () => ({ok: true}))]),
  limits: tight,
 })
 assert.equal(result.status, 'ok')
 closedProbe(result.context)
 assert.equal((result.context as {frozen?: boolean}).frozen, true)
})

test('string-built identifiers cannot reach host code generation', async () => {
 const code = `const k = "cons" + "tructor";
const p = "pro" + "cess";
const report = {escaped:false, generated:false, imported:false, processType: typeof globalThis[p]};
try {
  tools.click[k][k]("return 1")();
  report.generated = true;
} catch {}
try {
  const got = ({})[k][k]("return typeof globalThis[\\"" + p + "\\"]")();
  if (got !== "undefined") report.escaped = true;
} catch {}
try {
  globalThis[k]("return 1")();
  report.generated = true;
} catch {}
return report;`
 assert.ok(parseCodeModePlannerOutput(JSON.stringify({status: 'script', code})))
 const result = await runCodeModeTurn({
  script: code,
  registry: registry([tool('click', async () => ({ok: true}))]),
  limits: tight,
 })
 assert.equal(result.status, 'ok')
 closedProbe(result.context)
})

test('eval and Function via reachable objects fail closed', async () => {
 const result = await runCodeModeTurn({
  script: `const report = {escaped:false, generated:false, imported:false, processType: typeof process};
try { eval("1"); report.generated = true } catch {}
try { Function("return 1")(); report.generated = true } catch {}
try { (function(){}).constructor("return 1")(); report.generated = true } catch {}
try { (async function(){}).constructor("return 1")(); report.generated = true } catch {}
try { tools.click.constructor.constructor("return 1")(); report.generated = true } catch {}
try {
  const got = Error.constructor("return typeof process")();
  if (got !== "undefined") report.escaped = true;
} catch {}
return report;`,
  registry: registry([tool('click', async () => ({ok: true}))]),
  limits: tight,
 })
 assert.equal(result.status, 'ok')
 closedProbe(result.context)
})

test('dynamic import fails closed', async () => {
 const result = await runCodeModeTurn({
  script: `const report = {escaped:false, generated:false, imported:false, processType: typeof process};
try {
  await import("node:fs");
  report.imported = true;
} catch {}
try {
  await import("node:child_process");
  report.imported = true;
} catch {}
try {
  const spec = "node:" + "fs";
  await import(spec);
  report.imported = true;
} catch {}
return report;`,
  registry: registry([]),
  limits: tight,
 })
 assert.equal(result.status, 'ok')
 closedProbe(result.context)
})

function stalledText(first?: string): AsyncIterable<string> {
 return {
  [Symbol.asyncIterator]() {
   let yielded = !first
   return {
    next() {
     if (!yielded) {
      yielded = true
      return Promise.resolve({value: first as string, done: false})
     }
     return new Promise<{value: string; done: false}>((resolve) => {
      const timer = setTimeout(() => resolve({value: 'late', done: false}), 60_000)
      timer.unref()
     })
    },
    return() {
     return Promise.resolve({value: undefined, done: true})
    },
   }
  },
 }
}

test('a stalled assistant text stream cannot outlive the isolate deadline', async () => {
 const started = Date.now()
 const result = await runCodeModeTurn({
  script: 'return 1',
  registry: registry([]),
  assistantText: stalledText('start'),
  limits: {timeoutMs: 1500, memoryMb: 64, resultMaxBytes: 256, stdoutMaxBytes: 256, maxToolCalls: 2},
 })
 assert.ok(Date.now() - started < 4000)
 assert.equal(result.status, 'ok')
 assert.equal(result.events.at(-1)?.type, 'final')
})

test('timeout covers a hanging script together with a stalled text stream', async () => {
 const started = Date.now()
 const result = await runCodeModeTurn({
  script: 'await new Promise(() => {})',
  registry: registry([]),
  assistantText: stalledText(),
  limits: {timeoutMs: 1500, memoryMb: 64, resultMaxBytes: 256, stdoutMaxBytes: 256, maxToolCalls: 2},
 })
 assert.ok(Date.now() - started < 4000)
 assert.equal(result.status, 'timeout')
 assert.notEqual(result.status, 'ok')
 assert.equal(result.events.at(-1)?.type, 'final')
})

test('timeout kills the isolate process group including same-group descendants', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'tarx-code-mode-pgid-'))
 const pidFile = join(dir, 'child.pid')
 try {
  const child = spawn(process.execPath, ['-e', `
    const {spawn} = require("node:child_process");
    const {writeFileSync} = require("node:fs");
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {stdio: "ignore"});
    writeFileSync(process.argv[1], String(g.pid));
    setInterval(()=>{}, 1000);
  `, pidFile], {detached: true, stdio: 'ignore'})
  assert.ok(child.pid)
  const deadline = Date.now() + 3000
  let grand = 0
  while (Date.now() < deadline) {
   try {
    grand = Number(await readFile(pidFile, 'utf8'))
    if (Number.isInteger(grand) && grand > 0) break
   } catch {}
   await delay(20)
  }
  assert.ok(grand > 0)
  assert.equal(alive(child.pid!), true)
  assert.equal(alive(grand), true)
  killSandboxGroup(child.pid!)
  const stop = Date.now() + 2000
  while (Date.now() < stop && (alive(child.pid!) || alive(grand))) await delay(20)
  assert.equal(alive(child.pid!), false)
  assert.equal(alive(grand), false)
 } finally {
  await rm(dir, {recursive: true, force: true})
 }
})

test('scripts cannot leave a detached child after timeout', async () => {
 const result = await runCodeModeTurn({
  script: `const report = {escaped:false, generated:false, imported:false, spawned:false, processType: typeof process};
try {
  const cp = await import("node:child_process");
  cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {detached:true, stdio:"ignore"}).unref();
  report.spawned = true;
} catch {}
try {
  const F = tools.click.constructor.constructor;
  F("return process")().binding;
  report.escaped = true;
} catch {}
await new Promise(() => {});
return report;`,
  registry: registry([tool('click', async () => ({ok: true}))]),
  limits: {timeoutMs: 1500, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 2},
 })
 assert.equal(result.status, 'timeout')
 assert.notEqual(result.status, 'ok')
})

test('a denied command file does not run and stays denied', async () => {
 const run = createCommandTool({allowedFiles: [process.execPath]})
 const result = await runCodeModeTurn({
  script: 'return await tools.run({file:"/bin/sh",args:["-c","echo pwned"]})',
  registry: registry([run]),
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 const command = result.calls[0]!
 assert.equal(command.status, 'denied')
 assert.equal(command.exit_code, null)
 assert.doesNotMatch(command.stdout, /pwned/)
})

test('Code Mode planner parses scripts strictly and keeps done-before-action blocked', async () => {
 assert.deepEqual(parseCodeModePlannerOutput('{"status":"blocked"}'), {status: 'blocked'})
 assert.equal(parseCodeModePlannerOutput('{"status":"script","code":"return 1","approved":true}'), null)
 assert.equal(parseCodeModePlannerOutput('{"status":"script","code":"import fs from \\"fs\\"; return 1"}'), null)
 assert.ok(parseCodeModePlannerOutput('{"status":"script","code":"return await tools.click({handle:7})"}')?.status === 'script')
 let generations = 0
 const planner = createCodeModePlanner({
  client: {complete: async () => '{"status":"done"}'},
  registry: createComputerCodeModeRegistry({click: async () => ({ok: true}), observe: async () => ({controls: []})}),
  goal: 'Use the control',
  onGeneration: () => generations++,
 })
 const decision = await planner.complete('[7] button "Allowed"')
 assert.deepEqual(decision, {status: 'done'})
 assert.equal(generations, 1)
 const loop = await runLocalCodeModeLoop({
  client: {complete: async () => '{"status":"done"}'},
  registry: createComputerCodeModeRegistry({click: async () => ({ok: true}), observe: async () => ({controls: []})}),
  goal: 'Use the control',
  observation: '[7] button "Allowed"',
  maxRounds: 2,
 })
 assert.equal(loop.outcome, 'blocked')
 assert.equal(loop.decisionStatus, 'false_done')
})

test('local Code Mode loop executes a returned script through the isolate', async () => {
 let turns = 0
 const loop = await runLocalCodeModeLoop({
  client: {complete: async () => {
   turns++
   return turns === 1
    ? '{"status":"script","code":"const a = await tools.click({handle:7}); return {clicked: JSON.parse(a.stdout).handle}"}'
    : '{"status":"done"}'
  }},
  registry: createComputerCodeModeRegistry({
   click: async (handle) => ({status: 'ok', exit_code: null, stdout: JSON.stringify({handle}), stderr: ''}),
   observe: async () => ({controls: [{handle: 7, role: 'button', name: 'Allowed'}]}),
  }),
  goal: 'Click the allowed control',
  observation: '[7] button "Allowed"',
  maxRounds: 2,
  deliveredActions: () => 1,
  limits: {timeoutMs: 4000, memoryMb: 64, resultMaxBytes: 1024, stdoutMaxBytes: 256, maxToolCalls: 4},
 })
 assert.equal(loop.outcome, 'done')
 assert.deepEqual(loop.context, {clicked: 7})
 assert.equal(loop.calls[0]?.tool, 'click')
 assert.equal(loop.calls[0]?.status, 'ok')
 assert.equal(turns, 2)
})
