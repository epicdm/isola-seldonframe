# line-evidence adapter

Read-only composition of the telecom facts about ONE WhatsApp business number, for the "Phone & WhatsApp" page of the
SeldonFrame workspace. It reuses the services that already know the answers (Meta Graph API, MagnusBilling REST) and owns no
state. Node 22; the only runtime dependency is `mysql2` (pinned), used in sql mode.

```
GET /v1/lines/:phoneNumberId?waba=:wabaId     Authorization: Bearer <ADAPTER_TOKEN>      -> line-evidence/v1
GET /healthz                                                                             -> {"ok":true}
```

Env (names only): `ADAPTER_TOKEN` (>= 24 chars), `META_WA_TOKEN`, and the voice-platform settings for the chosen mode:
- `MAGNUS_MODE=sql` (default, the release path): `MAGNUS_DB_HOST`, `MAGNUS_DB_USER`, `MAGNUS_DB_PASSWORD`; optional `MAGNUS_DB_PORT`, `MAGNUS_DB_NAME`, `MAGNUS_DB_CA`.
  A database account that can only SELECT, so read-only is enforced by the database engine (see below). The service **refuses to start**
  if a Magnus API key is also present, or if the DB user is `root`/`mbillingUser`.
- `MAGNUS_MODE=rest` (preview only): `MAGNUS_URL`, `MAGNUS_API_KEY`, `MAGNUS_API_SECRET`. That key is write-capable on the server side; it must not be used for a customer-facing deployment.

Optional: `META_API_BASE`, `PORT`, `BIND`, `EVIDENCE_CACHE_SECONDS` (20), `EVIDENCE_RPM` (30). It refuses to start without the required ones.

## Database-enforced read-only access (sql mode)
The only SQL the service can run is three constant `SELECT` statements with bound parameters (`magnus-sql.mjs`). The account must hold
exactly these column-level grants and nothing else, and must require TLS:

```sql
CREATE USER 'line_evidence_ro'@'<source address of the SSH forward>' IDENTIFIED BY '<from the secret store>' REQUIRE SSL;
GRANT SELECT (id, did, activated, reserved)                       ON mbilling.pkg_did             TO 'line_evidence_ro'@'<source address>';
GRANT SELECT (id_did, destination, id_sip, activated)             ON mbilling.pkg_did_destination TO 'line_evidence_ro'@'<source address>';
GRANT SELECT (calledstation, starttime, sessiontime, terminatecauseid) ON mbilling.pkg_cdr         TO 'line_evidence_ro'@'<source address>';
```
If the database listens only on loopback, reach it through an SSH local forward whose key is restricted on the database host:
`restrict,port-forwarding,permitopen="127.0.0.1:3306",permitlisten="127.0.0.1:1",command="/bin/false",from="<adapter host address>" <public key>`.
Tested in isolation (scratch MariaDB with TLS; throwaway sshd): the integration test `magnus-sql.integration.test.mjs` shows the
engine refusing writes, DDL, file output, privilege changes, other tables, other columns, `SELECT *` and non-TLS connections, each with a
positive control; an over-broad grant makes it fail. Nothing here creates an account or installs a key: staff do that from the release packet.

Container entrypoint (`deploy/entrypoint.sh`): reads these secrets from files under `/run/secrets` (`lev_adapter_token`, `lev_meta_token`, `lev_db_password`,
`lev_ssh_key`, `lev_known_hosts`), refuses to start if any is missing or if the known-hosts pin is empty, opens the restricted SSH forward bound to the container's own
loopback (`StrictHostKeyChecking=yes`, key-only, reconnect loop), then runs the adapter. Plain settings: `TUNNEL_HOST` (required), `TUNNEL_PORT` (22), `TUNNEL_USER` (levfwd),
`MAGNUS_DB_USER` (line_evidence_ro). The server exits on SIGTERM, so a container stop is clean even without an init process.
Tested end to end in isolation: pinned forward up and reading through it, a wrong pin never brings the forward up, missing secrets exit 78, no write-capable key in the environment.

Container: `deploy/Dockerfile` (build context = this directory). The one runtime dependency, `mysql2`, is pinned exactly with a lockfile in `deploy/`,
which is deliberately outside `packages/*` so the adapter is not a pnpm workspace member.

## Contract `line-evidence/v1`
Each source block is `{ok:true, ...facts}` or `{ok:false, error}`; the consumer must treat a failed block as unknown.

| block | facts (verified against the live APIs) |
|---|---|
| `meta` | `displayNumber, verifiedName, status, codeVerification, quality, nameStatus, platformType, messagingLimitTier (from whatsapp_business_manager_messaging_limit), canReceiveCallSip (from health_status.entities[PHONE_NUMBER = this id])`. The number must be listed under the supplied WABA or the block fails. |
| `calling` | `status, sipStatus, sipHost, sipPort` from `/{id}/settings?fields=calling` |
| `magnus` | `did {activated,reserved}`, `destination {value,kind,activated,count}`, `lastCalls[] {startedAt (UTC ISO), durationSec, answered, terminateCauseId}` from the `did`, `diddestination` and `call` read modules |

## Guarantees (tested)
- Read only: every Magnus request is the `read` action; every Meta request is a GET; there is no write code path.
- Magnus filters that are not honoured (whole table returned) are reduced to exact matches.
- Bad ids are rejected before any upstream call; tokens never appear in an error or response.
- One route, bearer-protected with a constant-time compare, cached 20 s, rate limited.

Run tests: `node --test evidence.test.mjs`.
