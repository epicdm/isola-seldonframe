#!/usr/bin/env python3
"""Negative/positive controls for validate_package.py. Each mutation must make the validator FAIL; the fully substituted package must PASS in final mode."""
import json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(HERE, "..", "json"); V = os.path.join(HERE, "validate_package.py")
GOOD_DIGEST = "a" * 64          # staging image digest used in the fully substituted fixture
PROD_DIGEST = "c" * 64          # production image digest (a different build: a different digest)
CANON = "https://build.uplink.epic.dm"   # staging origin (PM ruling plan v2.8)
PROD = "https://uplink.epic.dm"          # production origin
SRC_COMMIT = "1234567890abcdef1234567890abcdef12345678"

BASELINE = os.environ.get("UPLINK_BASELINE", os.path.join(HERE, "..", "..", "uplink-baseline.final.sql"))
MAKE = os.path.join(HERE, "make_job_json.py")
def gen(d):
    g = d + "_gen"; subprocess.run([sys.executable, MAKE, "--baseline", BASELINE, "--out", g], capture_output=True, check=True); return g

def run(d, mode, generated=None):
    cmd = [sys.executable, V, "--mode", mode, "--dir", d]
    if generated: cmd += ["--generated", generated]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout

def fresh():
    d = tempfile.mkdtemp(prefix="uplinkval-");
    for f in os.listdir(SRC): shutil.copy(os.path.join(SRC, f), d)
    return d

def edit(d, name, fn):
    p = os.path.join(d, name); t = open(p, newline="").read(); t2 = fn(t); assert t != t2, "mutation did not change " + name
    open(p, "w", newline="").write(t2)

def substitute(d):
    subs = {"{{UPLINK_STAGING_IMAGE_DIGEST_HEX}}": GOOD_DIGEST, "{{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}}": PROD_DIGEST, "{{STAGING_OPERATOR_CIDR}}": "203.0.113.7/32",
            "{{PG_IMAGE_DIGEST_HEX}}": "65b16a8b326e0cfbdf33fa7e783f2a0cb352a61448616ccccfd616ef42aa0f65",
            "{{PYTHON_IMAGE_DIGEST_HEX}}": "b" * 64, "{{AWSCLI_VERSION}}": "1.0.0", "{{BACKUP_STORAGE_PROVIDER_ID}}": "provider-id-1"}
    for n in ("02-uplink-app.createFromSchema.json", "02p-uplink-app-production.createFromSchema.json", "01-middleware-uplink-operators.createMiddleware.json", "03-uplink-db.owner-ui-spec.json",
              "04-uplink-baseline-import-job.template.json", "05-uplink-restore-check-db.owner-ui-spec.json", "06-uplink-restore-verify-job.template.json",
              "07-uplink-backup-audit-service.template.json", "08-uplink-backup-config.createDatabaseBackup.json"):
        edit(d, n, lambda t: [t := t.replace(k, v) for k, v in subs.items()][-1])
    # env template stays a template (owner markers allowed); final mode is about the deployment JSON + contract
    c = json.load(open(os.path.join(d, "contract.json"))); c["pending_codex_keys"] = []
    open(os.path.join(d, "contract.json"), "w", newline="\n").write(json.dumps(c, indent=2) + "\n")
    for envf in ("uplink-app.staging.env.template", "uplink-app.production.env.template"):
        t = open(os.path.join(d, envf)).read()
        keep = [ln for ln in t.splitlines() if "{{CODEX_" not in ln]
        t = "\n".join(keep).replace("{{OWNER_SUPPORT_EMAIL_OR_EMPTY}}", "").replace("{{OWNER_LOGO_URL_OR_EMPTY}}", "").replace("{{OWNER_FAVICON_URL_OR_EMPTY}}", "")
        open(os.path.join(d, envf), "w", newline="\n").write(t + "\n")
    # the Codex receipt fields, filled with obviously synthetic test values (never real); a real run fills them only from the Codex receipt
    ic = json.load(open(os.path.join(d, "codex-image-contract.template.json")))
    ic["source_commit"] = SRC_COMMIT
    ic["workflow_run_urls"] = {"staging": "https://example.invalid/run/1", "production": "https://example.invalid/run/2"}
    ic["images"]["staging"].update(tag="uplink-build-test-" + SRC_COMMIT[:8], digest="sha256:" + GOOD_DIGEST)
    ic["images"]["production"].update(tag="uplink-prod-test-" + SRC_COMMIT[:8], digest="sha256:" + PROD_DIGEST)
    ic["readiness_path"] = "/ready-test"; ic["fixture_command"] = "fixture-test"
    for an in ic["adapters"]: ic["adapters"][an] = {"key": "TEST_KEY_" + an.upper(), "value": "off"}
    open(os.path.join(d, "codex-image-contract.template.json"), "w", newline="\n").write(json.dumps(ic, indent=2) + "\n")

