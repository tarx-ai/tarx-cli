import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createLoopbackPersonalClient,validatePersonalTurn,sanitizeAssistant} from './tarx-personal-turn.ts'

/**
 * Captured-request tests for the paired browser /personal-turn bridge. Real
 * listener + pairing identity/origin/revoke; the personal client is bound to a
 * captured loopback endpoint (never a browser-supplied URL/key). No model,
 * network, grant, or process. Run:
 *   node --test --experimental-strip-types tarx-personal-turn.test.ts
 */

const origin = 'https://www.tarx.com'
const subject = 'tvs_' + 'a'.repeat(32)

async function setup(opts: {withClient: boolean; clientReply?: string | null; captureHosted?: (url: string) => void} = {withClient: true}) {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-personal-'))
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const owners = createFileOwnerStore(join(dir, 'owners.json'))
  const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'fixture_install', store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch})
  assert.ok(ch.ok); if (!ch.ok) throw Error('fixture')
  await approvePairingChallenge(ch.challenge, pairs, Date.now(), 'personal_chat')
  // Capturing loopback personal client: records the exact body/url the bridge sends.
  const captured: any[] = []
  const fetcher = (async (url: string, init: any) => {
    captured.push({url, body: JSON.parse(init.body), headers: init.headers})
    if (opts.captureHosted && !url.startsWith('http://127.0.0.1')) opts.captureHosted(url)
    return new Response(JSON.stringify({choices: [{message: {content: opts.clientReply === undefined ? 'personal reply\u0000' : opts.clientReply}}]}), {status: 200, headers: {'content-type': 'application/json'}})
  }) as typeof fetch
  const personalClient = opts.withClient ? createLoopbackPersonalClient({baseURL: 'http://127.0.0.1:11463', model: 'tarx-personal', apiKey: 'SECRET_LOCAL_KEY', fetcher}) : undefined
  const listener = createPairedSessionListener({host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), pairStore: pairs, ownerStore: owners, eveClient: () => ({attach: () => ({async *stream() {}})}), readiness: async () => ({config_valid: true, worker_reachable: false, model_responsive: false, tools: [], healthy: false}), personalClient})
  const {port} = await listener.listen()
  const base = 'http://127.0.0.1:' + port
  const claim = await fetch(base + '/pairing/claim', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge: ch.challenge})})
  assert.equal(claim.status, 200)
  const token = (await claim.json()).pairing_credential
  return {listener, base, headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token}, captured, revoke: () => revokePairing(createHash('sha256').update(ch.challenge).digest('hex'), pairs)}
}

const goodBody = JSON.stringify({messages: [{role: 'user', content: 'what is a vault?'}]})

test('validator rejects anything beyond bounded {messages:[{role,content}]}', () => {
  assert.equal(validatePersonalTurn({messages: [{role: 'user', content: 'hi'}]}).ok, true)
  assert.equal(validatePersonalTurn({messages: [], model: 'x'}).ok, false) // extra key
  assert.equal(validatePersonalTurn({messages: [{role: 'system', content: 'x'}]}).ok, false) // no system role
  assert.equal(validatePersonalTurn({messages: [{role: 'user', content: 'x', url: 'http://evil'}]}).ok, false) // extra field
  assert.equal(validatePersonalTurn({messages: [{role: 'assistant', content: 'x'}]}).ok, false) // must end on user
  assert.equal(validatePersonalTurn({messages: [{role: 'user', content: 'x'.repeat(8001)}]}).ok, false) // too long
})

test('paired personal turn reaches the OWNED loopback client and returns sanitized assistant text', async () => {
  const f = await setup({withClient: true})
  try {
    const r = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: goodBody})
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.role, 'assistant')
    assert.equal(body.content, 'personal reply') // control char stripped by sanitize
    // the bridge sent to the loopback personal endpoint, with the browser's messages
    assert.equal(f.captured.length, 1)
    assert.equal(f.captured[0].url, 'http://127.0.0.1:11463/v1/chat/completions')
    assert.deepEqual(f.captured[0].body.messages, [{role: 'user', content: 'what is a vault?'}])
  } finally { await f.listener.close() }
})

