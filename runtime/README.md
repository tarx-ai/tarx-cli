# Optional local connection runtime

Install with `tarx runtime install` after installing Node.js24 or newer. The ordinary CLI install remains independent of Node.

The runtime package uses Eve0.83.2 and a lockfile. Setup resolves one GitHub source commit, validates the source archive, installs dependencies with lifecycle scripts disabled, and atomically activates the completed version. It does not start or register a background service, worker or model. User identity/pair records live separately under `~/.tarx/state/eve`.

## Connect this computer

1. Run `tarx`, then `/signin`, and finish the browser sign-in.
2. Run `tarx runtime challenge` to request a short-lived code using that saved account.
3. Explicitly approve it with `tarx runtime approve --challenge CODE`.
4. Run `tarx runtime serve --worker-url http://127.0.0.1:PORT` against an existing pinned Eve worker.
5. Ask TARX in the browser to connect this computer and enter the approved code.

The browser receives a scoped connection credential, never the saved CLI credential. The listener accepts only approved production origins and owned session reads. Codes expire after two minutes and can be claimed once; repeat the challenge/approval if needed. Use `tarx runtime revoke --challenge CODE` to revoke its connection.

This increment exposes pairing and read/attach only. It does not submit tasks or create session ownership. Worker health is not model responsiveness; readiness stays not-ready until that proof is integrated. Do not treat configuration, pairing, or an empty tool list as successful task execution. Keep using the browser for ordinary conversation.

## Verification

`npm ci --ignore-scripts --omit=dev --no-audit --no-fund` then `node --test --experimental-strip-types *.test.ts` in this directory. `python3 tests/test-runtime-package.py` from the repository root tests real staged install commands with fake network/dependency processes and disposable storage. No production sign-in, grant, inference or service is used.

## Paired private chat (runtime0.3.0)

`tarx runtime serve-personal` starts only the loopback listener, using the same owner-only `~/.tarx/state/personal-runtime.json` or `TARX_PERSONAL_RUNTIME_*` settings as CLI chat. It starts no model/Eve worker. A missing/unsafe/unreachable local configuration fails closed; no remote fallback. `serve` and `serve-check` also wire this personal client when configured.

Private chat requires a fresh pairing explicitly approved on the trusted CLI with `--task personal_chat`; prior read-only or tool scopes do not silently gain inference. The browser claims the challenge using the existing conversational pairing flow. Never paste model credentials into the browser. Revocation blocks future requests and withholds in-flight replies. `/personal-turn` accepts only bounded user/assistant messages, returns ordinary text, and cannot select model/url/key or execute tools. The existing `/tasks` endpoint remains local Eve tools; supercomputer compute uses the separate explicit hosted task-only web route.

On a phone, localhost refers to that phone, not a Mac. Configuration/readiness is not a responsive-model claim. Actual personal chat is accepted only after a scoped approved request succeeds; no per-user training or OS lifecycle guarantee.

## Context cache (not mounted on /personal-turn)

`tarx-context-cache.ts` stores bounded facts encrypted with a caller-supplied 32-byte key and builds a model-specific quoted pack. Owner namespace stays `ownerNamespace(subject_id, install_id)`. A `supercomputer` pack requires a current server-owned grant for that exact scope, provider, model, and purpose. `private_local` facts stay on `this_computer`. `deliverOwnedPersonalContext` can hand a local pack to the existing loopback `PersonalClient` as quoted user data, never as a system instruction. `/personal-turn` does not call it yet: that route still has no operator key, context file, or server-owned grant record. Source code here is not live persistence or Always On acceptance.


### Opt-in owned personal context

The existing `/personal-turn` route can now use the encrypted cache with a fresh explicit `personal_chat,personal_context` pairing approval. Existing chat-only grants do not read context. The browser body remains `{messages}`; owner identity comes from pairing, recipient/model identity from the bound local client. Remote context dispatch is unavailable on this route. Source facts stay data and output uses the existing sanitizer.

Operator configuration is optional: `~/.tarx/state/context-runtime.json` (owner-only0600), with its state directory0700. Example metadata only:

```json
{"version":1,"key_name":"operator","cache_name":"facts","bindings":[{"enabled":true,"scope":{"owner_namespace":"<server-derived 64-character owner hash>","workspace_id":"work","channel_id":"personal","purpose":"continue","grant_revision":"rev1"},"fact_ids":["goal"],"policy_version":"v1","prompt_version":"v1","max_bytes":2048}]}
```

The existing operator-supplied32-byte key is hex in `~/.tarx/state/context/operator.key` (0600, parent0700), and the encrypted store is `facts.json` in that directory. The runtime creates no key, imports no history and never accepts file paths, owner or grants from the browser. A missing policy preserves normal no-context chat. A configured but disabled/unbound/unsafe policy fails closed for context-enabled pairings. Policy is read again each turn; removing an owner's binding or setting enabled=false blocks future context-enabled turns. Revoking the pairing blocks dispatch even when revocation occurs during context resolution. These actions cannot erase content already delivered to a model.

Only the fixed personal scope is supported; channel context requires a separate server-authenticated channel binding. Populate approved facts through the cache library/operator path; no browser fact-upload endpoint or founder-memory importer exists. Starting the existing runtime with this code and consenting to the pairing are separate operator actions, not performed by source release. To roll back, revoke the context-enabled pairing and use ordinary chat approval. No new service or remote fallback is installed.
