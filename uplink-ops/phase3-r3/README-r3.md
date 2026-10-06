# Uplink Phase 3 runnable-readiness package r3

Status: candidate, UNEXECUTED on host03; offline-tested. Not a schema or source approval. Preserves r1/r2 (Port entities ev-lane-a-uplink-pkg-r1-*, -r2-*).
Governing records: master plan v2.2 / handoff v2.4 (EasyPanel-only), Chatwoot reuse decision.

## Layout (every file ASCII, LF line endings, UTF-8; hashes in SHA256SUMS are over these exact bytes)
json/contract.json                                       single source of limits, keys, forbidden keys, hashes, digest candidate, pending Codex keys
json/01-middleware-uplink-operators.createMiddleware.json  Traefik ipAllowList for operator-only staging
json/02-uplink-app.createFromSchema.json                 uplink-app (valid createFromSchema; env deliberately omitted)
json/03-uplink-db.owner-ui-spec.json                     fields the OWNER types for uplink-db (agents must not run the create call)
json/04-uplink-baseline-import-job.template.json         EasyPanel one-shot import job (content filled by tools/make_job_json.py)
json/05-uplink-restore-check-db.owner-ui-spec.json       disposable restore target (owner creates in the portal)
json/06-uplink-restore-verify-job.template.json          EasyPanel verify job
json/07-uplink-backup-audit-service.template.json        EasyPanel-managed backup audit (proposal needing approval)
json/08-uplink-backup-config.createDatabaseBackup.json   daily + weekly EasyPanel backup entries with count retention
json/uplink-app.env.template, job-import.env.template, audit.env.template   environment templates (names only; owner fills secrets)
tools/validate_package.py + test_validate.py             static validator (offline|final) and its 54 positive/negative controls
tools/uplink_job.sh                                      script the EasyPanel job runs (import|verify)
tools/make_job_json.py                                   builds the content-bearing job JSON from the templates + approved baseline
tools/backup_audit.py (+ --selftest), audit_loop.sh      restore-point counting audit
tools/acceptance_smoke.py + test_smoke.py                HTTP/branding/origin/fail-closed checks and 19 controls
tools/uplink_db_tools.sh, rehearse_baseline.sh           OFFLINE evidence tooling (disposable local Postgres; never run on host03)
RUNBOOK-r3.md, EASYPANEL-ONLY-AUDIT.md, BACKUP-POLICY.md, OWNER-SETUP-SHEET.md, CHATWOOT-REUSE-EVIDENCE.md
evidence/rehearsal-5.log                                 sanitized log of the disposable rehearsal (54 PASS, 0 FAIL)

## Reconstruct from Port
Each Port evidence entity ev-lane-a-uplink-pkg-r3-* holds files as blocks:
`===== FILE <path> =====` newline, the exact file text, then `===== END <path> =====`. Write the text between the markers to <path> with LF endings (the text ends with one trailing LF), UTF-8. Then `sha256sum -c SHA256SUMS` (published in ev-lane-a-uplink-pkg-r3-manifest). The approved baseline is NOT in Port: it is identified by sha256 8f9922e3ead013557a21427468f8392d20784d6d78bec839ae1e4cdb43dba8b8 (195441 bytes) and published as a git blob on the fork branch named in the receipt.

## Run the offline checks (Python 3.10+, no dependencies)
python tools/validate_package.py --mode offline            # placeholders reported as PENDING
python tools/test_validate.py                              # 54 controls
python tools/backup_audit.py --selftest                    # 10 controls
python tools/test_smoke.py                                 # 19 controls (local fixtures only)
python tools/make_job_json.py --baseline <baseline.sql> --out <dir>; python tools/validate_package.py --mode offline --generated <dir>
bash tools/rehearse_baseline.sh <baseline.sql> 8f9922e3ead013557a21427468f8392d20784d6d78bec839ae1e4cdb43dba8b8   # needs Docker; run on a scratch host, NOT host03
`--mode final` fails while any {{PLACEHOLDER}} remains (digests, CIDR, owner values, Codex keys) and requires --generated.
