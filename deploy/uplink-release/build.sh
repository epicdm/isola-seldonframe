#!/bin/bash
# Build the Uplink release image from the COMMITTED source of one commit (no overlay, no working-tree files).
#   deploy/uplink-release/build.sh <commit> [tag]     (run from a clone; needs docker and the pinned base image)
# Writes <out>/provenance.txt (commit, archive sha256, image id) and leaves the context in <out>/ctx.
set -euo pipefail
REV=${1:?usage: build.sh <commit> [tag]}
REPO=$(git rev-parse --show-toplevel)
C=$(git -C "$REPO" rev-parse "$REV^{commit}")
TAG=${2:-lane-a-uplink:release-${C:0:8}}
OUT=${OUT:-$HOME/zz-uplink-release-${C:0:8}}
# OUT is removed and recreated below: accept only a release scratch directory under $HOME (Codex LOW).
case "$OUT" in "$HOME"/zz-uplink-release-?*) ;; *) echo "refusing OUT outside $HOME/zz-uplink-release-*: $OUT" >&2; exit 2 ;; esac
case "$OUT" in *..*) echo "refusing OUT containing ..: $OUT" >&2; exit 2 ;; esac
rm -rf "$OUT"; mkdir -p "$OUT/ctx"
git -C "$REPO" archive --format=tar "$C" packages/crm > "$OUT/crm.tar"
tar -x -C "$OUT/ctx" -f "$OUT/crm.tar" && mv "$OUT/ctx/packages/crm" "$OUT/ctx/crm" && rmdir "$OUT/ctx/packages"
git -C "$REPO" show "$C:deploy/uplink-release/Dockerfile" > "$OUT/ctx/Dockerfile"
docker build --label org.opencontainers.image.revision="$C" --label release=uplink-release -t "$TAG" "$OUT/ctx" > "$OUT/build.log" 2>&1
{ echo "commit $C"
  echo "archive_sha256 $(sha256sum "$OUT/crm.tar" | cut -d' ' -f1)"
  echo "dockerfile_sha256 $(sha256sum "$OUT/ctx/Dockerfile" | cut -d' ' -f1)"
  echo "tag $TAG"
  echo "image $(docker image inspect "$TAG" --format '{{.Id}}')"
  echo "label_revision $(docker image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  echo "built $(date -u +%FT%TZ)"; } > "$OUT/provenance.txt"
cat "$OUT/provenance.txt"
