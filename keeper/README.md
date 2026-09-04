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