test('no private content or local key ever leaves to a hosted endpoint, and key is not returned', async () => {
  let hosted = 0
  const f = await setup({withClient: true, captureHosted: () => {hosted++}})
  try {
    const r = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: goodBody})
    const text = await r.text()
    assert.equal(hosted, 0) // nothing went to any non-loopback host
    assert.equal(text.includes('SECRET_LOCAL_KEY'), false) // key never surfaces to the browser
    // key is server-side only: present on the captured loopback request header
    assert.equal(f.captured[0].headers.authorization, 'Bearer SECRET_LOCAL_KEY')
  } finally { await f.listener.close() }
})

test('fail-closed: no personal client -> 503, no hosted fallback', async () => {
  const f = await setup({withClient: false})
  try {
    const r = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: goodBody})
    assert.equal(r.status, 503)
    assert.equal((await r.json()).error, 'personal_runtime_unavailable')
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('fail-closed: personal runtime unreachable -> 503', async () => {
  // A loopback client whose fetch throws models an unreachable local runtime.
  const dir = await mkdtemp(join(tmpdir(), 'tarx-personal-down-'))
  const pairs = createFilePairStore(join(dir, 'pairs.json'))
  const owners = createFileOwnerStore(join(dir, 'owners.json'))
  const ch = await createPairingChallenge({loadCredential: async () => 'tarx_cli_' + 'f'.repeat(64), install_id: 'fixture_install', store: pairs, fetcher: (async () => new Response(JSON.stringify({ok: true, subject_id: subject}))) as typeof fetch})
  if (!ch.ok) throw Error('fixture'); await approvePairingChallenge(ch.challenge, pairs, Date.now(), 'personal_chat')
  const down = createLoopbackPersonalClient({baseURL: 'http://127.0.0.1:11463', model: 'm', fetcher: (async () => {throw new Error('down')}) as typeof fetch})
  const listener = createPairedSessionListener({host: '127.0.0.1', port: 0, allowedOrigins: new Set([origin]), pairStore: pairs, ownerStore: owners, eveClient: () => ({attach: () => ({async *stream() {}})}), readiness: async () => ({config_valid: true, worker_reachable: false, model_responsive: false, tools: [], healthy: false}), personalClient: down})
  const {port} = await listener.listen(); const base = 'http://127.0.0.1:' + port
  const claim = await fetch(base + '/pairing/claim', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({challenge: ch.challenge})})
  const token = (await claim.json()).pairing_credential
  try {
    const r = await fetch(base + '/personal-turn', {method: 'POST', headers: {origin, 'content-type': 'application/json', authorization: 'Bearer ' + token}, body: goodBody})
    assert.equal(r.status, 503)
  } finally { await listener.close() }
})

test('foreign origin and missing identity are refused with no client call', async () => {
  const f = await setup({withClient: true})
  try {
    const bad = await fetch(f.base + '/personal-turn', {method: 'POST', headers: {...f.headers, origin: 'https://evil.example'}, body: goodBody})
    assert.equal(bad.status, 403)
    const noAuth = await fetch(f.base + '/personal-turn', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: goodBody})
    assert.equal(noAuth.status, 401)
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('revoked pairing can no longer send a personal turn', async () => {
  const f = await setup({withClient: true})
  try {
    await f.revoke()
    const r = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: goodBody})
    assert.equal(r.status, 401)
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('oversized or malformed body is refused before any client call', async () => {
  const f = await setup({withClient: true})
  try {
    const big = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: JSON.stringify({messages: [{role: 'user', content: 'x'.repeat(40000)}]})})
    assert.ok([400, 413].includes(big.status))
    const malformed = await fetch(f.base + '/personal-turn', {method: 'POST', headers: f.headers, body: '{not json'})
    assert.equal(malformed.status, 400)
    assert.equal(f.captured.length, 0)
  } finally { await f.listener.close() }
})

test('sanitizeAssistant strips control chars and caps length', () => {
  assert.equal(sanitizeAssistant('a\u0000b\u0007c'), 'abc')
  assert.equal(sanitizeAssistant('x'.repeat(9000)).length, 8000)
})
