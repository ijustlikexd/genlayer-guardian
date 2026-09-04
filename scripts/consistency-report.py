"""Summarize docs/consistency-run.jsonl: per-incident verdict distribution across identical targets,
and validator vote breakdown fetched from the Studionet receipt of each check tx.

Usage: PYTHONUTF8=1 python scripts/consistency-report.py [docs/consistency-run.jsonl]
Writes docs/consistency-report.md.
"""
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

src = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/consistency-run.jsonl")
rows = [json.loads(l) for l in src.read_text(encoding="utf-8").splitlines() if l.startswith("{")]
checks = [r for r in rows if r.get("event") == "check_submitted"]
print(f"{len(checks)} checks")

GD = [l for l in Path(".env").read_text().splitlines() if l.startswith("GUARDIAN_ADDRESS=")][0].split("=", 1)[1]


def cli(*args):
    # one command string: on Windows, list2cmdline would escape the quotes around keys containing '|'
    cmd = "npx genlayer " + " ".join(a if a.startswith("--") or a.startswith("0x") or a.isalnum() else f'"{a}"' for a in args)
    return subprocess.run(cmd, capture_output=True, text=True, shell=True).stdout


def votes(tx):
    out = cli("receipt", tx)
    for line in out.splitlines():
        if "validator_votes_name" in line:
            return [v.strip(" '") for v in line.split("[", 1)[1].split("]")[0].split(",") if v.strip()]
    return []


def verdict(key):
    out = cli("call", GD, "get_verdict", "--args", key)
    d = {}
    for f in ("action", "severity_bucket", "prerequisites_met", "reason_code"):
        for line in out.splitlines():
            if line.strip().startswith(f + ":"):
                d[f] = line.split(":", 1)[1].strip(" ,'")
    return d


per_incident = defaultdict(list)
vote_counter = Counter()
disagree_tx = []
for c in checks:
    v = verdict(c["verdict_key"])
    vs = votes(c["tx_hash"])
    vote_counter.update(vs)
    if "DISAGREE" in vs:
        disagree_tx.append((c["incident_id"], c["tx_hash"], vs))
    per_incident[c["incident_id"]].append((c["target_id"], v.get("action"), v.get("prerequisites_met"), v.get("severity_bucket"), vs))

lines = ["# Studionet consistency run", "", f"Source: `{src}`, {len(checks)} check transactions, "
         f"{len({c['target_id'] for c in checks})} identical targets.", "",
         "## Per-incident verdict distribution", "", "| incident | targets | actions | prerequisites_met | severity | votes with DISAGREE |", "|---|---|---|---|---|---|"]
for inc, items in sorted(per_incident.items()):
    acts = Counter(i[1] for i in items)
    pre = Counter(i[2] for i in items)
    sev = Counter(i[3] for i in items)
    dis = sum(1 for i in items if "DISAGREE" in i[4])
    lines.append(f"| {inc} | {len(items)} | {dict(acts)} | {dict(pre)} | {dict(sev)} | {dis} |")
total_votes = sum(vote_counter.values())
lines += ["", "## Validator votes (all txs)", "", f"{dict(vote_counter)} of {total_votes}",
          f"AGREE share among non-idle votes: {vote_counter['AGREE'] / max(1, total_votes - vote_counter['IDLE']):.1%}", ""]
if disagree_tx:
    lines += ["## Transactions with a DISAGREE vote", ""] + [f"- {i} `{t}` {v}" for i, t, v in disagree_tx]
same = sum(1 for items in per_incident.values() if len(Counter(i[1] for i in items)) == 1)
lines += ["", f"## Verdict stability: {same}/{len(per_incident)} incidents got the same action on every target."]
Path("docs/consistency-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
