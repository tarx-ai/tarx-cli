import {PUBLIC_NOTE,TASK_NAME,TASK_MESSAGE} from './tarx-bounded-task.ts'

/**
 * Machine-readable public capability contract for the ONE reviewed tool.
 *
 * This is the single declaration that discovery, invocation, and presentation
 * must agree on. It is derived from the real runtime constants — it does NOT
 * invent tools/skills and is NOT a second catalog. Instructions are not
 * capability authority; this contract only describes the one tool the worker
 * profile actually registers and the bounded-task controller actually accepts.
 */
export const READ_LAUNCH_NOTE_CONTRACT = {
  schema: 'tarx.capability.v0',
  tool: TASK_NAME,                       // 'read_launch_note'
  description: 'Read the fixed public tool-check note.',
  input_schema: {type: 'object', properties: {}, additionalProperties: false}, // z.object({}).strict()
  effect: 'read' as const,               // no write, no external, no delegation
  location: 'local' as const,
  default_tools: false as const,
  task_message: TASK_MESSAGE,            // the exact, only accepted task message
  output: {
    kind: 'tool-result' as const,
    source: 'fixture' as const,
    private_context: false as const,
    text: PUBLIC_NOTE,
  },
  receipt_billing_truth: 'not_a_charge' as const,
  /** Fields that must never reach the client presentation layer. */
  private_fields_never_presented: ['reasoning', 'trace', 'private', 'thought', 'raw', 'tool_arguments'] as const,
  requires: {
    account_install_session_ownership: true,
    explicit_task_grant: true,           // read/attach pairing does NOT grant this
    trusted_profile: true,               // a tool name or browser flag is not evidence
  },
} as const

export type ReadLaunchNoteContract = typeof READ_LAUNCH_NOTE_CONTRACT

/** True only for a tool-result event that matches the contract exactly.
 * Mirrors the acceptance in tarx-bounded-task refresh() so discovery/invocation
 * and this contract cannot drift: one definition, asserted by the test. */
export function matchesContractToolResult(event: {type?: string; data?: any}): boolean {
  if (event.type !== 'action.result') return false
  const result = event.data?.result, output = result?.output
  return event.data?.status === 'completed'
    && result?.kind === READ_LAUNCH_NOTE_CONTRACT.output.kind
    && result?.toolName === READ_LAUNCH_NOTE_CONTRACT.tool
    && output?.source === READ_LAUNCH_NOTE_CONTRACT.output.source
    && output?.privateContext === READ_LAUNCH_NOTE_CONTRACT.output.private_context
    && output?.text === READ_LAUNCH_NOTE_CONTRACT.output.text
}
