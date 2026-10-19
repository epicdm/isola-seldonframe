#!/bin/bash
# Prove an Uplink release image matches its commit. Exits non-zero unless every gate passes.
#   deploy/uplink-release/verify.sh <image> <commit> [baseline-image] [baseline-commit]
#   EXPECT_ROUTE_CHANGES=<n> (default 0): how many lines the compiled route list may differ from the baseline by.
# Gate 1: every regular source file under /app/packages/crm (generated output excluded) equals `git ls-tree` of the commit:
#         same count, same sha256, no extras; symlinks equal (target + path). A planted mismatch must be caught.
# Gate 2 (with a baseline): the image differs from the baseline image in exactly the files git says changed, and the
#         compiled route list changes by exactly EXPECT_ROUTE_CHANGES lines.
set -euo pipefail
IMG=${1:?image}; C=$(git rev-parse "${2:?commit}^{commit}"); BIMG=${3:-}; BC=${4:-}; EXPECT_ROUTE_CHANGES=${EXPECT_ROUTE_CHANGES:-0}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
FAIL=0; check() { if [ "$2" = "$3" ]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; FAIL=1; fi; }
EXCL='-not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/.swc/*" -not -path "*/.well-known/workflow/*" -not -name next-env.d.ts -not -name "*.tsbuildinfo"'
imgsrc() { docker run --rm --network none --entrypoint sh "$1" -c "cd /app && find packages/crm -type f $EXCL -print0 | sort -z | xargs -0 sha256sum"; }
imglinks() { docker run --rm --network none --entrypoint sh "$1" -c "cd /app && find packages/crm -type l $EXCL -printf '%l  %p\n'" | LC_ALL=C sort -k2; }
gitsrc() { git ls-tree -r "$1" -- packages/crm | python3 -c '
import hashlib, subprocess, sys
mode = sys.argv[2]
rows = [l.rstrip("\n").split("\t", 1) for l in sys.stdin if l.strip()]
paths = [p for meta, p in rows if (meta.split()[0] == "120000") == (mode == "links")]
p = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
out = []
for path in paths:
    p.stdin.write(f"{sys.argv[1]}:{path}\n".encode()); p.stdin.flush()
    size = int(p.stdout.readline().split()[2]); data = p.stdout.read(size); p.stdout.read(1)
    val = data.decode() if mode == "links" else hashlib.sha256(data).hexdigest()
    out.append(f"{val}  {path}")
print("\n".join(sorted(out, key=lambda l: l.split("  ", 1)[1].encode())))' "$1" "$2" | sed '/^$/d'; }
routes() { docker run --rm --network none --entrypoint sh "$1" -c 'cat /app/packages/crm/.next/server/app-paths-manifest.json' | python3 -c 'import json,sys; print("\n".join(sorted(json.load(sys.stdin))))'; }
ndiff() { diff <(LC_ALL=C sort -k2 "$1") <(LC_ALL=C sort -k2 "$2") | grep -c '^[<>]' || true; }

imgsrc "$IMG" > "$W/img.sha"; gitsrc "$C" files > "$W/git.sha"
echo "gate1 image_files=$(wc -l < "$W/img.sha") commit_files=$(wc -l < "$W/git.sha")"
check "gate1 file count" "$(wc -l < "$W/img.sha")" "$(wc -l < "$W/git.sha")"
check "gate1 differing lines" "$(ndiff "$W/img.sha" "$W/git.sha")" 0
diff <(LC_ALL=C sort -k2 "$W/img.sha") <(LC_ALL=C sort -k2 "$W/git.sha") | head -10 || true
awk 'NR==1{c=substr($0,1,1); $0=(c=="f"?"0":"f") substr($0,2)}1' "$W/git.sha" > "$W/planted.sha"
check "gate1 positive control (planted mismatch caught)" "$(ndiff "$W/img.sha" "$W/planted.sha")" 2
imglinks "$IMG" > "$W/img.links"; gitsrc "$C" links > "$W/git.links"
echo "gate1 symlinks image=$(wc -l < "$W/img.links") commit=$(wc -l < "$W/git.links")"
check "gate1 symlinks differing lines" "$(ndiff "$W/img.links" "$W/git.links")" 0
if [ -n "$BIMG" ] && [ -n "$BC" ]; then
  BC=$(git rev-parse "$BC^{commit}")
  imgsrc "$BIMG" > "$W/base.sha"; imglinks "$BIMG" > "$W/base.links"
  # Regular files and symlinks both count towards the delta (a symlink line is "<target>  <path>").
  { { diff <(LC_ALL=C sort -k2 "$W/base.sha") <(LC_ALL=C sort -k2 "$W/img.sha") || true; } | sed -n 's/^[<>] [0-9a-f]*  //p'
    { diff "$W/base.links" "$W/img.links" || true; } | sed -n 's/^[<>] .*  //p'; } | LC_ALL=C sort -u > "$W/img-delta.txt"
  git diff --name-only --no-renames "$BC" "$C" -- packages/crm | LC_ALL=C sort -u > "$W/git-delta.txt"
  echo "gate2 image_delta_files=$(wc -l < "$W/img-delta.txt") git_delta_files=$(wc -l < "$W/git-delta.txt")"
  check "gate2 delta == git diff" "$({ diff "$W/img-delta.txt" "$W/git-delta.txt" || true; } | grep -c '^[<>]' || true)" 0
  cat "$W/img-delta.txt"
  routes "$BIMG" > "$W/base.routes"; routes "$IMG" > "$W/img.routes"
  echo "gate2 routes baseline=$(wc -l < "$W/base.routes") image=$(wc -l < "$W/img.routes")"
  check "gate2 route lines changed" "$({ diff "$W/base.routes" "$W/img.routes" || true; } | grep -c '^[<>]' || true)" "$EXPECT_ROUTE_CHANGES"
  diff "$W/base.routes" "$W/img.routes" || true
fi
[ "$FAIL" = 0 ] && echo "VERIFY PASS" || { echo "VERIFY FAIL"; exit 1; }
