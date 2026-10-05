# TARX CLI

This repo is the **source of truth** for two distinct TARX command-line surfaces.
They are not interchangeable — know which one you are running.

## Two CLIs (do not confuse)

| CLI | Source in this repo | Installed path | Version | Owns |
|---|---|---|---|---|
| **Shell operator CLI** | `daemon/bin/tarx` | `~/.tarx/bin/tarx` (on `PATH`) | v1.1.0 | presence, status, **doctor**, start/stop, mcp |
| **Node flywheel CLI** | `bin/tarx.mjs` → `src/cli.ts` | run from repo | v1.0.0 | `build` (plan→diff→apply), `ask`, `review`, `status` |

**The PATH `tarx` has NO `build` command.** `tarx build` on the shell CLI fails
with `Unknown command: build`. All planning/apply goes through the Node CLI:

```bash
cd "/Users/master/Desktop/TARX/Repos - active/tarx-cli"
node bin/tarx.mjs build --plan-only --task "describe the task"
node bin/tarx.mjs build --task "..." --repo /path/to/repo
node bin/tarx.mjs build --help      # prints usage + this dual-CLI note
node bin/tarx.mjs ask "question"
node bin/tarx.mjs review
node bin/tarx.mjs status
```

Requires Node 22.6+ (uses `--experimental-strip-types`).

## Doctor health gates (operating floors)

`tarx doctor` (the shell CLI) enforces memory-plane safety floors. These exist
because a multi-agent CLI loop froze the machine on 2026-10-04 when the encrypted
`~/.tarx/tarx.db-wal` ballooned to ~61 GB on a 99%-full disk.

| Check | Threshold | Result | Override env |
|---|---|---|---|
| Free disk | `< 40 GB` | **FAIL** (exit 1) | `TARX_DISK_MIN_GB` |
| `~/.tarx/tarx.db-wal` | `> 1 GB` | **FAIL** (exit 1) | `TARX_WAL_MAX_GB` |

- `tarx doctor` **exits non-zero** when any gate (or other check) fails, so it can
  gate automation: `tarx doctor && node bin/tarx.mjs build --plan-only ...`.
- The WAL size (in bytes and MB) is **always reported** when the WAL file exists,
  even when it passes, so operators can watch it before it melts the machine.
- The old `< 6 GB` disk warning was a **false green** — it never failed and used
  a mis-scaled block count. Replaced with a hard 40 GB floor computed from `df -k`.

```bash
~/.tarx/bin/tarx doctor          # full diagnosis; exit 1 if a gate fails
echo $?                          # 0 = healthy, 1 = gate/check failed
```

### Bridge follow-up (out of scope for this CLI)
A red WAL gate means a prod **writer** left `wal_autocheckpoint` unhealthy
(e.g. `0`) so checkpointed frames never truncate. The real fix is in the Bridge
DB layer (single-writer ownership + periodic `PRAGMA wal_checkpoint(TRUNCATE)`),
not this CLI. See
`tarx-ops/agent-workstream/MEMORY_SUPERINTELLIGENCE_ROADMAP_2026-10-04.md` (P0 #3).

## Installing / syncing the shell CLI

`~/.tarx/bin/tarx` is a plain copy of `daemon/bin/tarx`. After editing the source
of truth in this repo, sync it:

```bash
install -m 0755 daemon/bin/tarx ~/.tarx/bin/tarx
~/.tarx/bin/tarx version        # expect 1.1.0
~/.tarx/bin/tarx doctor         # verify gates
```

Confirm they match: `diff -q daemon/bin/tarx ~/.tarx/bin/tarx` → no output.
