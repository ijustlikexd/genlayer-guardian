#!/usr/bin/env bash
# Studionet LLM consistency run: N targets with an identical manifest, each checked against the
# same set of incidents. Records per-tx consensus outcome so agreement can be measured.
# Uses the keeper account (.env). Targets point at a vault whose guardian is NOT this Guardian,
# so emitted actions revert harmlessly and demo vaults stay clean.
set -u
cd "$(dirname "$0")/.."
GD=$(grep '^GUARDIAN_ADDRESS=' .env | cut -d= -f2)
SINK=0x7292029b66060E990207373C27cC85d86428a180   # gate-test vault, guardian = GateProbe
N=${N:-5}
IDS="GHSA-p6mc-m468-83gw GHSA-29mw-wpgm-hmr9 GHSA-35jh-r3h4-6jhm GHSA-f23m-r3pf-42rh GHSA-r5fr-rjxr-66jc GHSA-xxjr-mmjv-4gpg"
OUT=${OUT:-docs/consistency-run.jsonl}
: > "$OUT"
MAN=docs/examples/manifest-stats.json
cat > "$MAN" <<'EOF'
{"target_id":"stats","dependencies":[{"ecosystem":"npm","name":"lodash","version":"4.17.15"}],"config":{"accepts_external_json_merge":true,"uses_functions":["merge","set","zipObjectDeep"],"input_source":"untrusted user JSON"}}
EOF
for i in $(seq 1 "$N"); do
  T="stats-$i"
  npx tsx keeper/cli.ts register "$T" "$SINK" "$MAN" docs/examples/policy-default.json >> "$OUT" 2>&1 || echo "{\"event\":\"register_failed\",\"target\":\"$T\"}" >> "$OUT"
done
for i in $(seq 1 "$N"); do
  for id in $IDS; do
    npx tsx keeper/cli.ts check "stats-$i" osv "$id" 2>&1 | grep -E '^\{"ts"' >> "$OUT"
  done
done
echo '{"event":"done"}' >> "$OUT"
