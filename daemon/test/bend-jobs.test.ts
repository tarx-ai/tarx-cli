import assert from "node:assert/strict"
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {createBendJobAdapter, BEND_JOB_KIND} from "../src/adapters/bend-jobs.ts"
import {createCoordinator} from "../src/coordinator.ts"
import {createDaemonStore} from "../src/store.ts"

const OWNER = "tvs_" + "b".repeat(32)
const INSTALL = "install_" + "c".repeat(48)
const CHANNEL = "channel-agent:bend"
const AGENT = "bend-agent"

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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-bend-"))
  const program = join(directory, "parallel-sum.bend")
  await writeFile(program, "import Base\ndef main() -> IO(Unit):\n  IO.print(\"x\")\n")
  const bend = join(directory, "bend")
  await writeFile(bend, MOCK_BEND, {mode: 0o755})
  await chmod(bend, 0o755)
  const store = createDaemonStore({file: join(directory, "daemon.sqlite")})
  const env = {PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, TMPDIR: directory, TARX_BEND_JOBS: "1", BEND_NO_TELEMETRY: "1"}
  return {directory, program, bend, store, env}
}

test("disabled bend jobs fail closed on the coordinator without replay", async () => {
  const f = await fixture()
  const submitted = f.store.submitTask({
    ownerId: OWNER,
    installId: INSTALL,
    channelId: CHANNEL,
    agentId: AGENT,
    kind: BEND_JOB_KIND,
    request: {program: f.program, backend: "cpu"},
  })
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-bend-off",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: createBendJobAdapter({env: {...f.env, TARX_BEND_JOBS: ""}, bendBin: f.bend}),
    delivery: {async deliver() {}},
  })
  try {
    await coordinator.tick()
    const task = f.store.getTask(submitted.task_id)
    assert.equal(task?.status, "failed")
    assert.equal(task?.error_code, "bend_jobs_disabled")
    assert.equal((await coordinator.tick()).task, null)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})

test("enabled bend jobs complete through the coordinator with captured output", async () => {
  const f = await fixture()
  const submitted = f.store.submitTask({
    ownerId: OWNER,
    installId: INSTALL,
    channelId: CHANNEL,
    agentId: AGENT,
    kind: BEND_JOB_KIND,
    request: {program: f.program, backend: "cpu"},
  })
  const coordinator = createCoordinator({
    store: f.store,
    workerId: "worker-bend-on",
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    executor: createBendJobAdapter({env: f.env, bendBin: f.bend}),
    delivery: {async deliver() {}},
  })
  try {
    const tick = await coordinator.tick()
    assert.equal(tick.task, submitted.task_id)
    const task = f.store.getTask(submitted.task_id)
    assert.equal(task?.status, "completed")
    assert.equal(task?.kind, BEND_JOB_KIND)
    const result = task?.result as {ok?: boolean; stdout?: string; checksum?: string}
    assert.equal(result.ok, true)
    assert.equal(result.stdout, "65536\n")
    assert.equal(typeof result.checksum, "string")
    assert.equal(result.checksum?.length, 64)
  } finally {
    await coordinator.stop()
    f.store.close()
    await rm(f.directory, {recursive: true, force: true})
  }
})
