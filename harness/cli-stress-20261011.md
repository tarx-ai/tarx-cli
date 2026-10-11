# CLI stress 2026-10-11

Ten turns through the local Textual CLI against `http://127.0.0.1:11450`. No send. Not promoted. PR #5 was not touched.

Gateway log used for pre-gate text: `~/.tarx/always-on/gateway-turns.jsonl`. A turn with no new log row has no pre-gate text.

| # | Ask | Surface after | Pre-gate (if logged) | Accepted | Result |
|---|---|---|---|---|---|
| 1 | What is git HEAD? | agent always-on | none | no assistant stored | fail, timeout |
| 2 | What does gateway health return? | agent always-on | none | no assistant stored | fail, timeout |
| 3 | empty enter | agent always-on | none | no turn added | pass |
| 4 | /channel howdy | channel howdy | none | command only | pass |
| 5 | /agent desk-check | agent desk-check | none | command only | pass |
| 6 | Is Nemotron loaded? | agent desk-check | Not proven. (`inf_0c89a1c55dfecbdb`, appended_stdout, stdout y) | Not proven, then tool stdout. The hash matches `git rev-parse HEAD` (`0c8c981ee46b2a2ad2b056db6b780195d71b4fb6`). The health body names upstream `http://127.0.0.1:11449`. | pass |
| 7 | /agent always-on | agent always-on | none | command only | pass |
| 8 | /agents | agent always-on | none | command only. Always On stayed the default. | pass |
| 9 | What is git HEAD? | agent always-on | none | no assistant stored | fail, timeout |
| 10 | Is Nemotron loaded? | agent always-on | none | no assistant stored | fail, timeout |

Pass 6. Fail 4. The four failures are timeouts, not command-only turns and not a logged abort. Each one stored the user line, stored no assistant, and added no `gateway-turns.jsonl` row. `logGatewayTurn` runs only after a completed upstream body. The gateway failure with that shape is `upstream_fetch_failed`: the upstream fetch is aborted because it times out. One later retry of “What is git HEAD?” was still in flight with no new gateway row when the wait ended. The full ten was not run again.

After the ten turns, `GET http://127.0.0.1:11450/health` returned status ok, `upstream` `http://127.0.0.1:11449`, `upstream_healthy` true. `GET http://127.0.0.1:11449/health` returned 200. `GET http://127.0.0.1:11448/health` returned 200. These turns did not select :11448. :11445 was not booted.
