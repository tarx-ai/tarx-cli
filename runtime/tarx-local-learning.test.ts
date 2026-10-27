import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod,lstat,readFile,readdir,rm,symlink,unlink} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createLoopbackPersonalClient} from './tarx-personal-turn.ts'
import {baseDigestObservations,baseModelDigest,createLearningController,createSubprocessRunner,denyNetworkArgv,ownerNamespace,resetBaseDigestObservations,type RunnerResult,type RunnerRequest} from './tarx-local-learning.ts'

/**
 * Node contract fixtures. The injected runner is not Root's MLX proof.
 * The child-launch test executes a real subprocess. Run:
 *   node --test --experimental-strip-types tarx-local-learning.test.ts
 */

const origin = 'https://www.tarx.com'
const subject = 'tvs_' + 'a'.repeat(32)
const WIRE = new Set(['ok', 'state', 'configured', 'approved_examples', 'version', 'job_id', 'error'])
const ADAPTER_BYTES = Buffer.from('fixture-adapter')
const CONFIG_BYTES = Buffer.from('{"lora_parameters":{"rank":4}}\n')

function assertWire(body: Record<string, unknown>) {
  for (const key of Object.keys(body)) assert.ok(WIRE.has(key), key)
  assert.equal('candidate_version' in body, false)
  assert.equal('active_version' in body, false)
}

async function provenDeadPid(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {stdio: 'ignore'})
    const pid = child.pid
    await new Promise((resolve) => child.once('exit', resolve))
    if (!pid || pid <= 1) continue
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw Error('no proven dead pid')
}

async function untilSettled(post: (body: unknown) => Promise<Response>) {
  let body: Record<string, unknown> = {}
  for (let i = 0; i < 100; i++) {
    body = await (await post({action: 'status'})).json() as Record<string, unknown>
    if (body.state !== 'training') return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return body
}

async function paired(scopes: string[], subjectId = subject, install = 'fixture_install') {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-learn-'))
  const base = join(dir, 'base')
  await mkdir(base, {recursive: true})
  await writeFile(join(base, 'config.json'), '{"model_type":"qwen3"}\n')
  await writeFile(join(base, 'model.safetensors'), 'fixture-weights')
  const base_sha256 = await baseModelDigest(base)
  if (!base_sha256) throw Error('fixture base')
  const adapter_sha256 = createHash('sha256').update(ADAPTER_BYTES).digest('hex')
  const adapter_config_sha256 = createHash('sha256').update(CONFIG_BYTES).digest('hex')
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: install, store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subjectId}))) as typeof fetch})
  if (!ch.ok) throw Error('fixture')
  await approvePairingChallenge(ch.challenge, pairs, Date.now(), scopes)
  const captured: {request: RunnerRequest; jsonl: string}[] = []
  let release: ((result: RunnerResult) => void) | undefined
  let runnerResult: RunnerResult = {ok: true, status: 'trained', adapter_sha256, adapter_config_sha256, base_sha256, base_control_passed: false, candidate_control_passed: true}
  const runner = async (_config: unknown, request: RunnerRequest, jsonl: string, signal?: AbortSignal) => {
    captured.push({request, jsonl})
    if (release) {
      await new Promise<void>((done) => {
        const finish = () => done()
        signal?.addEventListener('abort', finish, {once: true})
        release = () => finish()
      })
      if (signal?.aborted) return {ok: false, status: 'failed' as const, error: 'interrupted'}
    }
    await mkdir(request.adapter_path, {recursive: true, mode: 0o700})
    await chmod(request.adapter_path, 0o700)
    await writeFile(join(request.adapter_path, 'adapters.safetensors'), ADAPTER_BYTES, {mode: 0o600})
    await writeFile(join(request.adapter_path, 'adapter_config.json'), CONFIG_BYTES, {mode: 0o600})
    return {...runnerResult, adapter_sha256, adapter_config_sha256, base_sha256}
  }
  const learning = createLearningController({file: join(dir, 'learning.json'), stateRoot: join(dir, 'state'), config: {interpreter: '/usr/bin/python3', runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: base, sandboxWrap: (argv) => argv}, runner})
  const listener = createPairedSessionListener({host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), pairStore: pairs, ownerStore: createFileOwnerStore(join(dir, 'owners.json')), eveClient: () => ({attach: () => ({async *stream() {}})}), readiness: async () => ({config_valid: true, worker_reachable: false, model_responsive: false, tools: [], healthy: false}), learning})
  const {port} = await listener.listen()
  const baseURL = 'http://127.0.0.1:' + port
  const claim = await fetch(baseURL + '/pairing/claim', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge: ch.challenge})})
  const token = (await claim.json() as {pairing_credential: string}).pairing_credential
  const post = (body: unknown, hdr: Record<string, string> = {}) => fetch(baseURL + '/personal-learning', {method: 'POST', headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token, ...hdr}, body: JSON.stringify(body)})
  return {
    listener, dir, base, baseURL, post, token, captured, learning, pairs, challenge: ch.challenge,
    hold: () => { let done: () => void = () => {}; const gate = new Promise<void>((resolve) => { done = resolve }); release = () => done(); return gate },
    setRunner: (result: Partial<RunnerResult>) => { runnerResult = {...runnerResult, ...result} },
    revoke: () => revokePairing(createHash('sha256').update(ch.challenge).digest('hex'), pairs),
  }
}

test('scope approval combos: learning requires personal_chat; invalid scope refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-scope-'))
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const mk = async () => { const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'i', store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch}); if (!ch.ok) throw Error('x'); return ch.challenge }
  assert.equal(await approvePairingChallenge(await mk(), pairs, Date.now(), ['personal_chat', 'personal_learning']), true)
  assert.equal(await approvePairingChallenge(await mk(), pairs, Date.now(), ['personal_learning']), false)
  assert.equal(await approvePairingChallenge(await mk(), pairs, Date.now(), ['shell']), false)
})

