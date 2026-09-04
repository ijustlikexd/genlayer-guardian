# Studionet consistency run

Source: `docs\consistency-run.jsonl`, 30 check transactions, 5 identical targets.

## Per-incident verdict distribution

| incident | targets | actions | prerequisites_met | severity | votes with DISAGREE |
|---|---|---|---|---|---|
| GHSA-29mw-wpgm-hmr9 | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 5 |
| GHSA-35jh-r3h4-6jhm | 5 | {'RESTRICT': 5} | {'false': 5} | {'high': 5} | 3 |
| GHSA-f23m-r3pf-42rh | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 2 |
| GHSA-p6mc-m468-83gw | 5 | {'PAUSE': 5} | {'true': 5} | {'high': 5} | 0 |
| GHSA-r5fr-rjxr-66jc | 5 | {'RESTRICT': 5} | {'false': 5} | {'high': 5} | 4 |
| GHSA-xxjr-mmjv-4gpg | 5 | {'RESTRICT': 5} | {'false': 5} | {'moderate': 5} | 2 |

## Validator votes (all txs)

{'AGREE': 90, 'IDLE': 42, 'DISAGREE': 18} of 150
AGREE share among non-idle votes: 83.3%

## Transactions with a DISAGREE vote

- GHSA-29mw-wpgm-hmr9 `0x9a9c22544e413d004af61418ebc164fb31197f0399500cf3a4fc91ebb2840314` ['AGREE', 'AGREE', 'DISAGREE', 'IDLE', 'AGREE']
- GHSA-35jh-r3h4-6jhm `0xcb6c16caee73541ad43d2754e652c5bd2aa03d748b685084d40a1855bc169439` ['AGREE', 'AGREE', 'IDLE', 'DISAGREE', 'AGREE']
- GHSA-r5fr-rjxr-66jc `0x76227596195c52c433feeafeb88712303f525533cd5ce6b1f77c0b49f0d5b181` ['AGREE', 'DISAGREE', 'DISAGREE', 'AGREE', 'AGREE']
- GHSA-29mw-wpgm-hmr9 `0xfd7f54848473346ea5d5a0644b49109fcda7ea8524c46c86894e25bdb420e284` ['AGREE', 'DISAGREE', 'IDLE', 'AGREE', 'AGREE']
- GHSA-f23m-r3pf-42rh `0x29bb9f8c557aff852b8c7cf090d84799c4518815a8a5735fd1464b60eb16010d` ['AGREE', 'DISAGREE', 'AGREE', 'IDLE', 'AGREE']
- GHSA-r5fr-rjxr-66jc `0x1797a2e852819f04e2205a578e43ee219f3639c0f55ffe5f33ae26ca5bde235a` ['AGREE', 'AGREE', 'AGREE', 'DISAGREE', 'IDLE']
- GHSA-29mw-wpgm-hmr9 `0x2dcf7d17ccfe8a8b844ae8d1a048136084e504b6eee0fd4c877f2220462af729` ['AGREE', 'IDLE', 'DISAGREE', 'AGREE', 'AGREE']
- GHSA-35jh-r3h4-6jhm `0x557bff5ece71f7f61972320fd26b6a943a2ecbf954dab58f870695b445ba7512` ['AGREE', 'IDLE', 'DISAGREE', 'AGREE', 'AGREE']
- GHSA-r5fr-rjxr-66jc `0x72530088585eb1661e83981f4103ef0fc5ecb72718eacaf46510bfaa31d12d6f` ['IDLE', 'AGREE', 'AGREE', 'DISAGREE', 'AGREE']
- GHSA-xxjr-mmjv-4gpg `0xc234cac07a2319a07671d0b0b8152423e0d0583db933071216b9f272412e7557` ['AGREE', 'AGREE', 'IDLE', 'AGREE', 'DISAGREE']
- GHSA-29mw-wpgm-hmr9 `0x35a5a47d0847170cc2cc2a3134ddfc101a969c6dc39a2141805123cbbf2eeef9` ['IDLE', 'DISAGREE', 'AGREE', 'AGREE', 'AGREE']
- GHSA-35jh-r3h4-6jhm `0x6c7bd7bbdbcd5ec219c96ccfb49f805fbe63b3e4433857571c9f0c4f4ed235f1` ['IDLE', 'AGREE', 'DISAGREE', 'AGREE', 'AGREE']
- GHSA-f23m-r3pf-42rh `0x789b7b1c392f50fa65e76d58df55be69c3a14a50bc85f5e94a20b2d29022f090` ['AGREE', 'DISAGREE', 'AGREE', 'AGREE', 'IDLE']
- GHSA-r5fr-rjxr-66jc `0x79354fc2eba920e15900b633123bb9b389c120446c888675981a094f352131d2` ['AGREE', 'AGREE', 'DISAGREE', 'AGREE', 'DISAGREE']
- GHSA-xxjr-mmjv-4gpg `0x4593b58c37287235f3a2d4d8bfe45ecdfa5bed3c3f4a3b0d3a6b98c03717aedd` ['AGREE', 'IDLE', 'DISAGREE', 'AGREE', 'AGREE']
- GHSA-29mw-wpgm-hmr9 `0x641c3e99742739341ab533e568e4b4cb83e8434453b0caf823fa45c14863a3d0` ['IDLE', 'AGREE', 'DISAGREE', 'AGREE', 'AGREE']

## Verdict stability: 6/6 incidents got the same action on every target.
