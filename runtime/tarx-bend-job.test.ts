import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdtemp, rm, writeFile, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {
  BEND_JOB_KIND,
  benchBendJob,
  createBendJobExecutor,
  median,
  parseBendJobRequest,
  parseProgramOutput,
  percentile,
  runBendJob,
  runBendJobCli,
} from './tarx-bend-job.ts'

const owned = new Set<string>()
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tarx-bend-job-test-'))
  owned.add(dir)
  return dir
}
test.after(async () => {
  for (const dir of owned) await rm(dir, {recursive: true, force: true})
})

const EXPECTED_STDOUT = '65536\n'
const EXPECTED_CHECKSUM = createHash('sha256').update(EXPECTED_STDOUT).digest('hex')

const MOCK_BEND = `#!/usr/bin/env node
import {chmodSync, writeFileSync} from 'node:fs'
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
if (args.includes('-o') && out) {
  writeFileSync(out, ${JSON.stringify('#!/usr/bin/env node\nprocess.stdout.write("65536\\n")\n')})
  chmodSync(out, 0o755)
  process.exit(0)
}
process.stdout.write('65536\\n')
`

const HANG_BEND = `#!/usr/bin/env node
import {writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
writeFileSync(join(dirname(process.argv[1]), 'pid'), String(process.pid))
setInterval(() => {}, 1000)
`

async function mockBin(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, source, {mode: 0o755})
  await chmod(path, 0o755)
  return path
}

function enabledEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    TMPDIR: dir,
    TARX_BEND_JOBS: '1',
    BEND_NO_TELEMETRY: '1',
    ...extra,
  }
}

async function fixture() {
  const dir = await scratch()
  const program = join(dir, 'parallel-sum.bend')
  await writeFile(program, 'import Base\ndef main() -> IO(Unit):\n  IO.print("unused")\n')
  const bend = await mockBin(dir, 'bend', MOCK_BEND)
  return {dir, program, bend, env: enabledEnv(dir)}
}

test('parseBendJobRequest accepts cpu/metal and rejects extra fields', () => {
  assert.deepEqual(parseBendJobRequest({program: '/tmp/x.bend', backend: 'cpu'}), {ok: true, request: {program: '/tmp/x.bend', backend: 'cpu', timeout_ms: undefined, threads: undefined, depth: undefined}})
  assert.deepEqual(parseBendJobRequest({program: '/tmp/x.bend', backend: 'cpu', depth: 24}), {ok: true, request: {program: '/tmp/x.bend', backend: 'cpu', timeout_ms: undefined, threads: undefined, depth: 24}})
  assert.equal(parseBendJobRequest({program: '/tmp/x.bend', backend: 'cuda'}).ok, false)
  assert.equal(parseBendJobRequest({program: '/tmp/x.bend', backend: 'cpu', extra: 1}).ok, false)
  assert.equal(parseBendJobRequest({program: '/tmp/x.bend', backend: 'cpu', depth: 99}).ok, false)
})

