/**
 * TARX runtime capability manifest — v0 (CLI/daemon lane, metadata only).
 *
 * A bounded, versioned, read-only description of what the paired local runtime
 * can actually do, for channel/web consumers (Grok Connections). It is built
 * from the REAL runtime inputs the transport already trusts:
 *   - runtime-DISCOVERED tools (the capability authority; no hardcoded catalog),
 *   - the caller's GRANTED task scopes (from the authorized pairing),
 *   - the injected TransportReadiness probe (config AND worker AND model),
 *   - a small table of DECLARED capability metadata (action/schema/receipt).
 *
 * Hard rules (from kiro-runtime-capability-manifest-next.md + Always-On audit):
 *   - Credential/catalog presence is NOT execution-ready. A capability is only
 *     `available` when it is discovered, declared, healthy, AND granted.
 *   - Discovered-but-undeclared tools are `unknown` (not catalog-connected),
 *     never fabricated into a usable capability.
 *   - An unreachable/unhealthy runtime makes declared capabilities
 *     `unavailable`; we never infer healthy from an open port or source file.
 *   - Cognitive integration is a declared adapter that stays `unknown` until a
 *     bounded metadata-health probe exists. We never call
 *     snapshot/context/inference or activate any scheduler from here.
 *   - NO filesystem paths, private context, credentials, tokens, session ids,
 *     subject/install ids, or founder memory appear in the manifest.
 *   - This module opens no socket, starts no process, and performs no probe of
 *     its own; every fact is injected. It is pure and synchronous.
 *
 * This is a SOURCE CONTRACT increment. It does not claim Always-On accepted.
 */

export const CAPABILITY_MANIFEST_SCHEMA = 'tarx.capability_manifest.v0' as const

/** Where a capability actually runs. No network/path detail, just the lane. */
export type ExecutionLocation = 'this_computer' | 'supercomputer' | 'unknown'

/** The only honest statuses. `unknown` means we cannot yet attest it. */
export type CapabilityStatus = 'available' | 'needs_permission' | 'unavailable' | 'unknown'

/** The receipt a consumer can expect if the capability runs. Metadata only —
 *  no actual receipt, result, or credential. Mirrors the bounded-task receipt
 *  contract (see tarx-bounded-task.ts) without leaking any run data. */
export type ReceiptContract = {
  /** Stable receipt kind string a consumer can match on. */
  kind: string
  /** Field names the receipt will contain (names only, never values). */
  fields: readonly string[]
  /** Truthful billing posture; these local checks are not charges. */
  billing_truth: 'not_a_charge' | 'metered' | 'unknown'
}

/** Declared, static metadata for a capability TARX understands. This is NOT a
 *  claim of availability — availability is computed from discovery + health +
 *  grants. Declaring a capability only lets it be labeled instead of `unknown`. */
export type DeclaredCapability = {
  capability_id: string
  execution_location: ExecutionLocation
  /** The single action id a consumer invokes (e.g. a task name). */
  supported_action: string
  /** A stable, path-free input schema descriptor (JSON-schema-ish subset). */
  action_schema: Readonly<Record<string, unknown>>
  receipt_contract: ReceiptContract
  /** Scope that must be granted for this capability to be executable. */
  required_scope: string
}

/** One serialized manifest entry. Metadata only. */
export type CapabilityEntry = {
  capability_id: string
  execution_location: ExecutionLocation
  status: CapabilityStatus
  supported_action: string | null
  action_schema: Readonly<Record<string, unknown>> | null
  receipt_contract: ReceiptContract | null
  /** Why a capability is not `available`, for honest consumer UX. */
  reason: 'granted_and_reachable' | 'permission_required' | 'runtime_unavailable' | 'not_discovered' | 'undeclared_tool' | 'health_unknown'
}

export type CapabilityManifest = {
  schema: typeof CAPABILITY_MANIFEST_SCHEMA
  /** Bumped only when the entry shape changes; consumers pin on this. */
  version: number
  /** Overall runtime reachability, mirrored from the injected probe. */
  runtime: {
    config_valid: boolean
    worker_reachable: boolean
    model_responsive: boolean
    healthy: boolean
  }
  capabilities: CapabilityEntry[]
}

