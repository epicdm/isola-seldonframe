#!/bin/sh
# Runs inside the EasyPanel-managed uplink-backup-audit service. Lists the daily and weekly prefixes with a READ-ONLY key, runs backup_audit.py,
# logs the verdict to the portal logs. A failing audit exits non-zero so the portal shows the restart/failure (the only alert channel EasyPanel offers).
# Required environment (owner-entered): AUDIT_ENV (staging|production) AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION S3_ENDPOINT S3_BUCKET SERVICE_START. Never prints keys.
set -u
INTERVAL="${AUDIT_INTERVAL_SECONDS:-3600}"
case "${AUDIT_ENV:-}" in staging|production) ;; *) echo "AUDIT FAIL AUDIT_ENV must be staging or production"; exit 2;; esac
PFX="uplink/$AUDIT_ENV"          # this service audits ONLY its own environment's backup prefixes
while true; do
  for P in daily weekly; do
    aws s3api list-objects-v2 --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --prefix "$PFX/$P/" --output json > "/tmp/$P.json" 2>/tmp/err.txt \
      || { echo "AUDIT FAIL cannot list $PFX/$P/: $(head -c 200 /tmp/err.txt | tr -d '\n')"; sleep 300; exit 1; }
  done
  python3 - <<'PY' > /tmp/merged.json
import json
out = []
for p in ("daily", "weekly"):
    d = json.load(open(f"/tmp/{p}.json")); out += d.get("Contents", [])
print(json.dumps(out))
PY
  python3 /uplink/backup_audit.py --listing /tmp/merged.json --service-start "$SERVICE_START" --daily-prefix "$PFX/daily/" --weekly-prefix "$PFX/weekly/" --prune-plan > /tmp/verdict.txt; RC=$?
  cat /tmp/verdict.txt
  [ "$RC" = 0 ] || { echo "AUDIT FAIL restore-point requirement not met (see ALERT lines above)"; sleep 300; exit 1; }
  echo "AUDIT PASS $(date -u +%FT%TZ)"
  sleep "$INTERVAL"
done
