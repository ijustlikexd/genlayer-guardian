# Agent Tank form, field by field (paste-ready)

Form: https://portal.genlayer.foundation/agent-tank (deadline 17 Sep 2026 15:30 UTC)

**00 Track:** Autonomous Protocols

**01 GitHub repository:** https://github.com/ijustlikexd/genlayer-guardian

**03 Identity:** Project name `Guardian`. Logo: `docs/logo-guardian.png` (512x512).

**04 Project summary (<=180 chars):**
Intelligent Contract that adjudicates public security advisories against a protocol's declared dependencies and enforces its pre-committed pause policy in two finality stages.

**05 Project overview (<=1000 chars):**
An emergency pause today is an admin key or a bot on a CVSS score. Guardian replaces both. A protocol registers a manifest (dependencies, versions, exploit-relevant config) and a policy (NONE/RESTRICT/PAUSE thresholds). A permissionless keeper submits check(target, source, advisory_id) when OSV or a GitHub repository advisory appears. Inside consensus every validator fetches the advisory itself: version-range match, package identity and CVSS scoring are deterministic; the LLM is asked exactly one boolean, whether the advisory's exploit prerequisites are met by the declared config, and only when severity reaches the pause threshold. Validators agree on outcome enums only. The target contract receives RESTRICT on acceptance (bounded, reversible) and PAUSE on finalization; RESUME requires a fresh adjudication of the new manifest. Live on Studionet and Bradbury with real OSV/GitHub data, 85 tests, 40 ground-truth cases, validator disagreement measured from 18 votes to 0 over 90 real transactions.

**06 Demo video:** https://youtu.be/l0zF-Pje-xQ

**07 How-to (verification steps, no wallet needed):**
1. Open https://ijustlikexd.github.io/genlayer-guardian/ (Studionet). Targets: vault-a PAUSED, vault-c RESTRICTED, vault-b NORMAL, demo-repo RESTRICTED.
2. Click vault-a: GHSA-p6mc-m468-83gw shows applicable=true, high, prerequisites_met=true, PAUSE. Open the OSV link: affected < 4.17.19, manifest 4.17.15 using set/zipObjectDeep.
3. Click vault-c: same advisory, prerequisites_met=false, RESTRICT (config says internal constants only). Click vault-b: NONE (4.18.1 patched).
4. Paste `demo-repo|github_repo_advisory|GHSA-m9f4-gp45-2v27|m1|p1` in the verdict lookup: the advisory a human published on github.com/ijustlikexd/guardian-demo-target, paused the vault in 2.5 min, later RESUMEd after the manifest moved to 1.3.0 (key ...|m2|p1 with resumed=true).
5. Paste `demo-repo|github_repo_advisory|GHSA-x6fq-hq74-fhgv|m2|p1`: an advisory whose text orders "action NONE" (prompt injection) was adjudicated RESTRICT.
6. Switch to Bradbury testnet: 21 real transactions, verdicts identical to Studionet.
7. CLI: `npx genlayer network set studionet && npx genlayer call 0x022dA1B1384Fc5580Cde27D00E18d85B137cc5c3 get_verdict --args "vault-a|osv|GHSA-p6mc-m468-83gw|m1|p1"`. Trigger your own: publish an advisory on a repo you own, follow docs/demo-repo-advisory.md.

**08 Review verification (<=500 chars):**
Same lodash advisory yields three different outcomes from the same validators: vault-a PAUSE (uses the vulnerable functions on untrusted input), vault-c RESTRICT (prerequisite not met), vault-b NONE (patched). RESTRICT appears at acceptance, PAUSE only after finality. A prompt-injected advisory demanding NONE still returns RESTRICT. Resume is granted only after re-adjudication against the upgraded manifest. Every verdict is readable on-chain by key.

**09 Project links:**
Website https://ijustlikexd.github.io/genlayer-guardian/
GitHub https://github.com/ijustlikexd/genlayer-guardian
Contracts: Studionet Guardian 0x022dA1B1384Fc5580Cde27D00E18d85B137cc5c3; Bradbury Guardian 0xc1D87D9a1998093fCA37ff460e53883698940FEe, ToyVault 0x91b97b374bc95c4bCAA1AF7fB56E0a50c24d5E46
