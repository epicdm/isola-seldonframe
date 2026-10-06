# Aggregate capacity recheck for both environments (read-only; r3.3)

Measured through the EasyPanel MCP (epic-portal) names-only/aggregate queries getLegacyMonitorSystemStats, getMetricsSystemStats (sample 2026-10-06T15:21:53Z), getStorageStats, getDockerTaskStats and getAllServicesStats, on 2026-10-06 between 15:21Z and 15:27Z. No create/update/delete, no prune, no inspect of service configuration (those procedures return secrets and were not used).

## Three different quantities (do not mix them)
| Quantity | Meaning | Value for Uplink |
|---|---|---|
| Ceiling (limit) | the most a service may use; a cap, not a claim on the host | per environment: app 2 CPU / 3072 MiB, database 2 CPU / 4096 MiB |
| Reservation | what the scheduler sets aside for a service | per service 0.5 CPU / 1024 MiB for app and database |
| Measured use | what the host is actually using | below (host-wide; no Uplink service exists yet) |

Configured aggregate for the two environments (validator INFO line, computed from the JSON specs): steady-state ceilings 8 CPU / 14336 MiB (2 apps + 2 databases); steady-state reservations 2 CPU / 4096 MiB. Transient, disposable objects (each environment: one import job, one verify job, one restore-check database; ceilings 0.5/512 MiB per job and 1 CPU/1024 MiB per restore-check database) add at most 4 CPU / 4096 MiB if every one existed at once for both environments; the runbook deletes them after use and runs staging first, production only at Phase 5, so they never all coexist. Worst case, everything at ceiling at the same moment: 12 CPU / 18432 MiB (never a plan; shown only as the bound).

## Measured host state (host03)
- CPU: 12 cores; load average 3.06 / 2.67 / 2.43; usage 24.15 percent (legacy stats) and 12.7 percent instantaneous (metrics sample).
- Memory: 32142 MiB total, 9003 MiB used (28.0 percent), 23139 MiB free. Largest consumers: the easypanel service 3.4 GiB, activepieces 0.67 GiB, isola/chat 0.56 GiB, prometheus 0.51 GiB, hermes-agent 0.50 GiB.
- Disk: 468.7 GB total, 154.2 GB used (32.9 percent), 314.5 GB free. No Uplink project directory exists in getStorageStats.
- Services: about 95 Swarm services desired, all at desired replicas except those desired 0 (isola_ai, isola_ai-db, isola_isola-portal-api, isola_isola-runtime, zz-runner-dry/pos); no uplink_* service exists.

## Reading
- Steady-state ceilings for BOTH environments (14336 MiB) fit inside the measured free memory (23139 MiB) with about 8.6 GiB (8803 MiB) to spare; even the worst-case bound (18432 MiB) fits with about 4.6 GiB (4707 MiB) to spare (the host reports its totals in MB; the difference between MB and MiB is under 5 percent and does not change the verdict). CPU ceilings (8 of 12 cores) are caps, not reservations; with current use near 3 cores a simultaneous all-ceiling burst would be tight, which is a burst-sharing risk, not a reservation shortfall.
- Not measured (stated, not assumed): the configured limits and reservations of the existing services, hence the node's committed reservations; swap use and OOM history. Swarm schedules on reservations, so the reservation headroom must be read during staging (a failed placement shows in the portal immediately). The measurement above does not claim it.
- Sequencing keeps the exposure small: Phase 3 creates only the staging pair (ceilings 4 CPU / 7168 MiB plus transient jobs); the production pair appears only at Phase 5 after Phase 4 approval and the PM's cutover instruction, after a fresh read of these same figures.

## Verdict (candidate evidence, not independent acceptance)
No capacity blocker is measured for staging or for the later coexistence of both environments; no prune, resizing or sequencing change is proposed. The two named unmeasured items (committed reservations, swap/OOM history) are re-read before each environment is created, with names-only calls. If a safe-capacity check fails then, the report names the narrow sizing or sequence blocker; there is no broad prune.