fails = 0
total = 0
def expect(label, want_rc, d, mode, generated=None):
    global fails, total
    total += 1
    rc, out = run(d, mode, generated)
    good = (rc == 0) == (want_rc == 0)
    print(("PASS" if good else "FAIL"), label, f"(rc={rc})")
    if os.environ.get("UPLINK_TEST_REASONS") and want_rc != 0:    # show WHY each negative control failed, to prove it fails for the intended reason
        print("      reason:", "; ".join(l[:150] for l in out.splitlines() if l.startswith("FAIL"))[:420])
    if not good: fails += 1; print(out[:600])

# positive controls
d = fresh(); expect("offline mode accepts the shipped package (placeholders pending)", 0, d, "offline")
d = fresh(); expect("final mode REJECTS the shipped package (placeholders unsubstituted)", 1, d, "final")
d = fresh(); substitute(d); expect("final mode accepts a fully substituted package (with generated job files)", 0, d, "final", gen(d))
d = fresh(); substitute(d); expect("final mode REJECTS a package without the generated job files", 1, d, "final")
d = fresh(); expect("offline mode validates the shipped generated job files", 0, d, "offline", gen(d))

APP = "02-uplink-app.createFromSchema.json"; DB = "03-uplink-db.owner-ui-spec.json"; MW = "01-middleware-uplink-operators.createMiddleware.json"; ENV = "uplink-app.staging.env.template"; ENVP = "uplink-app.production.env.template"; APPP = "02p-uplink-app-production.createFromSchema.json"; ICF = "codex-image-contract.template.json"
muts = [
 ("mutable image tag", APP, lambda t: t.replace("@sha256:{{UPLINK_STAGING_IMAGE_DIGEST_HEX}}", ":latest")),
 ("short/invalid digest", APP, lambda t: t.replace("{{UPLINK_STAGING_IMAGE_DIGEST_HEX}}", "abc123")),
 ("app env present (agents must not write env)", APP, lambda t: t.replace('"deploy": {', '"env": "X=1",\n            "deploy": {')),
 ("production host attached before cutover", APP, lambda t: t.replace('"host": "build.uplink.epic.dm"', '"host": "uplink.epic.dm"')),
 ("domain without operator middleware", APP, lambda t: t.replace('"middlewares": ["uplink-operators"]', '"middlewares": []')),
 ("app CPU limit != plan", APP, lambda t: t.replace('"cpuLimit": 2', '"cpuLimit": 1')),
 ("app memory limit != plan", APP, lambda t: t.replace('"memoryLimit": 3072', '"memoryLimit": 1024')),
 ("unsupported field in app data", APP, lambda t: t.replace('"serviceName": "uplink-app",', '"serviceName": "uplink-app",\n            "healthcheck": {"test": "x"},')),
 ("host port published", APP, lambda t: t.replace('"deploy": {', '"ports": [{"published": 5432, "target": 3000}],\n            "deploy": {')),
 ("db password literal in spec", DB, lambda t: t.replace('"user": "uplink",', '"user": "uplink",\n      "password": "hunter2hunter2",')),
 ("db published port", DB, lambda t: t.replace('"dbGate"', '"exposedPort": 5432,\n      "dbGate"')),
 ("db limit != plan", DB, lambda t: t.replace('"memoryLimit": 4096', '"memoryLimit": 2048')),
 ("db on PostgreSQL 17", DB, lambda t: t.replace("postgres:16.15", "postgres:17.2")),
 ("db tool enabled", DB, lambda t: t.replace('"pgWeb": {"enabled": false}', '"pgWeb": {"enabled": true}')),
 ("CIDR too broad", MW, lambda t: t.replace("{{STAGING_OPERATOR_CIDR}}", "0.0.0.0/0")),
 ("CIDR /8", MW, lambda t: t.replace("{{STAGING_OPERATOR_CIDR}}", "10.0.0.0/8")),
 ("env: forbidden SMTP key", ENV, lambda t: t + "SMTP2GO_API_KEY=x\n"),
 ("env: Chatwoot key prefix", ENV, lambda t: t + "CHATWOOT_TOKEN=x\n"),
 ("env: AI provider key present", ENV, lambda t: t + "ANTHROPIC_API_KEY=x\n"),
 ("env: NEON_LOCAL_HOST present", ENV, lambda t: t + "NEON_LOCAL_HOST=neon-proxy\n"),
 ("env: secret key carries a value", ENV, lambda t: t.replace("AUTH_SECRET={{OWNER_ENTERS}}", "AUTH_SECRET=Abc123Def456Ghi789")),
 ("env: vendor branding on", ENV, lambda t: t.replace("SHOW_VENDOR_BRANDING=false", "SHOW_VENDOR_BRANDING=true")),
 ("env: beta host leaks", ENV, lambda t: t.replace("PLATFORM_HOME_URL=https://uplink.epic.dm", "PLATFORM_HOME_URL=https://front.isola.epic.dm")),
 ("env: staging NEXTAUTH_URL differs from the staging origin", ENV, lambda t: t.replace("NEXTAUTH_URL=https://build.uplink.epic.dm", "NEXTAUTH_URL=https://uplink.epic.dm")),
 ("env: r3 split origin (NEXT_PUBLIC production, others staging) is rejected", ENV, lambda t: t.replace("NEXT_PUBLIC_APP_URL=https://build.uplink.epic.dm", "NEXT_PUBLIC_APP_URL=https://uplink.epic.dm")),
 ("env: staging template carries the production origin in all four keys", ENV, lambda t: t.replace("https://build.uplink.epic.dm", "https://uplink.epic.dm")),
 ("env: production template carries the staging origin in all four keys", ENVP, lambda t: t.replace("https://uplink.epic.dm\nAUTH_URL", "https://build.uplink.epic.dm\nAUTH_URL").replace("AUTH_URL=https://uplink.epic.dm", "AUTH_URL=https://build.uplink.epic.dm").replace("NEXTAUTH_URL=https://uplink.epic.dm", "NEXTAUTH_URL=https://build.uplink.epic.dm").replace("PLATFORM_APP_URL=https://uplink.epic.dm", "PLATFORM_APP_URL=https://build.uplink.epic.dm")),
 ("env: production NEXT_PUBLIC_APP_URL differs from the other three", ENVP, lambda t: t.replace("NEXT_PUBLIC_APP_URL=https://uplink.epic.dm", "NEXT_PUBLIC_APP_URL=https://build.uplink.epic.dm")),
 ("env: staging and production differ outside the origin keys", ENVP, lambda t: t.replace("PLATFORM_NAME=Uplink", "PLATFORM_NAME=Uplink Pro")),
 ("env: production template missing a key the staging template has", ENVP, lambda t: t.replace("DB_POOL_MAX=10\n", "")),
 ("env: PLATFORM_APP_URL line removed", ENV, lambda t: t.replace("PLATFORM_APP_URL=https://build.uplink.epic.dm\n", "")),
 ("env: APP_HOSTS names the beta host", ENV, lambda t: t + "APP_HOSTS=agents.epic.dm\n"),
 ("env: missing required key", ENV, lambda t: t.replace("DB_DRIVER=pg\n", "")),
 ("env: wrong DB_DRIVER", ENV, lambda t: t.replace("DB_DRIVER=pg", "DB_DRIVER=neon")),
]
for label, name, fn in muts:
    d = fresh(); edit(d, name, fn); expect("negative control: " + label, 1, d, "offline")

