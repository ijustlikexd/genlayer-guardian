"""ToyVault safety properties: guardian-only, idempotent, escalation-only, resolved incidents ignore late actions."""

from tests.direct.helpers import VAULT, addr


def _deploy(direct_deploy, direct_vm, owner, guardian):
    direct_vm.sender = owner
    v = direct_deploy(VAULT)
    v.set_guardian(addr(guardian))
    return v


def test_only_guardian_and_only_known_actions(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    v = _deploy(direct_deploy, direct_vm, direct_owner, direct_alice)
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("Only guardian"):
            v.apply_action("inc-1", "PAUSE")
    with direct_vm.prank(direct_alice):
        with direct_vm.expect_revert("Unknown action"):
            v.apply_action("inc-1", "HALT")
    assert v.get_mode() == "NORMAL"


def test_restrict_then_pause_then_duplicates(direct_vm, direct_deploy, direct_owner, direct_alice):
    v = _deploy(direct_deploy, direct_vm, direct_owner, direct_alice)
    direct_vm.sender = direct_alice
    v.apply_action("inc-1", "RESTRICT")
    assert v.get_mode() == "RESTRICTED"
    v.apply_action("inc-1", "RESTRICT")  # appeal re-emit
    v.apply_action("inc-1", "PAUSE")
    assert v.get_mode() == "PAUSED"
    v.apply_action("inc-1", "PAUSE")
    v.apply_action("inc-1", "RESTRICT")  # late duplicate must not downgrade
    st = v.get_state()
    assert st["mode"] == "PAUSED"
    assert st["log"].count("dup:inc-1|RESTRICT") == 2 and st["log"].count("dup:inc-1|PAUSE") == 1


def test_resume_closes_incident_and_ignores_late_pause(direct_vm, direct_deploy, direct_owner, direct_alice):
    v = _deploy(direct_deploy, direct_vm, direct_owner, direct_alice)
    direct_vm.sender = direct_alice
    v.apply_action("inc-1", "RESTRICT")
    v.apply_action("inc-1", "RESUME")
    assert v.get_mode() == "NORMAL"
    v.apply_action("inc-1", "PAUSE")  # arrives after resume: ignored
    st = v.get_state()
    assert st["mode"] == "NORMAL"
    assert "late:inc-1|PAUSE" in st["log"]
    assert st["resolved"] == ["inc-1"]


def test_two_incidents_independent(direct_vm, direct_deploy, direct_owner, direct_alice):
    v = _deploy(direct_deploy, direct_vm, direct_owner, direct_alice)
    direct_vm.sender = direct_alice
    v.apply_action("inc-1", "PAUSE")
    v.apply_action("inc-2", "RESTRICT")
    v.apply_action("inc-1", "RESUME")
    assert v.get_mode() == "RESTRICTED"  # inc-2 still open
    v.apply_action("inc-2", "RESUME")
    assert v.get_mode() == "NORMAL"


def test_user_ops_follow_mode(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    v = _deploy(direct_deploy, direct_vm, direct_owner, direct_alice)
    from genlayer.py.types import u256
    direct_vm.sender = direct_bob
    v.deposit(u256(500))
    assert v.balance_of(addr(direct_bob)) == 500
    direct_vm.sender = direct_alice
    v.apply_action("inc-1", "RESTRICT")
    direct_vm.sender = direct_bob
    v.withdraw(u256(100))
    with direct_vm.expect_revert("withdrawal cap"):
        v.withdraw(u256(101))
    direct_vm.sender = direct_alice
    v.apply_action("inc-1", "PAUSE")
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Vault paused"):
        v.withdraw(u256(1))
    with direct_vm.expect_revert("Vault paused"):
        v.deposit(u256(1))
