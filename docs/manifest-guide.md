# Manifest and policy guide

This is for a target owner registering a protocol with Guardian. The manifest and policy are the
only inputs a target owner controls; how carefully they are written determines whether Guardian's
adjudication is stable (same incident, same target, same answer every time) or ambiguous.

## Manifest

```json
{
  "target_id": "vault-a",
  "target_address": "0x...",
  "dependencies": [
    {"ecosystem": "npm", "name": "lodash", "version": "4.17.15"}
  ],
  "config": {
    "accepts_external_json_merge": true,
    "uses_functions": ["merge", "set", "zipObjectDeep"],
    "input_source": "untrusted user JSON"
  },
  "manifest_version": 1
}
```

### `dependencies`: exact versions

Each entry needs `ecosystem`, `name`, and `version` as non-empty strings (enforced by
`_parse_manifest` in `contracts/Guardian.py`). The version must be the exact version actually
deployed, not a range and not "latest":

- Applicability for OSV sources is decided by OSV's own server-side `POST /v1/query`, which
  compares this exact version string against every affected range in its database. A wrong or
  stale version produces a wrong `applicable` result deterministically, with no LLM involved to
  catch it.
- Applicability for `github_repo_advisory` sources uses a minimal range parser
  (`_version_in_range`) against the same exact version string. Supported clause forms: `< x`,
  `<= x`, `> x`, `>= x`, `= x`, or a bare version (treated as `=`), comma-separated for compound
  ranges like `>= 1.0, < 2.0`. Anything else (pre-release suffixes past the numeric core, `~`, `^`,
  wildcards) returns `RANGE_UNPARSEABLE` -> `INSUFFICIENT_EVIDENCE`, not a guess.