J4 = "04-uplink-baseline-import-job.template.json"; J5 = "05-uplink-restore-check-db.owner-ui-spec.json"; J6 = "06-uplink-restore-verify-job.template.json"
J7 = "07-uplink-backup-audit-service.template.json"; J8 = "08-uplink-backup-config.createDatabaseBackup.json"; ENVJ = "job-import.env.template"
more = [
 ("04: host bind mount instead of file mounts", J4, lambda t: t.replace('{"type": "file", "mountPath": "/uplink/baseline.sql", "content": "{{BASELINE_SQL_CONTENT}}"}', '{"type": "bind", "hostPath": "/root", "mountPath": "/uplink/baseline.sql"}')),
 ("04: env present", J4, lambda t: t.replace('"deploy": {', '"env": "PGPASSWORD=x",\n            "deploy": {')),
 ("04: command changed", J4, lambda t: t.replace("sh /uplink/uplink_job.sh import", "sh -c 'psql -f /uplink/baseline.sql'")),
 ("04: mutable postgres tag", J4, lambda t: t.replace("postgres:16.15@sha256:{{PG_IMAGE_DIGEST_HEX}}", "postgres:16")),
 ("04: job given a published port", J4, lambda t: t.replace('"deploy": {', '"ports": [{"published": 5433, "target": 5432}],\n            "deploy": {')),
 ("04: job limits too large", J4, lambda t: t.replace('"memoryLimit": 512', '"memoryLimit": 8192')),
 ("06: domain on a job", J6, lambda t: t.replace('"deploy": {', '"domains": [{"host": "x.uplink.epic.dm", "port": 80}],\n            "deploy": {')),
 ("05: password literal", J5, lambda t: t.replace('"user": "uplink",', '"user": "uplink",\n      "password": "hunter2hunter2",')),
 ("05: restore target has its own backup schedule", J5, lambda t: t.replace('"dbGate"', '"backup": {"enabled": true},\n      "dbGate"')),
 ("07: Dockerfile base not pinned by digest", J7, lambda t: t.replace("FROM python:3.12-slim@sha256:{{PYTHON_IMAGE_DIGEST_HEX}}", "FROM python:3.12-slim")),
 ("07: audit service given a domain", J7, lambda t: t.replace('"deploy": {', '"domains": [{"host": "audit.uplink.epic.dm", "port": 80}],\n            "deploy": {')),
 ("08: daily retention 7 instead of 14", J8, lambda t: t.replace('"retention": 14', '"retention": 7')),
 ("08: weekly retention 4 instead of 8", J8, lambda t: t.replace('"retention": 8', '"retention": 4')),
 ("08: daily and weekly share one prefix", J8, lambda t: t.replace("uplink/weekly", "uplink/daily")),
 ("08: backups disabled", J8, lambda t: t.replace('"enabled": true', '"enabled": false', 1)),
 ("job env: literal password", ENVJ, lambda t: t.replace("PGPASSWORD={{OWNER_ENTERS}}", "PGPASSWORD=Abc123Def456Ghi789")),
 ("job env: wrong service host", ENVJ, lambda t: t.replace("PGHOST=uplink_uplink-db", "PGHOST=100.117.210.117")),
]
for label, name, fn in more:
    d = fresh(); edit(d, name, fn); expect("negative control: " + label, 1, d, "offline")
