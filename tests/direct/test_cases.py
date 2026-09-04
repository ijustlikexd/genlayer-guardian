"""Ground-truth driven tests: datasets/cases.json -> Guardian.check verdict + emitted messages."""
import copy
import json
from pathlib import Path

import pytest

from tests.direct.helpers import (
    DEFAULT_MANIFEST, DEFAULT_POLICY, MessageCapture, deploy_guardian, gh_adv, mock_gh, mock_llm_prereq, mock_osv,
    osv_vuln, register,
)

CASES = json.loads(Path("datasets/cases.json").read_text(encoding="utf-8"))["cases"]


def _apply(case, direct_vm, c):
    manifest = copy.deepcopy(DEFAULT_MANIFEST)
    manifest.update(case.get("manifest") or {})
    policy = dict(DEFAULT_POLICY, **(case.get("policy") or {}))
    register(c, manifest=manifest, policy=policy, source_repo=case.get("source_repo", ""))
    fx = case.get("fixture")
    if case["source"] == "osv":
        vid = case.get("incident_id", "GHSA-demo-0001")
        vuln = osv_vuln(vid, **fx) if fx is not None else vid
        qh = case.get("query_hit", True)
        if isinstance(qh, dict):  # explicit hit list: {"ids": [...], "aliases": [...]}
            from tests.direct.helpers import osv_query_hit
            qh = osv_query_hit(*qh.get("ids", []), aliases=qh.get("aliases", ()))
        mock_osv(direct_vm, vuln, query_hit=qh, vuln_status=case.get("vuln_status", 200),
                 query_status=case.get("query_status", 200), vuln_raw=case.get("vuln_raw"))
        incident = vid
    else:
        owner, repo = case["source_repo"].split("/")
        adv = gh_adv(**fx)
        mock_gh(direct_vm, owner, repo, adv, status=case.get("gh_status", 200))
        incident = adv["ghsa_id"]
    if case.get("llm_raw") is not None:
        mock_llm_prereq(direct_vm, None, raw=case["llm_raw"])
    elif case.get("llm_prereq") is not None:
        mock_llm_prereq(direct_vm, case["llm_prereq"], case.get("llm_bucket"))
    return incident


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_case(direct_vm, direct_deploy, direct_owner, case):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    cap = MessageCapture(direct_vm)
    incident = _apply(case, direct_vm, c)
    key = c.check("vault-a", case["source"], incident)
    v = c.get_verdict(key)
    for k, want in case["expect"].items():
        assert v[k] == want, f"{case['id']} field {k}: got {v[k]!r} want {want!r} (verdict={v})"
    got = [f"{m['calldata']['args'][1]}@{m['on']}" for m in cap.actions()]
    assert got == case["expect_messages"], f"{case['id']} messages {got}"
    for m in cap.actions():
        assert m["calldata"]["method"] == "apply_action"
        assert m["calldata"]["args"][0] == incident
    # validator with identical data agrees
    assert direct_vm.run_validator() is True


def test_case_distribution():
    actions = [c["expect"]["action"] for c in CASES]
    assert len(CASES) >= 15
    assert actions.count("PAUSE") >= 4
    assert actions.count("RESTRICT") >= 3
    assert actions.count("NONE") >= 4
    assert actions.count("INSUFFICIENT_EVIDENCE") >= 4