test('chat-only pairing can read status but cannot mutate', async () => {
  const f = await paired(['personal_chat'])
  try {
    const status = await f.post({action: 'status'})
    assert.equal(status.status, 200)
    assert.equal((await status.json() as {configured: boolean}).configured, true)
    assert.equal((await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})).status, 403)
    assert.equal((await f.post({action: 'train', request_id: randomUUID()})).status, 403)
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('train returns 202 immediately and a finished duplicate does not run again', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    const id = randomUUID()
    assert.equal((await f.post({action: 'add_example', example_id: id, prompt: 'call me Cedar', response: 'Okay, Cedar.'})).status, 200)
    const dup = await f.post({action: 'add_example', example_id: id, prompt: 'call me Cedar', response: 'Okay, Cedar.'})
    assert.equal((await dup.json() as {approved_examples: number}).approved_examples, 1)
    assert.equal((await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'x'.repeat(2001), response: 'r'})).status, 400)
    const req = randomUUID()
    const train = await f.post({action: 'train', request_id: req})
    const accepted = await train.json() as Record<string, unknown>
    assert.equal(train.status, 202)
    assert.equal(accepted.state, 'training')
    assert.equal(accepted.job_id, req)
    assertWire(accepted)
    const body = await untilSettled(f.post)
    assert.equal(body.state, 'candidate')
    assert.equal(body.version, req)
    assertWire(body)
    assert.equal(f.captured.length, 1)
    const cap = f.captured[0]
    assert.match(cap.request.owner, /^[a-f0-9]{64}$/)
    assert.equal(cap.request.adapter_path.endsWith('/versions/' + req), true)
    assert.equal(cap.request.iterations, 128)
    assert.deepEqual(cap.jsonl.trim().split('\n').map((line) => JSON.parse(line)), [{prompt: 'call me Cedar', response: 'Okay, Cedar.'}])
    const again = await f.post({action: 'train', request_id: req})
    assert.equal(again.status, 200)
    assert.equal((await again.json() as {state: string}).state, 'candidate')
    assert.equal(f.captured.length, 1)
  } finally { await f.listener.close() }
})

test('a running duplicate stays 202 and a second owner is busy', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  const other = 'cd'.repeat(32)
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
    f.hold()
    const req = randomUUID()
    const train = await f.post({action: 'train', request_id: req})
    assert.equal(train.status, 202)
    const replay = await f.post({action: 'train', request_id: req})
    assert.equal(replay.status, 202)
    assert.equal(f.captured.length, 1)
    const busy = await f.learning.handle(other, ['personal_chat', 'personal_learning'], {action: 'add_example', example_id: randomUUID(), prompt: 'q', response: 's'})
    assert.equal(busy.code, 200)
    const second = await f.learning.handle(other, ['personal_chat', 'personal_learning'], {action: 'train', request_id: randomUUID()})
    assert.equal(second.code, 409)
    assert.equal(f.captured.length, 1)
  } finally {
    await f.post({action: 'pause'}).catch(() => {})
    await f.listener.close()
  }
})

test('candidate requires candidate_control_passed; base_control is diagnostic only', async () => {
  {
    const f = await paired(['personal_chat', 'personal_learning'])
    try {
      await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
      f.setRunner({ok: true, status: 'trained', candidate_control_passed: false, base_control_passed: true})
      assert.equal((await f.post({action: 'train', request_id: randomUUID()})).status, 202)
      const body = await untilSettled(f.post)
      assert.equal(body.state, 'failed')
      assert.equal('version' in body, false)
      assertWire(body)
    } finally { await f.listener.close() }
  }
  {
    const f = await paired(['personal_chat', 'personal_learning'])
    try {
      await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
      const req = randomUUID()
      f.setRunner({base_control_passed: false, candidate_control_passed: true})
      assert.equal((await f.post({action: 'train', request_id: req})).status, 202)
      const body = await untilSettled(f.post)
      assert.equal(body.state, 'candidate')
      assert.equal(body.version, req)
      assertWire(body)
    } finally { await f.listener.close() }
  }
})

test('a failed candidate retains the previously active version', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
    const good = randomUUID()
    assert.equal((await f.post({action: 'train', request_id: good})).status, 202)
    assert.equal((await untilSettled(f.post)).state, 'candidate')
    assert.equal((await (await f.post({action: 'activate', version: good})).json() as {state: string}).state, 'active')
    f.setRunner({ok: true, status: 'trained', candidate_control_passed: false})
    assert.equal((await f.post({action: 'train', request_id: randomUUID()})).status, 202)
    const after = await untilSettled(f.post)
    assert.equal(after.state, 'active')
    assert.equal(after.version, good)
    assertWire(after)
  } finally { await f.listener.close() }
})

