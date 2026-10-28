import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createBoundedTaskController,TASK_NAME,PUBLIC_NOTE} from './tarx-bounded-task.ts'
import {
  buildCapabilityManifest,
  serializeManifest,
  READ_LAUNCH_NOTE_CAPABILITY,
  COGNITIVE_ADAPTER_UNKNOWN,
  CAPABILITY_MANIFEST_SCHEMA,
  CAPABILITY_MANIFEST_VERSION,
  type DeclaredCapability,
} from './tarx-capability-manifest.ts'

const origin = 'https://www.tarx.com'
const subject = 'tvs_' + 'a'.repeat(32)
const session = 'wrun_' + 'B'.repeat(26)

function entry(manifest: ReturnType<typeof buildCapabilityManifest>, id: string) {
  return manifest.capabilities.find((c) => c.capability_id === id)
}

// ── Pure builder: the packet's status matrix ────────────────────────────

test('discovered + granted + healthy => available; receipt + schema present', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: ['read_launch_note'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
    declared_unknown_adapters: [COGNITIVE_ADAPTER_UNKNOWN],
  })
  const e = entry(m, 'local.read_launch_note')!
  assert.equal(e.status, 'available')
  assert.equal(e.execution_location, 'this_computer')
  assert.equal(e.supported_action, 'read_launch_note')
  assert.equal(e.receipt_contract?.kind, 'local_eve_tool')
  assert.deepEqual(e.receipt_contract?.fields, ['kind', 'tool', 'status', 'result', 'billing_truth'])
})

test('discovered but NOT granted => needs_permission (not executable)', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: [], // read-only / ungranted pairing
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
  })
  const e = entry(m, 'local.read_launch_note')!
  assert.equal(e.status, 'needs_permission')
  assert.equal(e.reason, 'permission_required')
})

test('unhealthy runtime => declared capability is unavailable (no false ready)', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: ['read_launch_note'],
    // Listening/config is not healthy: model not responsive.
    readiness: {config_valid: true, worker_reachable: true, model_responsive: false, healthy: false},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
  })
  const e = entry(m, 'local.read_launch_note')!
  assert.equal(e.status, 'unavailable')
  assert.equal(e.reason, 'runtime_unavailable')
})

test('declared but NOT discovered => unavailable (catalog presence is not execution-ready)', () => {
  const m = buildCapabilityManifest({
    discovered_tools: [], // nothing discovered at runtime
    granted_scopes: ['read_launch_note'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
  })
  const e = entry(m, 'local.read_launch_note')!
  assert.equal(e.status, 'unavailable')
  assert.equal(e.reason, 'not_discovered')
})

test('discovered but undeclared tool => unknown (not catalog-connected)', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note', 'some_unrecognized_tool'],
    granted_scopes: ['read_launch_note', 'some_unrecognized_tool'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
  })
  const e = entry(m, 'some_unrecognized_tool')!
  assert.equal(e.status, 'unknown')
  assert.equal(e.reason, 'undeclared_tool')
  assert.equal(e.supported_action, null)
  assert.equal(e.action_schema, null)
  assert.equal(e.receipt_contract, null)
})

test('cognitive adapter stays unknown and is never probed', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: ['read_launch_note'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
    declared_unknown_adapters: [COGNITIVE_ADAPTER_UNKNOWN],
  })
  const c = entry(m, 'adapter.cognitive')!
  assert.equal(c.status, 'unknown')
  assert.equal(c.supported_action, null)
  assert.equal(c.receipt_contract, null)
})

test('a declared capability with an unsafe schema is demoted to unknown, never serialized', () => {
  const leaky: DeclaredCapability = {
    capability_id: 'local.leaky',
    execution_location: 'this_computer',
    supported_action: 'leaky_tool',
    action_schema: {type: 'object', properties: {home_path: {const: '/Users/someone/.tarx'}}},
    receipt_contract: {kind: 'local_eve_tool', fields: ['kind'], billing_truth: 'not_a_charge'},
    required_scope: 'leaky_tool',
  }
  const m = buildCapabilityManifest({
    discovered_tools: ['leaky_tool'],
    granted_scopes: ['leaky_tool'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [leaky],
  })
  const e = entry(m, 'local.leaky')!
  assert.equal(e.status, 'unknown')
  assert.equal(e.action_schema, null)
  assert.ok(!serializeManifest(m).includes('/Users/'))
})

test('serialized manifest contains no secrets, paths, or caller identity', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: ['read_launch_note'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
    declared_unknown_adapters: [COGNITIVE_ADAPTER_UNKNOWN],
  })
  const json = serializeManifest(m)
  for (const forbidden of ['/Users/', '/home/', '.tarx', 'Bearer', 'tarx_cli_', subject, 'install', 'credential', 'cookie', 'secret']) {
    assert.ok(!json.includes(forbidden), `manifest leaked ${forbidden}`)
  }
})

