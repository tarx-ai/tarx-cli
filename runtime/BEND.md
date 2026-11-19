# Bend 2 local job type (spike)

John-approved spike (19 Nov 2026). Draft PR only. This is an **opt-in local job
type**, not an inference, routing, Code Mode, or supercomputer-gateway change.

Enable with `TARX_BEND_JOBS=1`. Default is off.

## What landed

- Job kind: `bend`
- Dispatcher: `runtime/tarx-bend-job.ts` (`createBendJobExecutor`) plus
  `daemon/src/adapters/bend-jobs.ts` for the existing coordinator `kind` field
- Program: `runtime/bend/parallel-sum.bend` (parallel tree-sum, result `65536`)
- Bench: `runtime/bend/bench.sh` (median / p95 wall time + SHA-256 of stdout)

The daemon launcher (`tarxd`) is unchanged: it still does not install a default
executor. Tests inject the adapter into `createCoordinator`, which is how job
kinds are already executed.

## Bend 2 backends (Metal is real, but not a compiler flag)

Bend 2.0.40 **does** support Metal on macOS. It is the Darwin GPU lane for `!`
calls, not a `bend --backend metal` switch.

| TARX backend | Bend 2 mapping |
| --- | --- |
| `cpu` | compile `bend file.bend -o program`, run `./program +RTS --gpu off` |
| `metal` | same compile; run `./program +RTS --gpu on` (macOS Metal only) |

Facts from [Bend 2 README](https://github.com/bendlang/bend) / `bend guide` /
native `+RTS --help`:

- Targets are C, **Metal**, CUDA, and JavaScript.
- `!` is the GPU/parallel call. On macOS the native build uses Metal
  (`-DBEND_METAL=1`). On Linux it uses CUDA 12/13 when present.
- Runtime: `--gpu on\|off\|4GB` (default: on if a GPU is present; Metal default
  heap is 2GB). `--threads N` is the CPU worker count.
- Linux has **no Metal backend**. This VM therefore records Metal as
  `pending: needs a Mac run` and does not invent Mac numbers.

## Local CPU timings (Linux VM)

Host: Linux x86_64, 4 cores, no CUDA / no Metal. Bend 2.0.40. Native compile
warns `no CUDA toolkit … so ! runs on the CPU`, then the binary is run with
`+RTS --gpu off`.

Linux x86_64, 4 cores, Bend 2.0.40, clang 18, no CUDA. Compile once, then
11 runs of `./program +RTS --gpu off`. Wall time is process start + run
(`performance.now`); the tree-sum itself is smaller than spawn.

| Host | Backend | N | median wall ms | p95 wall ms | checksum | notes |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Linux VM | cpu | 11 | 2.284 | 3.096 | `0f3633c0ecb81f7639c3fe70873b438e74fb8960c68f7c39e6a8eac795e70a32` | real; compile 571 ms; `+RTS --gpu off` |
| Mac (Metal) | cpu | 11 | pending: needs a Mac run | pending: needs a Mac run | pending: needs a Mac run | |
| Mac (Metal) | metal | 11 | pending: needs a Mac run | pending: needs a Mac run | pending: needs a Mac run | |

Checksum of the deterministic stdout `65536\n` is
`0f3633c0ecb81f7639c3fe70873b438e74fb8960c68f7c39e6a8eac795e70a32`.

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
./bend/bench.sh
# equivalent:
# node --experimental-strip-types tarx-bend-job.ts bench \
#   --program "$PWD/bend/parallel-sum.bend" --backends cpu,metal --n 11
```

Paste the JSON into the table above. `backends.cpu` and `backends.metal` should
share the same `checksum`. A checksum mismatch is a real backend divergence,
not a timing issue.

One-shot run (not the N-sample bench):

```sh
export TARX_BEND_JOBS=1 BEND_NO_TELEMETRY=1
node --experimental-strip-types tarx-bend-job.ts run \
  --program "$PWD/bend/parallel-sum.bend" --backend cpu
node --experimental-strip-types tarx-bend-job.ts run \
  --program "$PWD/bend/parallel-sum.bend" --backend metal
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
- coordinator: disabled job fails closed; enabled job completes
