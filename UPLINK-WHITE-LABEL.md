# Uplink white-label configuration

This release keeps SeldonFrame's native workspace, public-form, booking, embed, auth, and commercial-entitlement behavior. Platform identity is configurable; unset values retain upstream SeldonFrame defaults.

## Runtime configuration

Set these non-secret values in the Uplink EasyPanel application service. The manual image workflow passes the same public values during `next build` because app metadata and public identity may be rendered or emitted at build time:

```dotenv
PLATFORM_NAME=Uplink
PLATFORM_OPERATOR_NAME=EPIC
PLATFORM_APP_URL=https://uplink.epic.dm
PLATFORM_HOME_URL=https://uplink.epic.dm
PLATFORM_SUPPORT_EMAIL=uplink@epic.dm
PLATFORM_EMAIL_FROM_NAME=Uplink by EPIC
PLATFORM_EMAIL_FOOTER=Uplink is operated by EPIC · uplink@epic.dm
SHOW_VENDOR_BRANDING=false
WORKSPACE_BASE_DOMAIN=uplink.epic.dm
APP_HOSTS=uplink.epic.dm
```

`PLATFORM_LOGO_URL` and `PLATFORM_FAVICON_URL` accept a root-relative path or HTTPS URL. If omitted for a non-SeldonFrame platform name, branded pages use the configured text name and do not reuse upstream SeldonFrame logo assets. `PLATFORM_SOURCE_URL` must be an HTTPS URL to the exact corresponding source made available to network users; do not set it to a private or unrelated repository. Until that source is publicly accessible, the license page provides the configured support contact and source availability remains a release compliance gate.

Keep `PLATFORM_APP_URL`, `NEXT_PUBLIC_APP_URL`, `AUTH_URL`, and `NEXTAUTH_URL` aligned to `https://uplink.epic.dm`. Runtime-only secrets such as `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, SMTP credentials, and model credentials belong in EasyPanel's approved runtime secret mechanism only; never pass them as build arguments.

## Entitlements and attribution

`SHOW_VENDOR_BRANDING=false` is an operator configuration for the self-hosted Uplink instance, not a paid-plan claim. Public `Powered by` suppression still passes through `shouldShowPoweredByBadgeForOrg` and `canRemoveBranding`; the override cannot remove attribution when the existing commercial entitlement denies it. Workspace/agency branding and workspace-level paid controls are unchanged. The SeldonFrame source license and legal notices remain available at `/license`, and the upstream `LICENSE` and `LICENSING.md` files are preserved.

## Image source path

The repository's existing manual GitHub Actions workflow `.github/workflows/build-isola-seldonframe.yml` is the supported candidate image-source path: it checks out the selected source revision, runs its verification job, and builds/pushes the image. Its `public_url` input is public configuration. `Dockerfile` uses build-only placeholders for auth/database values; real production secrets are not required or permitted as build arguments and are injected only by EasyPanel at runtime. This package does not dispatch that workflow or write to a registry. The alternate EasyPanel upload-source archive format remains unverified.

The workflow also passes `PLATFORM_NAME`, `PLATFORM_OPERATOR_NAME`, `PLATFORM_APP_URL`, `PLATFORM_HOME_URL`, `PLATFORM_SUPPORT_EMAIL`, `PLATFORM_EMAIL_FROM_NAME`, `PLATFORM_EMAIL_FOOTER`, `WORKSPACE_BASE_DOMAIN`, `PLATFORM_LOGO_URL`, `PLATFORM_FAVICON_URL`, `PLATFORM_SOURCE_URL`, and `SHOW_VENDOR_BRANDING`. It rejects mismatched public/app/home origins or a workspace base domain that differs from the app host. These are public brand settings, not secrets. `DATABASE_URL`, auth/encryption secrets, SMTP credentials, and provider credentials are not passed as build args.

The workflow also accepts `APP_HOSTS` for the canonical app-host allow-list and validates it against the public origin. Uplink uses `APP_HOSTS=uplink.epic.dm`. The workflow builds the explicit Docker target `uplink`, which carries non-secret EPIC/Uplink values as image defaults; EasyPanel runtime environment values override those defaults. The ordinary `runner` target retains upstream SeldonFrame defaults and leaves `APP_HOSTS` empty.

## Runtime entry and route behavior

The runner starts the already-installed Next CLI directly from `/app`:

```sh
node packages/crm/node_modules/next/dist/bin/next start packages/crm --hostname 0.0.0.0 --port 3000
```

This is equivalent to the CRM package's `next start` script and does not invoke Corepack or download pnpm when the container starts. The command was started locally against the completed production build; Next reported ready. The app-host `/` proxy bypass is limited to a configured non-default platform name; default SeldonFrame keeps its existing auth redirect. The actual proxy function was tested for an Uplink root request, and the production build includes the route. An HTTP request using runtime Uplink configuration could not be run because the execution policy rejected that local server invocation.

Auth.js sign-in keeps the existing Resend provider registration but replaces the returned provider's actual `sendVerificationRequest` function. SMTP2GO is selected ahead of Resend when its key and sender are configured, and the configured Uplink email identity is used. This path was exercised through Auth.js with a mock transport only; no live email was sent.

Dashboard and settings copy uses the configured platform identity and workspace base domain. Public URLs and the Stripe Connect webhook use configured Uplink origins. Existing plan gates, attribution entitlements, API identifiers and legal notices are preserved. Authenticated page rendering and database-backed writes remain unverified pending an isolated synthetic PostgreSQL runtime.
