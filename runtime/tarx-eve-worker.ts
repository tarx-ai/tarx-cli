/**
 * TARX local Eve worker adapter — v2 (CLI/daemon lane).
 *
 * Integrates the REAL pinned Eve (0.83.2) proven in harness/eve-compatibility:
 *   defineAgent (eve), defineTool (eve/tools), Client (eve/client),
 *   createOpenAICompatible (@ai-sdk/openai-compatible).
 * It does NOT rebuild a mock harness. It composes the worker config, a stable
 * per-install state location, a scoped typed-tool inventory, an explicit model
 * origin, and a typed stripped deep-job dispatch envelope for the existing
 * gateway identity/run contract.
 *
 * Hard rules (from harness README + launch scope):
 *  - Root agent uses LOCAL XSLM via a direct OpenAI-compatible provider. No AI
 *    Gateway model-string fallback for private/light turns.
 *  - Deep work is an explicit typed stripped payload to the existing gateway;
 *    the whole private conversation is never routed remotely.
 *  - defaultTools false; no shell/delegation/Slack/schedule defaults.
 *  - Nothing here starts a process, registers a service, or opens a socket.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export type ModelOrigin = 'local_xslm' | 'gateway_deep'

/** The only allowed local provider shape: a direct OpenAI-compatible endpoint on loopback. */
export type LocalModelConfig = {
  origin: 'local_xslm'
  baseURL: string // must be 127.0.0.1 / localhost
  modelId: string
  contextWindowTokens: number
}

export type EveWorkerConfig = {
  /** Stable per-install state dir. Eve Workflow SDK persists here; pin the version. */
  stateDir: string
  eveVersion: '0.83.2'
  model: LocalModelConfig
  /** Scoped typed tools only. No defaults, no shell, no delegation. */
  toolInventory: string[]
  defaultTools: false
}

export const PINNED_EVE_VERSION = '0.83.2' as const

/** Loopback check via real URL parsing, not a bare regex. */
function isLoopbackUrl(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
}

/** Stable per-install state location. Darwin and Linux match the shipped CLI. */
export function resolveWorkerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TARX_EVE_STATE_DIR) return env.TARX_EVE_STATE_DIR
  const home = env.HOME || homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'tarx', 'eve-worker')
  return join(home, '.tarx', 'eve-worker')
}

export type BuildResult =
  | { ok: true; config: EveWorkerConfig }
  | { ok: false; error: 'wrong_origin' | 'missing_config' | 'non_loopback_local' | 'unsupported_version' | 'invalid_context_budget' }

/**
 * Build the worker config from explicit inputs. Fails closed on a wrong model
 * origin, missing/whitespace config, a non-loopback "local" endpoint, an
 * unpinned Eve version, or a non-positive/oversized context budget. TypeScript
 * types are not the runtime boundary — every field is validated here.
 */
export function buildEveWorkerConfig(input: {
  origin?: string
  baseURL?: string
  modelId?: string
  contextWindowTokens?: number
  stateDir?: string
  eveVersion?: string
  toolInventory?: string[]
}): BuildResult {
  if (input.origin !== 'local_xslm') return { ok: false, error: 'wrong_origin' }
  const baseURL = typeof input.baseURL === 'string' ? input.baseURL.trim() : ''
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!baseURL || !modelId) return { ok: false, error: 'missing_config' }
  if (!isLoopbackUrl(baseURL)) return { ok: false, error: 'non_loopback_local' }
  if ((input.eveVersion ?? PINNED_EVE_VERSION) !== PINNED_EVE_VERSION) return { ok: false, error: 'unsupported_version' }
  const ctx = input.contextWindowTokens ?? 8192
  if (!Number.isInteger(ctx) || ctx <= 0 || ctx > 1_000_000) return { ok: false, error: 'invalid_context_budget' }

  return {
    ok: true,
    config: {
      stateDir: input.stateDir ?? resolveWorkerStateDir(),
      eveVersion: PINNED_EVE_VERSION,
      model: {
        origin: 'local_xslm',
        baseURL,
        modelId,
        contextWindowTokens: ctx,
      },
      toolInventory: [...(input.toolInventory ?? [])].map((t) => t.trim()).filter(Boolean),
      defaultTools: false,
    },
  }
}

