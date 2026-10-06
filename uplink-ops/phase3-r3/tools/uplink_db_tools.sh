#!/usr/bin/env bash
# Uplink database tools (r3). Credential-free: every command runs through docker exec on the container's local socket.
# usage: uplink_db_tools.sh COMMAND --container NAME [--user uplink] [--db uplink] [args]
#   counts                              print measured object counts and exact row total for --db
#   import FILE EXPECTED_SHA256         verify hash, import in ONE transaction (psql -1, ON_ERROR_STOP)
#   backup OUTPATH_IN_CONTAINER         pg_dump custom format, print sha256, size and pg_restore --list table entries
#   restore DUMP_IN_CONTAINER           restore into --db with --exit-on-error --single-transaction
#   schemahash                          sha256 of the normalised schema-only dump of --db
# Exit codes: 0 ok; 2 usage; 13 hash mismatch; 14 target not empty; any other non-zero is the psql/pg_restore/pg_dump exit code (psql ON_ERROR_STOP = 3).
# Nothing here prints a password; nothing connects over the network.
set -euo pipefail
CMD="${1:-}"; shift || true
CT=""; USR=uplink; DB=uplink; POS=()
while [ $# -gt 0 ]; do case "$1" in
  --container) CT="$2"; shift 2;; --user) USR="$2"; shift 2;; --db) DB="$2"; shift 2;; *) POS+=("$1"); shift;; esac; done
set -- "${POS[@]+"${POS[@]}"}"
[ -n "$CT" ] || { echo "need --container" >&2; exit 2; }
PSQL() { docker exec -i "$CT" psql -U "$USR" -d "$DB" -v ON_ERROR_STOP=1 -At "$@"; }

case "$CMD" in
counts)
  PSQL -c "select 'tables='||count(*) from pg_tables where schemaname='public'
    union all select 'explicit_indexes='||count(*) from pg_class i join pg_index x on x.indexrelid=i.oid join pg_namespace n on n.oid=i.relnamespace where n.nspname='public' and i.relkind='i' and not exists (select 1 from pg_constraint c where c.conindid=i.oid)
    union all select 'constraints='||count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype in ('p','u','f','c')
    union all select 'sequences='||count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='S'
    union all select 'views='||count(*) from pg_views where schemaname='public'
    union all select 'functions='||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    union all select 'triggers='||count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
    union all select 'schemas='||count(*) from pg_namespace where nspname not like 'pg\_%' and nspname<>'information_schema'
    union all select 'extensions='||string_agg(extname,',' order by extname) from pg_extension
    union all select 'rows='||coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint),0) from pg_tables where schemaname='public'";;
import)
  F="$1"; WANT="$2"
  GOT=$(sha256sum "$F" | cut -d' ' -f1)
  [ "$GOT" = "$WANT" ] || { echo "HASH MISMATCH: refusing to import (got ${GOT:0:12} want ${WANT:0:12})" >&2; exit 13; }
  n=$(PSQL -c "select count(*) from information_schema.tables where table_schema='public'")
  [ "$n" = 0 ] || { echo "TARGET NOT EMPTY ($n tables): refusing to import" >&2; exit 14; }
  # one transaction: any error rolls everything back
  docker exec -i "$CT" psql -U "$USR" -d "$DB" -v ON_ERROR_STOP=1 -q -1 < "$F" > /dev/null
  echo "import ok";;
backup)
  OUT="$1"
  docker exec "$CT" sh -c "pg_dump -U $USR -d $DB --format=custom --compress=6 --no-owner --no-privileges -f '$OUT' && sha256sum '$OUT' | cut -d' ' -f1 | sed 's/^/dump_sha256=/' && wc -c < '$OUT' | sed 's/^/dump_bytes=/' && pg_restore --list '$OUT' > /tmp/list.\$\$ && grep -c ' TABLE public ' /tmp/list.\$\$ | sed 's/^/list_table_entries=/'; rm -f /tmp/list.\$\$";;
restore)
  DUMP="$1"
  docker exec "$CT" pg_restore -U "$USR" -d "$DB" --no-owner --no-privileges --exit-on-error --single-transaction "$DUMP"
  echo "restore ok";;
schemahash)
  docker exec "$CT" pg_dump -U "$USR" -d "$DB" --schema-only --no-owner --no-privileges --no-comments | grep -v '^\\\(un\)\?restrict' | sha256sum | cut -d' ' -f1;;
*) echo "unknown command '$CMD'" >&2; exit 2;;
esac
