# Studionet consistency run

Source: `docs\consistency-run-v3.jsonl`, 30 check transactions, 5 identical targets.

## Per-incident verdict distribution

| incident | targets | actions | prerequisites_met | severity | votes with DISAGREE |
|---|---|---|---|---|---|
| GHSA-29mw-wpgm-hmr9 | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |
| GHSA-35jh-r3h4-6jhm | 5 | {'RESTRICT': 5} | {'false': 5} | {'high': 5} | 2 |
| GHSA-f23m-r3pf-42rh | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |
| GHSA-p6mc-m468-83gw | 5 | {'PAUSE': 5} | {'true': 5} | {'high': 5} | 0 |
| GHSA-r5fr-rjxr-66jc | 5 | {'PAUSE': 2, None: 1, 'RESTRICT': 2} | {'true': 2, None: 1, 'false': 2} | {'high': 4, None: 1} | 3 |
| GHSA-xxjr-mmjv-4gpg | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 0 |

## Validator votes (all txs)

{'IDLE': 54, 'AGREE': 88, 'DISAGREE': 7} of 149
AGREE share among non-idle votes: 92.6%

## Transactions with a DISAGREE vote

- GHSA-35jh-r3h4-6jhm `0x657d61ee588098514ccdc0e9dc5cadb4254dd017e69a4fbefa832f225a4607e0` ['DISAGREE', 'AGREE', 'IDLE', 'AGREE', 'AGREE']
- GHSA-r5fr-rjxr-66jc `0x93d0ef8e011f75cdf6e5de4626c95d88ba7e7da55b1a14cb0b4e989d7502a90d` ['AGREE', 'AGREE', 'AGREE', 'IDLE', 'DISAGREE']
- GHSA-r5fr-rjxr-66jc `0xe017bddcda56ed03c0dfd5f4c4bed895c2d3a1ec12c5417f93d0d6d454a9d65e` ['AGREE', 'DISAGREE', 'DISAGREE', 'DISAGREE']
- GHSA-35jh-r3h4-6jhm `0x832c89113eadb52f4b9fde280d9a31d8c62996ac08a396d8671066627e5b2ec7` ['AGREE', 'DISAGREE', 'AGREE', 'AGREE', 'IDLE']
- GHSA-r5fr-rjxr-66jc `0xa145a1c36b09875a5ea759648f55ecddcdb3fb7f48498da832136f2cc0b07ebe` ['AGREE', 'IDLE', 'AGREE', 'AGREE', 'DISAGREE']

## Verdict stability: 5/6 incidents got the same action on every target.
