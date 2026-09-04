"""Recorded real responses (tests/fixtures, fetched 2026-09-04) replayed through the adapters."""
import json
from pathlib import Path

from tests.direct.helpers import (
    DEFAULT_MANIFEST, DEFAULT_POLICY, GH_ADV_RE, OSV_QUERY_RE, OSV_VULN_RE, MessageCapture, deploy_guardian,
    mock_llm_prereq, register,
)

FX = Path("tests/fixtures")


def _read(name):
    return (FX / name).read_text(encoding="utf-8")


def _manifest(version):
    return {**DEFAULT_MANIFEST, "dependencies": [{"ecosystem": "npm", "name": "lodash", "version": version}]}


def _mock_real_osv(vm, version):
    vm.mock_web(OSV_VULN_RE.format(id="GHSA-p6mc-m468-83gw"), {"status": 200, "body": _read("osv_GHSA-p6mc-m468-83gw.json")})
    vm.mock_web(OSV_QUERY_RE, {"method": "POST", "status": 200, "body": _read(f"osv_query_lodash_{version}.json")})


def test_real_osv_lodash_4_17_15_is_affected(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    cap = MessageCapture(direct_vm)
    register(c, manifest=_manifest("4.17.15"))
    _mock_real_osv(direct_vm, "4.17.15")
    mock_llm_prereq(direct_vm, True)
    v = c.get_verdict(c.check("vault-a", "osv", "GHSA-p6mc-m468-83gw"))
    assert v["applicable"] is True
    assert v["severity_bucket"] == "high"          # OSV database_specific.severity = HIGH
    assert v["action"] == "PAUSE"
    assert v["evidence"]["published"].startswith("2020")
    assert [m["calldata"]["args"][1] for m in cap.actions()] == ["RESTRICT", "PAUSE"]
    assert direct_vm.run_validator() is True


def test_real_osv_lodash_4_17_21_not_affected_by_this_id(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c, manifest=_manifest("4.17.21"))
    _mock_real_osv(direct_vm, "4.17.21")
    v = c.get_verdict(c.check("vault-a", "osv", "GHSA-p6mc-m468-83gw"))
    assert v["action"] == "NONE" and v["reason_code"] == "VERSION_NOT_AFFECTED"
    # the real 4.17.21 query still lists other vulns; only the queried incident id matters
    assert "GHSA-f23m-r3pf-42rh" in _read("osv_query_lodash_4.17.21.json")


def test_real_osv_cvss_vector_scores_match_github(direct_vm, direct_deploy, direct_owner):
    """Deterministic CVSS calc: OSV vector for GHSA-p6mc / GHSA-r5fr -> GitHub says 7.4 / 8.1."""
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)  # loads SDK path so contract module is importable
    import importlib, sys
    mod = sys.modules[[k for k in sys.modules if k.endswith("_contract_Guardian")][0]]
    assert mod._cvss_base_score("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H") == 8.1
    assert mod._cvss_base_score("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H") == 7.4
    assert mod._cvss_base_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H") == 9.8
    assert mod._cvss_base_score("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N") == 6.4
    assert mod._cvss_base_score("not a vector") is None


def test_real_github_repo_advisory_high_range_incl_4_17_21(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    cap = MessageCapture(direct_vm)
    register(c, manifest=_manifest("4.17.21"), source_repo="lodash/lodash")
    direct_vm.mock_web(GH_ADV_RE.format(owner="lodash", repo="lodash", ghsa="GHSA-r5fr-rjxr-66jc"),
                       {"status": 200, "body": _read("gh_repo_lodash_GHSA-r5fr-rjxr-66jc.json")})
    mock_llm_prereq(direct_vm, True)
    v = c.get_verdict(c.check("vault-a", "github_repo_advisory", "GHSA-r5fr-rjxr-66jc"))
    assert v["applicable"] is True and v["severity_bucket"] == "high" and v["action"] == "PAUSE"
    assert v["evidence"]["affected_range"] == ">=4.0.0, <=4.17.23"
    assert [m["calldata"]["args"][1] for m in cap.actions()] == ["RESTRICT", "PAUSE"]


def test_real_github_medium_maps_to_moderate_exact_version_range(direct_vm, direct_deploy, direct_owner):
    lst = json.loads(_read("gh_repo_lodash_list.json"))
    adv = next(a for a in lst if a["ghsa_id"] == "GHSA-f23m-r3pf-42rh")   # severity "medium", range "4.17.23"
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    cap = MessageCapture(direct_vm)
    register(c, manifest=_manifest("4.17.23"), source_repo="lodash/lodash")
    direct_vm.mock_web(GH_ADV_RE.format(owner="lodash", repo="lodash", ghsa="GHSA-f23m-r3pf-42rh"), {"status": 200, "body": json.dumps(adv)})
    mock_llm_prereq(direct_vm, True)
    v = c.get_verdict(c.check("vault-a", "github_repo_advisory", "GHSA-f23m-r3pf-42rh"))
    assert v["applicable"] is True
    assert v["severity_bucket"] == "moderate"
    assert v["action"] == "RESTRICT" and v["reason_code"] == "SEVERITY_AT_RESTRICT_LEVEL"
    assert [m["calldata"]["args"][1] for m in cap.actions()] == ["RESTRICT"]
