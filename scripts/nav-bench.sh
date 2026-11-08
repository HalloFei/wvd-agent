#!/usr/bin/env bash
# Measure the World's navigation (诺森霍洛村 -> 北穿幽冥城), counting failures and timeouts **separately**.
#
#   scripts/nav-bench.sh <legacy|senses> [trials] [per-trial-timeout-s]
#
# A trial is classified, not just timed, because a travel can "succeed" in a way that hides a failure:
#
#   ok          the navigator under test reached the destination on its own
#   fell-back   it reported ok, but only after "the senses could not reach ... falling back to the atlas"
#   fail        it returned ok:false (or an error) without a timeout
#   timeout     it was killed at the per-trial bound — a hang is a failure, not a slow success
#
# The reset trip back to the start is **not** measured. The average is over ok trials only; failures,
# fall-backs and timeouts are reported as counts beside it.
set -u
NAV=${1:-legacy}
TRIALS=${2:-3}
LIMIT=${3:-120}
LOG=".tmp/nav-bench-${NAV}.log"
: > "$LOG"
ok=0; fell=0; fail=0; hang=0; total=0
for i in $(seq 1 "$TRIALS"); do
  WVD_NAV="$NAV" node scripts/live.mjs travel vnh >/dev/null 2>&1
  start=$(date +%s%3N)
  out=$(timeout "$LIMIT" env WVD_NAV="$NAV" node scripts/live.mjs travel ffxi-gcn 2>&1)
  code=$?
  end=$(date +%s%3N)
  ms=$((end - start))
  last=$(printf '%s' "$out" | tail -1)
  if [ "$code" -eq 124 ]; then
    echo "$NAV trial $i TIMEOUT ${ms}ms" | tee -a "$LOG"; hang=$((hang + 1))
  elif printf '%s' "$out" | grep -q "could not reach"; then
    echo "$NAV trial $i fell-back ${ms}ms $last" | tee -a "$LOG"; fell=$((fell + 1))
  elif printf '%s' "$last" | grep -q '"ok":true'; then
    echo "$NAV trial $i ok ${ms}ms" | tee -a "$LOG"; ok=$((ok + 1)); total=$((total + ms))
  else
    echo "$NAV trial $i FAIL ${ms}ms $last" | tee -a "$LOG"; fail=$((fail + 1))
  fi
done
avg=0
[ "$ok" -gt 0 ] && avg=$((total / ok))
echo "$NAV RESULT ok=$ok fell_back=$fell fail=$fail timeout=$hang avg_ok=${avg}ms (trials=$TRIALS, bound=${LIMIT}s)"
