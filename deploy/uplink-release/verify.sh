#!/bin/bash
# Prove an Uplink release image matches its commit.
#   deploy/uplink-release/verify.sh <image> <commit> [baseline-image] [baseline-commit]
# Gate 1: every regular source file under /app/packages/crm (generated output excluded) equals `git ls-tree` of the commit:
#         same count, same sha256, no extras. A planted mismatch must be caught (positive control).
# Gate 2 (with a baseline): the image differs from the baseline image in exactly the files git says changed, and the
#         compiled route list differs only where the commit adds or removes route files.
set -euo pipefail
IMG=${1:?image}; C=$(git rev-parse "${2:?commit}^{commit}"); BIMG=${3:-}; BC=${4:-}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
imgsrc() { docker run --rm --network none --entrypoint sh "$1" -c 'cd /app && find packages/crm -type f -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/.swc/*" -not -path "*/.well-known/workflow/*" -not -name next-env.d.ts -not -name "*.tsbuildinfo" -print0 | sort -z | xargs -0 sha256sum'; }
gitsrc() { git ls-tree -r "$1" -- packages/crm | awk '$1!="120000"{sub(/^[^\t]*\t/,""); print}' | python3 -c '
import hashlib, subprocess, sys
paths = [l.rstrip("\n") for l in sys.stdin if l.strip()]
p = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
out = []
for path in paths:
    p.stdin.write(f"{sys.argv[1]}:{path}\n".encode()); p.stdin.flush()
    size = int(p.stdout.readline().split()[2]); data = p.stdout.read(size); p.stdout.read(1)
    out.append(f"{hashlib.sha256(data).hexdigest()}  {path}")
print("\n".join(sorted(out, key=lambda l: l.split("  ", 1)[1].encode())))' "$1"; }
routes() { docker run --rm --network none --entrypoint sh "$1" -c 'cat /app/packages/crm/.next/server/app-paths-manifest.json' | python3 -c 'import json,sys; print("\n".join(sorted(json.load(sys.stdin))))'; }
cmpk() { LC_ALL=C sort -k2 "$1" > "$1.s"; LC_ALL=C sort -k2 "$2" > "$2.s"; diff "$1.s" "$2.s" | grep -c '^[<>]' || true; }

imgsrc "$IMG" > "$W/img.sha"; gitsrc "$C" > "$W/git.sha"
echo "gate1 image_files=$(wc -l < "$W/img.sha") commit_files=$(wc -l < "$W/git.sha") differing_lines=$(cmpk "$W/img.sha" "$W/git.sha")"
diff "$W/img.sha.s" "$W/git.sha.s" | head -10 || true
awk 'NR==1{c=substr($0,1,1); $0=(c=="f"?"0":"f") substr($0,2)}1' "$W/git.sha" > "$W/planted.sha"
echo "gate1 positive_control planted_differing_lines=$(cmpk "$W/img.sha" "$W/planted.sha") (must be 2)"
if [ -n "$BIMG" ] && [ -n "$BC" ]; then
  BC=$(git rev-parse "$BC^{commit}")
  imgsrc "$BIMG" > "$W/base.sha"
  diff <(LC_ALL=C sort -k2 "$W/base.sha") <(LC_ALL=C sort -k2 "$W/img.sha") | sed -n 's/^[<>] [0-9a-f]*  //p' | LC_ALL=C sort -u > "$W/img-delta.txt" || true
  git diff --name-only "$BC" "$C" -- packages/crm | LC_ALL=C sort -u > "$W/git-delta.txt"
  echo "gate2 image_delta_files=$(wc -l < "$W/img-delta.txt") git_delta_files=$(wc -l < "$W/git-delta.txt") mismatch=$(diff "$W/img-delta.txt" "$W/git-delta.txt" | grep -c '^[<>]' || true)"
  cat "$W/img-delta.txt"
  routes "$BIMG" > "$W/base.routes"; routes "$IMG" > "$W/img.routes"
  echo "gate2 routes baseline=$(wc -l < "$W/base.routes") image=$(wc -l < "$W/img.routes") changed=$(diff "$W/base.routes" "$W/img.routes" | grep -c '^[<>]' || true)"
  diff "$W/base.routes" "$W/img.routes" || true
fi
