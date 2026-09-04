# Guardian status site

Static, read-only status board for the GenLayer Guardian project. Vite + TypeScript,
no UI framework. It only ever calls `readContract` against Studionet via genlayer-js;
it never signs a transaction. Writes go through the keeper CLI or `npx genlayer`.

## Run locally

```
npm install          # from the repo root; installs vite as a devDependency
npm run site:dev      # starts a Vite dev server for site/, with HMR
```

## Build

```
npm run site:build    # builds site/ to site/dist/
```

`site/vite.config.ts` sets `base: './'` so the built `index.html` and asset URLs
are all relative. This is required for GitHub Pages project sites, which are
served from a subpath (`https://<user>.github.io/<repo>/`) rather than the
domain root.

## Deploy to GitHub Pages

1. `npm run site:build` (produces `site/dist/`).
2. Publish `site/dist/` as the Pages source. Either:
   - point the repo's Pages settings at a `gh-pages` branch and push the
     contents of `site/dist/` to it (e.g. with `gh-pages` or a manual
     `git subtree`/orphan-branch push), or
   - use a GitHub Actions workflow that runs `npm ci && npm run site:build`
     and uploads `site/dist/` as a Pages artifact (`actions/upload-pages-artifact`
     + `actions/deploy-pages`).
3. Because of `base: './'`, no further path configuration is needed even if the
   Pages URL includes a repo-name subpath.

## Updating after a Guardian redeploy

Everything address- and network-specific lives in `site/config.json`, which is
copied verbatim into the build output (it lives under `site/public/` so Vite's
static-asset copy picks it up) and fetched at runtime with
`fetch('./config.json')`. To point the site at a new deployment, edit only:

```jsonc
// site/public/config.json
{
  "network": "studionet",           // matches a genlayer-js/chains export name
  "guardian": "0x...",              // new Guardian contract address
  "targets": [
    { "id": "vault-a", "vault": "0x..." }
    // add/remove/rename targets and their ToyVault addresses here
  ],
  "explorer_tx": "https://studio.genlayer.com/tx/",
  "repo_url": "https://github.com/..."
}
```

No rebuild is strictly required to pick up a `config.json` edit on GitHub Pages
(it is a static JSON file served next to `index.html`), but re-running
`npm run site:build` and redeploying is the safest way to make sure the file
that ships matches `site/public/config.json` in source control.

`site/consistency.json` (also under `site/public/`) is a committed snapshot of
the numbers in `docs/consistency-report.md`. It is not fetched live and only
needs updating if a new consistency run is documented.

## genlayer-js in the browser

- The site creates a client with `createClient({ chain })` and **no account**.
  Verified against `node_modules/genlayer-js/dist/index.d.ts` (`ClientConfig.account?`)
  and `dist/index-C3Ul1Rte.d.ts` (`readContract`'s per-call `account?`) on the
  1.1.8 build pinned in `package.json`: both are optional, and `readContract`
  never requires a signer. No throwaway account is created.
- Vite bundles `genlayer-js` (and its `viem` dependency) without any extra
  config. No `global`/`Buffer`/`process` polyfill or `define: { global: 'globalThis' }`
  shim was needed for this version to build or run in the browser — checked by
  grepping the built `genlayer-js` dist for `global.`/`process.env`/`Buffer.`
  (none found) and by a full `vite build` + a live browser smoke test against
  the real Studionet RPC (see below). If a future genlayer-js release
  reintroduces a Node-only dependency, the fix is a `define` entry in
  `site/vite.config.ts`:
  ```ts
  export default defineConfig({
    define: { global: "globalThis" },
    // ...
  });
  ```

## What's live vs. static

- Targets grid, vault mode/state, target manifests/policies, and all verdicts:
  live `readContract` calls to the Guardian and ToyVault contracts named in
  `config.json`.
- Incident discovery for the OSV source: a live `POST https://api.osv.dev/v1/query`
  per manifest dependency, from the browser, to list known advisory ids. Each id
  is then looked up on-chain via `verdict_key_for` + `get_verdict`; an
  "Unknown verdict" revert is rendered as "not adjudicated", not an error.
- `github_repo_advisory` verdicts are not auto-discovered (there is no
  equivalent open query API to enumerate them client-side); use the "verdict
  key" lookup box with a key you already know (from the keeper CLI, the
  "Try it" panel, or `docs/studionet-run-2026-09-04.md`).
- The consistency panel is a static, committed snapshot (`site/consistency.json`),
  not a live query, per `docs/website.md`.

## Verified end-to-end

This was smoke-tested with a real browser against the live Studionet Guardian
v2 deployment (`0x69d6cbaBc2567A21B38fa4cAEd24835f9A988e50`) and its four
targets from `config.json`. All four target cards rendered real on-chain state
(manifests, policies, modes, open/resolved incidents). Selecting `vault-d` and
looking up the `demo-repo` verdict key both reproduced the exact verdict data
recorded in `docs/studionet-run-2026-09-04.md` (same `observed_at`,
`reason_code`, `evidence.affected_range`, etc). A transient RPC/CORS error
surfaced once in the browser console during that run (the Studionet endpoint
occasionally errors on a `gen_call`); the page recovered on its own and kept
rendering because every contract read here is wrapped in `try`/`catch`
(`tryGetVerdict` in particular treats any revert or transient failure as "not
adjudicated"), so no console error is unhandled and the page never dies from it.

## Unverified / judgment calls

- No CI/Pages workflow file is included (out of scope: this task owns only
  `site/`, not `.github/`). The deploy section above documents the two common
  options; wiring one up is a repo-level decision.
- Client-side OSV severity bucketing only reads `database_specific.severity`
  (matching the common case in `contracts/Guardian.py`'s `_bucket_from_osv`).
  It does not replicate the on-chain CVSS vector parser (`_cvss_base_score`),
  so a vulnerability with no `database_specific.severity` but a raw CVSS vector
  will show "unknown" in the incident table until a verdict exists on-chain;
  once a verdict exists, the contract's own `severity_bucket` is shown instead
  and is authoritative.
- `explorer_tx` in `config.json` is present per the task's config shape but this
  version of the UI does not yet print a `+ tx_hash` link next to each verdict,
  since verdicts read via `get_verdict` do not carry their originating tx hash
  on-chain. Tx hashes tie back to hashes recorded in `docs/*.md`, not to live
  state.
