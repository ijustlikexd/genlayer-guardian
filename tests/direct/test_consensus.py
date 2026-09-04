"""Leader/validator consensus and the resume path."""
import json

from tests.direct.helpers import (
    DEFAULT_MANIFEST, MessageCapture, deploy_guardian, mock_llm_prereq, mock_osv, osv_vuln, register,
)


def _setup(direct_deploy, direct_vm, owner):
    c = deploy_guardian(direct_deploy, direct_vm, owner)
    cap = MessageCapture(direct_vm)
    register(c)
    return c, cap


def test_validator_agrees_same_data(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    assert direct_vm.run_validator() is True


def test_validator_rejects_when_llm_disagrees_on_prerequisites(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, False)
    assert direct_vm.run_validator() is False


def test_validator_rejects_when_it_sees_withdrawn(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(withdrawn="2026-09-03T00:00:00Z"))
    assert direct_vm.run_validator() is False


def test_validator_rejects_forged_pause(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln(severity="LOW")); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    forged = {"applicable": True, "severity_bucket": "critical", "prerequisites_met": True,
              "action": "PAUSE", "reason_code": "VERSION_IN_RANGE_PREREQ_MET", "evidence": {}}
    assert direct_vm.run_validator(leader_result=forged) is False


def test_validator_ignores_observed_at(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    direct_vm.warp("2026-09-10T10:00:00Z")
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    direct_vm.warp("2026-09-10T10:07:00Z")
    assert direct_vm.run_validator() is True


def test_validators_agree_on_insufficient(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, "GHSA-demo-0001", vuln_status=500)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    assert direct_vm.run_validator() is True


# ------------------------------------------------------------------ resume

def _pause(c, direct_vm):
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    return c.check("vault-a", "osv", "GHSA-demo-0001")


def test_resume_denied_while_still_affected(direct_vm, direct_deploy, direct_owner):
    c, cap = _setup(direct_deploy, direct_vm, direct_owner)
    key = _pause(c, direct_vm)
    with direct_vm.expect_revert("Resume denied: STILL_AFFECTED"):
        c.request_resume("vault-a", key)
    assert [m["calldata"]["args"][1] for m in cap.actions()] == ["RESTRICT", "PAUSE"]


def test_resume_after_manifest_upgrade(direct_vm, direct_deploy, direct_owner):
    c, cap = _setup(direct_deploy, direct_vm, direct_owner)
    key = _pause(c, direct_vm)
    c.update_manifest("vault-a", json.dumps({**DEFAULT_MANIFEST, "dependencies": [{"ecosystem": "npm", "name": "lodash", "version": "4.17.21"}]}))
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(), query_hit=False)
    assert c.request_resume("vault-a", key) == "NO_LONGER_AFFECTED"
    last = cap.actions()[-1]
    assert (last["calldata"]["args"][1], last["on"]) == ("RESUME", "finalized")
    assert c.get_verdict(key)["resumed"] is True
    with direct_vm.expect_revert("Already resumed"):
        c.request_resume("vault-a", key)
    assert direct_vm.run_validator() is True


def test_resume_after_withdrawn(direct_vm, direct_deploy, direct_owner):
    c, cap = _setup(direct_deploy, direct_vm, direct_owner)
    key = _pause(c, direct_vm)
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(withdrawn="2026-09-05T00:00:00Z"))
    assert c.request_resume("vault-a", key) == "ADVISORY_WITHDRAWN"


def test_resume_only_by_target_owner_and_only_for_actions(direct_vm, direct_deploy, direct_owner, direct_bob):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    key = _pause(c, direct_vm)
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("Only target owner"):
            c.request_resume("vault-a", key)
    with direct_vm.expect_revert("Unknown verdict"):
        c.request_resume("vault-a", "nope")


# -------------------------------------------------------------- resume_all

def test_resume_all_partial_and_idempotent(direct_vm, direct_deploy, direct_owner):
    """Two open incidents; after upgrade one is no longer affected, one is withdrawn, a third still applies."""
    c, cap = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0001")); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")                       # PAUSE
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0002", severity="MODERATE"))
    c.check("vault-a", "osv", "GHSA-demo-0002")                       # RESTRICT
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0003", severity="MODERATE"))
    c.check("vault-a", "osv", "GHSA-demo-0003")                       # RESTRICT
    assert len(c.open_verdicts("vault-a")) == 3
    direct_vm.clear_mocks()
    # re-adjudication data: one shared OSV query response (same URL for every package) listing only 0003,
    # so 0001 is no longer affected, 0002 is withdrawn, 0003 is still affected
    from tests.direct.helpers import osv_query_hit
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0001"), query_hit=osv_query_hit("GHSA-demo-0003"))
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0002", severity="MODERATE", withdrawn="2026-09-05T00:00:00Z"))
    mock_osv(direct_vm, osv_vuln("GHSA-demo-0003", severity="MODERATE"))
    before = len(cap.actions())
    out = c.request_resume_all("vault-a")
    assert sorted(out["resumed"]) == ["GHSA-demo-0001", "GHSA-demo-0002"]
    assert out["denied"] == {"GHSA-demo-0003": "STILL_AFFECTED"}
    new = cap.actions()[before:]
    assert sorted((m["calldata"]["args"][0], m["calldata"]["args"][1], m["on"]) for m in new) == [
        ("GHSA-demo-0001", "RESUME", "finalized"), ("GHSA-demo-0002", "RESUME", "finalized")]
    assert c.open_verdicts("vault-a") == [k for k in c.open_verdicts("vault-a") if "0003" in k]
    assert direct_vm.run_validator() is True
    # second call only sees the remaining incident
    out2 = c.request_resume_all("vault-a")
    assert out2 == {"resumed": [], "denied": {"GHSA-demo-0003": "STILL_AFFECTED"}}


def test_resume_all_nothing_open_reverts_and_owner_only(direct_vm, direct_deploy, direct_owner, direct_bob):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert("Nothing to resume"):
        c.request_resume_all("vault-a")
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("Only target owner"):
            c.request_resume_all("vault-a")


def test_resume_all_validator_rejects_divergent_view(direct_vm, direct_deploy, direct_owner):
    c, _ = _setup(direct_deploy, direct_vm, direct_owner)
    mock_osv(direct_vm, osv_vuln()); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(), query_hit=False)
    c.request_resume_all("vault-a")
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(), query_hit=True)   # validator still sees it affected
    assert direct_vm.run_validator() is False
