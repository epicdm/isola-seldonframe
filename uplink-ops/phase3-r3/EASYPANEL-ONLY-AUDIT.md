# EasyPanel-only audit of r1/r2/r3 (handoff v2.4) and service-to-portal control map

## 1. Audit of earlier artifacts against "every deployed object is EasyPanel-managed"
| Item (where) | Verdict | Replacement in r3 |
|---|---|---|
| r1/r2 host-side backup option 4B: root systemd timer, age encryption, off-box copy (r1 02) | NONCOMPLIANT (host cron/script) | EasyPanel DB backup entries with count retention (08); audit via EasyPanel Box scheduled script or managed audit service (07) |
| r2 import via `docker exec psql` on host03 (r2-00 S4, tools/uplink_db_tools.sh) | NONCOMPLIANT on host03 | EasyPanel one-shot job service (04) running tools/uplink_job.sh; docker-based tools remain OFFLINE evidence tooling only (laptop/deepseek scratch) |
| r2 restore rehearsal "standalone throwaway container on host03" (r1 02 section 5, r2-00 S5) | NONCOMPLIANT | disposable EasyPanel Postgres service (05) + `restoreDatabaseBackup` + verify job (06), all deleted through the portal |
| r1 secret file / wrapper / Docker secrets / harvesting (r1 05) | NONCOMPLIANT and withdrawn | owner enters values in EasyPanel UI (r2-05 Option B) |
| r2 `docker service rollback`, host regression via docker CLI | host-level mechanism | EasyPanel `updateAppSourceImage` + `deployAppService`; names-only readbacks are evidence collection, not management |
| r2 EasyPanel app + Postgres services, domain, middleware, resources | COMPLIANT | unchanged (02, 03, 01) |
| Offline rehearsal on deepseek scratch / laptop (tools/rehearse_baseline.sh) | ALLOWED (not a deployed service) | evidence only, cleanup by self-removal, no teardown command |
| Existing Chatwoot reuse | see CHATWOOT-REUSE-EVIDENCE.md | n/a |

## 2. Service-to-portal control map (what exists, where the owner/portal manages it)
| Deployed object | Portal identity | Logs/status | Supported change path | Persists across redeploy because |
|---|---|---|---|---|
| uplink-db | project uplink > Postgres service | portal logs, getDockerTaskStats, getMonitorTableData | portal Advanced/Resources/Backups tabs; MCP createDatabaseBackup/updateDatabaseBackup/restoreDatabaseBackup | EasyPanel stored spec + dedicated bind data dir |
| uplink-app | project uplink > App service | portal logs, status | portal Source/Environment/Domains/Resources/Deploy; MCP updateAppSourceImage, deployAppService, updateAppDeploy | stored env block re-applied on every deploy; image digest in source; mounts/resources/domains in stored spec |
| uplink-app-prod (Phase 5 only, gated) | project uplink > App service | portal logs, status | portal Source/Environment/Domains/Deploy; MCP updateAppSourceImage, deployAppService | same mechanisms as uplink-app; its own production image and env block |
| uplink-db-prod (Phase 5, gated) | project uplink > Postgres service | portal logs, getDockerTaskStats | same mechanisms as uplink-db; its own backups (uplink/production/...) | its own EasyPanel stored spec and its own data volume |
| uplink-operators middleware | Traefik middleware list | n/a | portal/MCP createMiddleware | stored in EasyPanel proxy config |
| daily/weekly backup entries | uplink-db > Backups | portal backup list, destination objects | MCP create/update/deleteDatabaseBackup, runDatabaseBackup | stored backup configuration |
| uplink-baseline-import (temporary) | App service | portal logs, state completed | create/delete in portal | n/a (deleted after success) |
| uplink-restore-check + uplink-restore-verify (temporary) | Postgres + App service | portal logs | create/delete in portal | n/a (deleted after rehearsal) |
| backup audit | Box service scripts (preferred) or managed app service | portal logs/restarts | portal | stored spec; file-mount contents stored by EasyPanel |
| TLS certificate for build.uplink.epic.dm | domain entry | domain status in portal | portal | Traefik resolver |
| Chatwoot (existing, NOT deployed by this package) | project isola > chat (+ chatwoot-sidekiq, db, redis) | portal | portal | existing |

## 3. Gaps and EasyPanel-compatible proposals (none is claimed as solved; classification and handling in PREREQUISITES-ACCEPTANCE-OPTIONAL.md: only G4 (provider encryption/authorization) is an owner prerequisite, G2/G3/G5 are staging acceptance tests, G1/G7 are disclosed limitations, G6 is an inventory risk, none is a blanket approval)
G1 No push alerting for failed backups/audit: EasyPanel has no notification channel for these. Proposal: audit service/Box script fails visibly (status, restarts, logs) plus a recurring owner check; if push alerts are required, approve an EasyPanel-managed notifier service (e.g. a managed app that posts the verdict to a channel the owner chooses).
G2 restart.condition is not settable (on-failure for apps): a process that exits 0 is stranded. Mitigation: staging test, portal status watch; ask Codex to confirm the app exits non-zero when it terminates unexpectedly. No host-level override is allowed (it is erased by the next deploy).
G3 EasyPanel Postgres services have no health check or mount fields: readiness is verified by the import/verify jobs and by the app readiness endpoint (Codex Phase 1).
G4 Provider-side controls (bucket encryption at rest, lifecycle) are not portal-managed. Disclosed limitation; the owner sheet requires the owner to confirm them. EasyPanel count retention (retention=N) is the retention mechanism; bucket lifecycle must NOT be the only retention.
G5 Whether EasyPanel retention counts only successful backups is unproven; the audit counts real restore points independently.
G6 A non-EasyPanel Chatwoot-like stack (cw_*) exists on host03 (see CHATWOOT-REUSE-EVIDENCE.md): reported, not touched.
G7 DB service env/mount edits are limited in the MCP; the owner uses the portal for them.

## 4. Redeploy-persistence acceptance checklist (every deployed Uplink service, Phase 3 S8; QA re-runs in Phase 4)
Per service (uplink-db, uplink-app, the middleware, the backup entries): (a) record a names-only/non-secret spec projection BEFORE: image reference with digest, resources, mounts, ports (none), domains+middlewares, restart policy, replicas, env KEY NAMES, volume/bind identity, backup entries; (b) deploy twice with no change; (c) projection AFTER equals BEFORE; (d) change the image digest to a second approved digest then back (updateAppSourceImage + deploy) and confirm the SERVING task image after each; (e) owner changes one non-secret env value in the UI, deploy with forceRebuild, confirm the serving task has it, change it back; (f) uplink-db: row counts unchanged (zero before fixtures; fixture counts after) across a service restart; (g) portal shows logs and status for each object; (h) negative control: an out-of-band host change is NOT used; instead confirm the proposal contains no host-level step (grep the runbook and artifacts: no docker/systemctl/crontab on host03). Pass = every projection equal and every object manageable from the portal.
