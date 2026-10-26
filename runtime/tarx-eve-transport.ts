/**
 * TARX Eve local session transport contract — v0 (CLI/daemon lane).
 *
 * The secure boundary between the web surface (Grok) and the local Eve worker.
 * Pure contract + ownership/authorization logic; it opens no socket and starts
 * no worker. The launch adapter (tarx-eve-launch.ts) owns the process; this
 * module decides who may read/attach which session and how reload behaves.
 *
 * Invariants (from kiro-eve-connect-next.md):
 *  - Distinguish CONFIG validity from WORKER/MODEL/TOOL health.
 *  - Runtime-discovered tools are the capability authority. No hardcoded catalog.
 *  - Persist session/run/cursor ownership; verify origin + per-install/session
 *    authorization; reject unknown/foreign account/session IDs.
 *  - Reload is a read/attach, never duplicate execution.
 *  - The public bridge must not grant arbitrary host tool access.
 *  - Deep dispatch stays scoped; no private history leaves the device.
 */

import type { WorkerReadiness } from './tarx-eve-worker.ts'

/** Loopback-only transport. The worker never binds a public interface. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const STABLE_SUBJECT = /^tvs_[0-9a-f]{32}$/
const SESSION_ID = /^wrun_[0-9A-Z]{20,32}$/ // Eve Workflow run id shape

/** A session is owned by exactly one install + one account subject. */
export type SessionOwnership = {
  session_id: string
  subject_id: string
  install_id: string
  /** Monotonic read cursor for reload (attach), not a re-execute pointer. */
  cursor: number
}

/** Health is injected from a real probe; it is NOT config validity. */
export type WorkerHealth = {
  endpoint_reachable: boolean
  model_responsive: boolean
  /** Tools discovered at runtime from the worker — the capability authority. */
  discovered_tools: string[]
}

export type TransportReadiness = {
  config_valid: boolean
  worker_reachable: boolean
  model_responsive: boolean
  /** Runtime-discovered tools only. No hardcoded capability catalog. */
  tools: string[]
  /** Overall: config AND worker AND model. Config alone is never "healthy". */
  healthy: boolean
}

/** Compose honest readiness. config_valid from the config check, health from a
 *  real probe. tools come only from runtime discovery. */
export function transportReadiness(readiness: WorkerReadiness, health: WorkerHealth): TransportReadiness {
  const configValid = readiness.config_valid === 'ready'
  return {
    config_valid: configValid,
    worker_reachable: health.endpoint_reachable,
    model_responsive: health.model_responsive,
    tools: [...health.discovered_tools],
    healthy: configValid && health.endpoint_reachable && health.model_responsive,
  }
}

export type AuthzInput = {
  /** Origin header on the web→transport request. */
  origin: string
  /** Allowed origins for this install (e.g. the local app + tarx.com). */
  allowedOrigins: Set<string>
  /** Presented account subject + install id from the authorized session. */
  subject_id: string
  install_id: string
  /** The session the caller wants to read/attach. */
  session_id: string
  /** The owner record for that session, from local persistence. */
  owner: SessionOwnership | null
}

export type AuthzResult =
  | { ok: true }
  | { ok: false; error: 'untrusted_origin' | 'invalid_subject' | 'invalid_session_id' | 'unknown_session' | 'foreign_session' }

/** Fail-closed authorization for a session read/attach over the local bridge. */
export function authorizeSessionAccess(input: AuthzInput): AuthzResult {
  if (!input.origin || !input.allowedOrigins.has(input.origin)) return { ok: false, error: 'untrusted_origin' }
  if (!STABLE_SUBJECT.test(input.subject_id)) return { ok: false, error: 'invalid_subject' }
  if (!SESSION_ID.test(input.session_id)) return { ok: false, error: 'invalid_session_id' }
  if (!input.owner) return { ok: false, error: 'unknown_session' }
  // A session may only be read by its owning subject AND install.
  if (input.owner.session_id !== input.session_id || !input.install_id.trim() || input.owner.subject_id !== input.subject_id || input.owner.install_id !== input.install_id) {
    return { ok: false, error: 'foreign_session' }
  }
  return { ok: true }
}

export type AttachResult =
  | { ok: true; mode: 'read_attach'; from_cursor: number }
  | { ok: false; error: AuthzResult extends { ok: false } ? never : never }

/** Reload = read/attach from the persisted cursor. It NEVER re-executes the run.
 *  Callers must have passed authorizeSessionAccess first. */
export function attachForReload(owner: SessionOwnership): { mode: 'read_attach'; from_cursor: number } {
  return { mode: 'read_attach', from_cursor: owner.cursor }
}

/** Advance the read cursor after streaming events to the client. Monotonic. */
export function advanceCursor(owner: SessionOwnership, eventsRead: number): SessionOwnership {
  const n = Number.isInteger(eventsRead) && eventsRead > 0 ? eventsRead : 0
  return { ...owner, cursor: owner.cursor + n }
}

/** The public/web bridge may request only session read/attach and a scoped
 *  deep-dispatch. It may NOT request arbitrary host tool execution. */
const BRIDGE_ALLOWED_OPS = new Set(['session.attach', 'session.read', 'deep.dispatch', 'readiness'])

export function bridgeOpAllowed(op: string): boolean {
  return BRIDGE_ALLOWED_OPS.has(op)
}

/** A host-tool op from the bridge is always refused — arbitrary host tool
 *  access is not granted across the public boundary. */
export function bridgeGrantsHostTools(): false {
  return false
}
