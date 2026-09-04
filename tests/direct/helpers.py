"""Shared helpers for Guardian direct-mode tests."""
import json

GUARDIAN = "contracts/Guardian.py"
VAULT = "contracts/ToyVault.py"

OSV_VULN_RE = r"api\.osv\.dev/v1/vulns/{id}"
OSV_QUERY_RE = r"api\.osv\.dev/v1/query"
GH_ADV_RE = r"api\.github\.com/repos/{owner}/{repo}/security-advisories/{ghsa}"

DEFAULT_MANIFEST = {
    "target_id": "vault-a",
    "dependencies": [{"ecosystem": "npm", "name": "lodash", "version": "4.17.15"}],
    "config": {"accepts_external_json_merge": True, "feature_flags": {"user_config_merge": "enabled"}},
}
DEFAULT_POLICY = {
    "max_action_on_accepted": "RESTRICT",
    "max_action_on_finalized": "PAUSE",
    "min_severity_for_restrict": "moderate",
    "min_severity_for_pause": "high",
    "require_prerequisites_met_for_pause": True,
}
VAULT_ADDR = "0x1111111111111111111111111111111111111111"


def osv_vuln(vid="GHSA-demo-0001", *, ecosystem="npm", name="lodash", severity="CRITICAL",
             cvss=None, withdrawn=None, aliases=("CVE-2026-00001",), details="Prototype pollution in merge. "
             "Exploitable only when untrusted JSON is merged into shared configuration."):
    d = {
        "id": vid, "aliases": list(aliases), "summary": "Prototype pollution in lodash",
        "details": details, "published": "2026-09-01T00:00:00Z", "modified": "2026-09-01T00:00:00Z",
        "affected": [{"package": {"ecosystem": ecosystem, "name": name},
                      "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}],
        "references": [], "database_specific": {},
    }
    if severity is not None:
        d["database_specific"]["severity"] = severity
    if cvss is not None:
        d["severity"] = [{"type": "CVSS_V3", "score": cvss}]
    if withdrawn:
        d["withdrawn"] = withdrawn
    return d


def osv_query_hit(*ids, aliases=()):
    """OSV /v1/query response. `aliases` attaches CVE aliases to the first hit."""
    if not ids:
        return {}
    out = [{"id": i, "aliases": []} for i in ids]
    out[0]["aliases"] = list(aliases)
    return {"vulns": out}


def gh_adv(ghsa="GHSA-repo-0001", *, severity="high", rng="< 4.17.21", name="lodash", ecosystem="npm",
           state="published", withdrawn_at=None, cvss_score=8.1,
           description="Prototype pollution. Exploitable when external merge enabled."):
    return {
        "ghsa_id": ghsa, "state": state, "severity": severity, "summary": "Repo advisory", "description": description,
        "published_at": "2026-09-02T00:00:00Z", "withdrawn_at": withdrawn_at,
        "cvss_severities": {"cvss_v3": {"score": cvss_score, "vector_string": None}},
        "vulnerabilities": [{"package": {"ecosystem": ecosystem, "name": name}, "vulnerable_version_range": rng,
                             "patched_versions": "4.17.21"}],
    }


def mock_osv(vm, vuln, query_hit=True, vuln_status=200, query_status=200, vuln_raw=None):
    """query_hit: True (hit by id) | False (no hit) | dict (raw response). vuln_raw: raw body for the vuln GET."""
    vid = vuln["id"] if isinstance(vuln, dict) else vuln
    body = vuln_raw if vuln_raw is not None else (json.dumps(vuln) if isinstance(vuln, dict) else "")
    vm.mock_web(OSV_VULN_RE.format(id=vid), {"status": vuln_status, "body": body})
    hits = osv_query_hit(vid) if query_hit is True else (osv_query_hit() if query_hit is False else query_hit)
    vm.mock_web(OSV_QUERY_RE, {"method": "POST", "status": query_status, "body": json.dumps(hits)})


def mock_gh(vm, owner, repo, adv, status=200):
    vm.mock_web(GH_ADV_RE.format(owner=owner, repo=repo, ghsa=adv["ghsa_id"]), {"status": status, "body": json.dumps(adv)})


def mock_llm_prereq(vm, met, bucket=None, raw=None):
    """raw: exact LLM text to return (to simulate malformed output)."""
    if raw is not None:
        vm.mock_llm(r"security applicability judge", raw)
        return
    obj = {"prerequisites_met": met}
    if bucket is not None:
        obj["severity_bucket"] = bucket
    vm.mock_llm(r"security applicability judge", json.dumps(obj))


class MessageCapture:
    """Capture cross-contract PostMessage calls that direct mode does not execute."""

    def __init__(self, vm):
        self.calls = []
        vm._gl_call_hook = self._hook

    def _hook(self, vm, request):
        for k in ("PostMessage", "CallContract", "DeployContract"):
            if k in request:
                self.calls.append({k: request[k]})
                return {"ok": None}
        return None

    def actions(self):
        """Decode (on, method, args) best-effort from captured PostMessage payloads."""
        out = []
        for c in self.calls:
            pm = c.get("PostMessage")
            if pm is None:
                continue
            out.append(pm)
        return out


def deploy_guardian(direct_deploy, direct_vm, owner):
    direct_vm.sender = owner
    return direct_deploy(GUARDIAN)


def register(c, target_id="vault-a", manifest=None, policy=None, source_repo="", addr=VAULT_ADDR):
    from genlayer.py.types import Address
    c.register_target(target_id, Address(addr), json.dumps(DEFAULT_MANIFEST if manifest is None else manifest),
                      json.dumps(DEFAULT_POLICY if policy is None else policy), source_repo)


def addr(x):
    """bytes account fixture -> Address (SDK importable only after a deploy)."""
    from genlayer.py.types import Address
    return x if hasattr(x, "as_hex") else Address(x)
