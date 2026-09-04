# Studionet end-to-end run, 2026-09-04

Incident: OSV GHSA-p6mc-m468-83gw (CVE-2020-8203, lodash prototype pollution, HIGH, fixed 4.17.19). Real OSV data, real validator LLMs.

| Contract | Address |
|---|---|
| Guardian | 0x3d9662231eC7dB891d19BA7Fb360c10c0A70b754 |
| ToyVault A (targets vault-a, vault-b) | 0x2a51226330Da8DA06e06a3f3d96a8495C31072bC |
| ToyVault C (target vault-c) | 0x962EfdbDb61801A462137452ce05C96B3155A917 |

| Target | Manifest | check tx | Verdict | Vault after |
|---|---|---|---|---|
| vault-a | lodash 4.17.15, external JSON merge, uses merge/set/zipObjectDeep | 0x4d44a1c039112fd8012c9ada392c73f370d4929f52eb7f2d263d62023e988bd9 | applicable, high, prerequisites_met=true, **PAUSE** (VERSION_IN_RANGE_PREREQ_MET) | RESTRICTED at accepted, **PAUSED** at finalized |
| vault-b | lodash 4.17.21 | 0x5ac4b4812d694724e845da57b32618a967d5a7f0111d13288338a3929159629c | not applicable, **NONE** (VERSION_NOT_AFFECTED) | unchanged |
| vault-c | lodash 4.17.15, internal constants only, chunk/uniq | 0x088bd013953153f564ce208aafa900eeb73104eafa06a143b65084af2c15caa8 | applicable, high, prerequisites_met=false, **RESTRICT** (PREREQ_NOT_MET_DOWNGRADED) | **RESTRICTED** |

All three: MAJORITY_AGREE, 3 AGREE + 2 IDLE, about 15 to 20 s to ACCEPTED, finalization under a minute.

Reproduce (CLI account on studionet):
```
npx genlayer write 0x3d9662231eC7dB891d19BA7Fb360c10c0A70b754 check --args vault-a osv GHSA-p6mc-m468-83gw
npx genlayer call  0x3d9662231eC7dB891d19BA7Fb360c10c0A70b754 get_verdict --args "vault-a|osv|GHSA-p6mc-m468-83gw|m1|p1"
npx genlayer call  0x2a51226330Da8DA06e06a3f3d96a8495C31072bC get_state
```
Note: these verdict keys are already adjudicated; a second check reverts "Already adjudicated". Register a new target_id to re-run.

Lesson: `genlayer` CLI auto-parses JSON-looking string args into objects and "" into 0. Contract now accepts either form; pass `none` for an empty source_repo.

## Day 4 additions (Guardian v2 `0x69d6cbaBc2567A21B38fa4cAEd24835f9A988e50`)

Guardian was redeployed twice on Day 3 and Day 4 (v0 rejected CLI-decoded JSON args, v1 crashed on a string address from the SDK). v2 accepts str or decoded JSON for manifest/policy and str or Address for the target address.

### RESUME chain (vault-c, ToyVault C `0x962E…A917`)
1. `check vault-c osv GHSA-p6mc-m468-83gw` → RESTRICT (PREREQ_NOT_MET_DOWNGRADED), vault RESTRICTED.
2. `request_resume` while still on 4.17.15 → reverted `Resume denied: STILL_AFFECTED`.
3. `update_manifest` to lodash 4.17.21 → manifest_version 2.
4. `request_resume` → `NO_LONGER_AFFECTED`, `RESUME` emitted on finalized; vault log `GHSA-p6mc-m468-83gw|RESUME->NORMAL`, mode NORMAL, incident in resolved set.

### Keeper (TypeScript, account keeper-dev `0x9BDc…B094`, 0 GEN, Studionet)
- `register vault-d` via keeper: owner recorded as the keeper account.
- `check vault-d osv GHSA-p6mc-m468-83gw --wait-final`: PAUSE, accepted 13:21:36, finalized 13:22:40.
- `watch vault-a --interval 120`: discovered every lodash 4.17.15 advisory from OSV and submitted one check each. Verdicts on vault-a (config: external JSON merge, uses merge / set / zipObjectDeep):

| Incident | Topic | severity | prerequisites_met | action |
|---|---|---|---|---|
| GHSA-p6mc-m468-83gw | prototype pollution via set / zipObjectDeep | high | true | PAUSE |
| GHSA-35jh-r3h4-6jhm | command injection via `_.template` | high | false | RESTRICT |
| GHSA-r5fr-rjxr-66jc | `_.template` related | high | false | RESTRICT |
| GHSA-29mw-wpgm-hmr9 | ReDoS in toNumber / trim | moderate | false | RESTRICT |
| GHSA-f23m-r3pf-42rh, GHSA-xxjr-mmjv-4gpg | unset / other | moderate | false | RESTRICT |

The validators' prerequisite judgment tracked the manifest: only the advisory whose exploitable functions appear in `uses_functions` reached PAUSE. Vault A ends PAUSED with 6 open incidents; resuming requires clearing each.

Keeper bug found and fixed: it expanded OSV `aliases` (CVE ids) into separate incidents. OSV also serves CVE records with NVD-style affected data, so those adjudicated as NONE / PACKAGE_NOT_DEPLOYED and would have double-counted real hits. Keeper now submits canonical OSV ids only.

## Day 5: judge-reproducible path via a real GitHub repository advisory

Repo `ijustlikexd/guardian-demo-target`, advisory `GHSA-m9f4-gp45-2v27` (published 14:43:50Z, High, npm `guardian-demo-target < 1.3.0`, description states the exploit prerequisite `accepts_external_json_merge`). No CVE requested; GitHub's global-database review is irrelevant because Guardian reads the repo-level endpoint.

