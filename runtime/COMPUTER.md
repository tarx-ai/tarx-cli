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
