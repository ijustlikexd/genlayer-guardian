#!/usr/bin/env bash
# Studio Next preview intermittently rejects every deploy with "invalid_contract runner malformed"
# (observed 2026-09-14 14:58Z onward, even for the official v0.3 example). Probe every 10 min with a
# cheap ToyVault deploy; once the preview accepts contracts again, build the full environment and
# run the three lodash checks. Logs to docs/studio-next-run-2026-09-14.log.
cd "$(dirname "$0")/../.."
LOG=docs/studio-next-run-2026-09-14.log
for i in $(seq 1 18); do
  echo "== probe $i $(date -u +%FT%TZ)" | tee -a "$LOG"
  if PYTHONUTF8=1 node scripts/studio-next/next.mjs deploy contracts/ToyVault.py 2>&1 | grep -v deprecated | tee -a "$LOG" | grep -q '"event":"deployed"'; then
    echo "== preview accepts deploys again; deploy-all $(date -u +%FT%TZ)" | tee -a "$LOG"
    PYTHONUTF8=1 node scripts/studio-next/next.mjs deploy-all 2>&1 | grep -v deprecated | tee -a "$LOG"
    for t in vault-a vault-c vault-b; do
      echo "== check $t $(date -u +%FT%TZ)" | tee -a "$LOG"
      PYTHONUTF8=1 node scripts/studio-next/next.mjs check $t osv GHSA-p6mc-m468-83gw --wait-final 2>&1 | grep -v deprecated | tee -a "$LOG" | grep -E '"action"|"reason_code"|check_finalized'
    done
    echo "STUDIO_NEXT_DONE"; exit 0
  fi
  sleep 600
done
echo "STUDIO_NEXT_GAVE_UP"; exit 1