PM = [
 ("02p: production app also routes the staging host", APPP, lambda t: t.replace('"host": "uplink.epic.dm"', '"host": "build.uplink.epic.dm"')),
 ("02p: production domain carries the operator-only middleware", APPP, lambda t: t.replace('"middlewares": []', '"middlewares": ["uplink-operators"]')),
 ("02p: production service uses the staging digest placeholder", APPP, lambda t: t.replace("{{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}}", "{{UPLINK_STAGING_IMAGE_DIGEST_HEX}}")),
 ("02p: production service name is the staging service name", APPP, lambda t: t.replace('"serviceName": "uplink-app-prod"', '"serviceName": "uplink-app"')),
 ("02: staging service uses the production digest placeholder", APP, lambda t: t.replace("{{UPLINK_STAGING_IMAGE_DIGEST_HEX}}", "{{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}}")),
 ("image contract: staging public_url is the production origin", ICF, lambda t: t.replace('"public_url": "https://build.uplink.epic.dm"', '"public_url": "https://uplink.epic.dm"')),
 ("image contract: production public_url is the staging origin", ICF, lambda t: t.replace('"public_url": "https://uplink.epic.dm"', '"public_url": "https://build.uplink.epic.dm"')),
 ("image contract: repository differs", ICF, lambda t: t.replace("ghcr.io/epicdm/isola-seldonframe", "docker.io/other/app", 1)),
 ("image contract: adapters.voice_flag removed", ICF, lambda t: t.replace('"voice_flag"', '"voice_flag_x"')),
 ("image contract: fixture command emptied", ICF, lambda t: t.replace('"fixture_command": "{{CODEX_FIXTURE_COMMAND}}"', '"fixture_command": ""')),
]
for label, name, fn in PM:
    d = fresh(); edit(d, name, fn); expect("negative control: " + label, 1, d, "offline")
