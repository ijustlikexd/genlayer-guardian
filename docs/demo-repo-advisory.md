# Demo: trigger Guardian from a GitHub repository security advisory

Goal: a judge (or you) publishes a real security advisory on a repo you control, and Guardian
adjudicates it against a target whose manifest declares that repo's package. No OSV review queue is
involved: repo-level advisories are public the moment they are published.

## One-time setup (repo owner, manual, about 5 minutes)

1. Create a public repo, e.g. `guardian-demo-target`. It can contain just a `package.json` with
   `"name": "guardian-demo-target", "version": "1.2.0"`.
2. Repo Settings → Code security → enable "Private vulnerability reporting" (optional) and confirm the
   Security tab shows "Security advisories".
3. Register the target on Guardian with `source_repo` set to `<owner>/guardian-demo-target` and a manifest
   dependency `{"ecosystem":"npm","name":"guardian-demo-target","version":"1.2.0"}`:
   ```
   npx tsx keeper/cli.ts register demo-repo <vault_address> docs/examples/manifest-demo-repo.json docs/examples/policy-default.json <owner>/guardian-demo-target
   ```

## Publish an advisory (the trigger)

Security tab → Advisories → New draft security advisory:

| Field | Value |
|---|---|
| Ecosystem | npm |
| Package name | guardian-demo-target |
| Affected versions | `< 1.3.0` |
| Patched versions | `1.3.0` |
| Severity | High (or pick a CVSS vector) |
| Title | Prototype pollution in config merge |
| Description | State the exploit prerequisite explicitly, e.g. "Exploitable only when the service merges untrusted JSON into shared configuration." |

Publish it (no CVE needed). Note the `GHSA-xxxx-xxxx-xxxx` id. It is readable immediately at
`GET https://api.github.com/repos/<owner>/guardian-demo-target/security-advisories/<GHSA>`.

## Adjudicate

```
npx tsx keeper/cli.ts check demo-repo github_repo_advisory <GHSA> --wait-final
npx tsx keeper/cli.ts vault <vault_address>
```

Expected: validators fetch the advisory, deterministic layer matches package + range, LLM judges the
prerequisite against `manifest.config`, policy derives the action. With a manifest config that says
`"accepts_external_json_merge": true` you get PAUSE (RESTRICT at accepted, PAUSE at finalized); with
`false` you get RESTRICT.

## Variations for the video

- Edit the advisory to "Withdrawn" → `request_resume` returns `ADVISORY_WITHDRAWN`, vault RESUMEs.
- Bump the manifest to `1.3.0` → `request_resume` returns `NO_LONGER_AFFECTED`.

## Notes

- Repo advisories use severity words `low / medium / high / critical`; Guardian maps `medium` → moderate.
- Draft advisories are not public and return 404 to the validators → INSUFFICIENT_EVIDENCE.
- Ranges supported: `< x`, `<= x`, `>= a, < b`, `= x`, bare `x`. Anything else → INSUFFICIENT_EVIDENCE.
