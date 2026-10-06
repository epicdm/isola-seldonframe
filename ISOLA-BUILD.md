# Isola build of SeldonFrame (EPIC Communications)

This repository is a **fork of [seldonframe/seldonframe](https://github.com/seldonframe/seldonframe)**,
distributed under the same licence (GNU AGPL-3.0, see `LICENSE` and `LICENSING.md`, unchanged from upstream).
EPIC Communications Inc runs a modified copy as a public service; this repository is the **Corresponding Source**
for that service (AGPL-3.0 section 13).

* **Upstream base:** commit `3f386a2` of `seldonframe/seldonframe` (main as of 2026-08-24).
* **Our changes** (marked in-file with an `EPIC 2026-10-04` comment, as AGPL section 5(a) requires):
  1. `packages/crm/src/app/api/v1/public/intake/route.ts` - a public intake-form submission now also records one
     staff follow-up task and assigns the contact (`packages/crm/src/lib/bookings/owned-follow-up.ts`, new). The task goes to the
     workspace user named in `FOLLOW_UP_RESPONDER_EMAIL`; if no such user exists nothing is assigned. The enquiry itself is
     always saved and stays visible under Lead Forms.
  2. Customer portal "Your services" card: `packages/crm/src/lib/portal/service-links.ts`,
     `service-links-actions.ts`, `components/settings/portal-service-links-form.tsx`, the portal home page and the
     Client Portal settings page. Links are https-only, at most 5, no embedded credentials.
  3. Portal sign-in code email uses SMTP2GO when `SMTP2GO_API_KEY` and `PORTAL_EMAIL_FROM` are set, even if a Resend key is
     also present; otherwise Resend (`RESEND_API_KEY`) as before (`lib/portal/email-transport.ts`, `lib/emails/portal-access-code.ts`,
     `lib/portal/auth.ts`).
  4. `Dockerfile`: `NEXT_PUBLIC_APP_URL` is a build argument (upstream hard-coded `http://localhost:3000`).
  5. `lib/forms/actions.ts` and `lib/forms/contact-from-answers.ts`: the form server-action path now maps the name and phone
     answers onto the contact (it used to create a contact called "New" with no phone).
  6. Five unit specs under `packages/crm/tests/unit/agents/` covering the above.
* **Upstream workflows and Dependabot:** `ci.yml` (typecheck, unit tests, drift detectors) and `dependabot.yml` are kept
  unchanged. Omitted: `deploy-demo.yml` (deploys to upstream's Vercel project and smoke-tests upstream's production host),
  `publish-image.yml` (multi-arch push to upstream's registry path) and `publish-mcp.yml` (npm provenance publish of upstream's
  package). Dependency-update PRs do not publish or deploy anything here.
  The EPIC workflow is `build-isola-seldonframe.yml` (manual run; journal check, typecheck, launch specs, separate staging and production amd64 images from the same workflow SHA).
* **Not in this repository:** credentials, customer or tenant data, environment files, internal EPIC operating
  documents. Runtime configuration is supplied only through environment variables at deploy time.

## Build and deployment boundary

Production deployment and every deployed support service for Uplink are managed in EasyPanel. Do not deploy with host-level Docker/Compose/Swarm commands, standalone containers, host daemons, host cron, or manual service overrides. Application configuration and secrets are entered through the authorized EasyPanel controls; do not materialize secrets into host files or unmanaged wrappers. External DNS, provider storage, the existing Chatwoot deployment, and EPIC telecom systems are not recreated by this repository.

For a local/offline build check only:

    docker build --build-arg NEXT_PUBLIC_APP_URL=https://uplink.epic.dm -t isola-seldonframe .

For candidate images, dispatch `build-isola-seldonframe.yml` on the reviewed PR branch with `staging_public_url=https://build.uplink.epic.dm` and `production_public_url=https://uplink.epic.dm`. The workflow validates both origins, gates two amd64 image builds on verification, and publishes unique tags `uplink-staging-<sha>` and `uplink-production-<sha>` from that same source SHA. Record both immutable digests; never deploy by mutable tag. Workflow concurrency queues another run rather than cancelling the active pair. The Dockerfile's build-stage values (`DATABASE_URL`, `AUTH_SECRET`, ...) are throwaway placeholders, never runtime credentials. EasyPanel redeploy persistence must be verified from its portal read-back before staging.

## Runtime environment (names only)

Database: `DATABASE_URL`, optional `DB_DRIVER=pg`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_POOL_CONNECT_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`.

Canonical origin: set `PLATFORM_APP_URL`, `NEXT_PUBLIC_APP_URL`, `AUTH_URL`, and `NEXTAUTH_URL` to the same environment-specific origin: `https://build.uplink.epic.dm` in staging and `https://uplink.epic.dm` in production. `APP_HOSTS` contains only explicitly approved aliases. Set `WORKSPACE_BASE_DOMAIN` to the approved workspace host pattern when configured; if omitted, both emitted workspace URLs and proxy routing derive it from the canonical app host. `agents.epic.dm` is historical beta only and must not appear in Uplink auth, redirects, origins, or workspace links.

Branding: `PLATFORM_NAME`, `PLATFORM_HOME_URL`, `PLATFORM_SUPPORT_EMAIL`, `PLATFORM_LOGO_URL`, `PLATFORM_FAVICON_URL`, `PLATFORM_EMAIL_FROM_NAME`, `PLATFORM_EMAIL_FOOTER`, `SHOW_VENDOR_BRANDING`.

Integration contracts: `UPLINK_CHATWOOT_ENABLED=false` and `UPLINK_EPIC_VOICE_ENABLED=false` by default; readiness is `GET /api/health` (database probe, secret-free JSON, 503 on unavailable). This Phase 1 build has interfaces only; setting either flag true still fails closed as not implemented. No Chatwoot messages, voice calls, DID changes, recording or transcripts are enabled.

Synthetic fixtures: `pnpm --filter @seldonframe/crm db:seed-uplink` creates the Personal Line, Business Front Office, agency-parent and isolated child-client records with `.invalid` users, no passwords, no customer data and integrations off. It requires `UPLINK_FIXTURES=enabled` and `DB_DRIVER=pg` because writes are transaction-scoped; local use is restricted to loopback PostgreSQL. Production-mode fixture execution is restricted to `UPLINK_FIXTURE_TARGET=staging`, `PLATFORM_APP_URL=https://build.uplink.epic.dm`, and database host `uplink-db`. Existing slugs not marked by this fixture are rejected. The command is idempotent and transaction-scoped.

Authentication/application: `AUTH_SECRET`, `ENCRYPTION_KEY`. Portal email may use `SMTP2GO_API_KEY` and `PORTAL_EMAIL_FROM`; follow-up routing may use `FOLLOW_UP_RESPONDER_EMAIL`. Do not configure secrets from source files or local build arguments.
## Environment separation (v2.9)

Staging uses EasyPanel services `uplink-app` and `uplink-db`; production uses `uplink-app-prod` and `uplink-db-prod`. Each environment has its own database, persistent volume, `DATABASE_URL`, database credentials, `ENCRYPTION_KEY`, and auth/session secrets. Staging fixture/build jobs must connect only to their disposable or staging database; they never mount or contact the production database and never carry production secrets. Production bootstraps only from the independently accepted schema-only baseline, not a staging backup or fixture rows.
