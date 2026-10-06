#!/bin/sh
# Uplink one-shot database job (r3). Runs INSIDE an EasyPanel-managed app service (postgres image) as its command: sh /uplink/uplink_job.sh MODE
#   MODE import : refuse unless the baseline hash matches; import into an EMPTY database in ONE transaction; verify counts. Idempotent: an
#                 already-imported, count-correct database is reported and exits 0.
#   MODE verify : read-only count check of the database named by PGDATABASE (used on the disposable restore target and after import).
# Connection: libpq environment variables PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD entered by the OWNER in the EasyPanel Environment tab.
# Optional: BASELINE_PATH (default /uplink/baseline.sql), EXPECTED_SHA256, EXPECT_ROWS (default 0), SLEEP_ON_FAIL seconds (default 600).
# Exit 0 = success (EasyPanel does not restart a clean exit: the service shows as completed). Non-zero = failure; after SLEEP_ON_FAIL the
# restart policy retries, and a retry re-checks state first, so it can never double-import. The job never prints PGPASSWORD.
set -u
MODE="${1:-}"
BASE="${BASELINE_PATH:-/uplink/baseline.sql}"
WANT="${EXPECTED_SHA256:-8f9922e3ead013557a21427468f8392d20784d6d78bec839ae1e4cdb43dba8b8}"
EXP_ROWS="${EXPECT_ROWS:-0}"
fail() { echo "RESULT FAIL $1"; sleep "${SLEEP_ON_FAIL:-600}"; exit 1; }
Q() { psql -At -v ON_ERROR_STOP=1 -c "$1"; }

counts() {
  Q "select 'tables='||count(*) from pg_tables where schemaname='public'
    union all select 'explicit_indexes='||count(*) from pg_class i join pg_index x on x.indexrelid=i.oid join pg_namespace n on n.oid=i.relnamespace where n.nspname='public' and i.relkind='i' and not exists (select 1 from pg_constraint c where c.conindid=i.oid)
    union all select 'constraints='||count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype in ('p','u','f','c')
    union all select 'schemas='||count(*) from pg_namespace where nspname not like 'pg\_%' and nspname<>'information_schema'
    union all select 'extensions='||string_agg(extname,',' order by extname) from pg_extension
    union all select 'rows='||coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint),0) from pg_tables where schemaname='public'"
}

check_counts() {
  OUT="$(counts)" || fail "count query failed"
  for want in "tables=117" "explicit_indexes=231" "constraints=312" "schemas=1" "extensions=plpgsql" "rows=$EXP_ROWS"; do
    echo "$OUT" | grep -qx "$want" || fail "count mismatch: expected $want, measured: $(echo "$OUT" | tr '\n' ' ')"
  done
  echo "RESULT PASS counts $(echo "$OUT" | tr '\n' ' ')"
}

case "$MODE" in
verify)
  Q "select 1" > /dev/null || fail "cannot connect to $PGDATABASE"
  check_counts
  echo "RESULT PASS verify complete"; exit 0;;
import)
  [ -r "$BASE" ] || fail "baseline file not readable at $BASE"
  echo "$WANT  $BASE" | sha256sum -c - > /dev/null 2>&1 || fail "baseline sha256 does not match the approved hash (refusing to import)"
  echo "RESULT PASS baseline hash matches approved candidate"
  N="$(Q "select count(*) from information_schema.tables where table_schema='public'")" || fail "cannot connect to $PGDATABASE"
  if [ "$N" = "0" ]; then
    psql -v ON_ERROR_STOP=1 -q -1 -f "$BASE" > /dev/null || fail "import failed; the single transaction rolled back (database left empty)"
    echo "RESULT PASS imported in one transaction"
  elif [ "$N" = "117" ]; then
    echo "NOTE target already holds 117 tables: verifying instead of importing"
  else
    fail "target is neither empty nor the 117-table baseline ($N tables): refusing to touch it"
  fi
  check_counts
  echo "RESULT PASS import job complete"; exit 0;;
*) echo "usage: uplink_job.sh import|verify"; exit 2;;
esac
