# Uplink owner setup sheet (one page, EasyPanel UI only). Nothing here asks for a live AI, Chatwoot or voice decision.

You type secrets only into EasyPanel. Never paste a secret into chat, Port, GitHub or a file. Lane A will not read them.
Blocking map: each section blocks ONLY its dependent Phase 3 step; Lane A finishes everything else.

## A. Secret entry (blocks Phase 3 steps S3, S4, S6)
A1. Create the database service (S3). EasyPanel: project `uplink` > + Service > Postgres. Fields: Service name `uplink-db`; Database `uplink`; User `uplink`; Password = leave the generated one; Image `postgres:16.15@sha256:<DIGEST>` (Lane A gives the approved digest); Command `postgres -c max_connections=100 -c shared_buffers=1GB -c effective_cache_size=2GB -c work_mem=8MB -c maintenance_work_mem=128MB -c password_encryption=scram-sha-256 -c log_min_duration_statement=500 -c log_connections=on -c log_disconnections=on -c idle_in_transaction_session_timeout=60000`; Resources CPU limit 2 / reservation 0.5; memory limit 4096 MB / reservation 1024 MB; no exposed port; pgWeb/dbGate OFF.
A2. Copy the database password only into the three places below (never anywhere else): the DATABASE_URL line (A4), the PGPASSWORD of the temporary import job (A5), and your offline password manager.
A3. Offline custody of ENCRYPTION_KEY. Generate on your own machine: `openssl rand -hex 32` (run it in your own terminal; do not paste the output anywhere shared). Store it in your password manager AND on one offline copy (printed or encrypted USB). Losing it makes stored third-party credentials unrecoverable; changing it later needs a re-encrypt procedure, not a simple edit. Do the same for AUTH_SECRET and NEXTAUTH_SECRET (`openssl rand -base64 48`, two different values).
A4. App environment (S6). EasyPanel: uplink > uplink-app > Environment. Paste the contents of `uplink-app.env.template`, then replace every `{{...}}`: DATABASE_URL = `postgresql://uplink:<DB PASSWORD>@uplink_uplink-db:5432/uplink`; AUTH_SECRET, NEXTAUTH_SECRET, ENCRYPTION_KEY = your generated values; PLATFORM_SUPPORT_EMAIL / PLATFORM_LOGO_URL / PLATFORM_FAVICON_URL = your values or leave empty (text branding "Uplink" is used; no contacts are invented); the Codex keys when Lane A hands you the final list. Save, then Deploy with "Force rebuild" ON. After this only YOU edit this Environment tab.
A5. Import job env (S4). uplink > uplink-baseline-import > Environment: paste `job-import.env.template`, replace PGPASSWORD with the database password, Deploy. When its logs show `RESULT PASS import job complete`, delete this service.
A6. Masking: please look at the Environment tab and tell Overall PM whether values are shown masked or in clear text (not the values themselves). This decides whether the exposure profile in the secrets paper holds.

## B. Operator access (blocks S1/S6 staging route)
B1. Confirm the operator network CIDR(s). Candidate seen from this host's own SSH session: 66.118.37.10/32 (UNCONFIRMED). Check from each operator machine, e.g. open a "what is my IP" page, and send only the answer "yes, that is our fixed egress" or the list of CIDRs. A wrong value locks operators out of staging (recoverable by editing the rule). If you prefer credentials instead of IPs, say so: Lane A will propose a basic-auth rule whose password file you create.

## C. Backup prerequisites (blocks S5 step 1-2 and the Phase 3 backup acceptance)
C1. In the storage provider console for the destination EasyPanel calls "DO Spaces (isola-easypanel-backups)": confirm (answers only, not keys) (a) encryption at rest is on, (b) EPIC authorizes Uplink backups there, (c) a lifecycle backstop is either off or at least 60 days for `uplink/daily/` and 240 days for `uplink/weekly/`, never shorter, (d) you can create a second READ-ONLY key. If any answer is no, name another destination once.
C2. Create the read-only key for the audit and enter it ONLY in the audit service Environment (`audit.env.template`) when Lane A asks. Do not reuse the write key.
C3. Weekly check until the audit service shows green in the portal: look at the audit service status/logs (EasyPanel has no push alert; see control map G1).
C4. Restore rehearsal (S5): create the disposable Postgres `uplink-restore-check` from `05-uplink-restore-check-db.owner-ui-spec.json`, enter its password into the verify job env, and delete both temporary services when Lane A confirms the result.

## D. Administrator sign-in (blocks Phase 4/5 only, not Phases 1-3)
D1. Nominate the one administrator email for the first Uplink operator account. No email is sent until you do this; SMTP stays disabled during build and staging.
D2. When requested in Phase 4, you enter the email-provider secret in EasyPanel exactly like A4; Lane A never sees it.
D3. Until then sign-in stays disabled/closed by default and staging is operator-only (B1).

## What you do NOT need to decide now
AI provider, key or cost (simulators are used), live Chatwoot channel activation (reuse of the existing instance is confirmed; no mutation), voice routing, recording policy, wildcard DNS automation, logo/favicon files (text branding "Uplink by EPIC" is used; footer text candidate "Uplink by EPIC Communications").
