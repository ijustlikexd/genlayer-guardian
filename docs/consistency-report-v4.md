# Studionet consistency run

Source: `docs\consistency-run-v4.jsonl`, 30 check transactions, 5 identical targets.

## Per-incident verdict distribution

| incident | targets | actions | prerequisites_met | severity | votes with DISAGREE |
|---|---|---|---|---|---|
| GHSA-29mw-wpgm-hmr9 | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |
| GHSA-35jh-r3h4-6jhm | 5 | {'RESTRICT': 5} | {'false': 5} | {'high': 5} | 0 |
| GHSA-f23m-r3pf-42rh | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |
| GHSA-p6mc-m468-83gw | 5 | {'PAUSE': 5} | {'true': 5} | {'high': 5} | 0 |
| GHSA-r5fr-rjxr-66jc | 5 | {'RESTRICT': 5} | {'false': 5} | {'high': 5} | 0 |
| GHSA-xxjr-mmjv-4gpg | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |

## Validator votes (all txs)

{'IDLE': 60, 'AGREE': 90} of 150
AGREE share among non-idle votes: 100.0%


## Verdict stability: 6/6 incidents got the same action on every target.