- Only ecosystem/name/version are matched. There is no transitive resolution: a vulnerable
  sub-dependency not listed here is invisible to Guardian by design (see README, "Deliberately out
  of scope").

Only one dependency per `(ecosystem, name)` is expected; if you list the same package twice,
`_match_dep` returns the first match.

### `config`: the semantic layer's only input

`config` is free-form JSON. The deterministic layer (`_fetch_osv`, `_fetch_github_repo`,
`_derive_action`) never reads it. It exists only to answer one question inside the LLM prompt:
*are this advisory's exploit prerequisites met by this deployment?* Fields that matter:

| Field | Semantics | Why it matters |
|---|---|---|
| `uses_functions` | **Whitelist**, not a description. A list of function/API names this deployment actually calls from the vulnerable package. | Prompt rule 2: if `uses_functions` (or similarly named) is present, prerequisites are met **only if** a function the advisory names as vulnerable appears in that list. An advisory about `_.template` cannot satisfy prerequisites for a deployment whose `uses_functions` lists only `chunk`/`uniq`, no matter how the rest of the config reads. |
| `input_source` | Where data reaching the vulnerable path originates (e.g. `"untrusted user JSON"` vs `"internal config file"`). | Lets the LLM judge whether the advisory's "attacker-controlled input" precondition holds. Leave it out and, per rule 5, the answer defaults to false. |
| Feature flags (e.g. `accepts_external_json_merge`, `feature_flags.user_config_merge`) | Boolean or enum toggles matching an advisory's described feature gate. | Prompt rule 3: if the advisory names a required condition and your config **explicitly states the opposite**, the answer is false. An explicit `false` is doing real work here, not merely omitting a field. |
| Anything not listed | Absence, not "not applicable". | Prompt rule 5: if the config lacks the information needed to decide, the answer is false. Guardian never treats a missing field as permission; it treats it as "cannot confirm exploitable," which is the safe direction. |

Write `config` the way you would document exposure in a real incident postmortem: name exactly
which functions you call, where the input to them comes from, and which optional features are on.
A manifest with only `dependencies` and no `config` will never reach PAUSE at a severity where
`require_prerequisites_met_for_pause` is true, because there is nothing for the LLM to confirm
prerequisites against and rule 5 makes the answer false — it will settle at RESTRICT instead.

## The four interpretation rules (v4 prompt)

These are the exact rules `_judge_prerequisites` gives the LLM, added after a real ambiguous case
(`GHSA-r5fr-rjxr-66jc`, a lodash advisory with a chained condition) produced a 2 PAUSE / 2 RESTRICT
/ 1 Undetermined split across five identical targets under v3:

1. **Judge only the advisory's primary attack path.** Ignore secondary or chained conditions such
   as "if the prototype has already been polluted by another vector." A manifest cannot state
   whether some *other*, unrelated vector already happened; asking the LLM to speculate about that
   is what produced the instability.
2. **`uses_functions` is a whitelist.** Prerequisites are met only if a function the advisory names
   as vulnerable is present there.
3. **An explicit contrary statement means false**, not "unclear."
4. **No stated prerequisites means true.** If the advisory describes no specific exploit
   precondition at all, applicability alone is enough.
5. *(Also always in force, from `_und`'s fail-safe default and rule 5 in the prompt)* **Unknown
   means false.** Missing information is never read as permission.

## Examples

**Good — specific, matches the advisory's own vocabulary:**

```json
"config": {
  "accepts_external_json_merge": true,
  "uses_functions": ["merge", "set", "zipObjectDeep"],
  "input_source": "untrusted user JSON"
}
```

This is `docs/examples/manifest-vault-d.json`'s shape. It let the watch-mode run on vault-a
correctly separate a real hit (`GHSA-p6mc-m468-83gw`, which names `set`/`zipObjectDeep`) from five
advisories about `_.template` or unrelated functions, entirely from `uses_functions` membership,
with zero manual review.

**Good — a narrow config for a target that only uses the package internally:**

```json
"config": {
  "accepts_external_json_merge": false,
  "uses_functions": ["chunk", "uniq"],
  "input_source": "internal constants only"
}
```

This is what produced `PREREQ_NOT_MET_DOWNGRADED` (RESTRICT, not PAUSE) for vault-c in the live
three-scenario run against the same advisory that PAUSEd vault-a.

**Bad — vague, invites rule 5's fail-safe-to-false:**

```json
"config": {"notes": "we use lodash for utility functions"}
```

No `uses_functions`, no `input_source`, no feature flags. Every prerequisites question about this
manifest resolves to false under rule 5, so this target can never reach PAUSE at a severity where
`require_prerequisites_met_for_pause` is true — not because it is safe, but because there is
nothing here for Guardian to confirm exploitability against. If the deployment really is exposed,
this manifest under-reports risk by stalling at RESTRICT.

**Bad — a range Guardian cannot parse (for a `github_repo_advisory` source):** an advisory range
like `^4.17.0` or `>=1.0.0-beta.1` will parse the base numeric triple but fail on the wildcard/
pre-release suffix, returning `RANGE_UNPARSEABLE`. Nothing to fix on the manifest side here — it is
the advisory author's range syntax that must fall into the supported clause forms; if you control
the advisory (the demo-repo flow), write ranges as `< 1.3.0`, `>= 1.0, < 2.0`, `= 1.2.3`, or a bare
version.

## Policy

```json
{
  "max_action_on_accepted": "RESTRICT",
  "max_action_on_finalized": "PAUSE",
  "min_severity_for_restrict": "moderate",
  "min_severity_for_pause": "high",
  "require_prerequisites_met_for_pause": true,
  "auto_resume": false,
  "policy_version": 1
}
```

| Field | Clamps | Notes |
|---|---|---|
| `max_action_on_accepted` | The action allowed at the `accepted` finality stage. | Schema-validated to `NONE` or `RESTRICT` only — `PAUSE` is rejected outright by `_parse_policy`; a target can never pre-authorize an irreversible action at the weaker finality guarantee. |
| `max_action_on_finalized` | The action allowed at the `finalized` stage — the final ceiling on everything `_derive_action` computes. | `NONE`, `RESTRICT`, or `PAUSE`. If the computed action exceeds this, it is downgraded and the reason code becomes `CLAMPED_BY_POLICY`. Setting this to `RESTRICT` means the target can never be PAUSEd by Guardian at all, only restricted. |
| `min_severity_for_restrict` | The severity floor below which the result is `NONE` regardless of applicability. | One of `low`/`moderate`/`high`/`critical`. |
| `min_severity_for_pause` | The severity floor for a PAUSE candidate. | Must be `>=` `min_severity_for_restrict` (`_parse_policy` rejects an inverted pair at registration). |
| `require_prerequisites_met_for_pause` | Whether `prerequisites_met=false` downgrades a would-be PAUSE to RESTRICT. | Set `false` only if you want severity alone to be sufficient for PAUSE — this also skips the LLM prerequisites question entirely for incidents below `min_severity_for_pause`, and asks it unconditionally above that threshold when true. |
| `auto_resume` | Reserved; not read by any deterministic logic in the current contract. | Document only; RESUME today always requires an explicit `request_resume` call re-adjudicated by Guardian, regardless of this flag. |
| `policy_version` | Not a field consumed by validation; the contract tracks its own `policy_version` counter, bumped on every `update_policy`. | Included in the schema for the target owner's own bookkeeping; the on-chain source of truth is `TargetRecord.policy_version`. |

Policy can only ever tighten what a validator's raw judgment would produce, never loosen it: there
is no field that raises an action above what `_derive_action`'s severity/prerequisite logic
already computed, only ceilings (`max_action_on_*`) and floors (`min_severity_for_*`) that can cut
it down.
