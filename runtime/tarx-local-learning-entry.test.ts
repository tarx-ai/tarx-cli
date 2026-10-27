import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,chmod} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {runRuntimeEntry} from './tarx-runtime-entry.ts'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge} from './tarx-browser-pairing.ts'
import {baseModelDigest,createLearningController,ownerNamespace,type RunnerRequest} from './tarx-local-learning.ts'
import {loadLearningController} from './tarx-personal-config.ts'

const origin = 'https://www.tarx.com'
const subject = 'tvs_' + 'a'.repeat(32)

test('entrypoint serves a verified adapter and ignores a profile-selected runner script', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tarx-learning-entry-'))
  const state = join(home, 'pairs')
  const dir = join(home, '.tarx', 'state')
  const base = join(home, 'base')
  await mkdir(dir, {recursive: true})
  await mkdir(base, {recursive: true})
  await writeFile(join(base, 'config.json'), '{"model_type":"qwen3"}\n')
  await writeFile(join(base, 'model.safetensors'), 'fixture-weights')
  const baseHash = await baseModelDigest(base)
  assert.ok(baseHash)
  const seen: {model?: string; adapters?: string}[] = []
  const model = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push(JSON.parse(raw) as {model?: string; adapters?: string})
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({choices: [{message: {content: 'Local fixture reply'}}]}))
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', () => resolve()))
  const address = model.address()
  if (!address || typeof address === 'string') throw Error('fixture')
  const key = join(home, 'existing.key')
  await writeFile(key, 'LOCAL_FIXTURE_KEY', {mode: 0o600})
  await writeFile(join(dir, 'personal-runtime.json'), JSON.stringify({url: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-personal', key_file: key}), {mode: 0o600})
  await writeFile(join(dir, 'personal-learning.json'), JSON.stringify({interpreter: process.execPath, base_path: base, runner_script: '/tmp/not-the-packaged-runner.py'}), {mode: 0o600})
  const bytes = Buffer.from('entrypoint-adapter')
  const configBytes = Buffer.from('{"lora_parameters":{"rank":4}}\n')
  const ns = ownerNamespace(subject, 'fixture')
  const version = randomUUID()
  const learning = createLearningController({
    file: join(dir, 'learning.json'),
    stateRoot: join(dir, 'learning'),
    config: {interpreter: process.execPath, runnerScript: '/opt/tarx/personal_learning_mlx.py', basePath: base, sandboxWrap: (argv) => argv},
    runner: async (_config, request: RunnerRequest) => {
      await mkdir(request.adapter_path, {recursive: true, mode: 0o700})
      await chmod(request.adapter_path, 0o700)
      await writeFile(join(request.adapter_path, 'adapters.safetensors'), bytes, {mode: 0o600})
      await writeFile(join(request.adapter_path, 'adapter_config.json'), configBytes, {mode: 0o600})
      const {createHash} = await import('node:crypto')
      return {ok: true, status: 'trained', adapter_sha256: createHash('sha256').update(bytes).digest('hex'), adapter_config_sha256: createHash('sha256').update(configBytes).digest('hex'), base_sha256: baseHash, base_control_passed: false, candidate_control_passed: true}
    },
  })
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'add_example', example_id: randomUUID(), prompt: 'p', response: 'r'})).code, 200)
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'train', request_id: version})).code, 202)
  for (let i = 0; i < 50; i++) {
    const status = await learning.handle(ns, ['personal_chat'], {action: 'status'})
    if (status.body.state !== 'training') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal((await learning.handle(ns, ['personal_chat', 'personal_learning'], {action: 'activate', version})).code, 200)
  const loaded = await loadLearningController(home)
  const probe = await loaded.handle(ns, ['personal_chat'], {action: 'status'})
  if (process.platform !== 'darwin') {
    assert.equal(probe.body.configured, false)
    assert.equal(probe.body.state, 'off')
  } else {
    assert.equal(probe.body.configured, true)
    assert.notEqual(probe.body.state, 'off')
  }
  const runtime = await runRuntimeEntry(['serve-personal', '--state-dir', state, '--port', '0'], {personalHome: home, personalEnv: {}})
  if (!('address' in runtime) || !runtime.address) throw Error('entrypoint')
  const pairs = createFilePairStore(join(state, 'pairs.json'))
  const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'fixture', store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch})
  assert.equal(ch.ok, true)
  if (!ch.ok) throw Error('pair')
  assert.equal(await approvePairingChallenge(ch.challenge, pairs, Date.now(), 'personal_chat'), true)
  const claimed = await fetch(`http://127.0.0.1:${runtime.address.port}/pairing/claim`, {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge: ch.challenge})})
  const token = (await claimed.json() as {pairing_credential: string}).pairing_credential
  try {
    const turn = await fetch(`http://127.0.0.1:${runtime.address.port}/personal-turn`, {method: 'POST', headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token}, body: JSON.stringify({messages: [{role: 'user', content: 'synthetic private'}]})})
    assert.equal(turn.status, 200)
    if (process.platform === 'darwin') {
      assert.equal(seen[0].adapters, join(dir, 'learning', ns, 'versions', version))
      assert.equal(seen[0].model, base)
      assert.notEqual(seen[0].model, 'fixture-personal')
    } else assert.equal(seen[0].adapters, undefined)
    assert.equal(JSON.stringify(seen[0]).includes('/tmp/not-the-packaged-runner.py'), false)
  } finally {
    await runtime.listener.close()
    await new Promise<void>((resolve) => model.close(() => resolve()))
  }
})
