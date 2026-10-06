# Uplink Phase 3 runnable-readiness package r3 (r3.2: separate staging and production builds)

Status: candidate, UNEXECUTED on host03; offline-tested by Lane A only (these are Lane A's own tests, NOT independent acceptance). Not a schema or source approval, not deployment. Preserves r1/r2 (Port entities ev-lane-a-uplink-pkg-r1-*, -r2-*), the original r3 commit c869e993d70e6cbee193f50af6009103306a3e30 and the r3.1 commit 85d3995b965cdca6f4d26b4d71bab094e74258df (history is kept; r3.2 is a later additive commit).
Governing records: master plan / handoff v2.8 (EasyPanel-only; PM ruling: separate staging https://build.uplink.epic.dm and production https://uplink.epic.dm images from the same accepted source commit; PLATFORM_APP_URL, NEXT_PUBLIC_APP_URL, AUTH_URL and NEXTAUTH_URL agree within each environment), Chatwoot reuse decision.
r3.2 changes: json/uplink-app.env.template is replaced by json/uplink-app.staging.env.template and json/uplink-app.production.env.template (identical except the origin keys); json/02p-uplink-app-production.createFromSchema.json (Phase 5 only, gated, service uplink-app-prod); json/codex-image-contract.template.json (every Codex-owned field explicit and fail-closed: source commit, two origin-specific tags and digests, readiness path, fixture command, adapter flags); contract.json environments and image_contract sections; validator and 84 controls; UNRESOLVED-DEPENDENCIES.md. The r3.1 origin placeholder {{CANONICAL_APP_ORIGIN}} no longer exists.
r3.1 changes: single canonical origin (the r3 split origins are rejected by the real Codex source), prerequisites vs acceptance tests vs optional inputs, minimal owner sheet, leftover/credential inventory, no beta-login prerequisite, no new audit key. New files: ORIGIN-CONTRACT-RECONCILIATION.md, PREREQUISITES-ACCEPTANCE-OPTIONAL.md, LEFTOVERS-AND-CREDENTIAL-REMEDIATION.md, tools/origin_control.mts. Changed: json/contract.json, json/uplink-app.env.template, json/07..., json/audit.env.template, tools/validate_package.py, tools/test_validate.py (60 controls), tools/test_smoke.py (20 controls), OWNER-SETUP-SHEET.md, RUNBOOK-r3.md, EASYPANEL-ONLY-AUDIT.md, BACKUP-POLICY.md, CHATWOOT-REUSE-EVIDENCE.md. Unchanged and byte-identical to r3: the rest (see SHA256SUMS).

## Layout (every file ASCII, LF line endings, UTF-8; hashes in SHA256SUMS are over these exact bytes)
json/contract.json                                       single source of limits, keys, forbidden keys, hashes, digest candidate, pending Codex keys
json/01-middleware-uplink-operators.createMiddleware.json  Traefik ipAllowList for operator-only staging
json/02-uplink-app.createFromSchema.json                 STAGING uplink-app on build.uplink.epic.dm, operator-only (valid createFromSchema; env deliberately omitted)
json/02p-uplink-app-production.createFromSchema.json     PRODUCTION uplink-app-prod on uplink.epic.dm, Phase 5 only and gated (env omitted)
json/codex-image-contract.template.json                  the Codex receipt fields (source commit, staging/production tag+digest+public_url, readiness path, fixture command, adapter flags); placeholders fail final mode
json/03-uplink-db.owner-ui-spec.json                     fields the OWNER types for uplink-db (agents must not run the create call)
json/04-uplink-baseline-import-job.template.json         EasyPanel one-shot import job (content filled by tools/make_job_json.py)
json/05-uplink-restore-check-db.owner-ui-spec.json       disposable restore target (owner creates in the portal)
json/06-uplink-restore-verify-job.template.json          EasyPanel verify job
json/07-uplink-backup-audit-service.template.json        EasyPanel-managed backup audit (proposal needing approval)
json/08-uplink-backup-config.createDatabaseBackup.json   daily + weekly EasyPanel backup entries with count retention
json/uplink-app.staging.env.template, uplink-app.production.env.template, job-import.env.template, audit.env.template   environment templates (names only; owner fills secrets)
tools/validate_package.py + test_validate.py             static validator (offline|final) and its 84 positive/negative controls
tools/uplink_job.sh                                      script the EasyPanel job runs (import|verify)
tools/make_job_json.py                                   builds the content-bearing job JSON from the templates + approved baseline
tools/backup_audit.py (+ --selftest), audit_loop.sh      restore-point counting audit
tools/acceptance_smoke.py + test_smoke.py                HTTP/branding/origin/fail-closed checks and 20 controls
tools/origin_control.mts                                 runs the real Codex canonicalAppOrigin() against an env template (positive and negative control); run once per environment
RUNBOOK-r3.md ... UNRESOLVED-DEPENDENCIES.md             exact open dependencies and who closes each
tools/uplink_db_tools.sh, rehearse_baseline.sh           OFFLINE evidence tooling (disposable local Postgres; never run on host03)
RUNBOOK-r3.md, EASYPANEL-ONLY-AUDIT.md, BACKUP-POLICY.md, OWNER-SETUP-SHEET.md, CHATWOOT-REUSE-EVIDENCE.md
evidence/rehearsal-5.log                                 sanitized log of the disposable rehearsal (54 PASS, 0 FAIL)

## Reconstruct from Port
Authoritative bytes are the git files at the commit named in the receipt; Port copies are convenience copies and were verified by reconstruction (a correction entity records two transcription defects in the original six Port bodies; a later entity supersedes an earlier one for the same path). Each Port evidence entity ev-lane-a-uplink-pkg-r3-* holds files as blocks:
`===== FILE <path> =====` newline, the exact file text, then `===== END <path> =====`. Write the text between the markers to <path> with LF endings (the text ends with one trailing LF), UTF-8. Then `sha256sum -c SHA256SUMS` (published in ev-lane-a-uplink-pkg-r3-manifest). The approved baseline is NOT in Port: it is identified by sha256 8f9922e3ead013557a21427468f8392d20784d6d78bec839ae1e4cdb43dba8b8 (195441 bytes) and published as a git blob on the fork branch named in the receipt.

## Run the offline checks (Python 3.10+, no dependencies)
python tools/validate_package.py --mode offline            # placeholders reported as PENDING
python tools/test_validate.py                              # 84 controls (UPLINK_TEST_REASONS=1 prints why each negative fails)
python tools/backup_audit.py --selftest                    # 10 controls
python tools/test_smoke.py                                 # 20 controls (local fixtures only)
node --experimental-strip-types tools/origin_control.mts <checkout>/packages/crm/src/lib/http/app-hosts.ts json/uplink-app.staging.env.template https://build.uplink.epic.dm      # 3 controls against the real Codex origin function
node --experimental-strip-types tools/origin_control.mts <checkout>/packages/crm/src/lib/http/app-hosts.ts json/uplink-app.production.env.template https://uplink.epic.dm
python tools/make_job_json.py --baseline <baseline.sql> --out <dir>; python tools/validate_package.py --mode offline --generated <dir>
bash tools/rehearse_baseline.sh <baseline.sql> 8f9922e3ead013557a21427468f8392d20784d6d78bec839ae1e4cdb43dba8b8   # needs Docker; run on a scratch host, NOT host03
`--mode final` fails while any {{PLACEHOLDER}} remains (digests, CIDR, owner values, Codex keys) and requires --generated.
Everything above is Lane A's own offline testing. It is not Phase 2 review, QA or any other independent acceptance.
