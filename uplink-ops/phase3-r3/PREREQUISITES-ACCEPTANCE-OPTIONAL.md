# Uplink readiness: prerequisites vs staging acceptance tests vs optional inputs (r3.1, per plan v2.7)

Readiness here is CANDIDATE evidence. It is not independent approval and nothing is deployed. G1-G7 from r3 are NOT blanket owner approvals; each is classified below.

## 1. Actual prerequisites (deployment is blocked until all are true)
| # | Prerequisite | Who | Evidence that closes it |
|---|---|---|---|
| P1 | Accepted source/image: Codex Phase 1 receipt with passing CI and an immutable digest, then independent Phase 2 APPROVE of the exact source AND of the schema baseline (sha256 8f9922e3...dba8b8) | Codex Build, Codex Review | receipts ev-codex-uplink-phase1-production-source-rc-2026-10-06 and ev-codex-uplink-phase2-independent-acceptance-2026-10-06 |
| P2 | Owner secret entry in the EasyPanel UI, SEPARATELY per environment (staging now: DB password via the UI-created uplink-db, AUTH_SECRET, NEXTAUTH_SECRET, ENCRYPTION_KEY with offline custody; production later: its own uplink-db-prod password and its own newly generated secrets) and acknowledgement of the exposure profile | Owner | owner confirms in chat; Lane A reads key NAMES only |
| P3 | Confirmed operator access: the CIDR(s) allowed to reach staging (66.118.37.10/32 is a candidate only) | Owner | owner answer; middleware readback |
| P4 | Authorized, encrypted off-host backup destination: encryption at rest on, EPIC authorizes the uplink/staging/... and uplink/production/... prefixes | Owner (provider console) | owner answers; until then "encrypted off-host backup" is not claimed |
P1 now means TWO origin-specific images from the same accepted source commit (staging public_url=https://build.uplink.epic.dm, production public_url=https://uplink.epic.dm), each with its own recorded tag and digest, both reviewed for provenance (PM ruling plan v2.8). Internal gates (not owner asks): filling json/codex-image-contract.template.json ONLY from the Codex receipt (see UNRESOLVED-DEPENDENCIES.md); substituting digests and CIDR so make_job_json + validate_package --mode final exit 0; PM advancement after Phase 2. The origin question is closed (separate builds).

## 2. Staging acceptance tests (run in Phase 3/4, evidence-producing; none needs a separate approval)
| Test | Pass condition | Where defined |
|---|---|---|
| T1 file mounts | the 195 KB baseline and the job script mount byte-exact in the EasyPanel job (hash checked by the job itself) | RUNBOOK S4 |
| T2 job execution | import job logs the RESULT PASS lines, exits 0 and is not restarted; failure path exits non-zero, retries re-check state | RUNBOOK S4 |
| T3 restart/redeploy persistence | EASYPANEL-ONLY-AUDIT.md section 4 projections equal before/after; controlled stop shows restart behaviour (G2) | RUNBOOK S8 |
| T4 successful-backup retention | EasyPanel count retention (14/8) vs real restore points as counted by backup_audit.py over elapsed time (G5) | BACKUP-POLICY.md |
| T5 restore proof | restoreDatabaseBackup into the disposable EasyPanel Postgres + verify job; counts equal baseline; QA witness | RUNBOOK S5 |
| T6 audit mechanism | Box scheduled script or managed audit service can list the destination with EXISTING scoped access; no new key is created for this proposal alone (plan v2.7). If existing access cannot list the prefixes, the audit stays offline/on-demand and that is recorded | RUNBOOK S7 |
| T7 app acceptance | smoke checks (/api/health candidate, branding, origin, fail-closed) + Codex fixtures/isolation when the contract exists | tools/acceptance_smoke.py |

## 3. G1-G7 classification
| Gap | Class | Handling |
|---|---|---|
| G1 no push alert for failed backup/audit | accepted limitation, disclosed | portal status/logs; revisit only if the owner asks for push alerts |
| G2 restart.condition not settable (exit 0 strands a service) | acceptance test T3 + Codex source question | confirm the app exits non-zero on fatal termination; no host-level override |
| G3 Postgres service has no health/mount fields | acceptance test | import/verify jobs and the app readiness endpoint |
| G4 provider-side encryption/lifecycle not portal-managed | prerequisite P4 (encryption/authorization only); lifecycle disclosed | owner answers; lifecycle must not be the only retention |
| G5 EasyPanel retention counting unproven | acceptance test T4 | audit counts independently |
| G6 unidentified cw_* Chatwoot-like stack on host03 | inventory risk, NOT a blocker, NOT authority | not modified, replaced or migrated; Uplink targets only the EasyPanel-managed isola/chat at inbox.epic.dm; identify its role separately |
| G7 DB env/mount edits limited in MCP | accepted limitation | owner uses the portal; no workaround |

## 4. Optional inputs (never block readiness)
PLATFORM_SUPPORT_EMAIL, PLATFORM_LOGO_URL, PLATFORM_FAVICON_URL (text branding "Uplink" is used when empty); administrator email and email sign-in belong to Uplink Phase 4/5 only; beta login at agents.epic.dm is NOT an Uplink prerequisite and nothing in this package refers to it as one.
