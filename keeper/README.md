# Guardian keeper

TypeScript CLI that submits `check` transactions to the Guardian contract.
It is a trigger, not a judge: all applicability, severity, prerequisite, and
action decisions happen on-chain inside Guardian's non-deterministic block.
The keeper never inspects an advisory itself and never decides an outcome.

## What it is not

- Not a validator: it does not run the leader/validator adjudication logic.
- Not a policy engine: it does not read or apply `policy.json` rules.
- Not authoritative: `watch` is best-effort discovery; missing a poll cycle
  or an OSV outage only delays a `check` call, it never skips enforcement
  that the contract itself would perform.

## Commands

```
npm run keeper -- check <target_id> <source> <incident_id> [--wait-final]
npm run keeper -- watch <target_id> [--interval 300]
npm run keeper -- verdict <key>
npm run keeper -- vault <address>
npm run keeper -- register <target_id> <vault_address> <manifest.json> <policy.json> [source_repo]
npm run keeper -- resume <target_id> <verdict_key>

npm run keeper -- deploy <contracts/File.py> [args...]
npm run keeper -- set-guardian <vault_address> <guardian_address>
npm run keeper -- deploy-all <network> [--signer env|cli] [--spec docs/examples/deploy-spec.json]
```

`source` is `osv` or `github_repo_advisory`. `watch` polls a target's
manifest dependencies against OSV every `--interval` seconds, submits
`check` for any new, non-withdrawn, not-yet-adjudicated vuln id, and logs
one JSON line per action. Ctrl+C exits cleanly.

## Env

Copy `.env.example` to `.env`:

- `ACCOUNT_PRIVATE_KEY`: hex private key of the keeper's signing account.
- `GENLAYER_NETWORK`: `localnet` | `studionet` | `testnet-asimov` | `testnet-bradbury`.
- `GUARDIAN_ADDRESS`: deployed Guardian contract address.

## Finalization (Bradbury)

On Bradbury, finalization is a public action after the appeal window (about 30 minutes observed). Every
`check` and `resume` this keeper submits is recorded in `keeper/pending-finalize.json`.

- `finalize <txId...>`: finalize specific transactions.
- `finalize-pending`: try every tracked transaction once; finalized ones are dropped, not-ready ones stay.
- `finalize-pending --until-empty [--interval 300]`: repeat that round every `--interval` seconds
  until the tracker is empty or 24 rounds have run. Ctrl+C exits cleanly between rounds.

Finalization is decision-bound and permissionless: it delivers the already-decided PAUSE or RESUME, it cannot
change it. Studionet finalizes automatically, so these commands are only needed on testnets.

## Deploying contracts

- `deploy <contracts/File.py> [args...]`: deploys a contract with the `.env` keeper key
  (`ACCOUNT_PRIVATE_KEY`, network from `GENLAYER_NETWORK`), waits for ACCEPTED, and prints
  `{"address": "...", "tx_hash": "..."}`. Positional `args` are JSON-decoded when possible
  (so `42`, `true`, `"0xabc"` all work), otherwise passed through as strings.
- `set-guardian <vault_address> <guardian_address>`: calls `set_guardian` on a ToyVault with
  the `.env` keeper key. The caller must be the vault's owner.

## Rebuild an environment in one command

`deploy-all` builds a complete Guardian environment from a spec file: it deploys Guardian,
deploys one ToyVault per target, points each vault's `guardian` at the new Guardian, registers
every target (manifest/policy/source_repo from the spec), and records the results.

```
npx tsx keeper/cli.ts deploy-all studionet
npx tsx keeper/cli.ts deploy-all testnet-bradbury --signer cli
```

- `--signer env` (default): every deploy, `set_guardian`, and `register_target` call is signed
  by the `.env` keeper key via genlayer-js. Simplest path; use it whenever the keeper account
  is also allowed to own the deployed contracts.
- `--signer cli`: deploys and `set_guardian` shell out to `npx genlayer deploy --contract <file>`
  and `npx genlayer write <vault> set_guardian --args <guardian>`, so the GenLayer CLI's active
  account signs (and owns) them, without this process ever handling that key. `register_target`
  still goes through the `.env` keeper key, since that is the account Guardian expects `check`
  and `register_target` calls from afterwards. Use this on Bradbury when the deployer/owner
  wallet is the CLI's account rather than the keeper's.
- `--spec <path>` (default `docs/examples/deploy-spec.json`): a JSON file with a `targets` array
  of `{ target_id, manifest, policy, source_repo }`, where `manifest`/`policy` are either inline
  JSON objects or paths to `.json` files.

`deploy-all` always builds its own client for the given `<network>` argument, independent of
whatever `GENLAYER_NETWORK` is set to in `.env`. It also:

- migrates `deployments.json` from its old flat array into `{ current, history }` the first
  time it runs (every previous entry is preserved verbatim in `history`), then writes this
  run's guardian/vault addresses under `current.<network>`;
- updates only the deployed network's `guardian` and `targets` values in
  `site/public/config.json`, leaving everything else (other networks, `default_network`,
  `repo_url`) untouched;
- writes `GUARDIAN_ADDRESS` into `.env` only if `<network>` matches the `GENLAYER_NETWORK`
  already configured there (never creates `.env` from scratch).

It prints a JSON summary at the end: `{ network, signer, guardian, vaults }`.
