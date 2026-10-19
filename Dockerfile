# SeldonFrame — self-host image for the CRM app (dashboard + public sites + API).
# Build context is the repo root (the app is a pnpm workspace at packages/crm).
#
#   docker compose up            # recommended — brings up Postgres + Neon proxy + this app
#   docker build -t seldonframe .   # image only
#
# Two stages: `builder` installs the full workspace and runs `next build`;
# `runner` carries the built app + node_modules (drizzle-kit lives here too, so
# the compose `migrate` service can reuse this image). We copy the whole /app
# tree between stages so pnpm's relative workspace symlinks stay intact.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

COPY . .
# A Windows clone (core.autocrlf) checks shell scripts out as CRLF, which
# breaks bash inside the Linux build. Normalize them so the image builds the
# same on any host OS. (node_modules is not in the context — see .dockerignore.)
RUN find . -name '*.sh' -type f -exec sed -i 's/\r$//' {} +
RUN pnpm install --frozen-lockfile

# `next build` should not need real secrets — pages are dynamic/authed. The
# placeholders keep any module-load-time env reads happy; NEON_LOCAL_HOST is
# deliberately unset so the build path matches production (plain neon-http).
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG PLATFORM_NAME=SeldonFrame
ARG PLATFORM_OPERATOR_NAME=SeldonFrame
ARG PLATFORM_APP_URL=https://app.seldonframe.com
ARG PLATFORM_HOME_URL=https://www.seldonframe.com
ARG PLATFORM_SUPPORT_EMAIL=support@seldonframe.com
ARG PLATFORM_EMAIL_FROM_NAME=SeldonFrame
ARG PLATFORM_EMAIL_FOOTER=The SeldonFrame team
ARG WORKSPACE_BASE_DOMAIN=app.seldonframe.com
ARG APP_HOSTS=
ARG PLATFORM_LOGO_URL=
ARG PLATFORM_FAVICON_URL=
ARG PLATFORM_SOURCE_URL=
ARG SHOW_VENDOR_BRANDING=true
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    AUTH_SECRET=build-only-not-a-real-secret \
    NEXTAUTH_SECRET=build-only-not-a-real-secret \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    PLATFORM_NAME=${PLATFORM_NAME} \
    PLATFORM_OPERATOR_NAME=${PLATFORM_OPERATOR_NAME} \
    PLATFORM_APP_URL=${PLATFORM_APP_URL} \
    PLATFORM_HOME_URL=${PLATFORM_HOME_URL} \
    PLATFORM_SUPPORT_EMAIL=${PLATFORM_SUPPORT_EMAIL} \
    PLATFORM_EMAIL_FROM_NAME=${PLATFORM_EMAIL_FROM_NAME} \
    PLATFORM_EMAIL_FOOTER=${PLATFORM_EMAIL_FOOTER} \
    WORKSPACE_BASE_DOMAIN=${WORKSPACE_BASE_DOMAIN} \
    APP_HOSTS=${APP_HOSTS} \
    PLATFORM_LOGO_URL=${PLATFORM_LOGO_URL} \
    PLATFORM_FAVICON_URL=${PLATFORM_FAVICON_URL} \
    PLATFORM_SOURCE_URL=${PLATFORM_SOURCE_URL} \
    SHOW_VENDOR_BRANDING=${SHOW_VENDOR_BRANDING}
