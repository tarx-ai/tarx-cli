import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import test from "node:test"

import {DaemonError} from "../src/errors.ts"
import {acquireDaemonLock} from "../src/lock.ts"

test("the lock is exclusive and clean release reopens it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-lock-"))
  try {
    const first = await acquireDaemonLock(directory)
    await assert.rejects(acquireDaemonLock(directory), (error) => error instanceof DaemonError && error.code === "daemon_already_running")
    await first.release()
    const second = await acquireDaemonLock(directory)
    await second.release()
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})

test("SIGKILL releases the exclusive lock so the next daemon can recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-lock-crash-"))
  const holder = join(directory, "holder.ts")
  const lockModule = pathToFileURL(fileURLToPath(new URL("../src/lock.ts", import.meta.url))).href
  await writeFile(holder, `import {acquireDaemonLock} from ${JSON.stringify(lockModule)}\nconst lock=await acquireDaemonLock(process.argv[2])\nconsole.log('LOCKED')\nsetInterval(()=>{},1000)\nawait new Promise(()=>{})\n`)
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", holder, directory], {stdio: ["ignore", "pipe", "pipe"]})
    let output = ""
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    const deadline = Date.now() + 5_000
    while (!output.includes("LOCKED") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.match(output, /LOCKED/)
    child.kill("SIGKILL")
    await once(child, "exit")
    let lock: Awaited<ReturnType<typeof acquireDaemonLock>> | null = null
    for (let attempt = 0; attempt < 20 && !lock; attempt += 1) {
      try {
        lock = await acquireDaemonLock(directory)
      } catch (error) {
        if (!(error instanceof DaemonError) || error.code !== "daemon_already_running" || attempt === 19) throw error
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.ok(lock)
    await lock.release()
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
