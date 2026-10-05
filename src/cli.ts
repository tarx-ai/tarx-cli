#!/usr/bin/env node
/**
 * TARX CLI — Main Entry Point
 *
 * This is the user-facing TARX terminal experience.
 * It wraps the supercomputer terminal-builder engine with:
 *   - TARX ASCII header
 *   - Live service health bar
 *   - Numbered action menu
 *   - Structured colored output
 *   - Visible prompt with option hints
 *
 * Three surfaces, one product:
 *   Web   → tarx.com/chat  — conversational UI, user talks to TARX
 *   CLI   → this           — TARX works in the open, task → plan → diff → apply
 *   Mac   → Electron app   — channel host for Mac-native interactions
 *
 * Usage:
 *   tarx build --task "Fix the auth callback URL"
 *   tarx build --repo /path/to/repo --task "Add health endpoint"
 *   tarx build --plan-only --task "What's the smallest change for X?"
 *   tarx ask "How does channel restore work?"
 *   tarx review
 *   tarx status
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stdout } from 'node:process'

import {
  printHeader,
  printStatusBar,
  printActionMenu,
  printTask,
  printDivider,
  printSuccess,
  printError,
  printInfo,
  printSpinner,
  makePrompt,
  makeOutputHandler,
} from './ui.ts'

import { checkHealth, isHealthy } from './health.ts'

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPERCOMPUTER_CLI = join(
  homedir(),
  'Desktop/TARX/Worktrees/supercomputer-n1-s0/src/builder/terminal-builder.ts'
)

const VERSION = '1.0.0'

// ── Credential loader ─────────────────────────────────────────────────────────

function loadBearer(): string {
  const fromEnv = String(
    process.env.TARX_BUILD_API_KEY || process.env.TARX_EDGE_PROVIDER_BEARER || ''
  ).trim()
  if (fromEnv.length >= 16) return fromEnv
  const path = join(homedir(), '.tarx', 'provider-edge-staging', 'credentials.json')
  if (!existsSync(path)) return ''
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { PROVIDER_BEARER?: string }
    return String(json.PROVIDER_BEARER || '').trim()
  } catch {
    return ''
  }
}

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const [command = 'help', ...rest] = argv.slice(2)
  const opts: Record<string, string | boolean> = { command }
  const positional: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const v = rest[i]
    if (v === '--plan-only') { opts.planOnly = true; continue }
    if (v === '--help' || v === '-h') { opts.help = true; continue }
    if (v === '--yes' || v === '-y') { opts.yes = true; continue }
    if (v === '--task' || v === '--repo' || v === '--max-files') {
      opts[v.replace('--', '').replace('-', '_')] = rest[++i] ?? ''
      continue
    }
    if (!v.startsWith('--')) positional.push(v)
  }

  if (!opts.task && positional.length) opts.task = positional.join(' ')
  if (!opts.repo) opts.repo = process.cwd()
  if (!opts.max_files) opts.max_files = '4'

  return opts
}

// ── Status command ────────────────────────────────────────────────────────────

async function statusCommand() {
  printHeader('Sovereign AI — Service Status')
  printSpinner('Checking services...')

  const health = await checkHealth()
  printStatusBar(health)

  if (isHealthy(health)) {
    printSuccess('All core services are UP. TARX is ready.')
  } else {
    printError('One or more services are DOWN. Run: launchctl start com.tarx.bridge')
  }

  printDivider()
  printInfo('Bridge   http://localhost:11440/health')
  printInfo('Mind     http://localhost:11435/health')
  printInfo('Cognitive http://localhost:11438/health')
  printInfo('Broker   https://howdy-a3f.workers.dev/health')
  stdout.write('\n')
}

// ── Build command ─────────────────────────────────────────────────────────────

async function buildCommand(opts: Record<string, string | boolean>) {
  if (opts.help) { printHelp(); return }
  const task = String(opts.task || '').trim()
  const repo = String(opts.repo || process.cwd())
  const planOnly = Boolean(opts.planOnly)
  const maxFiles = Math.min(8, Math.max(1, Number(opts.max_files) || 4))

  if (!task) {
    printError('No task specified. Use: tarx build --task "describe the task"')
    process.exit(1)
  }

  // Header + health check
  printHeader('Sovereign AI — Build')
  printSpinner('Checking services...')
  const health = await checkHealth()
  printStatusBar(health)

  if (!isHealthy(health)) {
    printError('Bridge or Mind is DOWN. Cannot build. Check: tarx status')
    process.exit(1)
  }

  printActionMenu([
    { key: '1', label: 'Plan' },
    { key: '2', label: 'Diff' },
    { key: '3', label: 'Apply' },
    { key: '4', label: 'Ask' },
    { key: 'q', label: 'Quit', dim: true },
  ])

  printTask(task, repo)
  printDivider()

  // Load bearer
  const bearer = loadBearer()
  if (!bearer) {
    printError('No TARX bearer token found. Expected at ~/.tarx/provider-edge-staging/credentials.json')
    process.exit(1)
  }

  // Check terminal-builder exists
  if (!existsSync(SUPERCOMPUTER_CLI)) {
    printError(`terminal-builder not found at: ${SUPERCOMPUTER_CLI}`)
    printInfo('Expected the supercomputer-n1-s0 worktree at ~/Desktop/TARX/Worktrees/supercomputer-n1-s0')
    process.exit(1)
  }

  // Dynamically import the terminal-builder engine
  const { runTerminalBuild } = await import(
    join(homedir(), 'Desktop/TARX/Worktrees/supercomputer-n1-s0/src/builder/terminal-builder.ts')
  ) as { runTerminalBuild: Function }

  const prompt = makePrompt()
  const output = makeOutputHandler()

  try {
    await runTerminalBuild({
      cwd: repo,
      task,
      planOnly,
      maxFiles,
      bearer,
      output,
      input: opts.yes
        ? async (_: string) => 'yes'
        : (question: string) => prompt.ask(question, ['y', 'n', 'edit']),
    })

    printDivider()
    printSuccess(planOnly ? 'Plan complete.' : 'Build complete.')
    stdout.write('\n')
  } finally {
    prompt.close()
  }
}

// ── Ask / Review commands ─────────────────────────────────────────────────────

async function inquiryCommand(mode: 'ask' | 'review', opts: Record<string, string | boolean>) {
  const task = String(opts.task || '').trim() ||
    (mode === 'review' ? 'Review the current changes for actionable defects.' : '')

  if (!task && mode === 'ask') {
    printError('No question specified. Use: tarx ask "your question"')
    process.exit(1)
  }

  printHeader(mode === 'ask' ? 'Sovereign AI — Ask' : 'Sovereign AI — Review')
  printSpinner('Checking services...')
  const health = await checkHealth()
  printStatusBar(health)

  printTask(task, String(opts.repo || process.cwd()))
  printDivider()

  const bearer = loadBearer()
  if (!bearer) {
    printError('No TARX bearer token found.')
    process.exit(1)
  }

  const { runTerminalInquiry } = await import(
    join(homedir(), 'Desktop/TARX/Worktrees/supercomputer-n1-s0/src/builder/terminal-builder.ts')
  ) as { runTerminalInquiry: Function }

  const prompt = makePrompt()
  const output = makeOutputHandler()

  try {
    await runTerminalInquiry({
      mode,
      cwd: String(opts.repo || process.cwd()),
      task,
      bearer,
      output,
      input: (question: string) => prompt.ask(question, ['y', 'n']),
    })
    printDivider()
    printSuccess('Done.')
    stdout.write('\n')
  } finally {
    prompt.close()
  }
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  printHeader(`Sovereign AI — v${VERSION}`)
  stdout.write([
    '  Commands:\n',
    '    tarx build --task "..."         Plan → diff → apply a coding task\n',
    '    tarx build --plan-only --task   Plan only, no diff\n',
    '    tarx ask "question"             Read-only repo Q&A\n',
    '    tarx review                     Review current git diff\n',
    '    tarx status                     Check all service health\n',
    '\n',
    '  Options:\n',
    '    --repo PATH       Target git repo (default: cwd)\n',
    '    --task TEXT       Task description\n',
    '    --plan-only       Plan only, skip diff/apply\n',
    '    --max-files N     Max files in plan, 1-8 (default: 4)\n',
    '    --yes             Auto-approve all prompts\n',
    '\n',
    '  Two TARX CLIs (do not confuse):\n',
    '    • This Node flywheel CLI (tarx.mjs): build / ask / review / status.\n',
    '    • PATH shell CLI (~/.tarx/bin/tarx v1.1.0): presence/status/doctor/mcp\n',
    '      — it has NO "build". For planning always run this Node entrypoint:\n',
    '      node bin/tarx.mjs build --plan-only --task "..."\n',
    '\n',
  ].join(''))
}

// ── Main ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv)

switch (String(opts.command)) {
  case 'build':
    await buildCommand(opts)
    break
  case 'ask':
    await inquiryCommand('ask', opts)
    break
  case 'review':
    await inquiryCommand('review', opts)
    break
  case 'status':
  case 'build-status':
    await statusCommand()
    break
  case 'help':
  case '--help':
  case '-h':
  default:
    printHelp()
}