/**
 * Typed stripped deep-job dispatch envelope. This is the ONLY payload that may
 * leave the device for deep compute. It carries no private history: just the
 * approved task text, the stable subject, a run id, and routing context. The
 * gateway owns subject/run attribution, limits, and usage/energy truth.
 */
export type DeepJobDispatchV0 = {
  schema: 'tarx.deep_job_dispatch.v0'
  subject_id: string
  run_id: string
  task: string
  privacy_tier: 'mesh_safe' | 'public'
  routing: { broker: 'lumbergh' | 'none' }
  // Explicitly NOT included: full conversation, private memory, credentials.
}

/** Deep-job dispatch requires a STABLE subject: tvs_ + exactly 32 lowercase hex.
 *  Legacy rotating tjs_ login identity is not attributable and is refused. */
const STABLE_SUBJECT = /^tvs_[0-9a-f]{32}$/
/** Runtime allowlist — TypeScript types are not a runtime boundary. */
const DISPATCHABLE_TIERS = new Set(['mesh_safe', 'public'])
const KNOWN_TIERS = new Set(['private', 'personal', 'mesh_safe', 'public'])

export type DispatchResult =
  | { ok: true; envelope: DeepJobDispatchV0 }
  | { ok: false; error: 'invalid_subject' | 'invalid_run' | 'empty_task' | 'unknown_tier' | 'private_tier_not_dispatchable' }

/** Build a dispatch envelope. Fails closed: stable subject only, known tier
 *  only, non-empty run id and task, and private/personal stay local. */
export function buildDeepJobDispatch(input: {
  subject_id: string
  run_id: string
  task: string
  privacy_tier: string
}): DispatchResult {
  const subject = typeof input.subject_id === 'string' ? input.subject_id.trim() : ''
  const runId = typeof input.run_id === 'string' ? input.run_id.trim() : ''
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (!STABLE_SUBJECT.test(subject)) return { ok: false, error: 'invalid_subject' }
  if (!runId) return { ok: false, error: 'invalid_run' }
  if (!task) return { ok: false, error: 'empty_task' }
  if (!KNOWN_TIERS.has(input.privacy_tier)) return { ok: false, error: 'unknown_tier' }
  if (!DISPATCHABLE_TIERS.has(input.privacy_tier)) return { ok: false, error: 'private_tier_not_dispatchable' }
  return {
    ok: true,
    envelope: {
      schema: 'tarx.deep_job_dispatch.v0',
      subject_id: subject,
      run_id: runId,
      task,
      privacy_tier: input.privacy_tier as 'mesh_safe' | 'public',
      routing: { broker: 'lumbergh' },
    },
  }
}

/** CLI-facing readiness/launch contract. Observes config only; starts nothing.
 *  "config_valid" is NOT reachable, installed, or healthy — those are separate
 *  checks (process launch, /health, OS lifecycle). Labels stay honest. */
export type WorkerReadiness = {
  eve_version: string
  state_dir: string
  model_origin: ModelOrigin
  model_endpoint_is_loopback: boolean
  tool_count: number
  default_tools: false
  config_valid: 'ready' | 'blocked'
  blocker?: string
  /** Explicit: config validity does not prove the worker is running. */
  not_proven: readonly ['process_launched', 'endpoint_reachable', 'eve_installed', 'daemon_healthy']
}

export function workerReadiness(config: EveWorkerConfig): WorkerReadiness {
  const loopback = isLoopbackUrl(config.model.baseURL)
  const valid = loopback && config.eveVersion === PINNED_EVE_VERSION
  return {
    eve_version: config.eveVersion,
    state_dir: config.stateDir,
    model_origin: config.model.origin,
    model_endpoint_is_loopback: loopback,
    tool_count: config.toolInventory.length,
    default_tools: false,
    config_valid: valid ? 'ready' : 'blocked',
    blocker: valid ? undefined : loopback ? 'unsupported_version' : 'non_loopback_local',
    not_proven: ['process_launched', 'endpoint_reachable', 'eve_installed', 'daemon_healthy'],
  }
}
