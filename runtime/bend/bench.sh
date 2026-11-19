#!/bin/sh
# Local-only Bend job bench. Does not call tarx.com or the compute gateway.
# SIZES are log2 depths of the parallel tree (2^d ones). Default 16 20 24 26.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
export TARX_BEND_JOBS=1
export BEND_NO_TELEMETRY=1
N=${N:-11}
BACKENDS=${BACKENDS:-cpu,metal}
SIZES=${SIZES:-'16 20 24 26'}
SIZES_CSV=$(printf '%s' "$SIZES" | tr ' ' ',')
exec node --experimental-strip-types "$ROOT/tarx-bend-job.ts" bench \
  --program "$ROOT/bend/parallel-sum.bend" \
  --backends "$BACKENDS" \
  --sizes "$SIZES_CSV" \
  --n "$N" \
  "$@"
