# Demo video script (target 2:30 to 3:00)

Screen recording, no face. Voice-over lines in quotes; on-screen actions in brackets. Record against Studionet (fast finality); mention Bradbury at the end with the site.

## 0:00 to 0:20, the problem
[Slide: "Who is allowed to pause a protocol?" with two icons: admin key, CVSS bot]
"Today an emergency pause is either an admin key or a bot reacting to a CVSS score. One trusts a few people, the other pauses things that were never exploitable."

## 0:20 to 0:45, what Guardian judges
[Slide: manifest JSON on the left, advisory on the right, arrow to NONE / RESTRICT / PAUSE]
"Guardian is a GenLayer Intelligent Contract. A protocol declares what it actually runs. When a public advisory appears, validators independently fetch it, decide whether it applies to this deployment, and derive the action from a policy the protocol committed to in advance."

## 0:45 to 1:30, the live proof (terminal + site side by side)
[Terminal: `keeper check vault-a osv GHSA-p6mc-m468-83gw`]
"Real advisory, lodash prototype pollution. vault-a runs 4.17.15 and merges untrusted JSON with set and zipObjectDeep."
[Site refreshes: vault-a RESTRICTED, then PAUSED]
"RESTRICT lands the moment consensus accepts. PAUSE lands only after finality. Optimistic finality becomes risk escalation."
[Terminal: `keeper check vault-c osv GHSA-p6mc-m468-83gw`]
"Same advisory, vault-c uses lodash only for internal constants. Validators say the prerequisite is not met. RESTRICT, not PAUSE."
[Terminal: `keeper check vault-b osv GHSA-p6mc-m468-83gw`]
"vault-b is patched. NONE. No LLM was even asked."

## 1:30 to 2:05, the judge can trigger it
[Browser: GitHub Security tab of guardian-demo-target, advisory GHSA-m9f4 published]
"This advisory was published by a human on a demo repo. Guardian read it from the GitHub API."
[Terminal: `keeper check demo-repo github_repo_advisory GHSA-m9f4-gp45-2v27 --wait-final`; site shows PAUSED]
"Publish to pause in under three minutes. Anyone can reproduce this on their own repository."

## 2:05 to 2:35, recovery and numbers
[Terminal: `keeper update-manifest demo-repo manifest-demo-repo-fixed.json` then `keeper resume-all demo-repo`; site shows NORMAL]
"Upgrade the dependency, ask for resume. Validators re-check the evidence before anything unpauses."
[Site: consistency panel]
"Five identical targets, six advisories, thirty transactions. After moving consensus to outcome enums and gating the LLM, validator disagreement went from eighteen votes to zero."

## 2:35 to 2:55, close
[Site: Bradbury switcher, vault-a lifecycle]
"Guardian is live on Bradbury with twenty-one real transactions signed by our wallet. Everything you saw is a deployed contract, a keeper anyone can run, and a policy the protocol owns. Autonomous Protocols track. Thank you."

## Recording checklist
- Studionet environment freshly rebuilt (keeper deploy-all studionet), site config pointing at it.
- vault-a, vault-c, vault-b unadjudicated for p6mc before recording; demo-repo unadjudicated for m9f4 (register a new target id if needed).
- Site open in a second window with network = Studionet; refresh after each accepted tx.
- Terminal font large; `--wait-final` only on the demo-repo step.
