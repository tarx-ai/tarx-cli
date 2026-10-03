/**
 * TARX CLI — Render Engine
 * Handles all terminal output: header, status bar, action menu, colored blocks.
 * Designed to mirror the Grok build UX — structured, fast, information-dense.
 */

import chalk from 'chalk'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// ── Types ────────────────────────────────────────────────────────────────────

export type ServiceStatus = {
  bridge: 'up' | 'down' | 'unknown'
  mind: 'up' | 'down' | 'unknown'
  cognitive: 'up' | 'down' | 'unknown'
  broker: 'up' | 'down' | 'unknown'
}

export type ActionMenuItem = {
  key: string
  label: string
  dim?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TARX_BLUE   = chalk.hex('#4B8BF5')
const TARX_DIM    = chalk.hex('#666666')
const TARX_WHITE  = chalk.hex('#E8E8E8')
const TARX_GREEN  = chalk.hex('#4ADE80')
const TARX_RED    = chalk.hex('#F87171')
const TARX_YELLOW = chalk.hex('#FBBF24')
const TARX_CYAN   = chalk.hex('#22D3EE')

// ── ASCII Header ──────────────────────────────────────────────────────────────
// Slot for custom TARX ASCII art. Replace TARX_ASCII_ART with your graphic.
// Keep width ≤ 78 chars for universal terminal compatibility.

const TARX_ASCII_ART = `        *****      ******      *****        
       *******     ******     *******       
      ********    ********    ********      
      *********   ********    ********      
     **********  **********  **********     
     ***** ***** ********** ***** *****     
     ***** **********  ********** ******    
    *****  **********  **********  *****    
      **    *********  *********            
            ********    ********            
             ******      ******             
****          ****        ****          ****
****                                    ****
*****                                  *****
 *****                                ***** 
  ******                            ******  
    ******                        ******    
     *******                    *******     
       **********           *********       
          ************************          
              ****************              `

export function printHeader(subtitle?: string, version = '1.0.0') {
  const cols = stdout.columns || 80
  const divider = TARX_DIM('─'.repeat(Math.min(cols, 78)))

  stdout.write('\n')

  // ASCII art — has its own internal spacing, render as-is in white
  for (const line of TARX_ASCII_ART.split('\n')) {
    stdout.write(TARX_WHITE(line) + '\n')
  }

  stdout.write('\n')

  // Tagline: FREE TO THINK · version · Designed in Austin TX.
  const tagline = `FREE TO THINK  ·  v${version}  ·  Designed in Austin TX.`
  const tagPad = Math.max(0, Math.floor((cols - tagline.length) / 2))
  stdout.write(
    ' '.repeat(tagPad) +
    TARX_BLUE('FREE TO THINK') +
    TARX_DIM('  ·  ') +
    TARX_DIM(`v${version}`) +
    TARX_DIM('  ·  ') +
    TARX_DIM('Designed in Austin TX.') +
    '\n'
  )

  if (subtitle) {
    stdout.write('\n')
    const pad = Math.max(0, Math.floor((cols - subtitle.length) / 2))
    stdout.write(' '.repeat(pad) + TARX_DIM(subtitle) + '\n')
  }

  stdout.write('\n' + divider + '\n\n')
}

// ── Status Bar ────────────────────────────────────────────────────────────────

function svcDot(status: 'up' | 'down' | 'unknown') {
  if (status === 'up')      return TARX_GREEN('●')
  if (status === 'down')    return TARX_RED('●')
  return TARX_DIM('○')
}

export function printStatusBar(services: ServiceStatus) {
  const parts = [
    `${svcDot(services.bridge)} Bridge`,
    `${svcDot(services.mind)} Mind`,
    `${svcDot(services.cognitive)} Cognitive`,
    `${svcDot(services.broker)} Supercomputer`,
  ]
  stdout.write(TARX_DIM('  ') + parts.join(TARX_DIM('  ·  ')) + '\n\n')
}

// ── Action Menu ───────────────────────────────────────────────────────────────

export function printActionMenu(items: ActionMenuItem[]) {
  const rendered = items.map(({ key, label, dim }) => {
    const bracket = TARX_DIM('[') + TARX_WHITE(key) + TARX_DIM(']')
    const text = dim ? TARX_DIM(label) : TARX_WHITE(label)
    return `${bracket} ${text}`
  })
  stdout.write('  ' + rendered.join('   ') + '\n\n')
}

// ── Section blocks ────────────────────────────────────────────────────────────

export function printTask(task: string, repo?: string) {
  stdout.write(TARX_CYAN('  Task  ') + TARX_WHITE(task) + '\n')
  if (repo) stdout.write(TARX_DIM('  Repo  ') + TARX_DIM(repo) + '\n')
  stdout.write('\n')
}

export function printPlanBlock(plan: string) {
  stdout.write(TARX_BLUE('  ▸ Plan\n'))
  for (const line of plan.split('\n')) {
    stdout.write(TARX_DIM('    ') + TARX_WHITE(line) + '\n')
  }
  stdout.write('\n')
}

export function printFileList(label: string, files: string[]) {
  stdout.write(TARX_DIM(`  ${label}\n`))
  for (const f of files) {
    stdout.write(TARX_DIM('    ✓ ') + TARX_WHITE(f) + '\n')
  }
  stdout.write('\n')
}

export function printDiffBlock(diff: string) {
  stdout.write(TARX_BLUE('  ▸ Diff\n'))
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      stdout.write(TARX_GREEN('    ' + line) + '\n')
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      stdout.write(TARX_RED('    ' + line) + '\n')
    } else if (line.startsWith('@@')) {
      stdout.write(TARX_CYAN('    ' + line) + '\n')
    } else {
      stdout.write(TARX_DIM('    ' + line) + '\n')
    }
  }
  stdout.write('\n')
}

