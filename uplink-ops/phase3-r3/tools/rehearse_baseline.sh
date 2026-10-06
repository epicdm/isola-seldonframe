#!/usr/bin/env bash
# Disposable rehearsal of the schema-only baseline (r3). Candidate evidence only, NOT schema approval.
# usage: rehearse_baseline.sh BASELINE.sql EXPECTED_SHA256 [IMAGE]
# Isolation: --network none (no network, no published port), memory 512m, 1 CPU, --rm, anonymous volume.
# Cleanup without any teardown command: the container's wrapper stops postgres when /tmp/done appears; --rm then removes it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; T="$HERE/uplink_db_tools.sh"
BASE="$1"; WANT="$2"; IMAGE="${3:-postgres:16.15@sha256:65b16a8b326e0cfbdf33fa7e783f2a0cb352a61448616ccccfd616ef42aa0f65}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; NAME="uplink-r3-rehearsal-$STAMP"
PW="$(openssl rand -hex 16)"                      # held in this shell only; never printed
PASS=0; FAILN=0
ok()  { echo "RESULT PASS $1"; PASS=$((PASS+1)); }
bad() { echo "RESULT FAIL $1"; FAILN=$((FAILN+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 got=$2 want=$3"; fi; }
cnt() { "$T" counts --container "$NAME" --db "$1" | sed -n "s/^$2=//p"; }
echo "STAMP=$STAMP NAME=$NAME IMAGE=$IMAGE"
echo "baseline_sha256=$(sha256sum "$BASE" | cut -d' ' -f1) bytes=$(wc -c < "$BASE")"
chk "baseline hash equals approved candidate" "$(sha256sum "$BASE" | cut -d' ' -f1)" "$WANT"

docker pull -q "$IMAGE" > /dev/null || { echo "RESULT FAIL image pull"; exit 1; }
echo "image_id=$(docker image inspect "$IMAGE" --format '{{.Id}}' | cut -c1-19) server=$(docker image inspect "$IMAGE" --format '{{index .Config.Env 0}}' >/dev/null 2>&1; echo pinned-by-digest)"
docker run -d --rm --name "$NAME" --network none --memory 512m --cpus 1 --label "uplink.rehearsal=$STAMP" \
  -e POSTGRES_USER=uplink -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=uplink --entrypoint bash "$IMAGE" -c \
  'docker-entrypoint.sh postgres -c max_connections=30 -c fsync=off & P=$!; while [ ! -e /tmp/done ] && kill -0 $P 2>/dev/null; do sleep 1; done; kill -TERM $P 2>/dev/null; wait $P' > /dev/null
# the image first runs a temporary init server; only trust readiness after "init process complete" has been logged
for i in $(seq 90); do docker logs "$NAME" 2>&1 | grep -q "init process complete" && docker exec "$NAME" pg_isready -U uplink -d uplink -q 2>/dev/null && break; sleep 1; done
docker exec "$NAME" pg_isready -U uplink -d uplink -q && ok "disposable PostgreSQL ready ($(docker exec "$NAME" postgres --version | cut -d' ' -f3))" || { bad "postgres not ready"; exit 1; }
docker exec "$NAME" sh -c 'echo "--- container cpu/mem limits: $(cat /sys/fs/cgroup/memory.max 2>/dev/null) bytes mem, cpu.max $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"'
# the container has no published port and no network
chk "no published ports" "$(docker port "$NAME" | wc -l)" "0"
chk "network mode none" "$(docker inspect "$NAME" --format '{{.HostConfig.NetworkMode}}')" "none"
SQLF="$NAME-baseline.sql"; cp "$BASE" "/tmp/$SQLF"

echo "== 1 empty target"
chk "empty before import: tables" "$(cnt uplink tables)" "0"

echo "== 2 single-transaction import"
S=$(date +%s.%N); "$T" import "/tmp/$SQLF" "$WANT" --container "$NAME" --db uplink; RC=$?; E=$(date +%s.%N)
chk "import exit code" "$RC" "0"; echo "import_seconds=$(awk -v s=$S -v e=$E "BEGIN{printf \"%.2f\", e-s}")"
for k in "tables 117" "explicit_indexes 231" "constraints 312" "rows 0" "sequences 0" "views 0" "functions 0" "triggers 0" "schemas 1" "extensions plpgsql"; do set -- $k; chk "after import: $1" "$(cnt uplink $1)" "$2"; done
[ "$(cnt uplink tables)" = "117" ] || { echo "ABORT: import did not produce 117 tables; later equality checks would be vacuous"; docker exec "$NAME" touch /tmp/done; exit 1; }
H1="$("$T" schemahash --container "$NAME" --db uplink)"; echo "schema_hash_import=$H1"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_empty" > /dev/null
HE="$("$T" schemahash --container "$NAME" --db uplink_empty)"; echo "schema_hash_empty_control=$HE"
if [ "$H1" != "$HE" ]; then ok "control: an empty schema hashes differently from the baseline (equality checks below are not vacuous)"; else bad "empty and full schema hash identical"; fi

echo "== 3 repeatability: second fresh database"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_c" > /dev/null
"$T" import "/tmp/$SQLF" "$WANT" --container "$NAME" --db uplink_c; chk "second import exit code" "$?" "0"
chk "second database schema hash equals first" "$("$T" schemahash --container "$NAME" --db uplink_c)" "$H1"

echo "== 4 backup #0 and restore into a second database"
"$T" backup /tmp/b0.dump --container "$NAME" --db uplink | tee /tmp/$NAME-backup.txt
chk "pg_restore --list table entries" "$(sed -n 's/^list_table_entries=//p' /tmp/$NAME-backup.txt)" "117"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_restore" > /dev/null
S=$(date +%s.%N); "$T" restore /tmp/b0.dump --container "$NAME" --db uplink_restore; RC=$?; E=$(date +%s.%N)
chk "restore exit code" "$RC" "0"; echo "restore_seconds=$(awk -v s=$S -v e=$E "BEGIN{printf \"%.2f\", e-s}")"
for k in "tables 117" "explicit_indexes 231" "constraints 312" "rows 0" "schemas 1" "extensions plpgsql"; do set -- $k; chk "restored: $1" "$(cnt uplink_restore $1)" "$2"; done
chk "restored schema hash equals source" "$("$T" schemahash --container "$NAME" --db uplink_restore)" "$H1"

echo "== 5 deliberate failed import rolls back"
{ cat "$BASE"; echo; echo "SELECT 1/0;"; } > "/tmp/$NAME-bad.sql"; BADH="$(sha256sum "/tmp/$NAME-bad.sql" | cut -d' ' -f1)"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_fail" > /dev/null
"$T" import "/tmp/$NAME-bad.sql" "$BADH" --container "$NAME" --db uplink_fail > /dev/null 2>&1; RC=$?
chk "failing import fails with the psql ON_ERROR_STOP exit code" "$RC" "3"
chk "after failed import: tables rolled back to 0" "$(cnt uplink_fail tables)" "0"
echo "-- positive control: the same bad file WITHOUT the single transaction leaves a partial schema (proves the check can see partial imports)"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_partial" > /dev/null
docker exec -i "$NAME" psql -U uplink -d uplink_partial -v ON_ERROR_STOP=1 -q < "/tmp/$NAME-bad.sql" > /dev/null 2>&1; RCP=$?
chk "non-transactional failing import fails with the psql ON_ERROR_STOP exit code" "$RCP" "3"
P="$(cnt uplink_partial tables)"; if [ "${P:-0}" -gt 0 ]; then ok "control: partial import leaves $P tables (rollback result above is therefore meaningful)"; else bad "control saw no partial tables"; fi
echo "-- retry after the failure (runbook 2.6): good baseline into the rolled-back database"
"$T" import "/tmp/$SQLF" "$WANT" --container "$NAME" --db uplink_fail; chk "retry import exit code" "$?" "0"
chk "retry: tables" "$(cnt uplink_fail tables)" "117"
echo "-- refusal controls"
"$T" import "/tmp/$SQLF" "0000000000000000000000000000000000000000000000000000000000000000" --container "$NAME" --db uplink_c > /dev/null 2>&1; RCH=$?; chk "wrong hash is refused (rc 13)" "$RCH" "13"
"$T" import "/tmp/$SQLF" "$WANT" --container "$NAME" --db uplink > /dev/null 2>&1; RCN=$?; chk "non-empty target is refused (rc 14)" "$RCN" "14"

echo "== 6 corrupted backup is rejected"
docker exec "$NAME" sh -c 'head -c 20000 /tmp/b0.dump > /tmp/b0-trunc.dump'  # requires the real dump from section 4
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_badrestore" > /dev/null
chk "truncated dump file exists and is smaller than the real dump" "$(docker exec "$NAME" sh -c 'a=$(wc -c < /tmp/b0.dump); b=$(wc -c < /tmp/b0-trunc.dump); [ "$b" -gt 0 ] && [ "$b" -lt "$a" ] && echo yes || echo no')" "yes"
"$T" restore /tmp/b0-trunc.dump --container "$NAME" --db uplink_badrestore > /dev/null 2>&1; RCB=$?
if [ "$RCB" != 0 ] && [ "$RCB" != 2 ]; then ok "truncated dump rejected by pg_restore (rc=$RCB)"; else bad "truncated dump not rejected by pg_restore (rc=$RCB)"; fi
chk "truncated restore left no tables" "$(cnt uplink_badrestore tables)" "0"

echo "== 6b EasyPanel job script (uplink_job.sh) exercised exactly as the managed job will run it"
docker exec "$NAME" mkdir -p /uplink; docker cp "$HERE/uplink_job.sh" "$NAME:/uplink/uplink_job.sh" > /dev/null; docker cp "/tmp/$SQLF" "$NAME:/uplink/baseline.sql" > /dev/null
docker cp "/tmp/$NAME-bad.sql" "$NAME:/uplink/bad.sql" > /dev/null
JOB() { docker exec -e PGUSER=uplink -e PGDATABASE="$1" -e SLEEP_ON_FAIL=0 ${3:+-e "$3"} "$NAME" sh /uplink/uplink_job.sh "$2"; }
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_job" > /dev/null
JOB uplink_job import > /tmp/$NAME-job1.txt 2>&1; chk "job import into an empty database exits 0" "$?" "0"
chk "job reported the single-transaction import" "$(grep -c 'imported in one transaction' /tmp/$NAME-job1.txt)" "1"
JOB uplink_job import > /tmp/$NAME-job2.txt 2>&1; chk "job re-run is idempotent (exit 0, verifies instead of importing)" "$?" "0"
chk "job re-run did not import again" "$(grep -c 'verifying instead of importing' /tmp/$NAME-job2.txt)" "1"
JOB uplink_restore verify > /dev/null 2>&1; chk "verify mode accepts the restored database" "$?" "0"
JOB uplink_empty verify > /dev/null 2>&1; RCE=$?; chk "negative control: verify rejects an empty database" "$RCE" "1"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_odd" > /dev/null
docker exec "$NAME" psql -U uplink -d uplink_odd -c "create table zz_odd(id int)" > /dev/null
JOB uplink_odd import > /tmp/$NAME-job3.txt 2>&1; chk "negative control: job refuses a database that is neither empty nor the baseline" "$?" "1"
chk "refusal message names the reason" "$(grep -c 'neither empty nor the 117-table baseline' /tmp/$NAME-job3.txt)" "1"
docker exec -e PGUSER=uplink -e PGDATABASE=uplink_c -e SLEEP_ON_FAIL=0 -e BASELINE_PATH=/uplink/bad.sql "$NAME" sh /uplink/uplink_job.sh import > /tmp/$NAME-job4.txt 2>&1; chk "negative control: job refuses a baseline whose hash differs" "$?" "1"
chk "hash refusal message" "$(grep -c 'does not match the approved hash' /tmp/$NAME-job4.txt)" "1"
docker exec "$NAME" psql -U uplink -d postgres -c "create database uplink_job2" > /dev/null
docker exec -e PGUSER=uplink -e PGDATABASE=uplink_job2 -e SLEEP_ON_FAIL=0 -e EXPECTED_SHA256="$BADH" -e BASELINE_PATH=/uplink/bad.sql "$NAME" sh /uplink/uplink_job.sh import > /tmp/$NAME-job5.txt 2>&1; chk "negative control: a hash-approved but failing file is rolled back by the job (exit 1)" "$?" "1"
chk "failed job left the database empty" "$(cnt uplink_job2 tables)" "0"
chk "job output never contains the password" "$(cat /tmp/$NAME-job*.txt | grep -c "$PW")" "0"
rm -f /tmp/$NAME-job*.txt

echo "== 7 secrets hygiene of this run"
LOGS="$(docker logs "$NAME" 2>&1)"; case "$LOGS" in *"$PW"*) bad "password appears in container logs";; *) ok "password absent from container logs";; esac

echo "== 8 self-cleaning stop (no teardown command)"
docker exec "$NAME" touch /tmp/done
for i in $(seq 30); do docker ps -a --filter "name=^$NAME\$" --format '{{.Names}}' | grep -q . || break; sleep 1; done
LEFT="$(docker ps -a --filter "label=uplink.rehearsal=$STAMP" --format '{{.Names}}' | wc -l)"; chk "no container with this stamp remains" "$LEFT" "0"
rm -f "/tmp/$SQLF" "/tmp/$NAME-bad.sql" "/tmp/$NAME-backup.txt"
echo "SUMMARY pass=$PASS fail=$FAILN stamp=$STAMP"
[ "$FAILN" = 0 ]
