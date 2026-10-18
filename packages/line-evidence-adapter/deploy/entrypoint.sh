#!/bin/sh
# Container entrypoint: reads the secrets mounted as files (value-blind: nothing is printed), opens the restricted SSH forward to the
# database host, then runs the adapter. The forward is pinned to the recorded host key, key-restricted on the far side, and bound to
# the container's own loopback, so nothing else on any network can use it.
#   secrets (files under /run/secrets): lev_adapter_token, lev_meta_token, lev_db_password, lev_ssh_key, lev_known_hosts
#   settings (plain env): TUNNEL_HOST (required), TUNNEL_PORT (22), TUNNEL_USER (levfwd), MAGNUS_DB_USER (line_evidence_ro)
set -eu
S=/run/secrets
rd() { if [ -r "$S/$1" ]; then cat "$S/$1"; else echo "entrypoint: missing secret $1" >&2; exit 78; fi; }
: "${TUNNEL_HOST:?entrypoint: TUNNEL_HOST is required}"
ADAPTER_TOKEN="$(rd lev_adapter_token)"; META_WA_TOKEN="$(rd lev_meta_token)"; MAGNUS_DB_PASSWORD="$(rd lev_db_password)"
export ADAPTER_TOKEN META_WA_TOKEN MAGNUS_DB_PASSWORD
export MAGNUS_MODE=sql MAGNUS_DB_HOST=127.0.0.1 MAGNUS_DB_PORT=13306 MAGNUS_DB_USER="${MAGNUS_DB_USER:-line_evidence_ro}"
unset MAGNUS_API_KEY MAGNUS_API_SECRET

H="${HOME:-/home/node}/.ssh"; mkdir -p "$H"; chmod 700 "$H"
rd lev_ssh_key > "$H/lev"; chmod 600 "$H/lev"
rd lev_known_hosts > "$H/known_hosts"; chmod 600 "$H/known_hosts"
[ -s "$H/known_hosts" ] || { echo "entrypoint: lev_known_hosts is empty (the host key pin is mandatory)" >&2; exit 78; }

( while true; do
    ssh -N -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$H/known_hosts" -o IdentitiesOnly=yes -i "$H/lev" \
        -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o LogLevel=ERROR \
        -p "${TUNNEL_PORT:-22}" -L 127.0.0.1:13306:127.0.0.1:3306 "${TUNNEL_USER:-levfwd}@${TUNNEL_HOST}" || true
    sleep 3
  done ) &

exec node server.mjs