| Step | Time (UTC) | Result |
|---|---|---|
| ToyVault E deployed, guardian set | 14:45 | `0xff1C73E6774320073881C44A7243A0B13eC6C03B` |
| `keeper register demo-repo` with source_repo `ijustlikexd/guardian-demo-target` | 14:45:30 | owner = keeper account |
| `keeper check demo-repo github_repo_advisory GHSA-m9f4-gp45-2v27 --wait-final` | submitted 14:45:33, accepted 14:45:56, finalized 14:46:23 | applicable, high, prerequisites_met=true, **PAUSE**, evidence.affected_range `< 1.3.0` |
| Vault E | 14:46:25 | RESTRICT at accepted, PAUSE at finalized, mode PAUSED |

Publish-to-pause latency: about 2.5 minutes, of which Guardian consensus and finality took under one minute.

Follow-ups for the demo video: bump the manifest to 1.3.0 and `request_resume` (NO_LONGER_AFFECTED), or withdraw the advisory (ADVISORY_WITHDRAWN). Keeper needs an `update-manifest` command since the keeper account owns this target.

## Day 6: Guardian v3 (outcome-only consensus, LLM gating) and v4 (prompt rules)

Guardian v3 `0x35D13270c40F9406D437cEa8Cd4b9D38cbC81eDC`: consensus key reduced to (applicable, severity_bucket, action, reason_code); LLM consulted only when severity reaches the PAUSE threshold and the policy requires prerequisites (or when the source has no severity).

### Consistency, same 30-check protocol (5 identical targets x 6 lodash incidents)

| | v2 (`docs/consistency-report-v2.md`) | v3 (`docs/consistency-report-v3.md`) |
|---|---|---|
| ACCEPTED | 30/30 | 29/30 (1 MAJORITY_DISAGREE, no verdict stored, no action: fail-safe) |
| DISAGREE votes | 18 | 7 |
| AGREE share, non-idle | 83.3% | 92.6% |
| moderate incidents with any DISAGREE | 9 txs | 0 txs |
| incidents with identical action on all 5 targets | 6/6 | 5/6 |

The one unstable incident is GHSA-r5fr-rjxr-66jc (`_.template` imports injection). Its advisory adds a chained condition: "if Object.prototype has been polluted by any other vector, polluted keys reach Function()". The manifest declares an external JSON merge path, so some validators judged the prerequisite met (PAUSE) and others not (RESTRICT). This is genuine ambiguity in the advisory text, not model noise. Under v2 this incident was 5/5 RESTRICT only because prerequisites were also being compared and disagreements happened to fall on the leader's side.

Guardian v4 adds interpretation rules to the prompt: judge only the advisory's primary attack path; if the config lists `uses_functions`, prerequisites are met only when an advisory-named vulnerable function appears there; explicit contrary config statements mean false; unknown means false. Re-test on v4: see below.

### demo-repo RESUME via keeper (v3)
`check` → PAUSE (re-adjudicated on v3; vault already PAUSED, duplicate action ignored) → `resume` denied STILL_AFFECTED → `update-manifest` to 1.3.0 → `resume` accepted → vault E `GHSA-m9f4-gp45-2v27|RESUME->NORMAL`, mode NORMAL. All four steps from the keeper account that owns the target.

### v4 re-test (`0xd6Ca44edfD0C8ba7043a2AdD6Ec97597EC17787F`, prompt interpretation rules)

| Incident | Targets | Result |
|---|---|---|
| GHSA-r5fr-rjxr-66jc (`_.template` imports, chained pollution clause) | 5 identical | 5/5 RESTRICT, prerequisites_met=false |
| GHSA-35jh-r3h4-6jhm (`_.template` variable) | 5 identical | 5/5 RESTRICT, prerequisites_met=false |
| GHSA-p6mc-m468-83gw (set / zipObjectDeep, in `uses_functions`) | 3 | 3/3 PAUSE, prerequisites_met=true |
| GHSA-m9f4-gp45-2v27 (demo repo, prerequisite stated in prose, no function names) | 1 | PAUSE, prerequisites_met=true |

The rules removed the r5fr instability without flipping the true-positive cases. Current production Guardian is v4; site/config.json and .env point to it.

## Day 9 (2026-09-05): Studionet v5 rebuilt with one command

`npx tsx keeper/cli.ts deploy-all studionet` deployed Guardian v5 `0x02d8b2dd887B774E9d518Fcb223d664E33cf4608`, one ToyVault per target (vault-a `0x8A5d…b6A9`, vault-b `0x0A43…3938`, vault-c `0x9Ca3…9083`, demo-repo `0xd662…9122`), set guardians and registered all four targets in 90 seconds, then rewrote deployments.json (current/history) and the site config.

v5 adds `request_resume_all(target_id)`: one transaction re-adjudicates every open incident. Run log `docs/studionet-v5-rebuild.log`:

| Step | Result |
|---|---|
| vault-a p6mc | PAUSE |
| vault-b p6mc | NONE (4.18.1) |
| vault-c p6mc | RESTRICT (prerequisites not met) |
| demo-repo GHSA-m9f4 (GitHub repo advisory) | PAUSE |
| vault-a 35jh | RESTRICT |
| update-manifest vault-a to 4.18.1, then `resume-all` | both open incidents resumed in one tx, `still_open: []`, vault NORMAL |

End state: vault-a NORMAL, vault-b NORMAL, vault-c RESTRICTED, demo-repo PAUSED. The site reads this environment.
