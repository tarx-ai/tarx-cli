import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {syncComputerReceipts} from "../src/adapters/computer-receipts.ts"
import {createCoordinator} from "../src/coordinator.ts"
import {createDaemonStore} from "../src/store.ts"

const subject = "tvs_" + "a".repeat(32)
const install = "install_" + "b".repeat(48)
const channel = "review"
const agent = "review-agent"
const session = "wrun_" + "D".repeat(26)
const request = "saved_request_001"
const core = "c".repeat(40)
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function row(overrides: Record<string, unknown> = {}) {
  const base: Record<string, any> = {
    task: "computer_use",
    request_id: request,
    session_id: session,
    channel_id: channel,
    agent_id: agent,
    subject_id: subject,
    install_id: install,
    intent_sha256: "d".repeat(64),
    status: "completed",
  }
  base.execution_exit = {
    kind: "computer_execution_exit",
    version: 1,
    request_id: base.request_id,
    session_id: base.session_id,
    channel_id: base.channel_id,
    agent_id: base.agent_id,
    subject_id: base.subject_id,
    install_id: base.install_id,
    intent_sha256: base.intent_sha256,
    core_source: core,
  }
  base.receipt = {
    kind: "computer_use",
    session_id: base.session_id,
    channel_id: base.channel_id,
    agent_id: base.agent_id,
    independent_verified: true,
    native_actions: 1,
    model_calls: 2,
    core_source: core,
    execution_mode: "supercomputer",
    billing_truth: "not_a_charge",
  }
  return Object.assign(base, overrides)
}

async function ledgerFile(rows: Record<string, Record<string, unknown>>) {
  const directory = await mkdtemp(join(tmpdir(), "tarx-receipt-adapter-"))
  const file = join(directory, "computer-tasks.json")
  await writeFile(file, JSON.stringify(rows), {mode: 0o600})
  await chmod(file, 0o600)
  return {directory, file}
}

test("a completed computer receipt imports once and delivers once after the coordinator runs", async () => {
  const rowValue = row()
  const f = await ledgerFile({[`computer:${digest([subject, install, request])}`]: rowValue})
  const store = createDaemonStore({file: join(f.directory, "daemon.sqlite")})
  try {
    const first = await syncComputerReceipts({ledgerFile: f.file, store})
    assert.deepEqual(first, {scanned: 1, imported: 1, existing: 0, invalid: 0})
    assert.equal(store.getTask(request)?.status, "completed")
    assert.deepEqual(store.getTask(request)?.result, rowValue.receipt)
    assert.equal(store.listDeliveries({status: "pending"}).length, 1)

    const second = await syncComputerReceipts({ledgerFile: f.file, store})
    assert.deepEqual(second, {scanned: 1, imported: 0, existing: 1, invalid: 0})
    assert.equal(store.listDeliveries().length, 1)

    const delivered: string[] = []
    const coordinator = createCoordinator({
      store,
      workerId: "receipt-coordinator",
      leaseMs: 10_000,
      heartbeatMs: 1_000,
      executor: {async execute() { throw new Error("no task should execute on a receipt import") }},
      delivery: {async deliver(value) { delivered.push(value.delivery_id) }},
    })
    try {
      const result = await coordinator.tick()
      assert.equal(result.task, null)
      assert.equal(result.delivered, 1)
      assert.deepEqual(delivered, [store.listDeliveries()[0]?.delivery_id])
      assert.equal(store.listDeliveries()[0]?.status, "delivered")
    } finally {
      await coordinator.stop()
    }
  } finally {
    store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("cancelled, foreign or proof-less rows are not imported", async () => {
  const cancelled = row({status: "cancelled", receipt: undefined, execution_exit: undefined})
  delete cancelled.receipt
  delete cancelled.execution_exit
  const foreign = row({subject_id: "tvs_" + "f".repeat(32)})
  const extra = row({goal: "raw goal must not enter the ledger"})
  const f = await ledgerFile({
    [`computer:${digest([subject, install, request])}`]: cancelled,
    [`computer:${digest([subject, install, "saved_request_002"])}`]: foreign,
    [`computer:${digest([subject, install, "saved_request_003"])}`]: extra,
  })
  const store = createDaemonStore({file: join(f.directory, "daemon.sqlite")})
  try {
    const result = await syncComputerReceipts({ledgerFile: f.file, store})
    assert.equal(result.imported, 0)
    assert.equal(result.invalid, 3)
    assert.equal(store.listTasks().length, 0)
    assert.equal(store.listDeliveries().length, 0)
  } finally {
    store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})
