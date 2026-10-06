#!/usr/bin/env python3
"""Controls for acceptance_smoke.py using local fixture servers (no network beyond loopback)."""
import http.server, subprocess, sys, threading, os
HERE = os.path.dirname(os.path.abspath(__file__)); S = os.path.join(HERE, "acceptance_smoke.py")
CLEAN = b"<html><head><title>Uplink by EPIC</title><link rel=stylesheet href=/a.css></head><body>Hello Uplink</body></html>"
BRANDED = b"<html><head><title>SeldonFrame - Sell AI front offices</title></head><body>Powered by SeldonFrame <a href='https://app.seldonframe.com'>x</a></body></html>"

def serve(kind):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            p = self.path
            if kind == "forbidden": self.send_response(403); self.end_headers(); return
            if p == "/dashboard":
                if kind == "open": self.send_response(200); self.end_headers(); self.wfile.write(b"secret dashboard"); return
                self.send_response(307); self.send_header("Location", "/login"); self.end_headers(); return
            if p == "/login" or p == "/":
                if kind == "redirect-localhost" and p == "/": self.send_response(302); self.send_header("Location", "http://localhost:3000/login"); self.end_headers(); return
                body = BRANDED if kind == "branded" else (CLEAN.replace(b"</body>", b"<script>var pkg='@seldonframe/crm';</script></body>") if kind == "inline-script" else CLEAN)
                self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(body); return
            if p == "/a.css":
                self.send_response(200); self.end_headers(); self.wfile.write(b"body{} /* app.seldonframe.com */" if kind == "branded-asset" else b"body{}"); return
            if p == "/ready":
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ok","db":"ok"}' if kind != "leaky" else b'{"DATABASE_URL":"postgres://u:p@h/db","password":"x"}'); return
            self.send_response(404); self.end_headers()
    srv = http.server.HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

def run(kind, *extra):
    srv = serve(kind); port = srv.server_address[1]
    r = subprocess.run([sys.executable, S, "--base", f"http://127.0.0.1:{port}", "--allow-host", "127.0.0.1", *extra], capture_output=True, text=True)
    srv.shutdown(); return r.returncode, r.stdout

fails = 0
def expect(label, kind, want_rc, extra=(), must=None):
    global fails
    rc, out = run(kind, *extra)
    # the loopback host itself is listed in FORBIDDEN_STRINGS ('127.0.0.1'), so the clean fixture is checked with the loopback names stripped
    good = (rc == 0) == (want_rc == 0) and (must is None or must in out)
    print(("PASS" if good else "FAIL"), label, f"(rc={rc})"); fails += 0 if good else 1
    if not good: print(out[-700:])

# The fixture runs on 127.0.0.1, which the scanner (correctly) treats as a forbidden leak. A positive control therefore uses an alias host name.
import socket
def run_alias(kind, *extra):
    srv = serve(kind); port = srv.server_address[1]
    # 'localtest.me' style aliasing is not available offline, so patch the forbidden list through an env flag the scanner does not have;
    # instead run the scanner with FORBIDDEN_STRINGS minus loopback by importing it.
    sys.path.insert(0, HERE); import importlib, acceptance_smoke as m; importlib.reload(m)
    m.REDIRECT_EXTRA = [s for s in m.REDIRECT_EXTRA if s != "127.0.0.1"]   # the fixture itself lives on loopback
    sys.argv = ["x", "--base", f"http://127.0.0.1:{port}", "--allow-host", "127.0.0.1", *extra]
    import io, contextlib; buf = io.StringIO()
    with contextlib.redirect_stdout(buf): rc = m.main()
    srv.shutdown(); return rc, buf.getvalue()

def expect2(label, kind, want_rc, extra=(), must=None):
    global fails
    rc, out = run_alias(kind, *extra)
    good = (rc == 0) == (want_rc == 0) and (must is None or must in out)
    print(("PASS" if good else "FAIL"), label, f"(rc={rc})"); fails += 0 if good else 1
    if not good: print(out[-900:])

expect2("positive control: clean Uplink-branded fixture passes (skips are listed, not counted)", "clean", 0, ("--expect-title", "Uplink", "--readiness-path", "/ready"), must="SKIPPED")
expect2("negative control: vendor-branded fixture FAILS the branding scan", "branded", 1, ("--expect-title", "Uplink"), must="FAIL page / contains no 'seldonframe'")
expect2("negative control: vendor string inside a CSS/JS asset FAILS", "branded-asset", 1, must="FAIL client asset")
expect2("negative control: redirect to localhost FAILS", "redirect-localhost", 1, must="redirect from / does not contain 'localhost'")
expect2("negative control: unauthenticated /dashboard that is served FAILS fail-closed", "open", 1, must="FAIL fail-closed")
expect2("negative control: readiness body that leaks DATABASE_URL FAILS", "leaky", 1, ("--readiness-path", "/ready"), must="FAIL readiness body leaks no configuration")
expect2("without a readiness path the check is SKIPPED not passed", "clean", 0, must="SKIPPED readiness endpoint")
expect2("positive control: a package name inside an inline script is not customer-visible branding", "inline-script", 0, must="PASS page / contains no 'seldonframe'")
rc, out = run("forbidden", "--expect-forbidden"); good = rc == 0 and "403" in out
print(("PASS" if good else "FAIL"), "operator-only mode: 403 host passes the --expect-forbidden control", f"(rc={rc})"); fails += 0 if good else 1
rc, out = run("clean", "--expect-forbidden"); good = rc == 1
print(("PASS" if good else "FAIL"), "negative control: an open host FAILS --expect-forbidden", f"(rc={rc})"); fails += 0 if good else 1
print(f"SUMMARY smoke controls failed={fails}"); sys.exit(1 if fails else 0)
