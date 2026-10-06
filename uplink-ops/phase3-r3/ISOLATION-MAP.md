# Staging / production isolation mapping (r3.3, PM ruling plan v2.9 of 2026-10-06T15:20:01Z)

This maps configuration ownership. Distinct names and slots are NOT a network-isolation claim: roles, grants, cross-database access and network reachability are verified by QA after deployment. Lane A never reads, prints or compares any secret value; the validator checks slot NAMES and service/host identifiers only.

| Object | Staging (Phase 3) | Production (Phase 5, gated) |
|---|---|---|
| Public origin / image | https://build.uplink.epic.dm, staging image (public_url build.uplink.epic.dm) | https://uplink.epic.dm, production image (public_url uplink.epic.dm); same accepted source commit, distinct tag and digest |
| App service | uplink-app (02) | uplink-app-prod (02p) |
| Database service | uplink-db, database uplink (03, owner creates in UI) | uplink-db-prod, database uplink (03p, owner creates in UI) |
| Data volume | the EasyPanel-managed volume of uplink-db | the EasyPanel-managed volume of uplink-db-prod; never declared in a spec, never shared (specs that declare mounts/volumes fail validation) |
| Database credentials | slot OWNER_ENTERS_STAGING_DATABASE_URL (database password via the UI-generated password of uplink-db) | slot OWNER_ENTERS_PRODUCTION_DATABASE_URL (password of uplink-db-prod) |
| DATABASE_URL target | host uplink_uplink-db database uplink (stated in the template and validated) | host uplink_uplink-db-prod database uplink (stated in the template and validated) |
| ENCRYPTION_KEY | slot OWNER_ENTERS_STAGING_ENCRYPTION_KEY | slot OWNER_ENTERS_PRODUCTION_ENCRYPTION_KEY (never copied; no re-encryption migration) |
| Auth/session secrets | OWNER_ENTERS_STAGING_AUTH_SECRET and ..._NEXTAUTH_SECRET | OWNER_ENTERS_PRODUCTION_AUTH_SECRET and ..._NEXTAUTH_SECRET |
| Import job | uplink-baseline-import (04) with job-import.staging.env.template (PGHOST uplink_uplink-db, slot ..._STAGING_DB_PASSWORD) | uplink-baseline-import-prod (04p) with job-import.production.env.template (PGHOST uplink_uplink-db-prod, slot ..._PRODUCTION_DB_PASSWORD) |
| Restore rehearsal | uplink-restore-check (05) + uplink-restore-verify (06); env job-restore-verify.staging.env.template | uplink-restore-check-prod (05p) + uplink-restore-verify-prod (06p); env job-restore-verify.production.env.template |
| Backups (EasyPanel, count retention 14/8) | 08 on uplink-db; prefixes uplink/staging/daily and uplink/staging/weekly | 08p on uplink-db-prod; prefixes uplink/production/daily and uplink/production/weekly |
| Backup audit (DEFERRED, needs existing scoped access) | uplink-backup-audit (07), AUDIT_ENV=staging, slots ..._STAGING_AUDIT_... | uplink-backup-audit-prod (07p), AUDIT_ENV=production, slots ..._PRODUCTION_AUDIT_... |
| Database bootstrap | the approved schema-only baseline (sha256 8f9922e3...dba8b8) via the import job | the SAME approved baseline via its own import job; never staging rows and never a staging backup (a production artifact that references the staging prefixes, host or slots fails validation) |
| Synthetic fixtures | staging only (Codex fixture command, from its receipt) | none; image-contract fixture_scope must be staging-only; a fixture/seed/demo key or mention in any production artifact fails validation; separately approved isolated production acceptance fixtures would need a new ruling |
| Operator-only rule | middleware uplink-operators on build.uplink.epic.dm | none (public after cutover) |

## What the validator enforces (tools/validate_package.py, 112 controls in tools/test_validate.py)
Service names unique across both environments; each environment's artifacts reference only its own service/host/prefix/slot identifiers (the other environment's identifiers are searched for and refused); each secret slot in an environment's templates equals that environment's slot and no slot is shared; no generic shared marker; each app template states its own database target; each import/verify job targets only its own database or restore-check host and carries only its own password slot; backups target only their own database service and prefixes; the audit service audits only its own prefixes; DB specs declare no mounts/volumes; fixtures staging-only; the staging and production templates differ only in origin keys and secret slots.

## What it cannot prove (left to QA and to staging evidence)
That the two Postgres services use two physical volumes (readback with listMounts after creation), that no role or grant crosses databases, that the network does not let one app reach the other database, and that no secret VALUE was reused (values are never read; separate entry is a procedure the owner performs and attests).
