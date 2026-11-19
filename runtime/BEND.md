# Bend 2 local job type (spike)

John-approved spike (19 Nov 2026). Draft PR only. This is an **opt-in local job
type**, not an inference, routing, Code Mode, or supercomputer-gateway change.

Enable with `TARX_BEND_JOBS=1`. Default is off.

## What landed

- Job kind: `bend`
- Dispatcher: `runtime/tarx-bend-job.ts` (`createBendJobExecutor`) plus
  `daemon/src/adapters/bend-jobs.ts` for the existing coordinator `kind` field
- Program: `runtime/bend/parallel-sum.bend` (parallel tree-sum of `2^d` ones;
  `d` is argv log2 depth, default 16)
- Bench: `runtime/bend/bench.sh` with `SIZES='16 20 24 26'` (median / p95 wall
  and in-program `IO.now` time + SHA-256 of the `RESULT` line)

The daemon launcher (`tarxd`) is unchanged: it still does not install a default
executor. Tests inject the adapter into `createCoordinator`, which is how job
kinds are already executed.

## Bend 2 backends (Metal is real, but not a compiler flag)

Bend 2.0.40 **does** support Metal on macOS. It is the Darwin GPU lane for `!`
calls, not a `bend --backend metal` switch.

| TARX backend | Bend 2 mapping |
| --- | --- |
| `cpu` | compile `bend file.bend -o program`, run `./program +RTS --gpu off -RTS D` |
| `metal` | same compile; run `./program +RTS --gpu on -RTS D` (macOS Metal only) |

Facts from [Bend 2 README](https://github.com/bendlang/bend) / `bend guide` /
native `+RTS --help` / `IO.now` in Base:

- Targets are C, **Metal**, CUDA, and JavaScript.
- `!` is the GPU/parallel call. On macOS the native build uses Metal
  (`-DBEND_METAL=1`). On Linux it uses CUDA 12/13 when present.
- Runtime: `--gpu on\|off\|4GB` (default: on if a GPU is present; Metal default
  heap is 2GB). `--threads N` is the CPU worker count.
- Linux has **no Metal backend**. Mac numbers below are from T-QA on TARX
  PRIME (Apple Silicon) at `ae608f5c`, not from this Linux VM.
- Bend 2 **does** expose in-program time: `IO.now()` is a monotonic clock in
  milliseconds (rounds down). `parallel-sum.bend` wraps `parallel_sum!(d)` with
  it and prints `COMPUTE_MS`. Checksums hash only `RESULT <n>\n`, not the timer.

## Local CPU timings (Linux VM)

Host: Linux x86_64, 4 cores, Bend 2.0.40, clang 18, no CUDA. Compile once
(`compile_ms=817`), then 11 runs per depth of `./program +RTS --gpu off -RTS D`.
`wall_ms` is process start plus run (`performance.now`). `compute_ms` is
`IO.now` around the `!` call. At depth 16 spawn still dominates; at 24+ the
tree-sum is the majority of wall time.

| Host | Backend | depth | result | N | median wall ms | p95 wall ms | median compute ms | p95 compute ms | checksum of `RESULT n\\n` | notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Linux VM | cpu | 16 | 65536 | 11 | 2.425 | 2.637 | 0 | 1 | `06e9491b0a84b12fa5fd361a88e994618101b96dcc1ee4443498187d89c30e5e` | spawn-dominated |
| Linux VM | cpu | 20 | 1048576 | 11 | 3.295 | 3.482 | 1 | 2 | `568232f612c20241046735fbd32629236842b4973390926f4dee62f7388e9252` | |
| Linux VM | cpu | 24 | 16777216 | 11 | 21.989 | 25.133 | 19 | 23 | `c4a3c7abab305b73a0d9d36fb42fbbcb6eaaa6b7d186cc8f7237a7e67a99d928` | compute dominates |
| Linux VM | cpu | 26 | 67108864 | 11 | 78.800 | 80.376 | 75 | 77 | `15ecd907eda4f6e2b52941bc5e9cda781132f685fc31c64dc8bbef0de318c760` | compute dominates |
| TARX PRIME | cpu | 16 | 65536 | 11 | — | — | — | — | `06e9491b0a84b12fa5fd361a88e994618101b96dcc1ee4443498187d89c30e5e` | checksum matches metal |
| TARX PRIME | cpu | 20 | 1048576 | 11 | — | — | — | — | `568232f612c20241046735fbd32629236842b4973390926f4dee62f7388e9252` | checksum matches metal |
| TARX PRIME | cpu | 24 | 16777216 | 11 | — | — | — | — | `c4a3c7abab305b73a0d9d36fb42fbbcb6eaaa6b7d186cc8f7237a7e67a99d928` | checksum matches metal |
| TARX PRIME | cpu | 26 | 67108864 | 11 | — | — | 22 | — | `15ecd907eda4f6e2b52941bc5e9cda781132f685fc31c64dc8bbef0de318c760` | T-QA compute |
| TARX PRIME | metal | 16 | 65536 | 11 | — | — | — | — | `06e9491b0a84b12fa5fd361a88e994618101b96dcc1ee4443498187d89c30e5e` | slower than cpu |
| TARX PRIME | metal | 20 | 1048576 | 11 | — | — | — | — | `568232f612c20241046735fbd32629236842b4973390926f4dee62f7388e9252` | slower than cpu |
| TARX PRIME | metal | 24 | 16777216 | 11 | — | — | — | — | `c4a3c7abab305b73a0d9d36fb42fbbcb6eaaa6b7d186cc8f7237a7e67a99d928` | slower than cpu |
| TARX PRIME | metal | 26 | 67108864 | 11 | — | — | 77 | — | `15ecd907eda4f6e2b52941bc5e9cda781132f685fc31c64dc8bbef0de318c760` | T-QA compute; +55 ms vs cpu |

## Mac Metal (TARX PRIME, T-QA)

T-QA ran `SIZES='16 20 24 26'` on TARX PRIME (Apple Silicon) at `ae608f5c`.
The private `tarx-ops` REPORT.md was not readable from this agent; rows use
T-QA's summary plus the deterministic `RESULT` checksums (cpu and metal
matched at every depth). Wall/p95 and the 16/20/24 compute medians were not
in that summary, so those cells stay `—` rather than invented.

