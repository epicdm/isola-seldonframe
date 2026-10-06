# Lane A leftover objects and credential remediation (names and locations only; no values) - measured 2026-10-06

## Wording correction
r3 said "Deepseek untouched". Accurate statement: the beta APPLICATION and its data were not modified by the r3 work (no deploy, no config, no beta database write in r3), but Lane A DID write scratch objects on the deepseek host (below). A separate Lane A funnel step earlier in the day created a SeldonFrame token row in the beta database (listed below, not re-verified this turn).

## Objects this Lane A created on the deepseek host (read-only listing this turn)
| Object | Location | State | Purpose |
|---|---|---|---|
| container lanea-txtest | deepseek docker, image postgres:16 (id 1a6ab3f5345e), bound 127.0.0.1:55433 only | running (started 2026-10-06T10:27Z) | scratch Postgres for the transaction-fallback test; holds scratch databases incl. uplink_baseline_check |
| directory zz-txtest-2026-10-06 | /home/epicdm/ | present | scratch test material for lanea-txtest |
| directory zz-uplink-baseline-2026-10-06 | /home/epicdm/ (mode 700) | present | baseline candidate generation |
| directory zz-uplink-r3-2026-10-06 | /home/epicdm/ (mode 700) | present | r3 tools copy, baseline copy, rehearsal logs |
| directory zz-pgpool-2026-10-06 | /home/epicdm/ | present | PR #8 pooled-postgres scratch (earlier work) |
| image postgres@sha256:65b16a8b326e0cfbdf33fa7e783f2a0cb352a61448616ccccfd616ef42aa0f65 | deepseek docker images (no tag) | present | rehearsal image; shared image cache |
| rehearsal containers uplink-r3-rehearsal-* | - | none remain (self-removing; verified 0) | - |
The listing of every zz-* directory also shows many unrelated Lane A / earlier-session directories (zz-lanea-2026-10-05, zz-backups-*, restore containers zz-lanea-cl-restore-*). They are NOT part of r3 and are not claimed or touched here.

## Laptop
C:\Users\girau\AppData\Local\Temp\claude\txpw.txt (24 bytes, 2026-10-06 06:27 local): the scratch database password for lanea-txtest. Scratch credential only; it is not used by any Uplink, production or beta service.

## Credential-related items named by the plan (status, not values)
1. Scratch DB password (txpw.txt and inside lanea-txtest): exposure ends when the container and the file are removed; no production use. Remediation: owner/approved removal of the container, directories and file. No rotation needed beyond removal.
2. SeldonFrame token row lane-a-funnel-2026-10-06 (beta database, created for the funnel work): not re-verified in this turn. Remediation: owner/approved revocation of that one token row; do not touch other rows.
3. Plaintext Deepgram key copies: a names-only search under /home/epicdm/zz-* found the string "deepgram" in 7 files: zz-backups-voice-2026-10-05 (agent.py.before-sofia-english-20261006, agent.py.before-r3-20261005T161443Z, agent.py.before-tts-switch-20261006, env.before-r3-20261005T161443Z, env.before-tts-switch-20261006) and zz-lanea-2026-10-05 (run-deepgram-test.sh, dg.in). Whether each contains the key VALUE was not read or verified. These belong to the earlier voice work, not Uplink or r3. Remediation requirement: owner decides, via an approved channel, (a) deletion of the backup copies that hold a value, and (b) whether to rotate the key; before any rotation the live consumer (the voice agent environment) must be identified, because rotating without updating it breaks voice. Lane A does not rotate or delete.
4. No claim is made that Lane A handled no secrets: the items above are exactly the historical leftovers. Secret VALUES were not written to Port, git or this package (validator secret-hygiene scan on every artifact).

## What Lane A will NOT do without authority
Remove the scratch container/directories/image (the teardown hook blocks it and it is respected, not bypassed), revoke the token row, delete or rotate any credential, or prune shared images. Owner-side removal commands, if wanted, are plain `docker rm -f lanea-txtest`, `rm -rf` of the three directories named above, `docker image rm 65b16a8b326e`, and deleting txpw.txt on the laptop; run by the owner, after confirming nothing else uses them.
