# Unresolved dependencies (r3.3) - each stays explicit and fail-closed until its owner supplies it

Snapshot read 2026-10-06T15:29:12Z (tool clock) from GitHub and Port, read-only (replaces the 15:12:59Z snapshot of r3.2). Lane A's own offline tests are not independent acceptance. Nothing below is filled from a guess: every Codex-owned field lives in json/codex-image-contract.template.json as a {{placeholder}} and makes `validate_package.py --mode final` fail until the Codex receipt supplies it.

## Codex Build (Phase 1 receipt ev-codex-uplink-phase1-production-source-rc-2026-10-06 does not exist yet)
| # | Field / need | Where it lands | Status at snapshot |
|---|---|---|---|
| D1 | accepted source commit (one commit for both images) | codex-image-contract source_commit | open: branch isola/pooled-postgres head is d980546a6fc64b3b5b757e0a435af4af5ba06b05 (CI run 37487780261 in progress); the run on c33e7f35 completed with success; runs on 6e5ee87c and 9c1cc10e failed. Lane-observed only; no Phase 1 receipt names an accepted commit. |
| D2 | staging image: tag, digest, run URL, built with public_url=https://build.uplink.epic.dm | images.staging, workflow_run_urls.staging, {{UPLINK_STAGING_IMAGE_DIGEST_HEX}} in 02 | open: no image digest exists |
| D3 | production image: tag, digest, run URL, built with public_url=https://uplink.epic.dm | images.production, workflow_run_urls.production, {{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}} in 02p | open |
| D4 | origin-specific tags and non-cancelling concurrency. OBSERVED at d980546a (not a receipt, not reviewed): the workflow now has staging_public_url and production_public_url inputs validated against the two approved origins, one verify job, an images matrix building both targets with tags ghcr.io/<owner>/isola-seldonframe:uplink-<target>-<sha>, and a per-ref concurrency group with cancel-in-progress false. The validator accepts this scheme and still refuses the old source-only tag and equal tags. Both images come from one run; workflow_run_urls may therefore hold the same URL twice | Codex workflow / receipt | open until the receipt records the two tags, digests and run URL and Review verifies provenance |
| D5 | readiness path (candidate in source: /api/health) | readiness_path; smoke --readiness-path | open until named in the receipt |
| D6 | fixture command (CI runs `pnpm --filter @seldonframe/crm db:seed-uplink` twice with UPLINK_FIXTURES=enabled; observation only; staging-only per PM ruling v2.9) | fixture_command | open until the receipt names the supported command and its environment |
| D7 | adapter flag keys and fail-closed values: AI mode, Chatwoot, EPIC voice | adapters.*, and the three {{CODEX_*}} lines in each env template | open: no names found as a contract |
| D8 | Phase 1 receipt statement that both images come from the same commit with identical dependency/toolchain inputs | review input | open |

## Independent gates (not Lane A)
| # | Gate | Status |
|---|---|---|
| G-P2 | Codex Review: independent Phase 2 APPROVE of source and schema baseline 8f9922e3...dba8b8, including provenance and digest of BOTH images | not started (needs Phase 1 receipt) |
| G-PM | Overall PM advancement to Phase 3 | not given |
| G-QA | Codex QA: staging acceptance, and isolated/local checks of the production-origin artifact before cutover | later phases |

## Owner prerequisites (narrow)
O1 secret entry in EasyPanel, separately per environment (staging only after Phase 2 approval; production only at Phase 5 with its own newly generated secrets and its own database password), O2 confirmed operator CIDR (66.118.37.10/32 is a candidate only), O3 answers on authorized encrypted off-host backup. Optional: branding values. Later: administrator email (Uplink Phase 4/5; never agents.epic.dm).

## Lane A inputs also still open
{{PG_IMAGE_DIGEST_HEX}} and {{PYTHON_IMAGE_DIGEST_HEX}}/{{AWSCLI_VERSION}} (Postgres digest candidate 65b16a8b...2aa0f65 needs Review approval; the Python/awscli items belong to the DEFERRED audit service), {{STAGING_OPERATOR_CIDR}}, {{BACKUP_STORAGE_PROVIDER_ID}}, owner-entered secrets and optional PLATFORM_* values.

## PM questions raised by this package (no default is decided by Lane A)
None open from r3.2: PM ruling v2.9 approved uplink-app-prod + uplink-db-prod (database uplink), separate databases, volumes, credentials, ENCRYPTION_KEY and auth/session secrets. Remaining read-only unknowns are in CAPACITY-RECHECK.md (committed reservations of existing services; swap/OOM history), re-read before each environment is created.
