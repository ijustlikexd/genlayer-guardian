"""Produce contracts/next/*.py for GenLayer Studio Next (GenVM v0.3.0-rc7).

Differences from the v0.2 contracts in contracts/ (logic byte-identical otherwise):
- two-line runner header: `# v0.3.0` plus the Depends hash Studio Next's own examples use
- explicit `import genlayer as gl` and aliases for names the v0.3 star import no longer exports
- v0.3 module layout, introspected on Studio Next: gl.Contract -> gl.contract.Contract,
  gl.contract_interface -> gl.contract.interface
- ENFORCEMENT_ENABLED = False: the Studio Next preview has no contract-to-contract messages
  (its own banner says so; EmitInternalMessage fails with SystemError inval), so this build is
  adjudication-only. Verdicts are stored on-chain; vault actions are not emitted there.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
HDR = '# v0.3.0\n# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }\n'
NL = "\n"
COMMON = [
    ("from genlayer import *" + NL,
     "from genlayer import *" + NL + "import genlayer as gl" + NL
     + "TreeMap = gl.storage.TreeMap" + NL + "DynArray = gl.storage.DynArray" + NL + "allow_storage = gl.storage.allow" + NL
     + "Address = gl.Address" + NL + "u256 = gl.u256" + NL),
    ("(gl.Contract)", "(gl.contract.Contract)"),
    ("@gl.contract_interface", "@gl.contract.interface"),
]
GUARDIAN_ONLY = [
    ("u256 = gl.u256" + NL,
     "u256 = gl.u256" + NL + "ENFORCEMENT_ENABLED = False  # Studio Next: adjudication-only build" + NL),
    ('        if action in ("RESTRICT", "PAUSE"):' + NL + "            target = Target(t.address)",
     '        if ENFORCEMENT_ENABLED and action in ("RESTRICT", "PAUSE"):' + NL + "            target = Target(t.address)"),
    ('        Target(t.address).emit(on="finalized").apply_action(incident_id, "RESUME")',
     "        if ENFORCEMENT_ENABLED:" + NL + '            Target(t.address).emit(on="finalized").apply_action(incident_id, "RESUME")'),
    ('                target.emit(on="finalized").apply_action(v.incident_id, "RESUME")',
     "                if ENFORCEMENT_ENABLED:" + NL + '                    target.emit(on="finalized").apply_action(v.incident_id, "RESUME")'),
]

(ROOT / "contracts/next").mkdir(exist_ok=True)
for name in ("Guardian", "ToyVault"):
    src = (ROOT / f"contracts/{name}.py").read_text(encoding="utf-8").replace("\r\n", "\n")
    body = src.split("\n", 1)[1]
    rules = COMMON + (GUARDIAN_ONLY if name == "Guardian" else [])
    for old, new in rules:
        n = body.count(old)
        if n > 1 or (n == 0 and (name == "Guardian" or old not in ("@gl.contract_interface",))):
            raise SystemExit(f"{name}: expected exactly one occurrence of {old[:50]!r}, found {n}")
        body = body.replace(old, new)
    out = HDR + body
    (ROOT / f"contracts/next/{name}.py").write_text(out, encoding="utf-8", newline="\n")
    print("wrote", f"contracts/next/{name}.py", len(out), "bytes")
