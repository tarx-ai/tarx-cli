# Channel computer tasks

The paired runtime accepts `computer_use` through the existing local browser
bridge. It is unavailable unless a trusted desktop host supplies a computer
controller and verified native artifacts. Normal runtime entrypoints do not
activate it.

A task carries a request ID, channel ID, agent ID, approved session ID, goal and
optional context. It never carries executable/model paths, native refs, success
checks or approval flags. The native host separately supplies consent bound to
that exact request intent, identity, installation, window, deadline and step cap.
Pairing alone grants no computer session.

The controller reserves one computer task per installation in the existing
private task ledger. Repeated request IDs recover the existing result; uncertain
runs never replay. Raw goals, context, credentials and accessibility trees are not
stored in this ledger. Stop, revocation, expiry or changed consent abort execution.

After loss of the in-memory owner, a persisted `cancelling` record without matching
execution-exit proof remains held.
Repeating its request returns `computer_outcome_uncertain`, with no completion
receipt, observation or action replay. Neither an existing nor a missing grant
proves that the previous worker exited. The controller does not erase Stop intent
or free the installation lease on that assumption. Cleanup grace expiry also
preserves Stop intent instead of downgrading it to ordinary uncertain recovery.
Without confirmed owned cleanup this can hold indefinitely. There is no PID-based
or operator-state inference. A still-owned execution that fulfills after grace
expiry can record its actual exit and resolve Stop without a completion receipt.
Orphaned-worker reconciliation and full daemon crash recovery remain separate work.

Lost authority before or during read-only recovery also retains an uncertain
installation lease. Finishing an observer proves only that observer's cleanup;
it does not prove the original execution worker exited. If Stop was persisted,
recovery keeps `cancelling` instead. No completion or cancellation receipt is
inferred from permission loss. A live owner whose actual executor resolves still
uses its normal cancellation settlement. Independent observation success requires
matching original execution-exit proof; full ownership reconciliation remains
unaccepted.
Unverified, denied, error, cancelled or malformed observer results also retain
the lease; those verdicts do not prove the original execution worker exited.

Execution-exit proof is private metadata in the existing task ledger, bound to
the subject, installation, request, native session, channel, agent, intent hash
and core source. Only fulfillment of the trusted execution promise writes it.
The native executor fulfills only after its child and native-host cleanup end;
rejection or proof-publication failure leaves exit unconfirmed. Observation,
health, timeout and model output cannot create proof. Completion checks proof in
the same ledger transaction that publishes the receipt. A proof-backed Stop can
settle after reopening without replaying work. Proof is neither consent nor a
billing record and is not exposed in public task replies. Legacy nonterminal
rows without proof stay unconfirmed; existing terminal receipts remain readable.
This assumes the existing private-ledger trust boundary, not hostile same-UID
filesystem isolation. A crash before proof publication can still retain a lease.
The native proof covers the worker leader's close and the known private native
host cleanup. It does not establish exit of escaped or inaccessible descendants.

The native executor verifies artifact hashes, runs one isolated worker, observes
fresh native refs and checks the approved window before each click. It enforces
the core action policy and an explicit native action scope. Each run closes its
owned worker, adapter descendants and private macOS command host. Completion
requires fresh independent checks and a channel-bound metadata receipt.

`deterministic_actuator` and `local_model` are distinct receipt modes. Passing a
deterministic native case does not accept the autonomous planner. This source
adds no scheduler, persistent daemon, model activation or automatic consent.
The desktop consent UI, artifact/model integration and autonomous planner
acceptance remain separate release requirements.

The optional native cursor uses the hash-checked canonical 32px TARX shape, with
only eyes at this size. A private no-trace adapter session owns it. Rendering is
acknowledged by the adapter; the worker and parent both end their owned session.
It is presentation only and neither moves the user's OS pointer nor grants access.

The local planner receives only currently approved native controls with their
original refs. Browser chrome cannot consume its observation budget. Its compact
structured choice is parsed strictly and still passes through core policy. The
local MLX/Qwen client disables thinking for this request only; no model/profile
or service setting is modified. A model response before any delivered action
cannot establish completion.

Canonical Supercomputer planning uses the distinct `supercomputer` mode. The
native scope must record consent for the explicit goal and approved control
labels. No endpoint or credential is accepted in that scope. The trusted host
uses the existing identity-only CLI introspector on one loaded account token;
its verified subject must match the native grant. The executor passes only that
per-run token to its owned child over IPC, outside the environment, ledger,
scope, grant, renderer and receipt. Recovery never loads account access or calls
a model. The canonical transport has no service-key or local-provider fallback.

Only the approved goal and current scoped controls are sent to the canonical
route. Additional context, core history and native dialog titles are withheld.
`model_calls` counts received generation responses, not provider attempts,
account quota, token billing or monetary charges. Interrupted totals can remain
unknown. The receipt is not an invoice. Default desktop producer/host wiring,
explicit native data consent and a real account/native run remain acceptance
gates; this source does not switch product routing or activate a host.
