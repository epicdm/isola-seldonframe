#!/usr/bin/env python3
"""Uplink acceptance smoke checks (r3). Stdlib only. Read-only HTTP GETs; runs from an operator machine, deploys nothing.

usage: acceptance_smoke.py --base https://build.uplink.epic.dm [--readiness-path PATH] [--expect-title Uplink]
                           [--allow-host H ...] [--pages / /login] [--expect-forbidden] [--insecure-local]
  --readiness-path   the Codex Phase 1 readiness endpoint (unknown until that receipt exists; the check is SKIPPED, not passed, without it)
  --expect-forbidden assert the whole host answers 403 (run from a source OUTSIDE the operator CIDR: the negative control of the allow-list)
Exit 0 only when every executed check passed; skipped checks are listed and never counted as passes.
"""
import argparse, re, ssl, sys, socket, urllib.request, urllib.parse, urllib.error

# Customer-visible markup (scripts and styles removed): the brand word itself is forbidden.
FORBIDDEN_STRINGS = ["seldonframe", "powered by seldon", "app.seldonframe.com", "100.117.", "front.isola.epic.dm", "agents.epic.dm", "deepseek"]
# Redirect targets additionally must never point at a loopback host.
REDIRECT_EXTRA = ["localhost", "127.0.0.1"]
# Client assets (JS/CSS) may legitimately contain package names; only vendor HOSTS, the badge phrase and beta hosts are forbidden there.
ASSET_FORBIDDEN = ["seldonframe.com", "powered by seldon", "100.117.", "front.isola.epic.dm", "agents.epic.dm", "deepseek"]
SECRET_HINTS = [r"password\s*[:=]", r"secret\s*[:=]", r"database_url", r"postgres(ql)?://[^\s\"']+:[^\s\"']+@", r"[A-Za-z0-9+/]{40,}={0,2}"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def get(url, ctx, timeout=20):
    op = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ctx))
    req = urllib.request.Request(url, headers={"User-Agent": "uplink-acceptance-smoke/r3"})
    try:
        r = op.open(req, timeout=timeout); return r.status, dict(r.headers), r.read(400000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(400000)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--readiness-path"); ap.add_argument("--expect-title")
    ap.add_argument("--allow-host", action="append", default=[]); ap.add_argument("--pages", nargs="*", default=["/", "/login"])
    ap.add_argument("--expect-forbidden", action="store_true"); ap.add_argument("--insecure-local", action="store_true")
    a = ap.parse_args()
    base = a.base.rstrip("/"); host = urllib.parse.urlparse(base).hostname
    ctx = ssl.create_default_context()
    if a.insecure_local: ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    ok, bad, skipped = [], [], []
    def rec(label, cond, detail=""):
        (ok if cond else bad).append(label); print(("PASS " if cond else "FAIL ") + label + (f" [{detail}]" if detail else ""))

    if a.expect_forbidden:
        for p in ["/"] + a.pages:
            s, _, _ = get(base + p, ctx); rec(f"operator-only: {p} is 403 from this (non-allowed) source", s == 403, f"status {s}")
        return summary(ok, bad, skipped)

    if base.startswith("https://"):
        try:
            with socket.create_connection((host, 443), timeout=15) as sk, ctx.wrap_socket(sk, server_hostname=host) as ss:
                cert = ss.getpeercert(); rec("TLS certificate validates for the host", True, f"notAfter {cert.get('notAfter')}")
        except Exception as e:
            rec("TLS certificate validates for the host", False, type(e).__name__)
    allowed = {host, *a.allow_host}
    seen_assets, bodies = set(), {}
    for p in a.pages:
        s, h, body = get(base + p, ctx)
        rec(f"page {p} answers 2xx/3xx", 200 <= s < 400, f"status {s}")
        loc = h.get("Location") or h.get("location") or ""
        if 300 <= s < 400:
            lh = urllib.parse.urlparse(urllib.parse.urljoin(base + p, loc)).hostname
            rec(f"redirect from {p} stays on an allowed host", lh in allowed, f"-> {lh}")
            for bad_s in FORBIDDEN_STRINGS + REDIRECT_EXTRA: rec(f"redirect from {p} does not contain '{bad_s}'", bad_s not in loc.lower())
        if 200 <= s < 300:
            t = body.decode("utf-8", "replace"); bodies[p] = t
            for u in re.findall(r"""(?:src|href)=["']?([^"'\s>#]+)""", t):
                absu = urllib.parse.urljoin(base + p, u); uh = urllib.parse.urlparse(absu).hostname
                if uh == host and re.search(r"\.(js|css)(\?|$)", absu): seen_assets.add(absu)
                elif uh and uh not in allowed and not u.startswith(("mailto:", "tel:")): bodies.setdefault("_offhost", set()).add(uh)
    for p, t in list(bodies.items()):
        if p == "_offhost": continue
        low = re.sub(r"<(script|style)\b.*?</\1>", " ", t, flags=re.S | re.I).lower()   # customer-visible markup only
        for bad_s in FORBIDDEN_STRINGS: rec(f"page {p} contains no '{bad_s}'", bad_s not in low)
        if a.expect_title:
            m = re.search(r"<title>(.*?)</title>", t, re.S | re.I); rec(f"page {p} title contains '{a.expect_title}'", bool(m) and a.expect_title.lower() in m.group(1).lower(), (m.group(1).strip()[:60] if m else "no title"))
    off = bodies.get("_offhost", set())
    rec("no references to hosts outside the allowed set", not off, ", ".join(sorted(off))[:120])
    for u in sorted(seen_assets)[:25]:
        s, _, body = get(u, ctx); low = body.decode("utf-8", "replace").lower()
        hits = [b for b in ASSET_FORBIDDEN if b in low]
        rec(f"client asset {urllib.parse.urlparse(u).path.rsplit('/', 1)[-1][:28]} has no forbidden origin/branding", s == 200 and not hits, ",".join(hits))
    s, h, _ = get(base + "/dashboard", ctx)
    loc = (h.get("Location") or h.get("location") or "")
    rec("fail-closed: unauthenticated /dashboard is not served (3xx to login, 401, 403 or 404)", s in (401, 403, 404) or (300 <= s < 400 and "login" in loc.lower()), f"status {s}")
    if a.readiness_path:
        s, h, body = get(base + a.readiness_path, ctx); t = body.decode("utf-8", "replace")
        rec("readiness endpoint answers 200", s == 200, f"status {s}"); rec("readiness body is small (<2 KB)", len(body) < 2048, f"{len(body)} bytes")
        hits = [p for p in SECRET_HINTS if re.search(p, t, re.I)]
        rec("readiness body leaks no configuration or credentials", not hits, ",".join(hits)[:80])
    else:
        skipped.append("readiness endpoint (path unknown until the Codex Phase 1 contract exists)")
    skipped += ["authenticated own-workspace access / foreign-workspace denial (needs the Codex fixture + auth contract)",
                "fixture idempotency, simulated adapter events (needs the Codex fixture command)"]
    return summary(ok, bad, skipped)

def summary(ok, bad, skipped):
    for s in skipped: print("SKIPPED", s)
    print(f"SUMMARY passed={len(ok)} failed={len(bad)} skipped={len(skipped)}")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