test('a live same-process lease stays training and is not rerun', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
    f.hold()
    const req = randomUUID()
    assert.equal((await f.post({action: 'train', request_id: req})).status, 202)
    const ns = ownerNamespace(subject, 'fixture_install')
    const restarted = createLearningController({file: join(f.dir, 'learning.json'), stateRoot: join(f.dir, 'state'), config: {interpreter: '/usr/bin/python3', runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: f.base, sandboxWrap: (argv) => argv}, runner: async () => { throw Error('rerun') }})
    const status = await restarted.handle(ns, ['personal_chat'], {action: 'status'})
    assert.equal(status.body.state, 'training')
    const again = await restarted.handle(ns, ['personal_learning'], {action: 'train', request_id: req})
    assert.equal(again.code, 202)
    assert.equal(again.body.state, 'training')
    const stolen = await restarted.handle(ns, ['personal_learning'], {action: 'train', request_id: randomUUID()})
    assert.equal(stolen.code, 409)
    assert.equal(f.captured.length, 1)
    const leasePath = join(f.dir, 'state', 'training-lease.json')
    const leaseBefore = await readFile(leasePath, 'utf8')
    const foreignPause = await restarted.handle(ns, ['personal_learning'], {action: 'pause'})
    assert.equal(foreignPause.code, 409)
    assert.equal(await readFile(leasePath, 'utf8'), leaseBefore)
    const still = await restarted.handle(ns, ['personal_chat'], {action: 'status'})
    assert.equal(still.body.state, 'training')
    assert.equal(f.captured.length, 1)
  } finally {
    await f.post({action: 'pause'}).catch(() => {})
    await f.listener.close()
  }
})

test('pause or revoke during a job discards a late completion', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
    const gate = f.hold()
    const req = randomUUID()
    assert.equal((await f.post({action: 'train', request_id: req})).status, 202)
    assert.equal((await f.post({action: 'pause'})).status, 200)
    gate.catch(() => {})
    // Release is stored by hold(); the runner is awaiting it. Completing after pause must not activate.
    const ns = ownerNamespace(subject, 'fixture_install')
    const late = createLearningController({file: join(f.dir, 'learning.json'), stateRoot: join(f.dir, 'state'), config: {interpreter: '/usr/bin/python3', runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: f.base, sandboxWrap: (argv) => argv}})
    const status = await late.handle(ns, ['personal_chat'], {action: 'status'})
    assert.notEqual(status.body.state, 'active')
    assert.equal(status.body.version, undefined)
  } finally { await f.listener.close() }
})

test('a revoked pairing cannot apply a late training result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-revoke-'))
  const base = join(dir, 'base')
  await mkdir(base, {recursive: true})
  await writeFile(join(base, 'config.json'), '{"model_type":"qwen3"}\n')
  await writeFile(join(base, 'model.safetensors'), 'fixture-weights')
  const base_sha256 = await baseModelDigest(base)
  if (!base_sha256) throw Error('fixture')
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => { open = resolve })
  let calls = 0
  const learning = createLearningController({
    file: join(dir, 'learning.json'), stateRoot: join(dir, 'state'),
    config: {interpreter: '/usr/bin/python3', runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async (_config, request) => {
      calls += 1
      await gate
      await mkdir(request.adapter_path, {recursive: true, mode: 0o700})
      await writeFile(join(request.adapter_path, 'adapters.safetensors'), ADAPTER_BYTES, {mode: 0o600})
      return {ok: true, status: 'trained' as const, adapter_sha256: createHash('sha256').update(ADAPTER_BYTES).digest('hex'), base_sha256, candidate_control_passed: true, base_control_passed: false}
    },
  })
  const ns = 'ef'.repeat(32)
  let authorized = true
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})).code, 200)
  const req = randomUUID()
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'train', request_id: req}, {stillAuthorized: async () => authorized})).code, 202)
  const lease = join(dir, 'state', 'training-lease.json')
  const leaseWhileRunning = await readFile(lease, 'utf8')
  assert.match(leaseWhileRunning, /"pid":/)
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'train', request_id: randomUUID()})).code, 409)
  assert.equal(await readFile(lease, 'utf8'), leaseWhileRunning)
  authorized = false
  open()
  let body: Record<string, unknown> = {}
  for (let i = 0; i < 50; i++) {
    body = (await learning.handle(ns, ['personal_chat'], {action: 'status'})).body
    if (body.state !== 'training') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(body.state, 'interrupted')
  assert.equal(body.version, undefined)
  assert.equal(calls, 1)
  let released = false
  for (let i = 0; i < 50; i++) {
    if (await readFile(lease, 'utf8').then(() => false, () => true)) { released = true; break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(released, true)
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'train', request_id: req})).code, 200)
  assert.equal(calls, 1)
})

test('aggregate example bytes are capped at 256KB', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    const big = '\u00e9'.repeat(2000)
    let rejected = false
    for (let i = 0; i < 64; i++) {
      const response = await f.post({action: 'add_example', example_id: randomUUID(), prompt: big, response: big})
      if (response.status === 400) { rejected = true; break }
    }
    assert.equal(rejected, true)
  } finally { await f.listener.close() }
})

test('activate requires a verified version; pause returns to base; no private text leaks', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'secret preference phrase', response: 'noted'})
    const req = randomUUID()
    await f.post({action: 'train', request_id: req})
    await untilSettled(f.post)
    assert.equal((await f.post({action: 'activate', version: randomUUID()})).status, 404)
    const act = await f.post({action: 'activate', version: req})
    const active = await act.json() as Record<string, unknown>
    assert.equal(active.state, 'active')
    assert.equal(active.version, req)
    assertWire(active)
    const paused = await (await f.post({action: 'pause'})).json() as {state: string}
    assert.equal(paused.state, 'candidate')
    const status = await (await f.post({action: 'status'})).text()
    assert.equal(status.includes('secret preference phrase'), false)
    assert.equal(status.includes(f.base), false)
  } finally { await f.listener.close() }
})

