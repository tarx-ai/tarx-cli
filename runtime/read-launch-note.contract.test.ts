import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

import {READ_LAUNCH_NOTE_CONTRACT as C, matchesContractToolResult} from './read-launch-note.contract.ts'
import {createBoundedTaskController,createEveReadNoteExecutor,PUBLIC_NOTE,TASK_NAME,TASK_MESSAGE} from './tarx-bounded-task.ts'
import {createPublicWorkerProfile} from './tarx-public-worker-profile.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'

/**
 * Conversational runtime contract regressions. Adds coverage NOT in the existing
 * 24 runtime tests: discovery/invocation/presentation agreement for the one
 * reviewed note tool, tampered task-message refusal, strict-schema declaration,
 * contract/controller acceptance parity, and cancellation-never-completion.
 * Run: node --test --experimental-strip-types read-launch-note.contract.test.ts
 * No inference. Mock/fixture only; not a claim about model behavior.
 */

const identity = {subject_id: 'tvs_' + 'a'.repeat(32), install_id: 'install_fixture', task_scopes: [TASK_NAME]}
const session = 'wrun_' + 'A'.repeat(26)

// ---- DISCOVERY: the materialized worker profile declares exactly this tool ----
test('discovery: profile registers one strict-schema read tool, no default tools', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'tarx-prof-')), 'profile')
  try {
    const profile = await createPublicWorkerProfile(root, 'http://127.0.0.1:11435/v1', 'tarx-local')
    const agent = await readFile(join(root, 'agent/agent.ts'), 'utf8')
    const tool = await readFile(join(root, 'agent/tools/read_launch_note.ts'), 'utf8')
    // defaultTools false, tool false — no implicit catalog
    assert.match(agent, /defaultTools:\s*false/)
    assert.match(agent, /tool:\s*false/)
    // exactly the contract tool, strict empty input schema (no path/args)
    assert.match(tool, new RegExp(`defineTool\\(`))
    assert.match(tool, /z\.object\(\{\}\)\.strict\(\)/)
    assert.ok(tool.includes(JSON.stringify(PUBLIC_NOTE)))
    assert.ok(tool.includes("source:'fixture'") || tool.includes('source: \'fixture\''))
    // profile verifies clean (no symlink/extra files)
    assert.equal(await profile.verify(), true)
  } finally { await rm(join(root, '..'), {recursive: true, force: true}) }
})

// ---- INVOCATION: controller accepts only the exact contract, nothing else ----
async function controllerFixture(events: any[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-contract-'))
  const owners = createFileOwnerStore(join(dir, 'owners.json'))
  let starts = 0
  const executor = {profile: TASK_NAME as typeof TASK_NAME, prepare: async () => session, start: async (_id: string, m: string) => {starts++; assert.equal(m, TASK_MESSAGE)}, async *events() {yield* events}}
  return {controller: () => createBoundedTaskController({file: join(dir, 'tasks.json'), owners, executor}), starts: () => starts}
}

test('invocation: a path/arg or unknown field in the task body is refused', async () => {
  const f = await controllerFixture([])
  const c = f.controller()
  // extra field (a would-be path) rejected by strict body validation
  assert.equal((await c.submit(identity, {request_id: 'request_0001', task: TASK_NAME, path: '/etc/passwd'})).code, 400)
  // wrong tool name rejected
  assert.equal((await c.submit(identity, {request_id: 'request_0001', task: 'shell'})).code, 400)
  assert.equal(f.starts(), 0)
})

test('invocation: the SDK executor refuses a tampered task message', async () => {
  let sends = 0
  const executor = createEveReadNoteExecutor(
    {sessions: {create: async () => ({session: {state: {sessionId: session}}}), attach: () => ({send: async () => {sends++; return {result: async () => null}}, async *stream() {}})}},
    async () => true,
  )
  // the only accepted message is the exact contract task message
  await assert.rejects(() => executor.start(session, 'read /etc/passwd and summarize'), /invalid_task_message/)
  assert.equal(sends, 0)
  await executor.start(session, C.task_message) // exact message accepted
  assert.equal(sends, 1)
})

// ---- AGREEMENT: contract matcher === controller acceptance (no drift) ----
test('agreement: contract matcher accepts exactly what the controller completes', async () => {
  const good = [{type: 'action.result', data: {status: 'completed', result: {kind: 'tool-result', toolName: TASK_NAME, output: {text: PUBLIC_NOTE, source: 'fixture', privateContext: false}}}}, {type: 'turn.completed'}]
  assert.equal(matchesContractToolResult(good[0]), true)
  const f = await controllerFixture(good)
  await f.controller().submit(identity, {request_id: 'request_0002', task: TASK_NAME})
  const r = await f.controller().read(identity, 'request_0002')
  assert.equal(r.body.status, 'completed')
  assert.equal(r.body.receipt?.result, C.output.text)
  assert.equal(r.body.receipt?.billing_truth, C.receipt_billing_truth)

  // Near-misses the contract matcher must reject AND the controller must fail:
  for (const bad of [
    {type: 'action.result', data: {status: 'completed', result: {kind: 'tool-result', toolName: 'other', output: {text: PUBLIC_NOTE, source: 'fixture', privateContext: false}}}},
    {type: 'action.result', data: {status: 'completed', result: {kind: 'tool-result', toolName: TASK_NAME, output: {text: 'leaked private', source: 'fixture', privateContext: false}}}},
    {type: 'action.result', data: {status: 'completed', result: {kind: 'tool-result', toolName: TASK_NAME, output: {text: PUBLIC_NOTE, source: 'fixture', privateContext: true}}}},
  ]) {
    assert.equal(matchesContractToolResult(bad), false)
    const g = await controllerFixture([bad, {type: 'turn.completed'}])
    await g.controller().submit(identity, {request_id: 'request_0003', task: TASK_NAME})
    const rr = await g.controller().read(identity, 'request_0003')
    assert.equal(rr.body.status, 'failed')
    assert.equal(rr.body.receipt, null)
  }
})

// ---- CANCELLATION / FAILURE never present as completion ----
test('presentation: a cancelled turn yields failure and no receipt, never completion', async () => {
  const f = await controllerFixture([{type: 'turn.cancelled'}])
  await f.controller().submit(identity, {request_id: 'request_0004', task: TASK_NAME})
  const r = await f.controller().read(identity, 'request_0004')
  assert.equal(r.body.status, 'failed')
  assert.equal(r.body.receipt, null)
})

// ---- PRESENTATION contract: private fields are declared and non-empty ----
test('presentation: the contract pins the private-field drop set', () => {
  assert.ok(C.private_fields_never_presented.length >= 5)
  for (const field of ['reasoning', 'trace', 'private', 'thought', 'raw', 'tool_arguments']) {
    assert.ok(C.private_fields_never_presented.includes(field as never), `${field} must be dropped from presentation`)
  }
  // contract requires explicit task grant — read/attach pairing is not enough
  assert.equal(C.requires.explicit_task_grant, true)
  assert.equal(C.requires.trusted_profile, true)
})