export function printSuccess(msg: string) {
  stdout.write(TARX_GREEN('  ✓ ') + TARX_WHITE(msg) + '\n')
}

export function printError(msg: string) {
  stdout.write(TARX_RED('  ✗ ') + TARX_WHITE(msg) + '\n')
}

export function printInfo(msg: string) {
  stdout.write(TARX_DIM('  · ') + TARX_DIM(msg) + '\n')
}

export function printSpinner(msg: string) {
  stdout.write(TARX_YELLOW('  ⟳ ') + TARX_DIM(msg) + '\n')
}

export function printDivider() {
  const cols = stdout.columns || 80
  stdout.write(TARX_DIM('  ' + '─'.repeat(Math.min(cols - 4, 74))) + '\n\n')
}

// ── Prompt ────────────────────────────────────────────────────────────────────
// Returns a function that shows a structured prompt with visible options.

export function makePrompt() {
  const rl = createInterface({ input: stdin, output: stdout })

  async function ask(question: string, options?: string[]): Promise<string> {
    const optStr = options ? TARX_DIM(' [') + options.map((o, i) =>
      i === 0 ? TARX_WHITE(o) : TARX_DIM(o)
    ).join(TARX_DIM('/')) + TARX_DIM('] ') : ' '
    const prompt = '\n' + TARX_BLUE('  ▸ ') + TARX_WHITE(question) + optStr + TARX_BLUE('▌ ')
    const answer = await rl.question(prompt)
    stdout.write('\n')
    return answer.trim()
  }

  function close() {
    rl.close()
  }

  return { ask, close }
}

// ── Output handler ────────────────────────────────────────────────────────────
// Pass to terminal-builder as the `output` callback.
// Parses structured markers from terminal-builder output and renders them.

export function makeOutputHandler() {
  return (text: string) => {
    // Detect plan header
    if (text.match(/^=+ Plan =+$/i) || text.match(/^Plan:/i)) {
      printDivider()
      stdout.write(TARX_BLUE('  ▸ Plan\n\n'))
      return
    }
    // Detect file list lines
    if (text.match(/^\s*(✓|•|\*)\s+\S+\.(ts|tsx|js|py|md|json|css)/)) {
      stdout.write(TARX_DIM('    ✓ ') + TARX_WHITE(text.trim().replace(/^[✓•*]\s*/, '')) + '\n')
      return
    }
    // Detect diff lines
    if (text.match(/^[+-]{3}\s/) || text.match(/^@@\s/)) {
      if (text.startsWith('+')) stdout.write(TARX_GREEN('    ' + text) + '\n')
      else if (text.startsWith('-')) stdout.write(TARX_RED('    ' + text) + '\n')
      else stdout.write(TARX_CYAN('    ' + text) + '\n')
      return
    }
    // Detect success lines
    if (text.match(/^(Applied|Committed|Done|Success|✓)/i)) {
      stdout.write(TARX_GREEN('  ✓ ') + TARX_WHITE(text) + '\n')
      return
    }
    // Detect error lines
    if (text.match(/^(Error|Failed|✗|Rejected)/i)) {
      stdout.write(TARX_RED('  ✗ ') + TARX_WHITE(text) + '\n')
      return
    }
    // Default: dim info line
    stdout.write(TARX_DIM('  · ') + TARX_WHITE(text) + '\n')
  }
}
