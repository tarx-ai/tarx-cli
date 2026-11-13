/** Durable Internal QA browser check. The browser is the only executor; this
 * module validates the typed request/receipt and never opens a page itself. */
import {DaemonError} from "./errors.ts"

export const BROWSER_QA_KIND = "browser_qa"
export const BROWSER_QA_URL = "https://www.tarx.com/"
const REQUEST_ID = /^bqa_[a-f0-9]{16}$/
const TRACE_ID = /^[a-f0-9]{32}$/
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const GOAL_SECRET = /tarx_cli_|tpc_[0-9a-f]{64}|-----BEGIN |(?:\/Users\/|\/home\/|~\/\.tarx\/)|\bsk-[A-Za-z0-9]{12}/i

export type BrowserQaSubmit = {
  task_id?: string
  request_id: string
  channel_id: string
  agent_id: string
  goal: string
  trace_id: string
}

export type BrowserQaReceipt = {
  kind: "browser_qa"
  request_id: string
  channel_id: string
  agent_id: string
  trace_id: string
  url: typeof BROWSER_QA_URL
  navigation: "completed"
  composer_visible: true
  composer_usable: true
  independent_verified: true
  dom_actions: 1
  native_actions: 0
  model_calls: 0
  billing_truth: "not_a_charge"
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join(",") === [...keys].sort().join(",")
}

export function validateBrowserQaSubmit(value: unknown): BrowserQaSubmit {
  if (!exact(value, ["request_id", "channel_id", "agent_id", "goal", "trace_id"]) && !exact(value, ["request_id", "channel_id", "agent_id", "goal", "trace_id", "task_id"])) {
    throw new DaemonError("invalid_browser_qa_submit", 400)
  }
  const row = value as Record<string, unknown>
  if (typeof row.request_id !== "string" || !REQUEST_ID.test(row.request_id)) throw new DaemonError("invalid_browser_qa_submit", 400)
  if (typeof row.channel_id !== "string" || !OPAQUE.test(row.channel_id)) throw new DaemonError("invalid_browser_qa_submit", 400)
  if (typeof row.agent_id !== "string" || !OPAQUE.test(row.agent_id)) throw new DaemonError("invalid_browser_qa_submit", 400)
  if (typeof row.goal !== "string" || !row.goal.trim() || row.goal.length > 500 || CONTROL.test(row.goal) || GOAL_SECRET.test(row.goal)) {
    throw new DaemonError("invalid_browser_qa_submit", 400)
  }
  if (typeof row.trace_id !== "string" || !TRACE_ID.test(row.trace_id)) throw new DaemonError("invalid_browser_qa_submit", 400)
  if (row.task_id !== undefined && (typeof row.task_id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(row.task_id))) {
    throw new DaemonError("invalid_browser_qa_submit", 400)
  }
  return {
    ...(typeof row.task_id === "string" ? {task_id: row.task_id} : {}),
    request_id: row.request_id,
    channel_id: row.channel_id,
    agent_id: row.agent_id,
    goal: row.goal.trim(),
    trace_id: row.trace_id,
  }
}

export function validateBrowserQaReceipt(value: unknown, request: BrowserQaSubmit): BrowserQaReceipt {
  if (!exact(value, ["kind", "request_id", "channel_id", "agent_id", "trace_id", "url", "navigation", "composer_visible", "composer_usable", "independent_verified", "dom_actions", "native_actions", "model_calls", "billing_truth"])) {
    throw new DaemonError("invalid_browser_qa_receipt", 400)
  }
  const row = value as Record<string, unknown>
  if (row.kind !== "browser_qa" || row.request_id !== request.request_id || row.channel_id !== request.channel_id || row.agent_id !== request.agent_id || row.trace_id !== request.trace_id) {
    throw new DaemonError("browser_qa_receipt_mismatch", 409)
  }
  if (row.url !== BROWSER_QA_URL || row.navigation !== "completed" || row.composer_visible !== true || row.composer_usable !== true ||
      row.independent_verified !== true || row.dom_actions !== 1 || row.native_actions !== 0 || row.model_calls !== 0 ||
      row.billing_truth !== "not_a_charge") throw new DaemonError("invalid_browser_qa_receipt", 400)
  return row as BrowserQaReceipt
}

export function browserQaRequest(submit: BrowserQaSubmit): Record<string, unknown> {
  return {request_id: submit.request_id, channel_id: submit.channel_id, agent_id: submit.agent_id, goal: submit.goal, trace_id: submit.trace_id, url: BROWSER_QA_URL}
}

export function browserQaDelivery(receipt: BrowserQaReceipt, taskId: string) {
  return {
    kind: "result",
    payload: {request_id: receipt.request_id, channel_id: receipt.channel_id, agent_id: receipt.agent_id, trace_id: receipt.trace_id, receipt},
    idempotencyKey: `browser-qa:${taskId}`,
  }
}

export function browserQaCancelDelivery(taskId: string, requestId: string, channelId: string, agentId: string, traceId: string) {
  return {
    kind: "cancelled",
    payload: {request_id: requestId, channel_id: channelId, agent_id: agentId, trace_id: traceId, status: "cancelled"},
    idempotencyKey: `browser-qa-cancel:${taskId}`,
  }
}
