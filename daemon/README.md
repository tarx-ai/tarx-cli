# TARX Always On — daemon layer

The local, always-on surface of TARX: the `tarx` CLI (bare `tarx` = Presence + a
live session through the Supercomputer door), the Always On Presence service, the
keep-warm + self-heal watchdogs, and the launchd services that make the compute
door durable across reboot/sleep.

Grounded in `TARX_ALWAYS_ON_PRODUCT_LAW.md`: Always On is the on-switch, not a chat.
Bare `tarx` shows Presence first; the interactive session is an explicit,
user-invoked conversation.

## Layout

```
daemon/
  bin/
    tarx                 # the CLI. Bare `tarx` → Presence → live session.
    tarx-presence.sh     # Presence service → ~/.tarx/always-on/presence.json
    keep-warm-qwen.sh    # 5-min 1-token ping; kills the cold-start cliff
    tarx-self-heal.sh    # 60s watchdog: bridge/mind/gateway/model + public door
  always-on/
    session-prompt.md    # the situational system prompt seeded into `tarx` sessions
  launchd/
    com.tarx.supercomputer.gateway.plist         # OpenAI gateway :11450 (KeepAlive)
    com.tarx.supercomputer.compute-ngrok.plist   # ngrok → compute.tarx.com (KeepAlive)
    com.tarx.founder-brain-qwen-keepwarm.plist   # keep-warm (StartInterval 300)
    com.tarx.self-heal.plist                     # watchdog (StartInterval 60)
```

## Architecture

```
tarx  ──►  Presence (mode/runtime/watchers)   [~/.tarx/always-on/presence.json]
      └─►  live session  ──►  compute.tarx.com (ngrok)
                                └─►  gateway :11450 (tarx/t-supercomputer)
                                      └─►  base model :11445 (tarx-brain-qwen-27b)
```

Door identity is `tarx/t-supercomputer`; the raw base model stays hidden (G7).

## Computer registry vs production

Decision: separate. The Computer registry stays local. It does not override production, and production does not sync it.

`~/.tarx/agents/registry.json` is the Computer registry on this Mac. The CLI, the local web preview, and Eve read that file. Always On is the default agent there, not a channel.

The cross-surface command is the same on the CLI, Slack, and Gmail. Start on Always On. `/agents` lists `~/.tarx/agents/registry.json`. `/agent <slug>` pulls that agent into the turn. `/agent always-on` returns to Always On, which stays the default. Discord is out. Slack and Gmail do not send when they handle these tokens. The connector note sits in the Eve README next to Email and Slack.

`https://tarx.com/agents` and `https://tarx.com/channels` stay 404 until a production catalog exists. The production app shell on app.tarx.com and cli.tarx.com does not list Computer agents. No production catalog of those agents was found, so nothing was wired to copy the Mac file.

Computer registry is local-only. Web Always On talks to the gateway. No second list.

## Install on a node (manual)

1. Copy `daemon/bin/*` → `~/.tarx/bin/` and `chmod +x`.
2. Copy `daemon/always-on/session-prompt.md` → `~/.tarx/always-on/`.
3. Copy `daemon/launchd/*.plist` → `~/Library/LaunchAgents/`.
4. **Set the gateway key** in `com.tarx.supercomputer.gateway.plist`: replace
   `__SET_TARX_GATEWAY_API_KEY_HERE__` with the node's gateway key. This value is
   a secret and is intentionally NOT committed.
5. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tarx.*.plist`

## Secrets (never committed)

- `TARX_GATEWAY_API_KEY` — placeholder in the plist; set per node.
- ngrok authtoken — read from `~/Library/Application Support/ngrok/ngrok.yml`.
- keep-warm bearer — read at runtime from `~/.tarx/founder-brain/qwen-api-key`.

## Law boundaries

- Default mode is **Asleep**. No auto-arm, no auto-speak, no second personality.
- Provider admission (hosted/OpenRouter, `is_ready`, `authorized_to_deploy`,
  `TARX_GATEWAY_HOSTED_ENABLED`) stays CLOSED — not set by these artifacts.
