# Uplink Phase 3 runbook r3 (r3.2: separate staging/production builds; EasyPanel-only). UNEXECUTED. Applies only after Phase 2 APPROVE and PM advancement. Prerequisites vs acceptance tests vs optional inputs: PREREQUISITES-ACCEPTANCE-OPTIONAL.md.

Boundary (handoff v2.4): every deployed object is an EasyPanel project/service visible and changeable in the portal. No docker/swarm/compose commands on host03, no host cron or scripts, no standalone containers, no secret files. Agents never see secret values. Local/offline tooling in tools/ is evidence tooling, not a deployed service.

Notation: [LA] = Lane A through the EasyPanel MCP (epic-portal), [OWNER] = the owner in the EasyPanel UI, [QA] = independent witness. Every step lists Readback and Rollback.

## P0 Gate (all must be true, else STOP)
1. Codex Phase 1 receipt (integration head, image digest, configuration contract) and Phase 2 APPROVE for source AND schema (hash 8f9922e3...dba8b8, or its replacement hash written into tools/uplink_job.sh defaults, contract.json and the generator).
2. Substitute only receipt-sourced values: {{UPLINK_APP_IMAGE_DIGEST_HEX}}, {{PG_IMAGE_DIGEST_HEX}}, the Codex configuration keys (contract.json pending_codex_keys, env template), {{STAGING_OPERATOR_CIDR}}, {{BACKUP_STORAGE_PROVIDER_ID}} (owner sheet), PLATFORM_* owner values, and every field of json/codex-image-contract.template.json (source commit, STAGING and PRODUCTION image tag and digest, run URLs, readiness path, fixture command, adapter flags). PM ruling (plan v2.8): two origin-specific images from the SAME accepted source commit; staging uses build.uplink.epic.dm in all four origin keys, production uses uplink.epic.dm in all four; the staging image is built with public_url=https://build.uplink.epic.dm and the production image with public_url=https://uplink.epic.dm; tags and digests differ and are recorded individually. Never run a staging digest in production or the reverse; tools/origin_control.mts must pass for BOTH templates against the final Codex head.
3. `python tools/make_job_json.py --baseline <approved baseline> --out <dir>` then `python tools/validate_package.py --mode final --generated <dir>` must exit 0, and `python tools/test_validate.py`, `python tools/backup_audit.py --selftest`, `python tools/test_smoke.py` must all pass.
4. Host capacity re-read by names-only EasyPanel MCP calls (getDockerTaskStats, getMonitorTableData): no worse than the Gate 0 baseline. No cleanup is performed.
5. Owner sheet items O1-O3 answered (optional items and administrator email are not gates); Overall PM advancement recorded.

## S1 Operator-only staging rule [LA]
`createMiddleware` with 01-middleware-uplink-operators.createMiddleware.json (ipAllowList, owner-confirmed CIDR). Readback: `listMiddlewares` shows uplink-operators with the CIDR. Rollback: delete the middleware (own object, not yet attached).

## S2 Project [LA]
`createProject {name: "uplink"}` (creates the project and its isolated overlay network). Readback: `listProjects`. Rollback: delete the empty project.

## S3 Database [OWNER]
Owner creates service uplink-db from 03-uplink-db.owner-ui-spec.json (EasyPanel: project uplink > + Service > Postgres; fields exactly as the sheet). Why not an agent: the create call returns the password in plaintext.
[LA] Readback (names only): `listProjects`; `listPorts` for uplink-db is empty; `getServiceDatabases` shows database uplink; portal status running; no env value is read. Rollback: owner deletes the empty service in the portal (no data yet).

## S4 Baseline import [LA creates, OWNER enters env]
1. [LA] `createFromSchema` with the GENERATED 04-uplink-baseline-import-job.createFromSchema.json (EasyPanel app service uplink-baseline-import: postgres image, two file mounts, command `sh /uplink/uplink_job.sh import`, no route). It will fail its first start until env exists; that is expected.
2. [OWNER] Environment tab: paste job-import.staging.env.template, type PGPASSWORD (copied from the STAGING uplink-db service page; slot OWNER_ENTERS_STAGING_DB_PASSWORD), Deploy. The staging job targets uplink_uplink-db only and never carries a production secret.
3. [LA] Readback: portal logs of uplink-baseline-import show `RESULT PASS baseline hash matches approved candidate`, `RESULT PASS imported in one transaction`, `RESULT PASS counts tables=117 explicit_indexes=231 constraints=312 schemas=1 extensions=plpgsql rows=0`, `RESULT PASS import job complete`; service state completed (exit 0, not restarted).
Failure behaviour (tested offline, 54/54 rehearsal checks): hash mismatch or non-empty target refuses before changing anything; an import error rolls back the single transaction; the job waits `SLEEP_ON_FAIL` (600 s) then exits 1 and its retry re-checks state first, so it cannot double-import. Stop the service in the portal to end retries.
Rollback: delete the job service; if the import was incomplete the database is empty (single transaction) and S4 can be repeated; a damaged database is deleted and recreated before any data exists.
4. [OWNER] Delete uplink-baseline-import in the portal after success (it holds the password in its env). [LA] readback: service absent; uplink-db untouched.