# origin / image-contract controls in FINAL mode with synthetic Codex values (the positive twin proves the fixture can pass)
def final_pair(label, want_rc, name, fn):
    d = fresh(); substitute(d); edit(d, name, fn); expect(label, want_rc, d, "final", gen(d))
final_pair("final: synthetic Codex values + both templates + two images pass (positive twin of the controls below)", 0, ENV, lambda t: t + "# note\n")
final_pair("negative control final: both images share one digest", 1, ICF, lambda t: t.replace("c" * 64, "a" * 64))
final_pair("negative control final: both images share one tag", 1, ICF, lambda t: t.replace("uplink-prod-test-", "uplink-build-test-"))
final_pair("negative control final: a source-only tag (uplink-phase1-<sha>) is refused", 1, ICF, lambda t: t.replace("uplink-prod-test-" + SRC_COMMIT[:8], "uplink-phase1-" + SRC_COMMIT))
final_pair("negative control final: source commit is not a 40-hex commit", 1, ICF, lambda t: t.replace(SRC_COMMIT, "abc123"))
final_pair("negative control final: contract digest differs from the staging app JSON digest", 1, ICF, lambda t: t.replace("sha256:" + "a" * 64, "sha256:" + "d" * 64))
final_pair("negative control final: readiness path carries a query string", 1, ICF, lambda t: t.replace("/ready-test", "/ready?token=x"))
final_pair("negative control final: one adapter flag left as a placeholder", 1, ICF, lambda t: t.replace('"TEST_KEY_VOICE_FLAG"', '"{{CODEX_VOICE_FLAG_KEY}}"'))
final_pair("negative control final: production app JSON still carries a digest placeholder", 1, APPP, lambda t: t.replace("c" * 64, "{{UPLINK_PRODUCTION_IMAGE_DIGEST_HEX}}"))
# origin controls in FINAL mode (all placeholders substituted): consistent single origin passes (above); split or unrouted origins fail
def final_with(label, want_rc, fn):
    d = fresh(); substitute(d); edit(d, ENV, fn); expect(label, want_rc, d, "final", gen(d))
final_with("final: a consistent origin on the routed staging host passes (positive twin of the two controls below)", 0, lambda t: t.replace("# Codex canonicalAppOrigin", "# Codex canonicalAppOrigin", 1) + "# note\n")
final_with("negative control final: r3 split origin fails even fully substituted", 1, lambda t: t.replace("NEXT_PUBLIC_APP_URL=" + CANON, "NEXT_PUBLIC_APP_URL=https://uplink.epic.dm"))
final_with("negative control final: canonical origin = production host while only the staging host is routed fails", 1, lambda t: t.replace(CANON, "https://uplink.epic.dm"))
final_with("negative control final: canonical origin is not an Uplink origin fails", 1, lambda t: t.replace(CANON, "https://agents.epic.dm"))
# generated-file tampering must be caught
def tamper(label, fname, fn):
    d = fresh(); g = gen(d); p = os.path.join(g, fname); t = open(p, newline="").read(); t2 = fn(t); assert t != t2
    open(p, "w", newline="").write(t2); expect("negative control: generated file " + label, 1, d, "offline", g)
tamper("baseline content altered by one byte", "04-uplink-baseline-import-job.createFromSchema.json", lambda t: t.replace("CREATE TABLE", "CREATE  TABLE", 1))
tamper("job script content differs from tools/uplink_job.sh", "04-uplink-baseline-import-job.createFromSchema.json", lambda t: t.replace("RESULT PASS imported in one transaction", "RESULT PASS imported", 1))
tamper("verify job script content differs", "06-uplink-restore-verify-job.createFromSchema.json", lambda t: t.replace("verify complete", "done", 1))
# CRLF and non-ASCII
d = fresh(); edit(d, ENV, lambda t: t.replace("\n", "\r\n")); expect("negative control: CRLF line endings", 1, d, "offline")
d = fresh(); edit(d, ENV, lambda t: t + "# caf\u00e9\n"); expect("negative control: non-ASCII byte", 1, d, "offline")
print(f"SUMMARY controls={total} failed={fails}")
sys.exit(1 if fails else 0)