- Metal was slower at every depth. Depth 26 `compute_ms`: **metal 77 vs cpu 22**.
- GPU overhead was roughly flat at **~70–110 ms**.
- **8B resident** on the GPU during the run.
- Gateway health stayed **200**.

**Conclusion:** Metal is not worth it at these sizes. The `!` tree-sum of ones
does not amortize GPU launch. Next try depths **28/30** or a heavier per-leaf
op.

The Mac commands below remain the repro for anyone filling the `—` cells from
the full JSON.

## Mac commands (John)

Needs: macOS with Metal, Node 24+, clang 19+ (Apple clang 17+) for `!`, Bend 2.

```sh
# 1. Install Bend 2 (no sudo). Telemetry off.
export BEND_NO_TELEMETRY=1
curl -fsSL https://bend-lang.com/install.sh | sh
export PATH="$HOME/.bend/bin:$PATH"
bend version

# 2. From this PR checkout, install the pinned runtime deps (no scripts).
cd runtime
npm ci --ignore-scripts --omit=dev --no-audit --no-fund

# 3. Run the same job type the tests cover. Metal cannot be faked on Linux.
export TARX_BEND_JOBS=1
export BEND_NO_TELEMETRY=1
chmod +x bend/bench.sh
SIZES='16 20 24 26' N=11 ./bend/bench.sh
# equivalent:
# node --experimental-strip-types tarx-bend-job.ts bench \
#   --program "$PWD/bend/parallel-sum.bend" --backends cpu,metal \
#   --sizes 16,20,24,26 --n 11
```

T-QA already ran this on TARX PRIME. Re-run to fill wall/p95 cells. For each
depth, `backends.cpu` and `backends.metal` should share the same `checksum` /
`result`. Compare `median_compute_ms` (inside Bend) not `median_wall_ms`.

One-shot run (not the N-sample bench):

```sh
export TARX_BEND_JOBS=1 BEND_NO_TELEMETRY=1
node --experimental-strip-types tarx-bend-job.ts run \
  --program "$PWD/bend/parallel-sum.bend" --backend cpu --depth 26
node --experimental-strip-types tarx-bend-job.ts run \
  --program "$PWD/bend/parallel-sum.bend" --backend metal --depth 26
```

Without `TARX_BEND_JOBS=1` both commands return `bend_jobs_disabled`.

## Tests

GitHub Actions is not the record for this spike. From the repo root, Node 24:

```sh
cd runtime
npm ci --ignore-scripts --no-audit --no-fund
./node_modules/.bin/tsc --noEmit
node --test --experimental-strip-types *.test.ts

cd ../daemon
node --test --experimental-strip-types test/*.test.ts
```

Unit coverage (mocked `bend` binary, no network):

- flag off → `bend_jobs_disabled`, no spawn
- missing binary → `bend_binary_missing`
- timeout → process killed (`bend_timeout`)
- stdout captured + SHA-256 checksum
- `RESULT` checksum ignores `COMPUTE_MS`
- coordinator: disabled job fails closed; enabled job completes