## S5 First backup and restore rehearsal (all EasyPanel objects)
1. [LA] `createDatabaseBackup` x2 from 08-uplink-backup-config.createDatabaseBackup.json (STAGING database uplink-db: daily 15 2 * * * path uplink/staging/daily retention 14; weekly 15 3 * * 0 path uplink/staging/weekly retention 8; destination = owner-confirmed storage provider id; the production backup config 08p is Phase 5 only and uses uplink/production/...). Readback: `listDatabaseBackups` shows both with schedule, path, retention.
2. [LA] `runDatabaseBackup` for the daily config (backup #0). Evidence: object exists in the destination (owner or witness confirms key and size; Lane A holds no storage credential). 
3. [OWNER] Create the disposable Postgres service uplink-restore-check from 05-uplink-restore-check-db.owner-ui-spec.json.
4. [LA] `restoreDatabaseBackup {projectName: uplink, serviceName: uplink-restore-check, databaseName: uplink_restore, storageProviderId, path: <backup #0 key>}` (destructive-flagged; target is the disposable DB only; use execute_destructive after Overall PM approval).
5. [LA] `createFromSchema` GENERATED 06-uplink-restore-verify-job.createFromSchema.json; [OWNER] env: job-restore-verify.staging.env.template (PGHOST uplink_uplink-restore-check, PGDATABASE uplink_restore, slot OWNER_ENTERS_STAGING_RESTORE_CHECK_PASSWORD = the restore target's own password); Deploy. Readback: portal logs `RESULT PASS counts ... rows=0` and `RESULT PASS verify complete`. Measure restore time from the portal logs/timestamps.
6. [QA] witnesses steps 4-5. [OWNER] deletes uplink-restore-verify and uplink-restore-check in the portal. [LA] readback: both absent; uplink-db unchanged.
Pass rule: counts equal the baseline, zero rows, restore time recorded, witness present, object confirmed off-host. A configured schedule that was never restored is not a pass.

## S6 Application [LA creates, OWNER enters env]
1. [LA] `createFromSchema` 02-uplink-app.createFromSchema.json (STAGING image digest only, limits 2 CPU/3 GiB, domain build.uplink.epic.dm with middleware uplink-operators, NO env).
2. [OWNER] Environment tab: paste uplink-app.staging.env.template, replace every {{...}} (owner values), type DATABASE_URL, AUTH_SECRET, NEXTAUTH_SECRET, ENCRYPTION_KEY, add the Codex keys, Deploy with forceRebuild. From now no agent calls updateAppEnv or createFromSchema on uplink-app.
3. [LA] Readback (names only; env VALUES are never read): env KEY inventory vs contract.json (required present, forbidden absent) via the names-only projection; serving task started after the deploy and healthy (portal status, getDockerTaskStats); domain TLS certificate subject/issuer/expiry via a public TLS client.
4. [LA] `python tools/acceptance_smoke.py --base https://build.uplink.epic.dm --readiness-path <path named in the Codex receipt; /api/health is only the path observed in the candidate> --expect-title Uplink --allow-host uplink.epic.dm` from an allowed operator machine, and `--expect-forbidden` from a machine outside the CIDR (negative control). Both must exit 0.
5. [LA] run the Codex fixture command twice (idempotency) and the Codex isolation checks when the contract exists.
Rollback: see section Rollback.

## S7 Backup audit [LA, after confirming existing scoped read access; no new key is created for this proposal alone]
First confirm that the Box script / audit service can list the destination prefixes with access that already exists (acceptance test T6). If it cannot, keep the audit offline/on-demand and record that; do not create a key just to run it. Preferred (to prove on a disposable Box service first): an EasyPanel Box service whose scheduled script (Box `scripts[].schedule`) runs backup_audit.py against a read-only storage key. Alternative: 07-uplink-backup-audit-service (managed app service with a pinned Dockerfile build that loops hourly and exits non-zero on a failing audit; failures appear in portal status/restarts and logs). Neither has a push notification channel: that is a recorded gap (control map G1), mitigated by portal status and the weekly owner check in the owner sheet.

## S8 Redeploy-persistence and restart acceptance (see EASYPANEL-ONLY-AUDIT.md section 4) [LA + QA]
Redeploy uplink-app twice unchanged and once with a digest change; compare names-only readbacks; verify env key names, mounts, domain, limits, volumes and the database row counts persist; controlled graceful stop of the app task to observe restart behaviour (EasyPanel app services use restart on-failure; an exit 0 can strand a service - tested on staging only).

## S9 Host regression and receipt [LA]
Names+image+replica list of every service outside project uplink equals the pre-change list; RAM/swap/load not worse; Deepseek untouched. Write ev-lane-a-uplink-phase3-staging-deployment-2026-10-06 with every readback above.

## S10 Production runtime (PHASE 5 ONLY; gated by Phase 4 APPROVE, independent Review of both images, and an explicit Overall PM cutover instruction; not part of Phase 3)
Written now so nothing is improvised later; nothing here runs in Phase 3. Production is a fully separate pairing (PM ruling plan v2.9): uplink-app-prod + uplink-db-prod, its own volume, credentials, ENCRYPTION_KEY and auth/session secrets, built from the SEPARATE production image (public_url=https://uplink.epic.dm) of the same accepted source commit. See ISOLATION-MAP.md. Before step 1: re-read CAPACITY-RECHECK.md figures with names-only calls (aggregate ceilings, reservations, measured use); if a safe-capacity check fails, stop and report the narrow sizing/sequence blocker (no broad prune).
1. [OWNER] Create uplink-db-prod from 03p-uplink-db-prod.owner-ui-spec.json in the EasyPanel UI (creates its own data volume; the create call returns a password, so an agent never runs it). [LA] readback (names only): listProjects, listPorts empty, getServiceDatabases shows database uplink, listMounts shows a volume belonging to uplink-db-prod only and different from uplink-db's.
2. [LA] createFromSchema GENERATED 04p-uplink-baseline-import-prod-job.createFromSchema.json (service uplink-baseline-import-prod); [OWNER] env: job-import.production.env.template (PGHOST uplink_uplink-db-prod; slot OWNER_ENTERS_PRODUCTION_DB_PASSWORD = the production database's own password); Deploy; [LA] readback the RESULT PASS lines (the same approved baseline hash, 117 tables, 0 rows); [OWNER] delete the job service. The production database is bootstrapped ONLY from the approved schema-only baseline: never from staging rows or a staging backup, and no fixture command is run against it.
3. [LA] createDatabaseBackup x2 from 08p-uplink-backup-config-prod.createDatabaseBackup.json (database uplink-db-prod; prefixes uplink/production/daily and uplink/production/weekly; retention 14 and 8); backup #0 via runDatabaseBackup; restore rehearsal into the disposable uplink-restore-check-prod created from 05p, verified by the 06p job with job-restore-verify.production.env.template; QA witnesses; the temporary services are deleted. The production audit service (07p) follows the same deferral rule as staging.
4. [LA] createFromSchema 02p-uplink-app-production.createFromSchema.json (service uplink-app-prod, PRODUCTION digest, domain uplink.epic.dm, NO operator middleware, NO env). The staging pair stays at build.uplink.epic.dm for rollback/diagnostics; no image, database, secret or volume is shared or swapped between the two pairings.
5. [OWNER] Environment tab of uplink-app-prod: paste uplink-app.production.env.template; enter ONLY the production slots (DATABASE_URL pointing at uplink_uplink-db-prod, ENCRYPTION_KEY, AUTH_SECRET, NEXTAUTH_SECRET: all newly generated, none copied from staging); Deploy with forceRebuild.
6. [LA] Readback (names only; env VALUES are never read), TLS for uplink.epic.dm via a public TLS client, tools/acceptance_smoke.py --base https://uplink.epic.dm --readiness-path <Codex path> --expect-title Uplink, tools/origin_control.mts for the production template; confirm redirects stay on uplink.epic.dm and nothing leaks build.uplink.epic.dm. QA verifies isolation (no cross-database grant, no network path from either app to the other database, no staging identity or session valid in production).
7. Rollback: remove the uplink-app-prod domain (non-destructive); the staging pairing is untouched; the production database keeps its volume until the PM approves otherwise.

## Rollback (all EasyPanel mechanisms)
- Application image: `updateAppSourceImage` to the previous approved digest then `deployAppService` (forceRebuild per the env/redeploy rule); Swarm auto-rolls back a revision that never turns healthy (observed FailureAction=rollback, 40 s monitor). Readback the SERVING task image digest, not the API reply.
- Application environment: owner restores the previous block in the Environment tab from his own copy; deploy with forceRebuild.
- Database: restore the last verified backup into a NEW EasyPanel Postgres service (`restoreDatabaseBackup`), owner re-points DATABASE_URL; keep the old volume until verified.
- Staging route: remove the domain or middleware in the portal (non-destructive).
- Whole project: only with explicit approval; never touches other projects or Deepseek.
