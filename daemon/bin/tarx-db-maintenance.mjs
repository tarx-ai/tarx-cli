#!/usr/bin/env node
/**
 * Out-of-process TARX SQLite maintenance. Never import this from the
 * conversational bridge: checkpoint and archive must not share its event loop.
 *
 * Modes: inspect | run
 * Mutation is off unless --mutate is passed AND budgets allow a PASSIVE
 * checkpoint. Event deletion is never performed in this packet.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus, freemem, homedir, loadavg, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const sqliteCandidates = [
  '/Users/master/.tarx/servers/tarx-ops/node_modules/better-sqlite3-multiple-ciphers',
  join(process.cwd(), 'node_modules/better-sqlite3-multiple-ciphers'),
]
let Database = null
for (const candidate of sqliteCandidates) {
  try {
    Database = require(candidate)
    break
  } catch { /* next */ }
}

const HOME = process.env.TARX_HOME || homedir()
const DEFAULT_DB = join(HOME, '.tarx', 'tarx.db')
const KEY_PATH = join(HOME, '.tarx', '.db_key')
const STATUS_DIR = join(HOME, '.tarx', 'maintenance')
const ARCHIVE_DIR = join(STATUS_DIR, 'archive')
const BRIDGE_HEALTH = process.env.TARX_BRIDGE_HEALTH_URL || 'http://127.0.0.1:11440/health'

