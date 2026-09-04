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