RUN pnpm --filter @seldonframe/crm build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG PLATFORM_NAME=SeldonFrame
ARG PLATFORM_OPERATOR_NAME=SeldonFrame
ARG PLATFORM_APP_URL=https://app.seldonframe.com
ARG PLATFORM_HOME_URL=https://www.seldonframe.com
ARG PLATFORM_SUPPORT_EMAIL=support@seldonframe.com
ARG PLATFORM_EMAIL_FROM_NAME=SeldonFrame
ARG PLATFORM_EMAIL_FOOTER=The SeldonFrame team
ARG WORKSPACE_BASE_DOMAIN=app.seldonframe.com
ARG APP_HOSTS=
ARG PLATFORM_LOGO_URL=
ARG PLATFORM_FAVICON_URL=
ARG PLATFORM_SOURCE_URL=
ARG SHOW_VENDOR_BRANDING=true
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 PORT=3000
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    PLATFORM_NAME=${PLATFORM_NAME} \
    PLATFORM_OPERATOR_NAME=${PLATFORM_OPERATOR_NAME} \
    PLATFORM_APP_URL=${PLATFORM_APP_URL} \
    PLATFORM_HOME_URL=${PLATFORM_HOME_URL} \
    PLATFORM_SUPPORT_EMAIL=${PLATFORM_SUPPORT_EMAIL} \
    PLATFORM_EMAIL_FROM_NAME=${PLATFORM_EMAIL_FROM_NAME} \
    PLATFORM_EMAIL_FOOTER=${PLATFORM_EMAIL_FOOTER} \
    WORKSPACE_BASE_DOMAIN=${WORKSPACE_BASE_DOMAIN} \
    APP_HOSTS=${APP_HOSTS} \
    PLATFORM_LOGO_URL=${PLATFORM_LOGO_URL} \
    PLATFORM_FAVICON_URL=${PLATFORM_FAVICON_URL} \
    PLATFORM_SOURCE_URL=${PLATFORM_SOURCE_URL} \
    SHOW_VENDOR_BRANDING=${SHOW_VENDOR_BRANDING}
RUN corepack enable
WORKDIR /app

# curl for the healthcheck; tini for signal handling; psql for the
# self-host schema apply (scripts/docker-migrate.sh).
RUN apt-get update && apt-get install -y --no-install-recommends curl tini postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app ./

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/crm/node_modules/next/dist/bin/next", "start", "packages/crm", "--hostname", "0.0.0.0", "--port", "3000"]

# Explicit Uplink image profile. The upstream runner above retains its native
# SeldonFrame defaults; this target bakes only non-secret Uplink defaults, and
# Docker/EasyPanel runtime environment values continue to override them.
FROM runner AS uplink
ARG NEXT_PUBLIC_APP_URL=https://uplink.epic.dm
ARG PLATFORM_NAME=Uplink
ARG PLATFORM_OPERATOR_NAME=EPIC
ARG PLATFORM_APP_URL=https://uplink.epic.dm
ARG PLATFORM_HOME_URL=https://uplink.epic.dm
ARG PLATFORM_SUPPORT_EMAIL=uplink@epic.dm
ARG PLATFORM_EMAIL_FROM_NAME=Uplink by EPIC
ARG PLATFORM_EMAIL_FOOTER=Uplink is operated by EPIC - uplink@epic.dm
ARG WORKSPACE_BASE_DOMAIN=uplink.epic.dm
ARG APP_HOSTS=uplink.epic.dm
ARG PLATFORM_LOGO_URL=
ARG PLATFORM_FAVICON_URL=
ARG PLATFORM_SOURCE_URL=
ARG SHOW_VENDOR_BRANDING=false
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    PLATFORM_NAME=${PLATFORM_NAME} \
    PLATFORM_OPERATOR_NAME=${PLATFORM_OPERATOR_NAME} \
    PLATFORM_APP_URL=${PLATFORM_APP_URL} \
    PLATFORM_HOME_URL=${PLATFORM_HOME_URL} \
    PLATFORM_SUPPORT_EMAIL=${PLATFORM_SUPPORT_EMAIL} \
    PLATFORM_EMAIL_FROM_NAME=${PLATFORM_EMAIL_FROM_NAME} \
    PLATFORM_EMAIL_FOOTER=${PLATFORM_EMAIL_FOOTER} \
    WORKSPACE_BASE_DOMAIN=${WORKSPACE_BASE_DOMAIN} \
    APP_HOSTS=${APP_HOSTS} \
    PLATFORM_LOGO_URL=${PLATFORM_LOGO_URL} \
    PLATFORM_FAVICON_URL=${PLATFORM_FAVICON_URL} \
    PLATFORM_SOURCE_URL=${PLATFORM_SOURCE_URL} \
    SHOW_VENDOR_BRANDING=${SHOW_VENDOR_BRANDING}
