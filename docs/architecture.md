# Architecture

## Components

| Component | Type | Role |
|---|---|---|
| `Guardian` | GenLayer intelligent contract (`contracts/Guardian.py`) | Registry of targets, adjudicator of incidents, source of the two enforcement messages. |
| `ToyVault` | GenLayer intelligent contract (`contracts/ToyVault.py`) | Reference target implementation: idempotent, escalation-only mode machine driven entirely by messages from its guardian. |
| Keeper | TypeScript CLI (`keeper/`) | Permissionless trigger. Submits `check`/`request_resume` transactions and polls OSV for new advisories (`watch`). Never adjudicates. |
| Source adapters | Pure functions inside `Guardian.py`, run per validator | `_fetch_osv`, `_fetch_github_repo`: turn a raw advisory response into `{applicable, bucket, reason_code, summary, details, evidence}`. |
| Semantic layer | `_judge_prerequisites`, one `gl.nondet.exec_prompt` call | Answers `prerequisites_met` and/or `severity_bucket`, only when the answer can change the outcome. |
| Site | Static Vite/TS page (`site/`) | Read-only view of live Studionet state via `genlayer-js`. No writes. |

## Data flow

```
keeper.check(target_id, source, incident_id)
  -> Guardian.check()
       deterministic prechecks (target exists+enabled, source in registry, incident_id shape,
                                 not already adjudicated for this manifest/policy version)
       gl.vm.run_nondet(leader_fn, validator_fn):
         leader_fn(), and independently every validator's own leader_fn():
           1. fetch advisory over gl.nondet.web (OSV vuln + query, or GitHub repo advisory)
           2. deterministic applicability: package present in manifest? version in range?
              withdrawn? -> {applicable, bucket, reason_code, evidence}
           3. if applicable and (severity unknown OR severity already at PAUSE threshold
              AND policy requires prerequisites for PAUSE):
                gl.nondet.exec_prompt(...) -> {prerequisites_met?, severity_bucket?}
           4. _derive_action(applicable, bucket, prereq, policy) -> (action, reason_code)
         validator_fn compares consensus_key(mine) == consensus_key(leader's claimed result)
       MAJORITY_AGREE -> verdict written to Guardian.verdicts, action enforced (see below)
       otherwise -> protocol-level Undetermined, nothing written, nothing enforced
       [returns verdict key]
  -> keeper prints / polls get_verdict(key)
```

Everything inside `run_nondet` (fetching, LLM call, and the deterministic policy derivation done
right after them) is re-executed independently by every validator. Only the *outcome* is compared.

## The frozen decision order

Copied from `GUARDIAN_SPEC.md` section 4.5, and implemented exactly as numbered in
`Guardian.check` / the adapter functions:

1. **Deterministic, outside `run_nondet`.** Target exists and is enabled; `source` is in the
   source registry; `incident_id` matches the id shape; if `source == github_repo_advisory`, the
   target has a `source_repo`; the `(target, source, incident, manifest_version, policy_version)`
   key has no prior *final* verdict (an `INSUFFICIENT_EVIDENCE` verdict is retriable, anything
   else raises `Already adjudicated`).