const BUDGETS = {
  time_ms: Number(process.env.TARX_MAINT_TIME_MS || 8_000),
  io_bytes: Number(process.env.TARX_MAINT_IO_BYTES || 32 * 1024 * 1024),
  wal_max_bytes: Number(process.env.TARX_MAINT_WAL_MAX_BYTES || 32 * 1024 * 1024),
  wal_min_bytes: Number(process.env.TARX_MAINT_WAL_MIN_BYTES || 8 * 1024 * 1024),
  free_bytes: Number(process.env.TARX_MAINT_FREE_BYTES || 1024 * 1024 * 1024),
  health_ms: Number(process.env.TARX_MAINT_HEALTH_MS || 80),
  load_ratio: Number(process.env.TARX_MAINT_LOAD_RATIO || 0.8),
  archive_batch: Number(process.env.TARX_MAINT_ARCHIVE_BATCH || 250),
  checkpoint_retries: Number(process.env.TARX_MAINT_CHECKPOINT_RETRIES || 3),
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function nowIso() {
  return new Date().toISOString()
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function fileBytes(path) {
  try { return statSync(path).size } catch { return 0 }
}

function volumeFreeBytes(path) {
  try {
    const { spawnSync } = require('node:child_process')
    const result = spawnSync('/bin/df', ['-k', path], { encoding: 'utf8' })
    const line = String(result.stdout || '').trim().split('\n')[1] || ''
    const parts = line.split(/\s+/)
    return Number(parts[3] || 0) * 1024
  } catch {
    return freemem()
  }
}

function loadNative() {
  if (!Database) {
    throw new Error('sqlite_native_module_missing')
  }
  return Database
}

function readKey() {
  if (process.env.TARX_DB_KEY && process.env.TARX_DB_KEY.length >= 32) return process.env.TARX_DB_KEY
  try {
    const key = readFileSync(KEY_PATH, 'utf8').trim()
    return key.length >= 32 ? key : ''
  } catch {
    return ''
  }
}

function isEncrypted(dbPath) {
  if (!existsSync(dbPath)) return false
  const fd = openSync(dbPath, 'r')
  const buf = Buffer.alloc(16)
  readSync(fd, buf, 0, 16, 0)
  closeSync(fd)
  return buf.toString('ascii', 0, 15) !== 'SQLite format 3'
}

function openDb(dbPath, { readonly = true } = {}) {
  const Native = loadNative()
  const db = new Native(dbPath, { readonly, fileMustExist: existsSync(dbPath) })
  const key = readKey()
  if (key && (isEncrypted(dbPath) || !readonly)) {
    db.pragma("cipher='sqlcipher'")
    db.pragma('legacy=4')
    db.pragma(`key='${key}'`)
  }
  if (readonly) db.pragma('query_only = ON')
  db.pragma('busy_timeout = 250')
  if (!readonly) {
    db.pragma('journal_mode = WAL')
    // P0 overnight 2026-10-04: never leave autocheckpoint at 0 — that froze the
    // machine when WAL grew to tens of GB under Bridge writers. 1000 pages ≈ 4MB.
    db.pragma('wal_autocheckpoint = 1000')
  }
  return db
}

async function bridgeHealth() {
  if (process.env.TARX_MAINT_SKIP_BRIDGE_IDLE === '1') {
    return { ok: true, ms: 0, skipped: true }
  }
  const started = Date.now()
  try {
    const response = await fetch(BRIDGE_HEALTH, { signal: AbortSignal.timeout(BUDGETS.health_ms + 200) })
    return { ok: response.ok, ms: Date.now() - started, skipped: false }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, skipped: false, error: String(error.name || error).slice(0, 80) }
  }
}

function loadState() {
  const ncpu = Math.max(1, cpus().length)
  const load = loadavg()[0]
  return {
    ncpu,
    load_1m: Math.round(load * 100) / 100,
    load_ratio: load / ncpu,
    mem_free_bytes: freemem(),
    mem_total_bytes: totalmem(),
  }
}

function inspectPaths(dbPath) {
  return {
    db_bytes: fileBytes(dbPath),
    wal_bytes: fileBytes(`${dbPath}-wal`),
    shm_bytes: fileBytes(`${dbPath}-shm`),
    free_bytes: volumeFreeBytes(dbPath),
  }
}

function inspectSqlite(dbPath) {
  const db = openDb(dbPath, { readonly: true })
  try {
    const pageCount = Number(db.pragma('page_count', { simple: true }))
    const pageSize = Number(db.pragma('page_size', { simple: true }))
    const journal = String(db.pragma('journal_mode', { simple: true }))
    let seq = null
    let minRow = null
    let maxRow = null
    try { seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'tarx_events'`).get() } catch { /* optional */ }
    try {
      minRow = db.prepare(`SELECT created_at FROM tarx_events ORDER BY created_at ASC LIMIT 1`).get()
      maxRow = db.prepare(`SELECT created_at FROM tarx_events ORDER BY created_at DESC LIMIT 1`).get()
    } catch { /* optional */ }
    return {
      page_count: pageCount,
      page_size: pageSize,
      logical_bytes: pageCount * pageSize,
      journal_mode: journal,
      tarx_events_sqlite_sequence: seq ? Number(seq.seq) : null,
      events_created_at_min: minRow ? Number(minRow.created_at) : null,
      events_created_at_max: maxRow ? Number(maxRow.created_at) : null,
    }
  } finally {
    db.close()
  }
}

function decide(inspect, health, machine) {
  const held = []
  if (!health.ok && !health.skipped) held.push('bridge_not_idle')
  if (!health.skipped && health.ms > BUDGETS.health_ms) held.push('bridge_health_slow')
  if (machine.load_ratio > BUDGETS.load_ratio) held.push('interactive_load')
  if (inspect.free_bytes < BUDGETS.free_bytes) held.push('free_space_low')
  if (inspect.wal_bytes < BUDGETS.wal_min_bytes) held.push('wal_below_min')
  if (inspect.wal_bytes > inspect.free_bytes / 2) held.push('wal_exceeds_half_free_space')
  // Advisory only — large WAL must NOT block checkpoint (2026-10-04 freeze).
  if (inspect.wal_bytes > BUDGETS.wal_max_bytes) held.push('wal_over_io_budget_advisory')

  // Hard blocks for checkpoint. wal_over_io_budget_advisory is intentionally absent.
  // wal_exceeds_half_free_space still blocks (copy risk); ops can TRUNCATE manually.
  const checkpointBlocks = new Set([
    'bridge_not_idle',
    'bridge_health_slow',
    'interactive_load',
    'free_space_low',
    'wal_below_min',
    'wal_exceeds_half_free_space',
  ])
  return {
    checkpoint_allowed: !held.some((r) => checkpointBlocks.has(r)),
    archive_allowed: !held.includes('bridge_not_idle') && !held.includes('interactive_load'),
    held_reasons: held,
  }
}

function metadataStatus(extra = {}) {
  return {
    schema: 'tarx.db_maintenance.v1',
    at: nowIso(),
    mutated: false,
    deletion_held: true,
    budgets: BUDGETS,
    privacy: 'metadata_only_no_prompt_response_memory_tool_io_credentials_or_paths',
    ...extra,
  }
}

function writeStatus(status, outDir = STATUS_DIR) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const latest = join(outDir, 'latest.json')
  writeFileSync(latest, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  appendFileSync(join(outDir, 'history.jsonl'), `${JSON.stringify(status)}\n`)
  return latest
}

async function emitTelemetry(status) {
  const key = process.env.DD_API_KEY || (() => {
    try { return readFileSync(join(HOME, '.tarx', '.dd_api_key'), 'utf8').trim() } catch { return '' }
  })()
  if (!key || process.env.TARX_MAINT_TELEMETRY === '0') return { attempted: false }
  const site = process.env.DD_SITE || 'us5.datadoghq.com'
  const ts = Math.floor(Date.now() / 1000)
  const tags = [
    'service:tarx-db-maintenance',
    'env:local',
    `status:${status.decision?.checkpoint_allowed ? 'allowed' : 'held'}`,
    `mutated:${status.mutated ? '1' : '0'}`,
  ]
  const series = [
    { metric: 'tarx.db.wal_bytes', type: 0, points: [{ timestamp: ts, value: Number(status.inspect?.wal_bytes || 0) }], tags },
    { metric: 'tarx.db.maintenance.held', type: 0, points: [{ timestamp: ts, value: status.decision?.checkpoint_allowed ? 0 : 1 }], tags },
    { metric: 'tarx.db.maintenance.duration_ms', type: 0, points: [{ timestamp: ts, value: Number(status.duration_ms || 0) }], tags },
  ]
  try {
    const response = await fetch(`https://api.${site}/api/v2/series`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'DD-API-KEY': key },
      body: JSON.stringify({ series }),
      signal: AbortSignal.timeout(4000),
    })
    return { attempted: true, accepted: response.ok, status: response.status, site }
  } catch (error) {
    return { attempted: true, accepted: false, error: String(error.name || error).slice(0, 80) }
  }
}