test('flag off refuses a bend job without spawning', async () => {
  const f = await fixture()
  let spawned = 0
  const result = await runBendJob({program: f.program, backend: 'cpu'}, {
    env: enabledEnv(f.dir, {TARX_BEND_JOBS: ''}),
    bendBin: f.bend,
    spawn: async () => { spawned += 1; throw new Error('must not spawn') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bend_jobs_disabled')
  assert.equal(spawned, 0)
})

test('missing binary returns a clear bend_binary_missing error', async () => {
  const f = await fixture()
  const missing = join(f.dir, 'no-such-bend')
  const result = await runBendJob({program: f.program, backend: 'cpu'}, {env: f.env, bendBin: missing})
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bend_binary_missing')
  assert.match(result.detail ?? '', /not found/)
  assert.match(result.detail ?? '', /no-such-bend/)
})

test('timeouts kill the bend process', {timeout: 5000}, async () => {
  const f = await fixture()
  const hang = await mockBin(f.dir, 'hang-bend', HANG_BEND)
  const result = await runBendJob({program: f.program, backend: 'cpu', timeout_ms: 150}, {env: f.env, bendBin: hang})
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bend_timeout')
  assert.equal(result.killed, true)
  const pid = Number((await readFile(join(f.dir, 'pid'), 'utf8')).trim())
  assert.ok(pid > 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH')
})

test('successful mocked run captures stdout and checksum', async () => {
  const f = await fixture()
  const result = await runBendJob({program: f.program, backend: 'cpu'}, {env: f.env, bendBin: f.bend})
  assert.equal(result.ok, true, result.detail)
  assert.equal(result.kind, BEND_JOB_KIND)
  assert.equal(result.backend, 'cpu')
  assert.equal(result.stdout, EXPECTED_STDOUT)
  assert.equal(result.checksum, EXPECTED_CHECKSUM)
  assert.equal(result.killed, false)
  assert.equal(result.exit_code, 0)
})

test('metal is refused on Linux and accepted when the platform is Darwin', async () => {
  const f = await fixture()
  const linux = await runBendJob({program: f.program, backend: 'metal'}, {env: f.env, bendBin: f.bend, platform: 'linux'})
  assert.equal(linux.ok, false)
  assert.equal(linux.error, 'bend_metal_requires_macos')
  const mac = await runBendJob({program: f.program, backend: 'metal'}, {env: f.env, bendBin: f.bend, platform: 'darwin'})
  assert.equal(mac.ok, true, mac.detail)
  assert.equal(mac.backend, 'metal')
  assert.equal(mac.stdout, EXPECTED_STDOUT)
})

test('job executor refuses unknown kinds and disabled bend jobs', async () => {
  const f = await fixture()
  const disabled = createBendJobExecutor({env: enabledEnv(f.dir, {TARX_BEND_JOBS: '0'}), bendBin: f.bend})
  await assert.rejects(
    disabled.execute({kind: BEND_JOB_KIND, request: {program: f.program, backend: 'cpu'}}, {signal: new AbortController().signal}),
    (error: Error & {code?: string}) => error.code === 'bend_jobs_disabled',
  )
  const enabled = createBendJobExecutor({env: f.env, bendBin: f.bend})
  await assert.rejects(
    enabled.execute({kind: 'computer_use', request: {program: f.program, backend: 'cpu'}}, {signal: new AbortController().signal}),
    (error: Error & {code?: string}) => error.code === 'unknown_job_kind',
  )
  const execution = await enabled.execute({kind: BEND_JOB_KIND, request: {program: f.program, backend: 'cpu'}}, {signal: new AbortController().signal})
  assert.equal(execution.result.ok, true)
  assert.equal(execution.delivery.kind, 'result')
  assert.equal(execution.result.checksum, EXPECTED_CHECKSUM)
})

test('bench skips Metal on Linux and reports median/p95 for CPU', async () => {
  const f = await fixture()
  const report = await benchBendJob({program: f.program, backends: ['cpu', 'metal'], n: 3, sizes: [16], options: {env: f.env, bendBin: f.bend, platform: 'linux'}})
  const cpu = report.sizes['16']?.backends.cpu
  assert.equal(cpu?.status, 'ok')
  assert.equal(cpu?.checksum, EXPECTED_CHECKSUM)
  assert.equal(cpu?.wall_runs?.length, 3)
  assert.equal(typeof cpu?.median_wall_ms, 'number')
  assert.equal(typeof cpu?.p95_wall_ms, 'number')
  assert.equal(report.sizes['16']?.backends.metal?.status, 'pending: needs a Mac run')
})

test('checksum uses RESULT and ignores COMPUTE_MS', () => {
  const parsed = parseProgramOutput('RESULT 65536\nCOMPUTE_MS 99\n')
  assert.equal(parsed.result, '65536')
  assert.equal(parsed.compute_ms, 99)
  assert.equal(parsed.checksum, createHash('sha256').update('RESULT 65536\n').digest('hex'))
  const mock = parseProgramOutput('65536\n')
  assert.equal(mock.result, null)
  assert.equal(mock.compute_ms, null)
  assert.equal(mock.checksum, EXPECTED_CHECKSUM)
})

test('percentile helpers match the bench contract', () => {
  assert.equal(median([9, 1, 5]), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 95), 11)
})

test('CLI help does not require the feature flag', async () => {
  const help = await runBendJobCli(['help'], {env: {TARX_BEND_JOBS: ''}})
  assert.equal(help.ok, true)
  assert.equal(help.kind, BEND_JOB_KIND)
})

test('CLI run is refused when the flag is off', async () => {
  const f = await fixture()
  const result = await runBendJobCli(['run', '--program', f.program, '--backend', 'cpu'], {env: enabledEnv(f.dir, {TARX_BEND_JOBS: ''}), bendBin: f.bend})
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bend_jobs_disabled')
})

test('CLI entry prints JSON for help', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./tarx-bend-job.ts', import.meta.url).pathname, 'help'], {encoding: 'utf8'})
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).kind, BEND_JOB_KIND)
})
