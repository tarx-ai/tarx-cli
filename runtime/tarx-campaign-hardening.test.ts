import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createBoundedTaskController,TASK_NAME,PUBLIC_NOTE} from './tarx-bounded-task.ts'

/**
 * Campaign hardening — uncovered multi-turn edges NOT in tarx-task-http.test.ts:
 *  1. Capability declaration must not over-declare: a worker that discovers a
 *     foreign/extra tool never leaks it into available/permitted tasks.
 *  2. Claimed pairings cannot acquire task scope in place; a fresh pairing
 *     approved with scope is required. Approved submits and retries run once.
 * Real listener + real bounded-task controller; mock executor/identity/store.
 * Real disposable loopback HTTP, fixture identity and mock executor only.
 * No production model, approval, credential, or host service. Run:
 *   node --test --experimental-strip-types tarx-campaign-hardening.test.ts
 */

const origin = 'https://www.tarx.com'
const subject = 'tvs_' + 'a'.repeat(32)
const session = 'wrun_' + 'C'.repeat(26)

async function harness(opts: {discovery: string[]; grant: boolean}) {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-harden-'))
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const owners = createFileOwnerStore(join(dir, 'owners.json'))
  const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'fixture_install', store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch})
  assert.ok(ch.ok); if (!ch.ok) throw Error('fixture')
  const challenge = ch.challenge
  await approvePairingChallenge(challenge, pairs, Date.now(), opts.grant ? TASK_NAME : undefined)
  let starts = 0
  const executor = {profile: TASK_NAME as typeof TASK_NAME, prepare: async () => session, start: async () => {starts++}, async *events() {
    yield {type: 'action.result', data: {status: 'completed', result: {kind: 'tool-result', toolName: TASK_NAME, output: {text: PUBLIC_NOTE, source: 'fixture', privateContext: false}}}}
    yield {type: 'turn.completed'}
  }}
  const tasks = createBoundedTaskController({file: join(dir, 'tasks.json'), owners, executor})
  const listener = createPairedSessionListener({host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), pairStore: pairs, ownerStore: owners, eveClient: () => ({attach: () => ({async *stream() {}})}), readiness: async () => ({config_valid: true, worker_reachable: false, model_responsive: false, tools: [], healthy: false}), taskDiscovery: async () => opts.discovery, tasks})
  const {port} = await listener.listen()
  const base = 'http://127.0.0.1:' + port
  const claim = await fetch(base + '/pairing/claim', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge})})
  assert.equal(claim.status, 200)
  const token = (await claim.json()).pairing_credential
  // Claimed pairings deliberately reject further approval/scope changes.
  async function grantScope() { return approvePairingChallenge(challenge, pairs, Date.now(), TASK_NAME) }
  async function close() { try { await listener.close() } finally { await rm(dir, {recursive: true, force: true}) } }
  return {listener, base, headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token}, starts: () => starts, grantScope, close}
}

test('capability declaration never over-declares a discovered foreign/extra tool', async () => {
  // Worker "discovers" the real tool PLUS foreign names. Only read_launch_note
  // may ever appear in available/permitted — the rest are dropped at the edge.
  const f = await harness({discovery: [TASK_NAME, 'shell', 'read_launch_note_v2', 'fs.write'], grant: true})
  try {
    const r = await fetch(f.base + '/task-capabilities', {headers: f.headers})
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.deepEqual(body.available_tasks, [TASK_NAME])
    assert.deepEqual(body.permitted_tasks, [TASK_NAME])
    // and a submit for a foreign tool is still rejected 400, never executed
    const bad = await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body: JSON.stringify({request_id: 'harden_0001', task: 'shell'})})
    assert.equal(bad.status, 400)
    assert.equal(f.starts(), 0)
  } finally { await f.close() }
})

test('a permitted declaration is always backed by a submit the controller accepts', async () => {
  // Granted scope -> capabilities permit the tool -> submit for exactly that
  // tool is accepted (202), i.e. no advertise-then-refuse mismatch.
  const f = await harness({discovery: [TASK_NAME], grant: true})
  try {
    const caps = await (await fetch(f.base + '/task-capabilities', {headers: f.headers})).json()
    assert.deepEqual(caps.permitted_tasks, [TASK_NAME])
    const sub = await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body: JSON.stringify({request_id: 'harden_0002', task: TASK_NAME})})
    assert.equal(sub.status, 202)
    assert.equal(f.starts(), 1)
  } finally { await f.close() }
})

test('scope refusal is explicit; granting the scope requires a re-paired grant (real limit)', async () => {
  // No task scope: capabilities show available-but-not-permitted and submit is
  // refused 403 with nothing run. This documents the REAL limit — a task scope
  // is bound at approval time; an already-claimed pairing cannot be upgraded in
  // place (approvePairingChallenge refuses a claimed record). The supported
  // retry path is a fresh approved-with-scope pairing.
  const f = await harness({discovery: [TASK_NAME], grant: false})
  try {
    const body = JSON.stringify({request_id: 'harden_0003', task: TASK_NAME})
    const caps1 = await (await fetch(f.base + '/task-capabilities', {headers: f.headers})).json()
    assert.deepEqual(caps1.available_tasks, [TASK_NAME])
    assert.deepEqual(caps1.permitted_tasks, [])
    const refused = await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body})
    assert.equal(refused.status, 403)
    assert.equal(f.starts(), 0)
    // in-place grant on the claimed pairing is refused -> permitted stays empty
    assert.equal(await f.grantScope(), false, 'claimed pairing rejects re-approval')
    const caps2 = await (await fetch(f.base + '/task-capabilities', {headers: f.headers})).json()
    assert.deepEqual(caps2.permitted_tasks, [], 'claimed pairing cannot be upgraded in place')
    const stillRefused = await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body})
    assert.equal(stillRefused.status, 403)
    assert.equal(f.starts(), 0)
  } finally { await f.close() }
})

test('a scope granted at approval runs exactly once on first submit and idempotent retry', async () => {
  // The supported path: scope bound at approval, before claim. First submit runs
  // once; an identical retry is idempotent with no duplicate effect.
  const f = await harness({discovery: [TASK_NAME], grant: true})
  try {
    const body = JSON.stringify({request_id: 'harden_0004', task: TASK_NAME})
    assert.equal((await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body})).status, 202)
    const again = await fetch(f.base + '/tasks', {method: 'POST', headers: f.headers, body})
    assert.ok([200, 202].includes(again.status))
    assert.equal(f.starts(), 1) // exactly once
    const read = await (await fetch(f.base + '/tasks/harden_0004', {headers: f.headers})).json()
    assert.equal(read.status, 'completed')
    assert.equal(read.receipt.result, PUBLIC_NOTE)
  } finally { await f.close() }
})
