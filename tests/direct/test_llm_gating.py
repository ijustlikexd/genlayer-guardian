"""LLM is consulted only where it can change the outcome; consensus is on outcome fields only."""
from tests.direct.helpers import DEFAULT_POLICY, MessageCapture, deploy_guardian, mock_llm_prereq, mock_osv, osv_vuln, register


def test_moderate_severity_skips_llm_entirely(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c)
    direct_vm.strict_mocks = True           # any LLM call would raise MockNotFound -> SOURCE_ERROR path
    mock_osv(direct_vm, osv_vuln(severity="MODERATE"))
    v = c.get_verdict(c.check("vault-a", "osv", "GHSA-demo-0001"))
    assert v["action"] == "RESTRICT" and v["reason_code"] == "SEVERITY_AT_RESTRICT_LEVEL"
    assert v["prerequisites_met"] is False


def test_policy_without_prereq_requirement_skips_llm(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c, policy={**DEFAULT_POLICY, "require_prerequisites_met_for_pause": False})
    direct_vm.strict_mocks = True
    mock_osv(direct_vm, osv_vuln(severity="CRITICAL"))
    v = c.get_verdict(c.check("vault-a", "osv", "GHSA-demo-0001"))
    assert v["action"] == "PAUSE"


def test_missing_severity_asks_llm_for_bucket_only_when_prereq_not_required(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c, policy={**DEFAULT_POLICY, "require_prerequisites_met_for_pause": False})
    mock_osv(direct_vm, osv_vuln(severity=None))
    direct_vm.mock_llm(r"security applicability judge", '{"severity_bucket": "high"}')   # no prerequisites field
    v = c.get_verdict(c.check("vault-a", "osv", "GHSA-demo-0001"))
    assert v["severity_bucket"] == "high" and v["action"] == "PAUSE"


def test_prereq_disagreement_on_high_still_breaks_consensus(direct_vm, direct_deploy, direct_owner):
    """At PAUSE level prerequisites change the action, so a differing validator must disagree."""
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c)
    mock_osv(direct_vm, osv_vuln(severity="HIGH")); mock_llm_prereq(direct_vm, True)
    c.check("vault-a", "osv", "GHSA-demo-0001")
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(severity="HIGH")); mock_llm_prereq(direct_vm, False)
    assert direct_vm.run_validator() is False
