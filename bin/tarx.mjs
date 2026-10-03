#!/usr/bin/env node
// TARX CLI — executable entry point
// Runs src/cli.ts directly via Node's built-in TypeScript strip-types.
// Requires Node 22.6+ (--experimental-strip-types) or Node 23+ (stable).
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '../src/cli.ts')

// Re-invoke with --experimental-strip-types if not already set
if (!process.execArgv.includes('--experimental-strip-types') &&
    !process.execArgv.includes('--strip-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 0)
} else {
  await import(cliPath)
}