test('foreign origin, missing identity, and revoked pairing are refused with no runner call', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  try {
    assert.equal((await f.post({action: 'status'}, {origin: 'https://evil.example'})).status, 403)
    const noAuth = await fetch(f.baseURL + '/personal-learning', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({action: 'status'})})
    assert.equal(noAuth.status, 401)
    await f.revoke()
    assert.equal((await f.post({action: 'status'})).status, 401)
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('owner namespace is derived from subject+install, not the browser', () => {
  const a = ownerNamespace(subject, 'install_1')
  assert.match(a, /^[a-f0-9]{64}$/)
  assert.notEqual(a, ownerNamespace(subject, 'install_2'))
  assert.notEqual(a, ownerNamespace('tvs_' + 'c'.repeat(32), 'install_1'))
})

test('not configured -> mutations 503, status off, personal chat keeps the base path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-off-'))
  const learning = createLearningController({file: join(dir, 'l.json'), stateRoot: join(dir, 's')})
  const ns = 'ab'.repeat(32)
  const r1 = await learning.handle(ns, ['personal_learning'], {action: 'status'})
  assert.equal(r1.body.state, 'off')
  const r2 = await learning.handle(ns, ['personal_learning'], {action: 'train', request_id: randomUUID()})
  assert.equal(r2.code, 503)
  assert.deepEqual(await learning.resolveAdapter(ns), {kind: 'base'})
})

test('real child receives bounded stdin and a minimal offline env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-child-'))
  const script = join(dir, 'echo-runner.mjs')
  await writeFile(script, `let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',async()=>{const req=JSON.parse(raw);const {writeFile}=await import('node:fs/promises');const {dirname,join}=await import('node:path');await writeFile(join(dirname(req.adapter_path),'captured-stdin.json'),JSON.stringify({req,env:process.env}));process.stdout.write(JSON.stringify({ok:true,status:'failed',error:'fixture_child'}))})\n`)
  const ns = 'ab'.repeat(32)
  const job = randomUUID()
  const state = join(dir, 'state')
  const request = {action: 'train' as const, base_path: join(dir, 'base'), state_root: state, owner: ns, job_id: job, examples_path: join(state, ns, 'examples', job + '.jsonl'), adapter_path: join(state, ns, 'versions', job), iterations: 64}
  const result = await createSubprocessRunner()({interpreter: process.execPath, runnerScript: script, basePath: request.base_path, sandboxWrap: (argv) => argv, deadlineMs: 5000}, request, '{"prompt":"secret example","response":"secret answer"}\n')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'fixture_child')
  const captured = JSON.parse(await readFile(join(state, ns, 'versions', 'captured-stdin.json'), 'utf8')) as {req: RunnerRequest; env: Record<string, string>}
  assert.equal(captured.req.job_id, job)
  assert.equal(captured.env.HF_HUB_OFFLINE, '1')
  assert.equal(captured.env.WANDB_MODE, 'disabled')
  assert.equal('HOME' in captured.env, false)
  assert.equal(JSON.stringify(captured.env).includes('secret'), false)
  const info = await lstat(request.examples_path)
  assert.equal(info.mode & 0o077, 0)
  assert.equal(await readFile(request.examples_path, 'utf8'), '{"prompt":"secret example","response":"secret answer"}\n')
})

test('darwin trainer launch uses sandbox-exec and refuses a raw interpreter', async () => {
  const wrapped = denyNetworkArgv(['/usr/bin/python3', '/opt/tarx/personal_learning_mlx.py'])
  assert.equal(wrapped[0], '/usr/bin/sandbox-exec')
  assert.match(wrapped[2], /deny network\*/)
  const dir = await mkdtemp(join(tmpdir(), 'tarx-nosandbox-'))
  const ns = 'cd'.repeat(32)
  const job = randomUUID()
  const state = join(dir, 'state')
  const request = {action: 'train' as const, base_path: dir, state_root: state, owner: ns, job_id: job, examples_path: join(state, ns, 'examples', job + '.jsonl'), adapter_path: join(state, ns, 'versions', job), iterations: 64}
  const refused = await createSubprocessRunner()({interpreter: process.execPath, runnerScript: process.execPath, basePath: dir}, request, '{}\n')
  assert.equal(refused.error, 'unavailable')
  assert.equal(await readFile(request.examples_path, 'utf8').catch(() => ''), '')
  if (process.platform === 'darwin') {
    const sandboxed = join(dir, 'sandboxed.mjs')
    await writeFile(sandboxed, `process.stdin.on('data',()=>{});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({ok:false,status:'failed',error:'sandboxed_child'}))})\n`)
    const job2 = randomUUID()
    const request2 = {...request, job_id: job2, examples_path: join(state, ns, 'examples', job2 + '.jsonl'), adapter_path: join(state, ns, 'versions', job2)}
    const ran = await createSubprocessRunner()({interpreter: process.execPath, runnerScript: sandboxed, basePath: dir, sandboxWrap: denyNetworkArgv, deadlineMs: 8000}, request2, '{}\n')
    assert.equal(ran.error, 'sandboxed_child')
  }
})