test('schema id and version are stable; entry shape is fixed', () => {
  const m = buildCapabilityManifest({
    discovered_tools: ['read_launch_note'],
    granted_scopes: ['read_launch_note'],
    readiness: {config_valid: true, worker_reachable: true, model_responsive: true, healthy: true},
    declared: [READ_LAUNCH_NOTE_CAPABILITY],
    declared_unknown_adapters: [COGNITIVE_ADAPTER_UNKNOWN],
  })
  assert.equal(m.schema, CAPABILITY_MANIFEST_SCHEMA)
  assert.equal(m.schema, 'tarx.capability_manifest.v0')
  assert.equal(m.version, CAPABILITY_MANIFEST_VERSION)
  assert.deepEqual(Object.keys(m).sort(), ['capabilities', 'runtime', 'schema', 'version'])
  const e = entry(m, 'local.read_launch_note')!
  assert.deepEqual(
    Object.keys(e).sort(),
    ['action_schema', 'capability_id', 'execution_location', 'reason', 'receipt_contract', 'status', 'supported_action'],
  )
})

// ── Live HTTP fixture: real listener, pairing, origin + revocation ──────

async function setup(taskApproval: boolean, opts: {healthy?: boolean; discovery?: string[]} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-capability-manifest-'))
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const owners = createFileOwnerStore(join(dir, 'owners.json'))
  const ch = await createPairingChallenge({
    loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64),
    install_id: 'fixture_install',
    store: pairs,
    fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch,
  })
  assert.ok(ch.ok)
  if (!ch.ok) throw Error('fixture')
  await approvePairingChallenge(ch.challenge, pairs, Date.now(), taskApproval ? TASK_NAME : undefined)
  const executor = {
    profile: TASK_NAME as typeof TASK_NAME,
    prepare: async () => session,
    start: async () => {},
    async *events() {},
  }
  const healthy = opts.healthy ?? true
  const discovery = opts.discovery ?? [TASK_NAME]
  const listener = createPairedSessionListener({
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: new Set([origin]),
    pairStore: pairs,
    ownerStore: owners,
    eveClient: () => ({attach: () => ({async *stream() {}})}),
    readiness: async () => ({
      config_valid: true,
      worker_reachable: healthy,
      model_responsive: healthy,
      tools: discovery,
      healthy,
    }),
    taskDiscovery: async () => discovery,
    tasks: createBoundedTaskController({file: join(dir, 'tasks.json'), owners, executor}),
  })
  const {port} = await listener.listen()
  const base = 'http://127.0.0.1:' + port
  const claim = await fetch(base + '/pairing/claim', {
    method: 'POST',
    headers: {origin, 'content-type': 'application/json'},
    body: JSON.stringify({challenge: ch.challenge}),
  })
  assert.equal(claim.status, 200)
  const token = (await claim.json()).pairing_credential
  return {
    listener,
    base,
    headers: {origin, authorization: 'Bearer ' + token},
    revoke: () => revokePairing(createHash('sha256').update(ch.challenge).digest('hex'), pairs),
  }
}

test('HTTP: granted pairing sees read_launch_note available with receipt + cognitive unknown', async () => {
  const f = await setup(true)
  try {
    const res = await fetch(f.base + '/capability-manifest', {headers: f.headers})
    assert.equal(res.status, 200)
    const m = await res.json()
    assert.equal(m.schema, 'tarx.capability_manifest.v0')
    const read = m.capabilities.find((c: any) => c.capability_id === 'local.read_launch_note')
    assert.equal(read.status, 'available')
    assert.equal(read.receipt_contract.kind, 'local_eve_tool')
    const cog = m.capabilities.find((c: any) => c.capability_id === 'adapter.cognitive')
    assert.equal(cog.status, 'unknown')
  } finally {
    await f.listener.close()
  }
})

test('HTTP: read-only pairing (ungranted) => needs_permission, not executable', async () => {
  const f = await setup(false)
  try {
    const res = await fetch(f.base + '/capability-manifest', {headers: f.headers})
    assert.equal(res.status, 200)
    const m = await res.json()
    const read = m.capabilities.find((c: any) => c.capability_id === 'local.read_launch_note')
    assert.equal(read.status, 'needs_permission')
  } finally {
    await f.listener.close()
  }
})

test('HTTP: unhealthy runtime => declared capability unavailable', async () => {
  const f = await setup(true, {healthy: false})
  try {
    const m = await (await fetch(f.base + '/capability-manifest', {headers: f.headers})).json()
    const read = m.capabilities.find((c: any) => c.capability_id === 'local.read_launch_note')
    assert.equal(read.status, 'unavailable')
    assert.equal(m.runtime.healthy, false)
  } finally {
    await f.listener.close()
  }
})

test('HTTP: discovered-but-undeclared tool reported as unknown', async () => {
  const f = await setup(true, {discovery: [TASK_NAME, 'mystery_tool']})
  try {
    const m = await (await fetch(f.base + '/capability-manifest', {headers: f.headers})).json()
    const mystery = m.capabilities.find((c: any) => c.capability_id === 'mystery_tool')
    assert.equal(mystery.status, 'unknown')
  } finally {
    await f.listener.close()
  }
})

test('HTTP: untrusted origin and revoked pairing are refused', async () => {
  const f = await setup(true)
  try {
    const bad = await fetch(f.base + '/capability-manifest', {headers: {origin: 'https://evil.example', authorization: f.headers.authorization}})
    assert.equal(bad.status, 403)
    await f.revoke()
    const after = await fetch(f.base + '/capability-manifest', {headers: f.headers})
    assert.equal(after.status, 401)
  } finally {
    await f.listener.close()
  }
})
