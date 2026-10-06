# Origin contract reconciliation (r3.1) - candidate evidence, not the final Codex release contract

## Finding (defect in r3, found by running the real Codex source)
r3's env template set NEXT_PUBLIC_APP_URL=https://uplink.epic.dm (the value the manual image workflow bakes in) while AUTH_URL, NEXTAUTH_URL, PLATFORM_APP_URL and APP_HOSTS pointed at https://build.uplink.epic.dm (staging). The Codex source at isola/pooled-postgres c853877fe9d89b361fc6f86a7e5d144af890d42b (packages/crm/src/lib/http/app-hosts.ts, canonicalAppOrigin) THROWS unless PLATFORM_APP_URL, AUTH_URL (or NEXTAUTH_URL) and NEXT_PUBLIC_APP_URL are one origin. Measured with the real function (tools/origin_control.mts, Node 24 --experimental-strip-types): r3 split values -> THROWS; one origin (staging or production) -> accepted; empty environment -> vendor default https://app.seldonframe.com (so an unset key is not a safe state). No assumption that split staging-runtime and production-baked URLs are compatible is retained.

## What r3.1 changes
- json/contract.json: new `origin` section; the five origin keys leave expected_config.
- json/uplink-app.env.template: NEXT_PUBLIC_APP_URL, AUTH_URL, NEXTAUTH_URL and PLATFORM_APP_URL all carry the single placeholder {{CANONICAL_APP_ORIGIN}}; APP_HOSTS is no longer set (optional alias list).
- tools/validate_package.py: the four keys must be identical; the canonical origin must be an Uplink origin AND its host must be routed to the app in 02 (auth and redirects are built from it); APP_HOSTS, if set, may list only Uplink hosts; the placeholder fails final mode.
- 60 validator controls (was 54), incl. the r3 split in offline and final mode, a production-host origin with only the staging host routed, and the beta host.

## Open decision (Codex Build / Overall PM; Lane A does not choose)
Which origin does the STAGING app use? Placeholders stay unresolved and fail closed until the final Codex contract/receipt states it.
- A. Separate builds: staging image built with workflow input public_url=https://build.uplink.epic.dm and all four keys = that origin; production image rebuilt with https://uplink.epic.dm. Consistent with the source and with locked decision 9 (stage on build.uplink.epic.dm), but staging does not prove the production digest: Phase 5 needs a second image acceptance.
- B. One image, one origin: canonical origin https://uplink.epic.dm for all four keys, the SAME digest and config promoted; before cutover the app is routed on uplink.epic.dm behind the operator allow-list (middleware uplink-operators returns 403 to everyone else) and the cutover is removing that middleware. Needs a PM amendment of decision 9 / Phase 5 wording (the bare domain is routed and gets its certificate earlier); build.uplink.epic.dm may remain an alias via APP_HOSTS if Codex's alias handling is accepted by Review.
- C. Codex changes the source so the runtime origin is not tied to the baked value (source change; outside Lane A scope).
Lane A recommendation: B if the PM accepts the amendment (it is the only option where the accepted digest and configuration are what runs in production), otherwise A with an explicit second acceptance. Either is a one-line substitution of {{CANONICAL_APP_ORIGIN}} (and the domain host in 02 for B); the validator enforces consistency for both.

## Other keys observed in the Codex candidate (c853877f) - observation only, not a contract
- Readiness: GET /api/health -> 200 {"status":"ok","database":"ready"}, 503 {"status":"unavailable","database":"unavailable"}; no configuration in the body (packages/crm/src/app/api/health/route.ts). {{CODEX_READINESS_PATH}} stays a placeholder until the Phase 1 receipt names it; tools/test_smoke.py now models this body and the 503 case.
- White-label keys read by packages/crm/src/lib/platform/branding.ts: PLATFORM_NAME, PLATFORM_HOME_URL, SHOW_VENDOR_BRANDING, PLATFORM_LOGO_URL, PLATFORM_FAVICON_URL, PLATFORM_SUPPORT_EMAIL, PLATFORM_EMAIL_FROM_NAME, PLATFORM_EMAIL_FOOTER (matches the plan list).
- No AI/Chatwoot/voice flag names and no fixture command were found as final contract; those placeholders are unchanged and never invented.
- CI at the time of reading: no passing run and no image digest (plan v2.7: run 37475577904 on aafb7f6 failed with 2 unit failures; the branch has moved to c853877f with fixes that are Codex-reported, not verified here).

## Reproduce
node --experimental-strip-types tools/origin_control.mts <checkout>/packages/crm/src/lib/http/app-hosts.ts json/uplink-app.env.template [origin]
(Run against the final release head when the receipt exists; if the file name or function changed, this check must be re-pointed, not assumed.)
