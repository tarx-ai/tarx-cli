# Bounded task dispatch acknowledgements

The existing `read_launch_note` fixture controller now bounds executor preparation and dispatch acknowledgement to 15 seconds per phase (trusted constructor override: 1–30,000 ms). This does not register a new task, grant a permission, start a scheduler, or activate a host service.

Before dispatch intent, a failed/timed-out preparation records a terminal `failed` result and returns `task_preparation_failed` (503). An identical request stays idempotent; a new explicit request can proceed. A late preparation resolution cannot call start.

Once dispatch intent is durable, a start failure or lost/timed-out acknowledgement records `uncertain` and returns `task_outcome_uncertain` (502). The executor may have accepted work. Repeating that request never dispatches again, and another request for that owner/install is blocked while its outcome is unresolved. A late acknowledgement alone cannot manufacture a running/completed result; existing receipt verification remains authoritative.

These are acknowledgement deadlines, not proof of remote cancellation. Existing event reads/recovery, supervised execution, cancellation acknowledgement, installed activation, and real connector acceptance remain separate work. No claim of a completed Always On product follows from this source increment.
