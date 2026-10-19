# Uplink release image (host04 uplink_uplink-app-prod). Build context = the committed packages/crm tree of ONE commit
# (deploy/uplink-release/build.sh makes it with `git archive`; nothing uncommitted can enter).
#
# Base: the original production image, pinned by digest. It was built from da08b734 (tip of
# uplink/release-v4.48-g5-pilot-gate-org-coverage) and carries the installed node_modules. The root lockfile and package
# files are identical from da08b734 to the production baseline 562bf55c, so its dependencies match the committed lockfile.
# COPY adds and replaces files but never deletes, so verify.sh checks that the image's source equals the commit exactly.
FROM ghcr.io/epicdm/isola-seldonframe@sha256:9306368dae177d6f2a69fc59df7d17ad8aa6873571bbccdb9701593aefc03307
COPY crm/ /app/packages/crm/
WORKDIR /app/packages/crm
RUN NODE_OPTIONS=--max-old-space-size=8192 bash scripts/check-use-server.sh src && NODE_OPTIONS=--max-old-space-size=8192 node node_modules/next/dist/bin/next build && (test -d .next/cache && find .next/cache -mindepth 1 -delete || true)
WORKDIR /app
