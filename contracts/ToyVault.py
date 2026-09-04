# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""ToyVault: a protected target whose operating mode is governed by a Guardian contract.

Safety properties:
- Only the registered guardian can change mode.
- Idempotent per (incident_id, action): re-emitted messages after appeal rounds are no-ops.
- Escalation-only within an incident: RESTRICT never downgrades PAUSED.
- RESUME closes an incident; late RESTRICT/PAUSE for a resolved incident are ignored.
- Mode is derived from the set of open incidents, so two incidents cannot unpause each other.
"""
from genlayer import *

ACTIONS = ("RESTRICT", "PAUSE", "RESUME")


class ToyVault(gl.Contract):
    owner: Address
    guardian: Address
    balances: TreeMap[Address, u256]
    open_incidents: TreeMap[str, str]  # incident_id -> "RESTRICT" | "PAUSE"
    resolved: TreeMap[str, bool]  # incident_id -> True
    applied: TreeMap[str, bool]  # "incident|action" -> True
    log: DynArray[str]

    def __init__(self):
        self.owner = gl.message.sender_address
        self.guardian = gl.message.sender_address

    # ------------------------------------------------------------ admin
    @gl.public.write
    def set_guardian(self, guardian: Address) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("Only owner")
        if isinstance(guardian, str):  # SDK clients may send a hex string instead of an Address
            guardian = Address(guardian)
        self.guardian = guardian

    # --------------------------------------------------------- guardian
    @gl.public.write
    def apply_action(self, incident_id: str, action: str) -> None:
        if gl.message.sender_address != self.guardian:
            raise gl.vm.UserError("Only guardian")
        if action not in ACTIONS:
            raise gl.vm.UserError("Unknown action")
        key = f"{incident_id}|{action}"
        if key in self.applied:
            self.log.append(f"dup:{key}")
            return
        self.applied[key] = True
        if incident_id in self.resolved and action != "RESUME":
            self.log.append(f"late:{key}")
            return
        if action == "RESUME":
            if incident_id in self.open_incidents:
                del self.open_incidents[incident_id]
            self.resolved[incident_id] = True
        elif action == "PAUSE":
            self.open_incidents[incident_id] = "PAUSE"
        else:  # RESTRICT
            if self.open_incidents.get(incident_id, "") != "PAUSE":
                self.open_incidents[incident_id] = "RESTRICT"
        self.log.append(f"{key}->{self._mode()}")

    # ------------------------------------------------------------ users
    @gl.public.write
    def deposit(self, amount: u256) -> None:
        if self._mode() == "PAUSED":
            raise gl.vm.UserError("Vault paused")
        self.balances[gl.message.sender_address] = self.balances.get(gl.message.sender_address, u256(0)) + amount

    @gl.public.write
    def withdraw(self, amount: u256) -> None:
        mode = self._mode()
        if mode == "PAUSED":
            raise gl.vm.UserError("Vault paused")
        bal = self.balances.get(gl.message.sender_address, u256(0))
        if amount > bal:
            raise gl.vm.UserError("Insufficient balance")
        if mode == "RESTRICTED" and amount > u256(100):
            raise gl.vm.UserError("Restricted mode: withdrawal cap 100")
        self.balances[gl.message.sender_address] = bal - amount

    # ------------------------------------------------------------ views
    def _mode(self) -> str:
        mode = "NORMAL"
        for _, level in self.open_incidents.items():
            if level == "PAUSE":
                return "PAUSED"
            mode = "RESTRICTED"
        return mode

    @gl.public.view
    def get_mode(self) -> str:
        return self._mode()

    @gl.public.view
    def get_state(self) -> dict:
        return {
            "mode": self._mode(),
            "guardian": self.guardian.as_hex,
            "open_incidents": {k: v for k, v in self.open_incidents.items()},
            "resolved": [k for k, _ in self.resolved.items()],
            "log": list(self.log),
        }

    @gl.public.view
    def balance_of(self, who: Address) -> int:
        return int(self.balances.get(who, u256(0)))