export const CAPABILITY_MANIFEST_VERSION = 1 as const

/** Injected runtime facts. Every field comes from a real source; this module
 *  invents nothing and reaches nothing. */
export type ManifestInput = {
  /** Tools the worker reported at runtime. The capability authority. */
  discovered_tools: readonly string[]
  /** Task scopes granted to THIS authorized caller (from the pairing). */
  granted_scopes: readonly string[]
  /** Real readiness probe. `healthy` requires config AND worker AND model. */
  readiness: {
    config_valid: boolean
    worker_reachable: boolean
    model_responsive: boolean
    healthy: boolean
  }
  /** Capabilities TARX declares metadata for. Anything discovered but not here
   *  is reported as `unknown` (undeclared tool), never fabricated. */
  declared: readonly DeclaredCapability[]
  /** Optional adapter integrations whose health is not yet attestable. They are
   *  always reported `unknown` with no action/schema/receipt. Used for the
   *  cognitive adapter until a bounded metadata-health probe exists. */
  declared_unknown_adapters?: readonly { capability_id: string; execution_location?: ExecutionLocation }[]
}

const SENSITIVE_KEY = /(?:^|[^a-z0-9])(path|dir|home|token|secret|key|credential|cookie|authorization|bearer|subject|install|session|password|memory|private|origin)(?:$|[^a-z0-9])/i
const MAX_CAPABILITIES = 64
function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value) && !SENSITIVE_KEY.test(value.replace(/([a-z])([A-Z])/g, '$1_$2'))
}

/** Reject any declared metadata that would leak secrets or paths through the
 *  schema. Keys and string values are both checked; we fail closed to `unknown`
 *  rather than serialize something sensitive. */
function schemaIsSafe(schema: Readonly<Record<string, unknown>>): boolean {
  let safe = true
  const visit = (value: unknown): void => {
    if (!safe) return
    if (typeof value === 'string') {
      if (value.includes('/') || value.includes('\\') || SENSITIVE_KEY.test(value)) safe = false
      return
    }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(k)) { safe = false; return }
        visit(v)
      }
    }
  }
  visit(schema)
  return safe
}

function receiptIsSafe(receipt: ReceiptContract): boolean {
  if (SENSITIVE_KEY.test(receipt.kind)) return false
  return receipt.fields.every((f) => !SENSITIVE_KEY.test(f) && !f.includes('/') && !f.includes('\\'))
}

/**
 * Build the capability manifest. Pure and synchronous. Fails closed: a
 * capability is `available` only when it is declared, discovered at runtime,
 * the runtime is healthy, AND the required scope is granted. Everything else
 * degrades to the most conservative honest status.
 */
