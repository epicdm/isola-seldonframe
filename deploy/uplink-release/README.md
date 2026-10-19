# Uplink release image recipe

The production Uplink app (host04 `uplink_uplink-app-prod`) is built from **committed source only**:

1. `build.sh <commit>` takes `git archive <commit> packages/crm` and the committed `Dockerfile` here, and builds on the
   original production image pinned by digest (it carries the installed dependencies; the root lockfile and package files
   are unchanged since that image's source, da08b734). It writes `provenance.txt` (commit, archive sha256, image id).
2. `verify.sh <image> <commit> [baseline-image baseline-commit]` proves the image's source equals the commit (count,
   sha256, no extras, with a planted-mismatch control) and that, against the baseline, only the committed delta and the
   intended routes changed.

No overlay of uncommitted files is used. Production drift found on 2026-10-19 was committed as the baseline 562bf55c
(chore/uplink-production-baseline-2026-10-19), which reproduces the live image (4016/4016 files, 804/804 routes).
Building or verifying does not push or deploy; promotion needs the owner's release go.