test('active adapter is served from disk across a new controller, and the other owner stays isolated', async () => {
  const f = await paired(['personal_chat', 'personal_learning'])
  const seen: {body: {model?: string; adapters?: string; messages: {content: string}[]}}[] = []
  const model = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({body: JSON.parse(raw) as {model?: string; adapters?: string; messages: {content: string}[]}})
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({choices: [{message: {content: 'fixture reply'}}]}))
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', () => resolve()))
  const address = model.address()
  if (!address || typeof address === 'string') throw Error('fixture model')
  const personal = createLoopbackPersonalClient({baseURL: `http://127.0.0.1:${address.port}`, model: 'fixture', apiKey: 'LOCAL_FIXTURE_KEY'})
  try {
    await f.post({action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})
    const req = randomUUID()
    await f.post({action: 'train', request_id: req})
    await untilSettled(f.post)
    assert.equal((await f.post({action: 'activate', version: req})).status, 200)
    const ns = ownerNamespace(subject, 'fixture_install')
    const adapter = join(f.dir, 'state', ns, 'versions', req)
    const rebuilt = createLearningController({file: join(f.dir, 'learning.json'), stateRoot: join(f.dir, 'state'), config: {interpreter: '/usr/bin/python3', runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: f.base, sandboxWrap: (argv) => argv}})
    const listener = createPairedSessionListener({host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), pairStore: f.pairs, ownerStore: createFileOwnerStore(join(f.dir, 'owners.json')), personalClient: personal, learning: rebuilt, eveClient: () => ({attach: () => ({async *stream() {}})}), readiness: async () => ({config_valid: true, worker_reachable: false, model_responsive: false, tools: [], healthy: false})})
    const {port} = await listener.listen()
    const turn = (token: string, content: string) => fetch(`http://127.0.0.1:${port}/personal-turn`, {method: 'POST', headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token}, body: JSON.stringify({messages: [{role: 'user', content}]})})
    try {
      const first = await turn(f.token, 'owner A phrase')
      assert.equal(first.status, 200)
      assert.equal(seen[0].body.adapters, adapter)
      assert.equal(seen[0].body.model, f.base)
      assert.notEqual(seen[0].body.model, 'fixture')
      assert.equal(JSON.stringify(seen[0].body).includes('call me'), false)
      const otherSubject = 'tvs_' + 'b'.repeat(32)
      const otherChallenge = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'other_install', store: f.pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: otherSubject}))) as typeof fetch})
      if (!otherChallenge.ok) throw Error('fixture pair')
      assert.equal(await approvePairingChallenge(otherChallenge.challenge, f.pairs, Date.now(), ['personal_chat']), true)
      const otherClaim = await fetch(`http://127.0.0.1:${port}/pairing/claim`, {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge: otherChallenge.challenge})})
      const otherToken = (await otherClaim.json() as {pairing_credential: string}).pairing_credential
      const isolated = await turn(otherToken, 'owner B phrase')
      assert.equal(isolated.status, 200)
      assert.equal(seen[1].body.adapters, undefined)
      assert.equal(seen[1].body.model, 'fixture')
      assert.notEqual(seen[1].body.model, f.base)
      assert.equal(JSON.stringify(seen[1].body).includes(adapter), false)
      await chmod(join(adapter, 'adapters.safetensors'), 0o644)
      const before = seen.length
      const closed = await turn(f.token, 'owner A after tamper')
      assert.equal(closed.status, 503)
      assert.equal(seen.length, before)
      await chmod(join(adapter, 'adapters.safetensors'), 0o600)
      await writeFile(join(adapter, 'adapter_config.json'), Buffer.from('{"lora_parameters":{"rank":8}}\n'), {mode: 0o600})
      const configTamper = seen.length
      const configClosed = await turn(f.token, 'owner A config tamper')
      assert.equal(configClosed.status, 503)
      assert.equal(seen.length, configTamper)
      await writeFile(join(adapter, 'adapter_config.json'), CONFIG_BYTES, {mode: 0o600})
      await chmod(adapter, 0o707)
      const dirTamper = seen.length
      const dirClosed = await turn(f.token, 'owner A directory tamper')
      assert.equal(dirClosed.status, 503)
      assert.equal(seen.length, dirTamper)
      await chmod(adapter, 0o700)
      const outside = join(f.dir, 'foreign-adapter-config.json')
      await writeFile(outside, Buffer.from('{"lora_parameters":{"rank":8}}\n'), {mode: 0o600})
      await unlink(join(adapter, 'adapter_config.json'))
      await symlink(outside, join(adapter, 'adapter_config.json'))
      const linkTamper = seen.length
      const linkClosed = await turn(f.token, 'owner A config symlink')
      assert.equal(linkClosed.status, 503)
      assert.equal(seen.length, linkTamper)
      await unlink(join(adapter, 'adapter_config.json'))
      await writeFile(join(adapter, 'adapter_config.json'), CONFIG_BYTES, {mode: 0o600})
      const restored = await turn(f.token, 'owner A restored')
      assert.equal(restored.status, 200)
      assert.equal(seen.at(-1)?.body.adapters, adapter)
      assert.equal(seen.at(-1)?.body.model, f.base)
      const paused = await rebuilt.handle(ns, ['personal_chat', 'personal_learning'], {action: 'pause'})
      assert.equal(paused.body.state, 'candidate')
      const baseTurn = await turn(f.token, 'owner A paused')
      assert.equal(baseTurn.status, 200)
      assert.equal(seen.at(-1)?.body.adapters, undefined)
      assert.equal(seen.at(-1)?.body.model, 'fixture')
    } finally { await listener.close() }
  } finally {
    await f.listener.close()
    await new Promise<void>((resolve) => model.close(() => resolve()))
  }
})

test('base digest cache hits on unchanged file identity and misses after tamper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-digest-'))
  const base = join(dir, 'base')
  await mkdir(base)
  await writeFile(join(base, 'config.json'), '{"model_type":"qwen3"}\n')
  await writeFile(join(base, 'model.safetensors'), 'fixture-weights')
  resetBaseDigestObservations()
  const first = await baseModelDigest(base)
  const afterFirst = baseDigestObservations().fileReads
  const second = await baseModelDigest(base)
  assert.equal(second, first)
  assert.equal(baseDigestObservations().fileReads, afterFirst)
  assert.ok(afterFirst >= 2)
  const labeled = await baseModelDigest(join(base, '..', 'base'))
  assert.equal(labeled, first)
  assert.equal(baseDigestObservations().fileReads, afterFirst)
  const link = join(dir, 'linked-base')
  await symlink(base, link)
  assert.equal(await baseModelDigest(link), null)
  assert.equal(baseDigestObservations().fileReads, afterFirst)
  await writeFile(join(base, 'config.json'), '{"model_type":"qwen3","changed":true}\n')
  const third = await baseModelDigest(base)
  assert.notEqual(third, first)
  assert.ok(baseDigestObservations().fileReads > afterFirst)
})

