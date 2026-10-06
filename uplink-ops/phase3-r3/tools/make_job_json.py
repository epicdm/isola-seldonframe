#!/usr/bin/env python3
"""Generate the content-bearing EasyPanel job JSON files from the templates (r3). Deterministic; no network.

usage: make_job_json.py --baseline PATH_TO_BASELINE.sql --out DIR
Writes DIR/04-uplink-baseline-import-job.createFromSchema.json, 06-uplink-restore-verify-job.createFromSchema.json,
07-uplink-backup-audit-service.createFromSchema.json and the production twins 04p/06p/07p (separate services, r3.3) by substituting ONLY these placeholders with the exact bytes of repository files:
  {{JOB_SCRIPT_CONTENT}} <- tools/uplink_job.sh        {{BASELINE_SQL_CONTENT}} <- the approved baseline (sha256 verified against contract.json)
  {{AUDIT_SCRIPT_CONTENT}} <- tools/backup_audit.py    {{AUDIT_LOOP_CONTENT}} <- tools/audit_loop.sh
Digest and owner placeholders stay in place (validate_package.py --mode final rejects them).
"""
import argparse, hashlib, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); JS = os.path.join(HERE, "..", "json")
ap = argparse.ArgumentParser(); ap.add_argument("--baseline", required=True); ap.add_argument("--out", required=True); a = ap.parse_args()
contract = json.load(open(os.path.join(JS, "contract.json")))
base = open(a.baseline, "rb").read()
if hashlib.sha256(base).hexdigest() != contract["baseline"]["sha256"]:
    sys.exit("REFUSED: baseline sha256 differs from the approved candidate in contract.json")
read = lambda p: open(os.path.join(HERE, p), "rb").read().decode("utf-8")
SUBS = {"{{JOB_SCRIPT_CONTENT}}": read("uplink_job.sh"), "{{BASELINE_SQL_CONTENT}}": base.decode("utf-8"),
        "{{AUDIT_SCRIPT_CONTENT}}": read("backup_audit.py"), "{{AUDIT_LOOP_CONTENT}}": read("audit_loop.sh")}
def walk(o):
    if isinstance(o, dict): return {k: walk(v) for k, v in o.items()}
    if isinstance(o, list): return [walk(v) for v in o]
    if isinstance(o, str) and o in SUBS: return SUBS[o]
    return o
os.makedirs(a.out, exist_ok=True)
for tpl, out in (("04-uplink-baseline-import-job.template.json", "04-uplink-baseline-import-job.createFromSchema.json"),
                 ("06-uplink-restore-verify-job.template.json", "06-uplink-restore-verify-job.createFromSchema.json"),
                 ("07-uplink-backup-audit-service.template.json", "07-uplink-backup-audit-service.createFromSchema.json"),
                 ("04p-uplink-baseline-import-prod-job.template.json", "04p-uplink-baseline-import-prod-job.createFromSchema.json"),
                 ("06p-uplink-restore-verify-prod-job.template.json", "06p-uplink-restore-verify-prod-job.createFromSchema.json"),
                 ("07p-uplink-backup-audit-prod-service.template.json", "07p-uplink-backup-audit-prod-service.createFromSchema.json")):
    d = walk(json.load(open(os.path.join(JS, tpl))))
    d.pop("_generated_by", None)
    txt = json.dumps(d, indent=2, ensure_ascii=True) + "\n"
    open(os.path.join(a.out, out), "w", newline="\n").write(txt)
    print(out, len(txt), "bytes", hashlib.sha256(txt.encode()).hexdigest())
