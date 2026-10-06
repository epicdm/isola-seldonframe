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
  The EPIC workflow is `build-isola-seldonframe.yml` (manual run; journal check, typecheck, launch specs, one amd64 image).
* **Not in this repository:** credentials, customer or tenant data, environment files, internal EPIC operating
  documents. Runtime configuration is supplied only through environment variables at deploy time.

## Build and deployment boundary

Production deployment and every deployed support service for Uplink are managed in EasyPanel. Do not deploy with host-level Docker/Compose/Swarm commands, standalone containers, host daemons, host cron, or manual service overrides. Application configuration and secrets are entered through the authorized EasyPanel controls; do not materialize secrets into host files or unmanaged wrappers. External DNS, provider storage, the existing Chatwoot deployment, and EPIC telecom systems are not recreated by this repository.

For a local/offline build check only:

    docker build --build-arg NEXT_PUBLIC_APP_URL=https://uplink.epic.dm -t isola-seldonframe .

For a candidate image, run the `build-isola-seldonframe` workflow (Actions tab). It type-checks, runs the configured specs and pushes one amd64 image to
`ghcr.io/<owner>/isola-seldonframe`. Record and pin the workflow's immutable digest in EasyPanel; do not deploy by mutable tag. The Dockerfile's build-stage values (`DATABASE_URL`, `AUTH_SECRET`, ...) are throwaway placeholders, never runtime credentials. EasyPanel redeploy persistence must be verified from its portal read-back before staging.

## Runtime environment (names only)

Database: `DATABASE_URL`, optional `DB_DRIVER=pg`, `DB_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_POOL_CONNECT_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`.

Canonical origin: `PLATFORM_APP_URL`, `NEXT_PUBLIC_APP_URL`, and `AUTH_URL` must agree; `APP_HOSTS` contains only explicitly approved aliases.

Branding: `PLATFORM_NAME`, `PLATFORM_HOME_URL`, `PLATFORM_SUPPORT_EMAIL`, `PLATFORM_LOGO_URL`, `PLATFORM_FAVICON_URL`, `PLATFORM_EMAIL_FROM_NAME`, `PLATFORM_EMAIL_FOOTER`, `SHOW_VENDOR_BRANDING`.

Authentication/application: `AUTH_SECRET`, `ENCRYPTION_KEY`. Portal email may use `SMTP2GO_API_KEY` and `PORTAL_EMAIL_FROM`; follow-up routing may use `FOLLOW_UP_RESPONDER_EMAIL`. Do not configure secrets from source files or local build arguments.