test('a second controller cannot steal a live job, and a dead owner is interrupted without a rerun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-lease-'))
  const base = join(dir, 'base')
  await mkdir(base)
  await writeFile(join(base, 'config.json'), '{}')
  await writeFile(join(base, 'model.safetensors'), 'fixture')
  let starts = 0
  let releaseHang: () => void = () => {}
  const input = {
    file: join(dir, 'state.json'),
    stateRoot: join(dir, 'artifacts'),
    config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv: string[]) => argv},
    runner: async () => {
      starts += 1
      await new Promise<void>((resolve) => { releaseHang = resolve })
      return {ok: false as const, status: 'failed' as const, error: 'released'}
    },
  }
  const owner = 'a7'.repeat(32)
  const scopes = ['personal_chat', 'personal_learning']
  const first = createLearningController(input)
  const second = createLearningController(input)
  const childDir = await mkdtemp(join(tmpdir(), 'tarx-lease-proc-'))
  const script = join(childDir, 'hold.mts')
  const moduleUrl = new URL('./tarx-local-learning.ts', import.meta.url).href
  await writeFile(script, `import {createLearningController} from ${JSON.stringify(moduleUrl)}
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
setInterval(() => {}, 1000)
const dir=process.argv[2]
const base=dir+'/base'
await mkdir(base)
await writeFile(base+'/config.json','{}')
await writeFile(base+'/model.safetensors','fixture')
const id=randomUUID()
await writeFile(dir+'/job', id)
const learning=createLearningController({file:dir+'/state.json',stateRoot:dir+'/artifacts',config:{interpreter:'/usr/bin/python3',runnerScript:'/fixture.py',basePath:base,sandboxWrap:(argv)=>argv},runner:async()=>{await writeFile(dir+'/started','1'); return new Promise(()=>{})}})
const owner='b8'.repeat(32)
const scopes=['personal_chat','personal_learning']
await learning.handle(owner,scopes,{action:'add_example',example_id:randomUUID(),prompt:'synthetic',response:'synthetic'})
const train=await learning.handle(owner,scopes,{action:'train',request_id:id})
if(train.code!==202) throw Error('child_train_'+train.code)
await new Promise(()=>{})
`)
  const child = spawn(process.execPath, ['--experimental-strip-types', script, childDir], {stdio: ['ignore', 'pipe', 'pipe']})
  let childErr = ''
  child.stderr.on('data', (chunk) => { childErr += chunk.toString('utf8') })
  try {
    assert.equal((await first.handle(owner, scopes, {action: 'add_example', example_id: randomUUID(), prompt: 'synthetic', response: 'synthetic'})).code, 200)
    const started = await first.handle(owner, scopes, {action: 'train', request_id: randomUUID()})
    assert.equal(started.code, 202)
    const status = await second.handle(owner, scopes, {action: 'status'})
    assert.equal(status.body.state, 'training')
    const stolen = await second.handle(owner, scopes, {action: 'train', request_id: randomUUID()})
    assert.equal(stolen.code, 409)
    assert.equal(starts, 1)

    const ready = join(childDir, 'started')
    for (let i = 0; i < 50; i++) {
      if (await readFile(ready, 'utf8').catch(() => '') === '1') break
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(await readFile(ready, 'utf8').catch(() => ''), '1', childErr.slice(0, 400))
    assert.equal(child.exitCode, null, childErr.slice(0, 400))
    let parentStarts = 0
    const parent = createLearningController({
      file: join(childDir, 'state.json'),
      stateRoot: join(childDir, 'artifacts'),
      config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: join(childDir, 'base'), sandboxWrap: (argv) => argv},
      runner: async () => { parentStarts += 1; return {ok: false, status: 'failed', error: 'parent_should_not_run'} },
    })
    const foreign = 'b8'.repeat(32)
    const childLease = join(childDir, 'artifacts', 'training-lease.json')
    const childLeaseBefore = await readFile(childLease, 'utf8')
    const overlap = await parent.handle(foreign, scopes, {action: 'train', request_id: randomUUID()})
    assert.equal(overlap.code, 409)
    assert.equal(parentStarts, 0)
    assert.equal(await readFile(childLease, 'utf8'), childLeaseBefore)
    const job = (await readFile(join(childDir, 'job'), 'utf8')).trim()
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    const after = await parent.handle(foreign, scopes, {action: 'status'})
    assert.equal(after.body.state, 'interrupted')
    const replay = await parent.handle(foreign, scopes, {action: 'train', request_id: job})
    assert.equal(replay.code, 200)
    assert.equal(replay.body.state, 'interrupted')
    assert.equal(parentStarts, 0)
  } finally {
    releaseHang()
    const ownLease = join(dir, 'artifacts', 'training-lease.json')
    for (let i = 0; i < 50; i++) {
      if (await readFile(ownLease, 'utf8').then(() => false, () => true)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
    for (const target of [dir, childDir]) {
      for (let i = 0; i < 5; i++) {
        try { await rm(target, {recursive: true, force: true}); break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || i === 4) throw error
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
    }
  }
})

test('an uncertain lease fails closed and is left in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-lease-uncertain-'))
  const base = join(dir, 'base')
  const artifacts = join(dir, 'artifacts')
  await mkdir(base)
  await mkdir(artifacts, {mode: 0o700})
  await writeFile(join(base, 'config.json'), '{}')
  await writeFile(join(base, 'model.safetensors'), 'fixture')
  const lease = join(artifacts, 'training-lease.json')
  const body = JSON.stringify({pid: -1, namespace: '', job_id: '', nonce: 'uncertain'})
  await writeFile(lease, body, {mode: 0o600})
  const learning = createLearningController({
    file: join(dir, 'state.json'),
    stateRoot: artifacts,
    config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async () => { throw Error('uncertain_lease_ran') },
  })
  try {
    const blocked = await learning.handle('c9'.repeat(32), ['personal_chat', 'personal_learning'], {action: 'add_example', example_id: randomUUID(), prompt: 'synthetic', response: 'synthetic'})
    assert.equal(blocked.code, 200)
    const train = await learning.handle('c9'.repeat(32), ['personal_chat', 'personal_learning'], {action: 'train', request_id: randomUUID()})
    assert.equal(train.code, 409)
    assert.equal(await readFile(lease, 'utf8'), body)
    const dead = await provenDeadPid()
    const writable = JSON.stringify({pid: dead, namespace: 'c9'.repeat(32), job_id: randomUUID(), nonce: 'ab'.repeat(16)})
    await writeFile(lease, writable)
    await chmod(lease, 0o666)
    assert.equal(((await lstat(lease)).mode & 0o022) !== 0, true)
    const stillBlocked = await learning.handle('c9'.repeat(32), ['personal_chat', 'personal_learning'], {action: 'train', request_id: randomUUID()})
    assert.equal(stillBlocked.code, 409)
    assert.equal(await readFile(lease, 'utf8'), writable)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('pause aborts the runner but the lease stays until that runner settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-lease-pause-'))
  const base = join(dir, 'base')
  await mkdir(base)
  await writeFile(join(base, 'config.json'), '{}')
  await writeFile(join(base, 'model.safetensors'), 'fixture')
  let finish: () => void = () => {}
  let aborted = false
  const learning = createLearningController({
    file: join(dir, 'state.json'),
    stateRoot: join(dir, 'artifacts'),
    config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async (_config, _request, _jsonl, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        finish = resolve
        signal?.addEventListener('abort', () => { aborted = true }, {once: true})
      })
      return {ok: false, status: 'failed', error: 'interrupted'}
    },
  })
  const lease = join(dir, 'artifacts', 'training-lease.json')
  const owner = 'd1'.repeat(32)
  const scopes = ['personal_chat', 'personal_learning']
  try {
    assert.equal((await learning.handle(owner, scopes, {action: 'add_example', example_id: randomUUID(), prompt: 'synthetic', response: 'synthetic'})).code, 200)
    assert.equal((await learning.handle(owner, scopes, {action: 'train', request_id: randomUUID()})).code, 202)
    assert.equal((await learning.handle(owner, scopes, {action: 'pause'})).code, 200)
    assert.equal(aborted, true)
    const held = await readFile(lease, 'utf8')
    assert.match(held, /"pid":/)
    let during = 0
    const other = createLearningController({
      file: join(dir, 'state.json'),
      stateRoot: join(dir, 'artifacts'),
      config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv) => argv},
      runner: async () => { during += 1; return {ok: false, status: 'failed', error: 'started_while_settling'} },
    })
    const blocked = await other.handle(owner, scopes, {action: 'train', request_id: randomUUID()})
    assert.equal(blocked.code, 409)
    assert.equal(during, 0)
    assert.equal(await readFile(lease, 'utf8'), held)
    finish()
    let gone = false
    for (let i = 0; i < 50; i++) {
      if (await readFile(lease, 'utf8').then(() => false, () => true)) { gone = true; break }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(gone, true)
  } finally {
    finish()
    await rm(dir, {recursive: true, force: true})
  }
})

