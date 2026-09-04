# Guardian, in one page

**Track:** Autonomous Protocols (contracts that govern other contracts' emergency posture from public evidence, with no admin key).

**One-liner (180 chars):**
Guardian is an Intelligent Contract that adjudicates public security incidents against a protocol's declared dependencies and enforces a pre-committed safety policy in two finality-aware stages.

**Why GenLayer:** the question is not "is there a CVE" but "does this incident apply to *this* deployment, and what does its own policy allow". That needs web evidence, a semantic judgment, and a result no single operator controls. Validators fetch the advisory independently, agree on outcome enums only, and the target contract executes RESTRICT on acceptance and PAUSE on finalization. Remove GenLayer and you are back to an admin key or a bot on CVSS.

## What it does

| Layer | Deterministic | Semantic (LLM, gated) |
|---|---|---|
| Applicability | OSV server-side version match, package identity, withdrawn state | none |
| Severity | OSV / GitHub bucket, CVSS v3 vector computed on-chain | only if the source has no severity |
| Prerequisites | none | one boolean: are the advisory's exploit preconditions met by `manifest.config`, only when severity reaches the PAUSE threshold |
| Action | policy clamp: NONE / RESTRICT / PAUSE, INSUFFICIENT_EVIDENCE never acts | none |
| Enforcement | RESTRICT `on='accepted'` (bounded, reversible), PAUSE `on='finalized'`; RESUME only after re-adjudication | none |

## Evidence (all live, real OSV and GitHub data, real validator LLMs)

| | Studionet | Bradbury |
|---|---|---|
| Guardian | `0x02d8b2dd887B774E9d518Fcb223d664E33cf4608` (v5, one vault per target; v4 `0xd6Ca…787F` holds the consistency runs) | `0xc1D87D9a1998093fCA37ff460e53883698940FEe` |
| Three scenarios (PAUSE / NONE / RESTRICT) | yes | yes, 21 real tx from the owner's wallet, verdicts identical to Studionet |
| Watch discovery | 6 lodash advisories found and adjudicated; only the one whose functions the manifest uses reached PAUSE | |
| RESUME lifecycle | vault-a 6 incidents, vault-c, demo-repo | vault-a 6 incidents, finalized by the network |
| Judge-triggerable path | publish an advisory on your own repo, 2.5 min publish-to-pause | |

Consistency, 5 identical targets x 6 incidents, 30 checks per version:

| Version | Change | DISAGREE votes | AGREE share (non-idle) | Incidents stable |
|---|---|---|---|---|
| v2 | baseline | 18 | 83.3% | 6/6 |
| v3 | consensus on outcome only, LLM gating | 7 | 92.6% | 5/6 (1 tx rejected by protocol: fail-safe) |
| v4 | prompt interpretation rules | 0 | 100% | 6/6 |

Tests: 85 Direct Mode tests, 40 ground-truth cases, Red Team R1 to R18 mapped to evidence.

## Five-minute check (no wallet, no install)

1. Open https://ijustlikexd.github.io/genlayer-guardian/ . Switch to Bradbury. vault-a shows the incidents it went through and is NORMAL after RESUME.
2. Click vault-a, pick GHSA-p6mc-m468-83gw. Verdict: applicable, high, prerequisites met, PAUSE. Open the OSV link beside it: affected `< 4.17.19`, manifest says 4.17.15 and uses `set` / `zipObjectDeep`.
3. Pick GHSA-35jh-r3h4-6jhm on the same target: RESTRICT, prerequisites not met. The advisory is about `_.template`, which the manifest does not use. Same validators, same data, different outcome because of applicability.
4. Switch to Studionet, target vault-c: same advisory as step 2, config says internal constants only, result RESTRICT. Policy, not CVSS, decided.
5. Paste the verdict key `demo-repo|github_repo_advisory|GHSA-m9f4-gp45-2v27|m1|p1` into the lookup box: the incident a human published on GitHub at 14:43 and the vault that was paused by 14:46.

## Fifteen-minute check (CLI)

```
npx genlayer network set studionet
npx genlayer call 0x02d8b2dd887B774E9d518Fcb223d664E33cf4608 get_target --args vault-a
npx genlayer call 0x02d8b2dd887B774E9d518Fcb223d664E33cf4608 get_verdict --args "vault-a|osv|GHSA-p6mc-m468-83gw|m1|p1"
```
Then trigger your own: publish an advisory on a repo you own, register a target bound to it, `keeper check`, watch the vault flip. Steps in docs/demo-repo-advisory.md.

## Honest limits

Transitive dependencies are out of scope. Targets are Intelligent Contracts (Studio cannot write to EVM contracts yet). Advisory text can be genuinely ambiguous; v4 rules decide it conservatively and the protocol rejects the round when validators still disagree. Bradbury finalization takes the appeal window (about 30 minutes) plus the network finalizer; the keeper can finalize earlier.

## After the hackathon

OSV and GitHub advisory adapters, applicability judge, policy engine, finality-aware action controller, keeper, and recovery judge are each separable Builder contributions. EVM adapter for real protocols on Bradbury.