function archiveEvents(dbPath, outDir, started) {
  const db = openDb(dbPath, { readonly: true })
  const batch = []
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const rows = db.prepare(`
      SELECT id, ts, category, message, data, created_at
      FROM tarx_events
      WHERE created_at < ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(cutoff, BUDGETS.archive_batch)
    for (const row of rows) {
      if (Date.now() - started > BUDGETS.time_ms / 2) break
      batch.push({
        id: row.id,
        ts: row.ts,
        category: row.category,
        created_at: row.created_at,
        message_sha256: sha256(row.message),
        data_sha256: sha256(row.data),
        bytes: Buffer.byteLength(String(row.message || '')) + Buffer.byteLength(String(row.data || '')),
      })
    }
  } finally {
    db.close()
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const stamp = nowIso().replace(/[:.]/g, '-')
  const jsonlPath = join(outDir, `events-${stamp}.jsonl`)
  const body = batch.map((row) => JSON.stringify(row)).join('\n') + (batch.length ? '\n' : '')
  writeFileSync(jsonlPath, body, { mode: 0o600 })
  const digest = sha256(body)
  const manifestRow = {
    schema: 'tarx.event_archive_manifest.v1',
    at: nowIso(),
    count: batch.length,
    first_id: batch[0]?.id ?? null,
    last_id: batch[batch.length - 1]?.id ?? null,
    jsonl_sha256: digest,
    deletion_held: true,
    independent_verify: null,
  }
  const verifyDb = openDb(dbPath, { readonly: true })
  try {
    let matched = 0
    const lookup = verifyDb.prepare(`SELECT message, data FROM tarx_events WHERE id = ?`)
    for (const row of batch) {
      const live = lookup.get(row.id)
      if (!live) continue
      if (sha256(live.message) === row.message_sha256 && sha256(live.data) === row.data_sha256) matched += 1
    }
    manifestRow.independent_verify = {
      hashed_rows: batch.length,
      live_matches: matched,
      ok: matched === batch.length,
    }
  } finally {
    verifyDb.close()
  }
  appendFileSync(join(outDir, 'manifest.jsonl'), `${JSON.stringify(manifestRow)}\n`)
  return { ...manifestRow, jsonl_bytes: Buffer.byteLength(body) }
}

function checkpointPassive(dbPath, started) {
  const walBefore = fileBytes(`${dbPath}-wal`)
  // Skip full WAL file backup when over I/O budget (can be hundreds of MB–GB).
  // Still attempt checkpoint — refusing here was the 2026-10-04 catch-22.
  const backup = `${dbPath}-wal.bak-${Date.now()}`
  let backupStatus = 'skipped_over_io_budget'
  if (walBefore > 0 && walBefore <= BUDGETS.io_bytes) {
    writeFileSync(backup, readFileSync(`${dbPath}-wal`))
    backupStatus = 'present'
  }
  const db = openDb(dbPath, { readonly: false })
  let last = null
  let attempts = 0
  let mode = 'PASSIVE'
  try {
    for (let i = 0; i < BUDGETS.checkpoint_retries; i += 1) {
      if (Date.now() - started > BUDGETS.time_ms) break
      attempts += 1
      const rows = db.pragma('wal_checkpoint(PASSIVE)')
      last = rows?.[0] || rows
    }
    // If PASSIVE left a large WAL, try TRUNCATE once (requires quiet readers).
    const mid = fileBytes(`${dbPath}-wal`)
    if (mid > BUDGETS.wal_max_bytes && Date.now() - started < BUDGETS.time_ms) {
      mode = 'PASSIVE+TRUNCATE'
      attempts += 1
      const rows = db.pragma('wal_checkpoint(TRUNCATE)')
      last = rows?.[0] || rows
    }
  } finally {
    db.close()
  }
  return {
    attempted: true,
    mode,
    attempts,
    result: last,
    wal_before: walBefore,
    wal_after: fileBytes(`${dbPath}-wal`),
    rollback_wal: backupStatus,
  }
}

async function inspect(dbPath) {
  const started = Date.now()
  const paths = inspectPaths(dbPath)
  const sqlite = inspectSqlite(dbPath)
  const health = await bridgeHealth()
  const machine = loadState()
  const decision = decide({ ...paths }, health, machine)
  return metadataStatus({
    mode: 'inspect',
    duration_ms: Date.now() - started,
    inspect: { ...paths, ...sqlite },
    health,
    machine,
    decision,
    live_checkpoint: 'not_attempted',
  })
}

async function run(dbPath, { mutate = false, statusDir = STATUS_DIR, archiveDir = ARCHIVE_DIR } = {}) {
  const started = Date.now()
  const before = await inspect(dbPath)
  let archive = null
  let checkpoint = { attempted: false, held: 'not_requested' }
  if (before.decision.archive_allowed) {
    archive = archiveEvents(dbPath, archiveDir, started)
  }
  if (mutate && before.decision.checkpoint_allowed) {
    checkpoint = checkpointPassive(dbPath, started)
  } else if (mutate) {
    checkpoint = { attempted: false, held: before.decision.held_reasons.join(',') || 'budgets_blocked' }
  }
  const afterPaths = inspectPaths(dbPath)
  const status = metadataStatus({
    mode: 'run',
    duration_ms: Date.now() - started,
    inspect: before.inspect,
    health: before.health,
    machine: before.machine,
    decision: before.decision,
    archive,
    checkpoint,
    after: afterPaths,
    mutated: Boolean(checkpoint.attempted),
  })
  writeStatus(status, statusDir)
  status.datadog = await emitTelemetry(status)
  return status
}

async function main() {
  const mode = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'inspect'
  const dbPath = arg('--db', process.env.TARX_DB_PATH || DEFAULT_DB)
  const mutate = hasFlag('--mutate')
  const statusDir = arg('--status-dir', STATUS_DIR)
  const archiveDir = arg('--archive-dir', ARCHIVE_DIR)
  mkdirSync(statusDir, { recursive: true, mode: 0o700 })

  if (mode === 'inspect') {
    const status = await inspect(dbPath)
    writeStatus(status, statusDir)
    console.log(JSON.stringify(status, null, 2))
    process.exit(0)
  }

  if (mode === 'run') {
    const status = await run(dbPath, { mutate, statusDir, archiveDir })
    console.log(JSON.stringify(status, null, 2))
    process.exit(status.decision ? 0 : 1)
  }

  console.error('usage: tarx-db-maintenance.mjs inspect|run [--db PATH] [--mutate] [--status-dir DIR] [--archive-dir DIR]')
  process.exit(2)
}

const isMain = Boolean(process.argv[1] && process.argv[1].includes('tarx-db-maintenance.mjs'))
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 200) }))
    process.exit(1)
  })
}

export { inspect, run, BUDGETS, archiveEvents, checkpointPassive, decide }
