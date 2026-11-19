/**
 * Opt-in Bend 2 job adapter for the daemon coordinator.
 * Off by default (TARX_BEND_JOBS=1). Not on the inference or gateway path.
 */
import {createBendJobExecutor, BEND_JOB_KIND, type BendJobOptions} from "../../../runtime/tarx-bend-job.ts"
import type {TaskExecutor} from "../coordinator.ts"

export {BEND_JOB_KIND}

export function createBendJobAdapter(options: BendJobOptions = {}): TaskExecutor {
  const executor = createBendJobExecutor(options)
  return {
    execute(task, context) {
      return executor.execute(task, context)
    },
  }
}
