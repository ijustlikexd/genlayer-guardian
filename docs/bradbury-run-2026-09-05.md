# Bradbury testnet run, 2026-09-05

Deployer: `0xa1d6346d736964feb320f206cc28ab3c292bc4a2` (owner's wallet, imported into the GenLayer CLI keystore as `main-wallet` by the owner; this is the Developer NFT address). Faucet: 100 GEN. Chain id 4221, RPC https://rpc-bradbury.genlayer.com.

| Contract | Address |
|---|---|
| Guardian v4 | `0xc1D87D9a1998093fCA37ff460e53883698940FEe` |
| ToyVault A | `0x91b97b374bc95c4bCAA1AF7fB56E0a50c24d5E46` |

Deploy cost: both contracts plus set_guardian and register_target left 99.9945 GEN of 100.

## First adjudication

`check vault-a osv GHSA-p6mc-m468-83gw`, submitted 17:02:37Z. The CLI first reported `LEADER_TIMEOUT` (Bradbury validators are slower than Studionet; the leader did not respond within the CLI wait window). The transaction was nevertheless processed: a second submission returned ACCEPTED at 17:03:38Z and the stored verdict carries `resolved_at 17:02:41Z`, i.e. from the first round.

Verdict: applicable, high, prerequisites_met=true, **PAUSE**. Vault: `RESTRICT->RESTRICTED` at accepted; PAUSE lands at finalization (Bradbury appeal window is longer than Studionet).

Lesson for the keeper and the How-to: on Bradbury treat `LEADER_TIMEOUT` as "poll the verdict key before resubmitting"; a resubmit of an already adjudicated pair reverts `Already adjudicated`.

## Batch

`scripts/bradbury-batch.sh` registers vault-b (lodash 4.18.1) and vault-c (internal use) on the same ToyVault, adjudicates the six lodash advisories on vault-a, one on vault-b and three on vault-c, then reads back every verdict and the vault state. Log: `docs/bradbury-batch.log`.

## Batch results

21 real transactions on Bradbury from the owner's wallet (2 deploys, 1 set_guardian, 3 register_target, 14 check, 1 request_resume), all ACCEPTED; one check reported LEADER_TIMEOUT to the CLI but completed on-chain. Total spend 0.008 GEN.

| Target | Incident | Verdict | Matches Studionet v4 |
|---|---|---|---|
| vault-a | GHSA-p6mc-m468-83gw | PAUSE | yes |
| vault-a | GHSA-35jh, r5fr | RESTRICT, prerequisites not met | yes |
| vault-a | GHSA-29mw, f23m, xxjr | RESTRICT, moderate | yes |
| vault-b (4.18.1) | GHSA-p6mc | NONE, VERSION_NOT_AFFECTED | yes |
| vault-c (internal use) | GHSA-p6mc, 35jh, r5fr | RESTRICT, prerequisites not met | yes |
| vault-c | request_resume | denied STILL_AFFECTED | yes |

ToyVault A: five RESTRICT applied at accepted; vault-c targets share the vault so their RESTRICTs show as `dup` entries. The `on='finalized'` PAUSE for p6mc was still pending at the time of writing (Bradbury finality window is longer than Studionet).

## Finalization on Bradbury: a public action, eventually performed by the network

Studionet finalizes transactions for you, which is why every `on='finalized'` PAUSE landed within a minute there. On Bradbury the protocol only opens the appeal window; after it closes **anyone must submit the finalization action** (`npx genlayer finalize <txId>`). Until then the stored status stays Accepted and on-finalization messages are not delivered.

Observed: check tx `0x2accf319…d62a26a` (p6mc, vault-a) was Accepted at 17:03Z. `finalize` at about 17:30Z reverted (window still open); at 17:33:36Z it succeeded and the vault logged `GHSA-p6mc-m468-83gw|PAUSE->PAUSED` at 17:35Z. Appeal window on Bradbury is therefore on the order of 30 minutes.

Correction after observing 24 Guardian transactions: 17 reached FINALIZED without any action from us, so the network (validators or a protocol finalizer) does perform finalization after the window; only the most recent 7 were still Accepted, all inside their window. Manual `finalize` therefore accelerates delivery rather than being strictly required. Delivery latency of an on-finalization PAUSE on Bradbury is the appeal window (about 30 minutes) plus whatever delay the network finalizer adds.

Consequence for Guardian: the keeper gains an optional finalizer duty that shortens PAUSE delivery to the window itself. It records the tx ids of the checks and resumes it submits and calls `finalize` once the window has elapsed. Finalization is permissionless and decision-bound, so this adds no trust: the keeper cannot change what gets finalized, only when the already-decided PAUSE or RESUME is delivered. Guardian tx ids can also be recovered from the consensus contract logs (`docs/bradbury-txids.txt`, recovered via `eth_getLogs` filtered on the Guardian address), so a finalizer does not depend on the original submitter.

Bradbury block time observed: about 0.8 s.