test('an orphan training record without a lease stays busy and is not stolen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-lease-orphan-'))
  const base = join(dir, 'base')
  const artifacts = join(dir, 'artifacts')
  await mkdir(base)
  await mkdir(artifacts, {mode: 0o700})
  await writeFile(join(base, 'config.json'), '{}')
  await writeFile(join(base, 'model.safetensors'), 'fixture')
  const ns = 'e3'.repeat(32)
  const job = randomUUID()
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    [ns]: {
      namespace: ns,
      examples: [{example_id: randomUUID(), prompt: 'synthetic', response: 'synthetic'}],
      state: 'training',
      job_id: job,
      versions: [],
      jobs: {[job]: 'training'},
    },
  }), {mode: 0o600})
  let calls = 0
  const learning = createLearningController({
    file: join(dir, 'state.json'),
    stateRoot: artifacts,
    config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async () => { calls += 1; return {ok: false, status: 'failed', error: 'orphan_ran'} },
  })
  const scopes = ['personal_chat', 'personal_learning']
  try {
    const status = await learning.handle(ns, ['personal_chat'], {action: 'status'})
    assert.equal(status.body.state, 'training')
    assert.equal(status.body.job_id, job)
    const stolen = await learning.handle(ns, scopes, {action: 'train', request_id: randomUUID()})
    assert.equal(stolen.code, 409)
    assert.equal(calls, 0)
    const again = await learning.handle(ns, ['personal_chat'], {action: 'status'})
    assert.equal(again.body.state, 'training')
    assert.equal(again.body.job_id, job)
    assert.equal(await readFile(join(artifacts, 'training-lease.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('a proven-dead owner is interrupted without a rerun and keeps the prior active adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-lease-dead-'))
  const base = join(dir, 'base')
  const artifacts = join(dir, 'artifacts')
  await mkdir(base)
  await mkdir(artifacts, {mode: 0o700})
  await writeFile(join(base, 'config.json'), '{}')
  await writeFile(join(base, 'model.safetensors'), 'fixture')
  const ns = 'e4'.repeat(32)
  const prior = randomUUID()
  const job = randomUUID()
  const pid = await provenDeadPid()
  const lease = join(artifacts, 'training-lease.json')
  await writeFile(lease, JSON.stringify({pid, namespace: ns, job_id: job, nonce: 'ab'.repeat(16)}), {mode: 0o600})
  await chmod(lease, 0o600)
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    [ns]: {
      namespace: ns,
      examples: [{example_id: randomUUID(), prompt: 'synthetic', response: 'synthetic'}],
      state: 'training',
      job_id: job,
      active_version: prior,
      versions: [{version: prior, job_id: prior, adapter_sha256: 'a'.repeat(64), base_sha256: 'b'.repeat(64), adapter_config_sha256: 'c'.repeat(64)}],
      jobs: {[prior]: 'candidate', [job]: 'training'},
    },
  }), {mode: 0o600})
  let calls = 0
  const learning = createLearningController({
    file: join(dir, 'state.json'),
    stateRoot: artifacts,
    config: {interpreter: '/usr/bin/python3', runnerScript: '/fixture.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async () => { calls += 1; return {ok: false, status: 'failed', error: 'dead_owner_reran'} },
  })
  try {
    const status = await learning.handle(ns, ['personal_chat'], {action: 'status'})
    assert.equal(status.body.state, 'active')
    assert.equal(status.body.version, prior)
    assert.equal(calls, 0)
    assert.equal(await readFile(lease, 'utf8').catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT')
    const replay = await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'train', request_id: job})
    assert.equal(replay.code, 200)
    assert.equal(replay.body.state, 'interrupted')
    assert.equal(calls, 0)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('venv python keeps its prefix when the interpreter path is a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-venv-'))
  const created = await new Promise<number>((resolve) => {
    const child = spawn('python3', ['-m', 'venv', '--without-pip', join(dir, 'venv')], {stdio: 'ignore'})
    child.once('exit', (code) => resolve(code ?? 1))
  })
  assert.equal(created, 0)
  let interpreter = join(dir, 'venv', 'bin', 'python3')
  try { await lstat(interpreter) } catch { interpreter = join(dir, 'venv', 'bin', 'python') }
  assert.equal((await lstat(interpreter)).isSymbolicLink(), true)
  const {realpath} = await import('node:fs/promises')
  const target = await realpath(interpreter)
  const pythons = (await readdir(join(dir, 'venv', 'lib'))).filter((name) => name.startsWith('python'))
  assert.equal(pythons.length > 0, true)
  await writeFile(join(dir, 'venv', 'lib', pythons[0], 'site-packages', 'tarx_venv_marker.py'), 'TOKEN = "venv-kept"\n')
  const script = join(dir, 'prefix.py')
  const prefixFile = join(dir, 'prefix.txt')
  await writeFile(script, [
    'import json, sys',
    'marker = "missing"',
    'try:',
    '    import tarx_venv_marker',
    '    marker = tarx_venv_marker.TOKEN',
    'except Exception:',
    '    marker = "missing"',
    `open(${JSON.stringify(prefixFile)}, "w").write(sys.prefix + "\\n" + marker + "\\n")`,
    'print(json.dumps({"ok": False, "status": "failed", "error": "venv_prefix"}))',
    '',
  ].join('\n'))
  const ns = 'ab'.repeat(32)
  const state = join(dir, 'state')
  const launch = (py: string, job: string) => createSubprocessRunner()({
    interpreter: py, runnerScript: script, basePath: dir, sandboxWrap: (argv) => argv, deadlineMs: 8000,
  }, {
    action: 'train' as const, base_path: dir, state_root: state, owner: ns, job_id: job,
    examples_path: join(state, ns, 'examples', job + '.jsonl'),
    adapter_path: join(state, ns, 'versions', job), iterations: 128,
  }, '{}\n')
  const kept = await launch(interpreter, randomUUID())
  assert.equal(kept.error, 'venv_prefix')
  const keptLines = (await readFile(prefixFile, 'utf8')).trim().split('\n')
  assert.equal(await realpath(keptLines[0]), await realpath(join(dir, 'venv')))
  assert.equal(keptLines[1], 'venv-kept')
  const lost = await launch(target, randomUUID())
  assert.equal(lost.error, 'venv_prefix')
  const lostLines = (await readFile(prefixFile, 'utf8')).trim().split('\n')
  assert.notEqual(await realpath(lostLines[0]), await realpath(join(dir, 'venv')))
  assert.equal(lostLines[1], 'missing')
})

test('an adapter request refuses an alias and sends only the verified absolute base', async () => {
  const seen: Record<string, unknown>[] = []
  const client = createLoopbackPersonalClient({
    baseURL: 'http://127.0.0.1:9/v1',
    model: 'fixture-alias',
    fetcher: (async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({choices: [{message: {content: 'ok'}}]}), {status: 200})
    }) as typeof fetch,
  })
  const messages = [{role: 'user' as const, content: 'synthetic'}]
  assert.equal(await client(messages, {adapters: '/tmp/adapter-dir', model: 'fixture-alias'}), null)
  assert.equal(await client(messages, {adapters: 'relative/adapter', model: '/tmp/verified-base'}), null)
  assert.equal(seen.length, 0)
  assert.equal(await client(messages, {adapters: '/tmp/adapter-dir', model: '/tmp/verified-base'}), 'ok')
  assert.equal(seen[0].model, '/tmp/verified-base')
  assert.equal(seen[0].adapters, '/tmp/adapter-dir')
  assert.equal(await client(messages), 'ok')
  assert.equal(seen[1].model, 'fixture-alias')
  assert.equal(seen[1].adapters, undefined)
})
