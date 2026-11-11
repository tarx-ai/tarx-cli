import assert from "node:assert/strict"
import {mkdtemp, rm, stat} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {runDaemon} from "../src/main.ts"

test("once and check acquire, recover, close and release the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarx-daemon-main-"))
  try {
    const first = await runDaemon({stateDirectory: directory, once: true, now: () => 1_000})
    assert.equal(first.ok, true)
    assert.equal((first.stats as any).schema, 1)
    const second = await runDaemon({stateDirectory: directory, check: true, now: () => 2_000})
    assert.equal(second.ok, true)
    assert.equal(second.check, true)
    const file = await stat(join(directory, "daemon.sqlite"))
    assert.equal(file.mode & 0o777, 0o600)
    await assert.rejects(stat(join(directory, ".daemon.lock")), {code: "ENOENT"})
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
