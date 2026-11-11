import {createHash} from "node:crypto"
import {lstat, readFile} from "node:fs/promises"
import {dirname} from "node:path"

import type {DaemonStore} from "../store.ts"

const MAX_LEDGER = 1024 * 1024
const MAX_ROWS = 512
const REQUEST = /^[A-Za-z0-9_-]{8,80}$/
const SESSION = /^wrun_[0-9A-Z]{20,32}$/
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SUBJECT = /^tvs_[a-f0-9]{32}$/
const DIGEST = /^[a-f0-9]{64}$/
const CORE = /^[a-f0-9]{40}$/

const ROW_KEYS = "agent_id,channel_id,execution_exit,install_id,intent_sha256,receipt,request_id,session_id,status,subject_id,task"
const PROOF_KEYS = "agent_id,channel_id,core_source,install_id,intent_sha256,kind,request_id,session_id,subject_id,version"
const RECEIPT_KEYS = "agent_id,billing_truth,channel_id,core_source,execution_mode,independent_verified,kind,model_calls,native_actions,session_id"

type Row = Record<string, any>

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function exact(value: unknown, keys: string): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).sort().join(",") === keys.split(",").sort().join(",")
}

function validRecord(key: string, row: unknown): row is Row {
  if (!exact(row, ROW_KEYS)) return false
  if (row.task !== "computer_use" || row.status !== "completed") return false
  if (!REQUEST.test(row.request_id) || !SESSION.test(row.session_id) || !OPAQUE.test(row.channel_id) || !AGENT.test(row.agent_id)) return false
  if (!SUBJECT.test(row.subject_id) || !OPAQUE.test(row.install_id) || !DIGEST.test(row.intent_sha256)) return false
  if (key !== `computer:${digest([row.subject_id, row.install_id, row.request_id])}`) return false

  const proof = row.execution_exit
  if (!exact(proof, PROOF_KEYS) || proof.kind !== "computer_execution_exit" || proof.version !== 1 || !CORE.test(proof.core_source)) return false
  for (const field of ["request_id", "session_id", "channel_id", "agent_id", "subject_id", "install_id", "intent_sha256"]) {
    if (proof[field] !== row[field]) return false
  }

  const receipt = row.receipt
  if (!exact(receipt, RECEIPT_KEYS) || receipt.kind !== "computer_use" || receipt.independent_verified !== true || receipt.billing_truth !== "not_a_charge") return false
  if (receipt.core_source !== proof.core_source || !["supercomputer", "local_model", "deterministic_actuator"].includes(receipt.execution_mode)) return false
  for (const field of ["session_id", "channel_id", "agent_id"]) {
    if (receipt[field] !== row[field]) return false
  }
  return [receipt.native_actions, receipt.model_calls].every((value) => Number.isInteger(value) && value >= 0 && value <= 50)
}

async function readLedger(file: string): Promise<Record<string, unknown>> {
  if (!file.startsWith("/")) throw new Error("computer_receipt_ledger_required")
  const directory = await lstat(dirname(file))
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error("computer_receipt_ledger_unsafe")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size < 1 || info.size > MAX_LEDGER) throw new Error("computer_receipt_ledger_unsafe")
  const parsed = JSON.parse(await readFile(file, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > MAX_ROWS) throw new Error("computer_receipt_ledger_invalid")
  return parsed as Record<string, unknown>
}

export type ReceiptImportResult = {scanned: number; imported: number; existing: number; invalid: number}

/** One-way bridge from the existing desktop computer-task ledger into the
 * daemon outbox. It does not execute, replay or expose raw execution proof.
 * The receipt payload is bounded metadata; the deterministic idempotency key
 * makes a repeated import safe. */
export async function syncComputerReceipts(input: {ledgerFile: string; store: DaemonStore}): Promise<ReceiptImportResult> {
  const ledger = await readLedger(input.ledgerFile)
  const result: ReceiptImportResult = {scanned: 0, imported: 0, existing: 0, invalid: 0}
  for (const [key, row] of Object.entries(ledger)) {
    result.scanned += 1
    if (!validRecord(key, row)) {
      result.invalid += 1
      continue
    }
    try {
      const imported = input.store.importCompletedTask({
        taskId: row.request_id,
        ownerId: row.subject_id,
        installId: row.install_id,
        channelId: row.channel_id,
        agentId: row.agent_id,
        kind: "computer_use",
        request: {request_id: row.request_id, session_id: row.session_id, channel_id: row.channel_id, agent_id: row.agent_id},
        result: row.receipt,
        delivery: {
          kind: "result",
          payload: {request_id: row.request_id, session_id: row.session_id, channel_id: row.channel_id, agent_id: row.agent_id, receipt: row.receipt},
          idempotencyKey: `computer-receipt:${digest([row.subject_id, row.install_id, row.request_id, row.session_id])}`,
        },
      })
      if (imported.imported) result.imported += 1
      else result.existing += 1
    } catch (error) {
      result.invalid += 1
    }
  }
  return result
}
