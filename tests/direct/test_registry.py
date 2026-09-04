"""Deterministic layer: registration, validation, access control, idempotency of check."""
import json

import pytest

from tests.direct.helpers import (
    DEFAULT_MANIFEST, DEFAULT_POLICY, MessageCapture, deploy_guardian, mock_llm_prereq, mock_osv, osv_vuln, register,
)


def test_register_and_get_target(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    register(c, source_repo="demo-org/demo-vault")
    t = c.get_target("vault-a")
    assert t["manifest_version"] == 1 and t["policy_version"] == 1 and t["enabled"] is True
    assert t["policy"]["max_action_on_accepted"] == "RESTRICT"
    assert t["source_repo"] == "demo-org/demo-vault"
    assert c.verdict_key_for("vault-a", "osv", "GHSA-x") == "vault-a|osv|GHSA-x|m1|p1"


def test_duplicate_target_id_rejected(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    register(c)
    with direct_vm.expect_revert("target_id exists"):
        register(c)


@pytest.mark.parametrize("manifest,msg", [
    ({"dependencies": []}, "Invalid manifest"),
    ({"dependencies": [{"ecosystem": "npm", "name": "lodash"}]}, "Invalid manifest"),
    ({"dependencies": [{"ecosystem": "npm", "name": "lodash", "version": "1"}], "config": "x"}, "Invalid manifest"),
    ([], "Invalid manifest"),
])
def test_invalid_manifest(direct_vm, direct_deploy, direct_owner, manifest, msg):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert(msg):
        register(c, manifest=manifest)


@pytest.mark.parametrize("policy", [
    {"max_action_on_accepted": "PAUSE"},                      # hard cap: accepted stage may never pause
    {"max_action_on_finalized": "HALT"},
    {"min_severity_for_restrict": "high", "min_severity_for_pause": "moderate"},
    {"min_severity_for_pause": "severe"},
])
def test_invalid_policy(direct_vm, direct_deploy, direct_owner, policy):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert("Invalid policy"):
        register(c, policy=dict(DEFAULT_POLICY, **policy))


def test_invalid_source_repo(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    with direct_vm.expect_revert("Invalid source_repo"):
        register(c, source_repo="../evil")


def test_only_target_owner_can_update(direct_vm, direct_deploy, direct_owner, direct_bob):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    register(c)
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("Only target owner"):
            c.update_policy("vault-a", json.dumps(DEFAULT_POLICY))
        with direct_vm.expect_revert("Only target owner"):
            c.set_enabled("vault-a", False)


def test_update_bumps_versions_and_changes_key(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    register(c)
    c.update_manifest("vault-a", json.dumps(DEFAULT_MANIFEST))
    c.update_policy("vault-a", json.dumps(DEFAULT_POLICY))
    t = c.get_target("vault-a")
    assert (t["manifest_version"], t["policy_version"]) == (2, 2)
    assert c.verdict_key_for("vault-a", "osv", "GHSA-x").endswith("|m2|p2")


def test_check_prechecks_before_any_web_call(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    register(c)
    direct_vm.strict_mocks = True
    with direct_vm.expect_revert("Unknown target"):
        c.check("nope", "osv", "GHSA-x")
    with direct_vm.expect_revert("Unknown source"):
        c.check("vault-a", "nvd", "GHSA-x")
    with direct_vm.expect_revert("Invalid incident_id"):
        c.check("vault-a", "osv", "bad id!")
    with direct_vm.expect_revert("Target has no source_repo"):
        c.check("vault-a", "github_repo_advisory", "GHSA-x")
    c.set_enabled("vault-a", False)
    with direct_vm.expect_revert("Target disabled"):
        c.check("vault-a", "osv", "GHSA-x")


def test_final_verdict_not_readjudicated_but_insufficient_is(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c)
    mock_osv(direct_vm, "GHSA-demo-0001", vuln_status=404)
    key = c.check("vault-a", "osv", "GHSA-demo-0001")
    assert c.get_verdict(key)["action"] == "INSUFFICIENT_EVIDENCE"
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln())
    mock_llm_prereq(direct_vm, True)
    assert c.check("vault-a", "osv", "GHSA-demo-0001") == key
    v = c.get_verdict(key)
    assert v["action"] == "PAUSE" and v["attempts"] == 2
    with direct_vm.expect_revert("Already adjudicated"):
        c.check("vault-a", "osv", "GHSA-demo-0001")


def test_manifest_update_allows_fresh_adjudication(direct_vm, direct_deploy, direct_owner):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c)
    mock_osv(direct_vm, osv_vuln())
    mock_llm_prereq(direct_vm, True)
    k1 = c.check("vault-a", "osv", "GHSA-demo-0001")
    c.update_manifest("vault-a", json.dumps({**DEFAULT_MANIFEST, "dependencies": [{"ecosystem": "npm", "name": "lodash", "version": "4.17.21"}]}))
    direct_vm.clear_mocks()
    mock_osv(direct_vm, osv_vuln(), query_hit=False)
    k2 = c.check("vault-a", "osv", "GHSA-demo-0001")
    assert k1 != k2
    assert c.get_verdict(k2)["action"] == "NONE"


def test_anyone_can_trigger_check(direct_vm, direct_deploy, direct_owner, direct_alice):
    c = deploy_guardian(direct_deploy, direct_vm, direct_owner)
    MessageCapture(direct_vm)
    register(c)
    mock_osv(direct_vm, osv_vuln())
    mock_llm_prereq(direct_vm, True)
    with direct_vm.prank(direct_alice):
        key = c.check("vault-a", "osv", "GHSA-demo-0001")
    assert c.get_verdict(key)["action"] == "PAUSE"
