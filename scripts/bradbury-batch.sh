#!/usr/bin/env bash
# Bradbury real-usage batch: registers two more targets and adjudicates the lodash advisory set.
# Uses the GenLayer CLI active account (main-wallet). Sequential to avoid nonce races.
set -u
cd "$(dirname "$0")/.."
GD=${GD:-0xc1D87D9a1998093fCA37ff460e53883698940FEe}
VA=${VA:-0x91b97b374bc95c4bCAA1AF7fB56E0a50c24d5E46}
OUT=${OUT:-docs/bradbury-batch.log}
: > "$OUT"
log(){ echo "$(date -u +%FT%TZ) $*" >> "$OUT"; }
POL='{"max_action_on_accepted":"RESTRICT","max_action_on_finalized":"PAUSE","min_severity_for_restrict":"moderate","min_severity_for_pause":"high","require_prerequisites_met_for_pause":true}'
MB='{"target_id":"vault-b","dependencies":[{"ecosystem":"npm","name":"lodash","version":"4.18.1"}],"config":{"accepts_external_json_merge":true}}'
MC='{"target_id":"vault-c","dependencies":[{"ecosystem":"npm","name":"lodash","version":"4.17.15"}],"config":{"accepts_external_json_merge":false,"uses_functions":["chunk","uniq"],"input_source":"internal constants only","note":"no user-controlled keys reach lodash"}}'
w(){ # write and summarize
  R=$(npx genlayer write "$@" 2>&1)
  TX=$(echo "$R" | grep -oE "tx_id: '0x[0-9a-f]+'" | head -1 | grep -oE "0x[0-9a-f]+")
  ST=$(echo "$R" | grep -oE "status_name: '[A-Z_]+'" | tail -1 | grep -oE "'[A-Z_]+'" | tr -d "'")
  RN=$(echo "$R" | grep -oE "result_name: '[A-Z_]+'" | head -1 | grep -oE "'[A-Z_]+'" | tr -d "'")
  PL=$(echo "$R" | grep -oE "payload: '[^']*'" | tail -1)
  log "write $* | $ST | $RN | $TX | $PL"
}
w $GD register_target --args vault-b $VA "$MB" "$POL" none
w $GD register_target --args vault-c $VA "$MC" "$POL" none
for id in GHSA-29mw-wpgm-hmr9 GHSA-35jh-r3h4-6jhm GHSA-f23m-r3pf-42rh GHSA-r5fr-rjxr-66jc GHSA-xxjr-mmjv-4gpg; do w $GD check --args vault-a osv $id; done
w $GD check --args vault-b osv GHSA-p6mc-m468-83gw
for id in GHSA-p6mc-m468-83gw GHSA-35jh-r3h4-6jhm GHSA-r5fr-rjxr-66jc; do w $GD check --args vault-c osv $id; done
sleep 240
for t in vault-a vault-b vault-c; do for id in GHSA-p6mc-m468-83gw GHSA-29mw-wpgm-hmr9 GHSA-35jh-r3h4-6jhm GHSA-f23m-r3pf-42rh GHSA-r5fr-rjxr-66jc GHSA-xxjr-mmjv-4gpg; do
  V=$(npx genlayer call $GD get_verdict --args "$t|osv|$id|m1|p1" 2>&1 | grep -E "^  (action|prerequisites_met|severity_bucket|reason_code)" | tr -d "\n ' ")
  [ -n "$V" ] && log "verdict $t $id $V"
done; done
log "vault $(npx genlayer call $VA get_state 2>&1 | grep -E 'mode|->' | tr -d '\n')"
log "balance $(npx genlayer account show --rpc https://rpc-bradbury.genlayer.com 2>&1 | grep balance | tr -d ' ,')"
log done
