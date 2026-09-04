# Website: data layer and scope

Purpose: the Agent Tank submission requires a website. It is a read-only status board plus the exact
How-to. It never signs transactions; all writes go through the keeper CLI or the GenLayer CLI.

## Stack

- Static single page (Vite + TypeScript, no framework, or plain HTML + one bundled script).
- Reads chain state in the browser with genlayer-js `readContract` against Studionet (later Bradbury).
- Hosted on GitHub Pages from the same repo. No backend, no database, no secrets.

## Reads (all contract views, no auth)

| Section | Source | Call |
|---|---|---|
| Registered targets | Guardian | `get_target(target_id)` for a static list of ids in `site/config.json` |
| Target status | ToyVault | `get_state()` → mode, open_incidents, resolved, log |
| Verdicts per target | Guardian | `verdict_key_for(target, "osv", id)` then `get_verdict(key)` for known incident ids (from OSV query done client-side) |
| Live discovery | OSV | `POST api.osv.dev/v1/query` from the browser for each manifest dependency, to show "known advisories vs adjudicated" |
| Tx links | static | Studio explorer URL pattern + tx hashes stored in `deployments.json` and `docs/*.md` |

Everything the site shows is reproducible by the judge with the CLI commands printed next to each value.

## Page layout

1. Header: one-liner, Guardian address, network, link to repo and How-to.
2. Targets grid: one card per target. Mode badge (NORMAL / RESTRICTED / PAUSED), manifest summary
   (deps, key config flags), policy summary, open incidents with action, resolved list.
3. Incident table for the selected target: incident id, severity, applicable, prerequisites_met, action,
   reason_code, observed_at, published, link to OSV, link to tx.
4. "Try it" panel: the three CLI commands (check, verdict, vault) with copy buttons and the demo-repo
   advisory flow (publish advisory → keeper check → vault state changes).
5. Consistency panel: numbers from `docs/consistency-run.jsonl` (agreement rate, per-incident verdict
   distribution), rendered from a committed JSON snapshot, not live.

## Config

`site/config.json`:
```json
{"network":"studionet","guardian":"0x69d6…","targets":["vault-a","vault-b","vault-c","vault-d"],
 "vaults":{"vault-a":"0x2a51…","vault-c":"0x962E…","vault-d":"0x322e…"}}
```

## Out of scope

Wallet connect, registering targets from the UI, keeper controls, historical charts.
