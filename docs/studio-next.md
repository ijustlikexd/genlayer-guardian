# Guardian on GenLayer Studio Next (chain 61997)

Studio Next (`https://studio-dev.genlayer.com/api`, GenVM v0.3.0-rc7, explorer `https://explorer-studio-dev.genlayer.com` (the portal form calls this network "Studio Dev"))
is the preview environment the Agent Tank form asks for. It differs from Studionet in three ways that matter here:

| | Studionet / Bradbury | Studio Next |
|---|---|---|
| Runner header | one line, v0.2 hash | `# v0.3.0` + Depends `py-genlayer:5jycge4q…` (the hash Studio Next's own examples use) |
| SDK layout | `from genlayer import *` exports `gl`, `TreeMap`, `allow_storage`… | must `import genlayer as gl`; `gl.contract.Contract`, `gl.contract.interface`, `gl.storage.TreeMap`, `gl.storage.allow` |
| Consensus contract | `addTransaction` without fees (genlayer-js 1.1.8) | fee-aware ConsensusMain: needs genlayer-js 2.0.0-rc.1 `estimateTransactionFees()` (`FeesDistributionMissing` / `FeeValueMustBeNonZero` otherwise) |
| Contract-to-contract | supported (RESTRICT@accepted, PAUSE@finalized reach the vault) | **not supported** in the preview (its banner says so; `EmitInternalMessage` fails with `SystemError: inval`) |

So the Studio Next build is **adjudication-only**: `scripts/studio-next/make-next-contracts.py` generates `contracts/next/*.py`
from the canonical contracts with the header, import and `ENFORCEMENT_ENABLED = False` changes and nothing else; verdicts are
stored on-chain exactly as on Studionet, vault actions are not emitted. `scripts/studio-next/next.mjs` (genlayer-js 2.0.0-rc.1)
deploys and drives it.

## Deployment 2026-09-14

Guardian `0x06c8C109cC04EAeA26834e20b1150a7c56066288`, vaults vault-a `0xa5C9…5D55`, vault-b `0x9d2b…5288`, vault-c `0xf381…89fE`, demo-repo `0x40CD…7458`.

| Check | Verdict | Same as Studionet v6 |
|---|---|---|
| vault-a osv GHSA-p6mc-m468-83gw | applicable, high, prerequisites_met=true, **PAUSE** (VERSION_IN_RANGE_PREREQ_MET), finalized 15:25:37Z | yes |
| vault-c osv GHSA-p6mc-m468-83gw | applicable, high, prerequisites_met=false, **RESTRICT** (PREREQ_NOT_MET_DOWNGRADED), finalized 15:26:28Z | yes |
| vault-b osv GHSA-p6mc-m468-83gw | not applicable, **NONE** (VERSION_NOT_AFFECTED), finalized 15:27:13Z | yes |

Real OSV data, real Studio Next validator LLMs. Full log: `docs/studio-next-run-2026-09-14.log` (includes the failed attempts:
FeesDistributionMissing, runner malformed under the v0.2 and GitHub-main v0.3 hashes, the emit SystemError).

Reproduce:
```
cd scripts/studio-next && npm i
node next.mjs fund            # Studio faucet for the keeper key
node next.mjs deploy-all      # writes deployments.json + site/public/config.json
node next.mjs check vault-a osv GHSA-p6mc-m468-83gw --wait-final
node next.mjs verdict "vault-a|osv|GHSA-p6mc-m468-83gw|m1|p1"
```
