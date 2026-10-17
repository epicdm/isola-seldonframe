# line-evidence adapter

Read-only composition of the telecom facts about ONE WhatsApp business number, for the "Phone & WhatsApp" page of the
SeldonFrame workspace. It reuses the services that already know the answers (Meta Graph API, MagnusBilling REST) and owns no
state. Zero dependencies (Node 22).

```
GET /v1/lines/:phoneNumberId?waba=:wabaId     Authorization: Bearer <ADAPTER_TOKEN>      -> line-evidence/v1
GET /healthz                                                                             -> {"ok":true}
```

Env (names only): `ADAPTER_TOKEN` (>= 24 chars), `META_WA_TOKEN`, `MAGNUS_URL`, `MAGNUS_API_KEY`, `MAGNUS_API_SECRET`;
optional `META_API_BASE`, `PORT`, `BIND`, `EVIDENCE_CACHE_SECONDS` (20), `EVIDENCE_RPM` (30). It refuses to start without them.

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
