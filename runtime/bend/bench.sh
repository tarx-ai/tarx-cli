#!/bin/sh
# Local-only Bend job bench. Does not call tarx.com or the compute gateway.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
export TARX_BEND_JOBS=1
export BEND_NO_TELEMETRY=1
N=${N:-11}
BACKENDS=${BACKENDS:-cpu,metal}
exec node --experimental-strip-types "$ROOT/tarx-bend-job.ts" bench \
  --program "$ROOT/bend/parallel-sum.bend" \
  --backends "$BACKENDS" \
  --n "$N" \
  "$@"