export function buildCapabilityManifest(input: ManifestInput): CapabilityManifest {
  // Discovery names are untrusted metadata: never echo paths or credential labels.
  const discovered = new Set(input.discovered_tools.filter(safeIdentifier).slice(0, MAX_CAPABILITIES))
  const granted = new Set(input.granted_scopes.map((s) => String(s).trim()).filter(Boolean))
  const healthy = input.readiness.healthy === true && input.readiness.config_valid === true
    && input.readiness.worker_reachable === true && input.readiness.model_responsive === true

  const capabilities: CapabilityEntry[] = []
  const declaredActions = new Set<string>()

  for (const cap of input.declared.slice(0, MAX_CAPABILITIES)) {
    if (!safeIdentifier(cap.capability_id) || !safeIdentifier(cap.supported_action)) continue
    declaredActions.add(cap.supported_action)
    // A declared capability with unsafe metadata is demoted to `unknown`
    // rather than risk serializing a path or secret.
    const metaSafe = schemaIsSafe(cap.action_schema) && receiptIsSafe(cap.receipt_contract)
    if (!metaSafe) {
      capabilities.push({
        capability_id: cap.capability_id,
        execution_location: cap.execution_location,
        status: 'unknown',
        supported_action: null,
        action_schema: null,
        receipt_contract: null,
        reason: 'health_unknown',
      })
      continue
    }

    const present = discovered.has(cap.supported_action)
    const granted_ok = granted.has(cap.required_scope)
    let status: CapabilityStatus
    let reason: CapabilityEntry['reason']
    if (!present) {
      // Declared but not discovered at runtime: catalog presence is not
      // execution-ready.
      status = 'unavailable'
      reason = 'not_discovered'
    } else if (!healthy) {
      // Discovered but the runtime is not reachable/responsive.
      status = 'unavailable'
      reason = 'runtime_unavailable'
    } else if (!granted_ok) {
      status = 'needs_permission'
      reason = 'permission_required'
    } else {
      status = 'available'
      reason = 'granted_and_reachable'
    }

    capabilities.push({
      capability_id: cap.capability_id,
      execution_location: cap.execution_location,
      status,
      supported_action: cap.supported_action,
      action_schema: cap.action_schema,
      receipt_contract: cap.receipt_contract,
      reason,
    })
  }

  // Declared-unknown adapters (e.g. cognitive): always `unknown`, no action.
  for (const adapter of input.declared_unknown_adapters ?? []) {
    if (capabilities.length >= MAX_CAPABILITIES) break
    if (!safeIdentifier(adapter.capability_id)) continue
    capabilities.push({
      capability_id: adapter.capability_id,
      execution_location: adapter.execution_location ?? 'unknown',
      status: 'unknown',
      supported_action: null,
      action_schema: null,
      receipt_contract: null,
      reason: 'health_unknown',
    })
  }

  // Discovered-but-undeclared tools: surfaced as `unknown` so a consumer never
  // treats an unrecognized tool as catalog-connected.
  for (const tool of discovered) {
    if (capabilities.length >= MAX_CAPABILITIES) break
    if (declaredActions.has(tool)) continue
    capabilities.push({
      capability_id: tool,
      execution_location: 'unknown',
      status: 'unknown',
      supported_action: null,
      action_schema: null,
      receipt_contract: null,
      reason: 'undeclared_tool',
    })
  }

  return {
    schema: CAPABILITY_MANIFEST_SCHEMA,
    version: CAPABILITY_MANIFEST_VERSION,
    runtime: {
      config_valid: input.readiness.config_valid === true,
      worker_reachable: input.readiness.worker_reachable === true,
      model_responsive: input.readiness.model_responsive === true,
      healthy,
    },
    capabilities,
  }
}

/**
 * Declared metadata for the one read-only capability that exists today: the
 * bounded `read_launch_note` local Eve tool. Mirrors tarx-bounded-task.ts
 * (TASK_NAME + receipt shape) with field NAMES only. No values, no paths.
 */
export const READ_LAUNCH_NOTE_CAPABILITY: DeclaredCapability = {
  capability_id: 'local.read_launch_note',
  execution_location: 'this_computer',
  supported_action: 'read_launch_note',
  action_schema: {
    type: 'object',
    required: ['request_id', 'task'],
    properties: {
      request_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,80}$' },
      task: { const: 'read_launch_note' },
    },
    additionalProperties: false,
  },
  receipt_contract: {
    kind: 'local_eve_tool',
    fields: ['kind', 'tool', 'status', 'result', 'billing_truth'],
    billing_truth: 'not_a_charge',
  },
  required_scope: 'read_launch_note',
}

/**
 * The cognitive integration as a declared-unknown adapter. Per the Always-On
 * audit, listening on a port is not healthy and the deployed code/version is
 * not established, so it stays `unknown` and this module never probes it.
 */
export const COGNITIVE_ADAPTER_UNKNOWN = {
  capability_id: 'adapter.cognitive',
  execution_location: 'this_computer' as ExecutionLocation,
}

/** Serialize the manifest to a stable JSON string (sorted keys) so the schema
 *  and any serialization regressions are easy to assert. */
export function serializeManifest(manifest: CapabilityManifest): string {
  return JSON.stringify(manifest, sortReplacer(), 2)
}

/** Stable key order for deterministic serialization. */
function sortReplacer() {
  return function (this: unknown, _key: string, value: unknown) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k]
          return acc
        }, {})
    }
    return value
  }
}