2. **Deterministic, inside `run_nondet`.** Fetch the advisory. `withdrawn` (or GitHub
   `withdrawn_at`/`state == withdrawn`) -> `INSUFFICIENT_EVIDENCE` / `ADVISORY_WITHDRAWN`. Package
   not found among the manifest's dependencies -> `NONE` / `PACKAGE_NOT_DEPLOYED`. Version not in
   the affected range (OSV's own server-side `POST /v1/query` match, or the GitHub range parser)
   -> `NONE` / `VERSION_NOT_AFFECTED`. Severity bucket is read from `database_specific.severity` or
   computed locally from a CVSS v3 vector (`_cvss_base_score`); if neither is present, it is left
   empty for the semantic layer to fill in.
3. **Semantic (LLM), only when `applicable` is true and only when it can change the result.**
   `_judge_prerequisites` asks at most two fields: `severity_bucket` (only if step 2 could not
   determine it) and `prerequisites_met` (only if the policy requires prerequisites for PAUSE and
   severity is already at or above the PAUSE threshold, or severity itself is still unknown). The
   LLM never sees or returns `action`. Output is a fixed, minimal JSON object; anything that fails
   schema validation is `INSUFFICIENT_EVIDENCE` / `LLM_OUTPUT_INVALID`.
4. **Deterministic action derivation.** `_derive_action(applicable, bucket, prereq, policy)`:
   not applicable -> `NONE`/`NOT_APPLICABLE`. Severity below `min_severity_for_restrict` ->
   `NONE`/`BELOW_RESTRICT_THRESHOLD`. Otherwise `RESTRICT`/`SEVERITY_AT_RESTRICT_LEVEL`; if
   severity also reaches `min_severity_for_pause` and (`prerequisites_met` or the policy does not
   require it), escalate to `PAUSE`/`VERSION_IN_RANGE_PREREQ_MET`, else stay at
   `RESTRICT`/`PREREQ_NOT_MET_DOWNGRADED`. Finally clamp to `policy.max_action_on_finalized`;
   if the pre-clamp action exceeded it, the result is `CLAMPED_BY_POLICY`.
5. **Validator repeat.** Every validator (including the leader, re-run by every other validator)
   redoes steps 2-4 independently and compares only the consensus key.

## Consensus key rationale

```python
def _consensus_key(r: dict) -> tuple:
    return (r.get("applicable"), r.get("severity_bucket"), r.get("action"), r.get("reason_code"))
```

Only outcome fields are compared. `prerequisites_met` is stored on the verdict but deliberately
excluded from consensus: whenever it actually changes the outcome, `action` and `reason_code`
already differ, so comparing it separately only adds a way to disagree on something that turns out
not to matter (e.g. two validators both landing on RESTRICT for different underlying reasons about
prerequisites at a severity where prerequisites don't gate the action). This produced a measured
drop in DISAGREE votes between v2 and v3 (18 -> 7 out of ~150, see
[consistency-report-v2.md](consistency-report-v2.md) / [-v3.md](consistency-report-v3.md)) without
changing which action any incident received.

## Why LLM gating

The LLM is called only when its answer can change the result:

- `severity_bucket` is asked only if neither `database_specific.severity` nor a parseable CVSS
  vector was present.
- `prerequisites_met` is asked only if the policy requires prerequisites for PAUSE *and* severity
  is already at or above the PAUSE threshold (or severity itself is still unknown, in which case
  both are asked together).

Below the PAUSE threshold, `prerequisites_met` cannot change `_derive_action`'s output (a moderate
incident with `require_prerequisites_met_for_pause=true` still only ever reaches RESTRICT), so
asking the LLM there only adds prompt-injection surface and a chance of spurious disagreement for
zero effect on the verdict. This is the single largest driver of the v2 -> v3 consistency
improvement: moderate-severity incidents with any DISAGREE vote went from 9 transactions to 0.

## Storage layout

```python
@dataclass
class TargetRecord:
    owner: Address
    address: Address          # Target IC address (must implement Target.Write.apply_action)
    manifest_json: str
    policy_json: str
    source_repo: str          # "" or "owner/repo", required for github_repo_advisory
    manifest_version: u256    # bumped by update_manifest
    policy_version: u256      # bumped by update_policy
    enabled: bool

@dataclass
class VerdictRecord:
    key: str                  # see below
    target_id: str
    source: str
    incident_id: str
    applicable: bool
    severity_bucket: str
    prerequisites_met: bool   # stored, not compared in consensus
    action: str
    reason_code: str
    evidence_json: str        # source, id, published, affected_package, deployed_version,
                               # affected_range, observed_at -- free text, excluded from consensus
    manifest_version: u256    # manifest/policy version this verdict was computed against
    policy_version: u256
    resolved_at: str
    attempts: u256            # count of INSUFFICIENT_EVIDENCE retries that led here
    resumed: bool
```

`Guardian.targets: TreeMap[str, TargetRecord]` and `Guardian.verdicts: TreeMap[str, VerdictRecord]`
are the entire contract state besides `owner`.

### Verdict key format

```
f"{target_id}|{source}|{incident_id}|m{manifest_version}|p{policy_version}"
```

Binding the manifest and policy version into the key means an `update_manifest` or
`update_policy` call automatically opens a fresh adjudication slot for the same incident, rather
than silently reusing a stale verdict computed against an old config. `verdict_key_for` (a view)
computes this from a target's *current* versions so callers never have to track version numbers
themselves.

## Message flow: `on='accepted'` vs `on='finalized'`

```python
if action in ("RESTRICT", "PAUSE"):
    target = Target(t.address)
    if ACTION_ORDER["RESTRICT"] <= ACTION_ORDER.get(policy["max_action_on_accepted"], 0):
        target.emit(on="accepted").apply_action(incident_id, "RESTRICT")
    if action == "PAUSE":
        target.emit(on="finalized").apply_action(incident_id, "PAUSE")
    elif policy["max_action_on_accepted"] == "NONE":
        target.emit(on="finalized").apply_action(incident_id, "RESTRICT")
```

`on='accepted'` messages are delivered once the enclosing `check` transaction itself reaches
ACCEPTED consensus; `on='finalized'` messages wait for FINALIZED. This maps GenLayer's own
optimistic-finality distinction directly onto risk escalation: the bounded, reversible action goes
out at the earlier, weaker finality guarantee, and the harsher one waits for the stronger
guarantee. `RESUME` is always sent `on='finalized'`, since lifting an action should never be
optimistic. Measured gap between the two stages in the live three-scenario run: about two minutes,
of which most is the underlying finality wait rather than adjudication time.

## Keeper role and trust model

The keeper is a pure trigger. It:

- submits `check(target_id, source, incident_id)` and `request_resume(target_id, verdict_key)`,
- polls OSV for a target's manifest dependencies (`watch`) and calls `check` on new, non-withdrawn,
  not-yet-adjudicated ids,
- reads views (`get_verdict`, `get_target`, `get_state`).

It never runs `_derive_action`, never reads `policy_json` for its own decisions, and never
evaluates advisory content. A malicious or broken keeper can only affect *when* `check` is called
and for *which* incident id, never the outcome: `check` recomputes everything from scratch inside
`run_nondet`, and a false or garbage `incident_id` simply resolves to `ADVISORY_NOT_FOUND` (via
`_fetch_osv`/`_fetch_github_repo` returning `None` from a 404). A keeper that stops running just
delays enforcement; it can never forge one.

## Failure modes

| Failure | Guardian's response | Result |
|---|---|---|
| Advisory not found (404) | `ADVISORY_NOT_FOUND` | `INSUFFICIENT_EVIDENCE`, no action, retriable |
| Advisory withdrawn | `ADVISORY_WITHDRAWN` | `INSUFFICIENT_EVIDENCE`, no action; RESUME path can close an open incident on this reason |
| GitHub repo advisory still a draft | `ADVISORY_NOT_PUBLISHED` | `INSUFFICIENT_EVIDENCE`, no action |
| Version range unparseable (GitHub) | `RANGE_UNPARSEABLE` | `INSUFFICIENT_EVIDENCE`, no action |
| OSV query call itself fails | `SOURCE_ERROR` | `INSUFFICIENT_EVIDENCE`, no action |
| LLM output fails schema validation | `LLM_OUTPUT_INVALID` | `INSUFFICIENT_EVIDENCE`, no action |
| Package not in manifest | `PACKAGE_NOT_DEPLOYED` | `NONE`, no action |
| Version not in affected range | `VERSION_NOT_AFFECTED` | `NONE`, no action |
| Validators disagree on the consensus key | GenLayer protocol: `Undetermined` | no verdict stored, no action, no state change at all |
| Same `(target, source, incident, manifest_version, policy_version)` already finally adjudicated | `Already adjudicated` revert before any nondet work | no wasted validator work, no duplicate verdict |
| GitHub 60 req/h rate limit hit by one validator | that validator's `leader_fn` returns `SOURCE_ERROR`/`INSUFFICIENT_EVIDENCE`, disagreeing with validators that succeeded | consensus fails to `Undetermined` rather than a wrong verdict; retriable |
| Repeated `apply_action` message for the same `incident_id\|action` | ToyVault's `applied` map short-circuits | logged `dup:...`, state unchanged |
| Action arrives for an incident already `RESUME`d | ToyVault checks `resolved` before applying (except `RESUME` itself) | logged `late:...`, state unchanged |
