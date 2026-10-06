# Unresolved dependencies (r3.2) - each stays explicit and fail-closed until its owner supplies it

Snapshot read 2026-10-06T15:12:59Z (tool clock) from GitHub and Port, read-only. Lane A's own offline tests are not independent acceptance. Nothing below is filled from a guess: every Codex-owned field lives in json/codex-image-contract.template.json as a {{placeholder}} and makes `validate_package.py --mode final` fail until the Codex receipt supplies it.

## Codex Build (Phase 1 receipt ev-codex-uplink-phase1-production-source-rc-2026-10-06 does not exist yet)
| # | Field / need | Where it lands | Status at snapshot |
|---|---|---|---|
| D1 | accepted source commit (one commit for both images) | codex-image-contract source_commit | open: branch isola/pooled-postgres head is 6e5ee87c52d37a751d2463445332e4d905f4c3bf; its CI run 37484918792 completed with FAILURE; the previous two runs were 1 failure and 2 successes on other heads. No accepted commit. |
| D2 | staging image: tag, digest, run URL, built with public_url=https://build.uplink.epic.dm | images.staging, workflow_run_urls.staging, {{UPLINK_STAGING_IMAGE_DIGEST_HEX}} in 02 | open: no image digest exists |
| D3 | production image: tag, digest, run URL, built with public_url=https://uplink.epic.dm | images.production, workflow_run_urls.production, {{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}} in 02p | open |
| D4 | origin-specific tags. The workflow at 6e5ee87c tags every build ghcr.io/<owner>/isola-seldonframe:uplink-phase1-<sha> regardless of public_url, so the second build would overwrite the first tag (the first digest stays pullable by digest). The validator refuses the source-only tag and refuses equal tags. Also note concurrency group build-isola-seldonframe has cancel-in-progress: true, so the two dispatches must run one after the other | Codex workflow (not editable by Lane A) | open: needs a Codex change or an explicit tag record from the receipt |
| D5 | readiness path (candidate in source: /api/health) | readiness_path; smoke --readiness-path | open until named in the receipt |
| D6 | fixture command (CI runs `pnpm --filter @seldonframe/crm db:seed-uplink` twice with UPLINK_FIXTURES=enabled; observation only) | fixture_command | open until the receipt names the supported command and its environment |
| D7 | adapter flag keys and fail-closed values: AI mode, Chatwoot, EPIC voice | adapters.*, and the three {{CODEX_*}} lines in each env template | open: no names found as a contract |
| D8 | Phase 1 receipt statement that both images come from the same commit with identical dependency/toolchain inputs | review input | open |

## Independent gates (not Lane A)
| # | Gate | Status |
|---|---|---|
| G-P2 | Codex Review: independent Phase 2 APPROVE of source and schema baseline 8f9922e3...dba8b8, including provenance and digest of BOTH images | not started (needs Phase 1 receipt) |
| G-PM | Overall PM advancement to Phase 3 | not given |
| G-QA | Codex QA: staging acceptance, and isolated/local checks of the production-origin artifact before cutover | later phases |

## Owner prerequisites (narrow)
O1 secret entry in EasyPanel (only after Phase 2 approval), O2 confirmed operator CIDR (66.118.37.10/32 is a candidate only), O3 answers on authorized encrypted off-host backup. Optional: branding values. Later: administrator email (Uplink Phase 4/5; never agents.epic.dm).

## Lane A inputs also still open
{{PG_IMAGE_DIGEST_HEX}} and {{PYTHON_IMAGE_DIGEST_HEX}}/{{AWSCLI_VERSION}} (Postgres digest candidate 65b16a8b...2aa0f65 needs Review approval; the Python/awscli items belong to the DEFERRED audit service), {{STAGING_OPERATOR_CIDR}}, {{BACKUP_STORAGE_PROVIDER_ID}}, owner-entered secrets and optional PLATFORM_* values.

## PM questions raised by this package (no default is decided by Lane A)
1. Production DB: this package assumes the single uplink-db serves both uplink-app (staging) and uplink-app-prod, with the same ENCRYPTION_KEY. Confirm, or ask for a separate production database (new spec and baseline import).
2. Service name for production is uplink-app-prod (the plan names one uplink-app); confirm the naming.
