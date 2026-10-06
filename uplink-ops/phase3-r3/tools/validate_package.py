#!/usr/bin/env python3
"""Uplink r3 static validator. Offline, no network, no secrets.

usage: validate_package.py [--mode offline|final] [--dir DIR]

offline: {{PLACEHOLDER}} tokens are reported as PENDING (allowed); everything else is enforced.
final  : any {{PLACEHOLDER}} left anywhere is a FAILURE (the package is not deployable yet).
Exit code 0 = no failures (offline may still list pending items), 1 = failures.
The embedded schema is the supported subset of the EasyPanel createFromSchema/createMiddleware inputs
as returned by the epic-portal MCP search_procedures on 2026-10-06 (additionalProperties enforced at data level).
"""
import json, os, re, sys

MODE = "offline"
GEN = None
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "json")
args = sys.argv[1:]
while args:
    a = args.pop(0)
    if a == "--mode": MODE = args.pop(0)
    elif a == "--dir": BASE = args.pop(0)
    elif a == "--generated": GEN = args.pop(0)
    else: sys.exit("unknown arg " + a)
assert MODE in ("offline", "final")

NAME = re.compile(r"^[a-z0-9\-_]+$")
PLACEHOLDER = re.compile(r"\{\{[A-Z0-9_]+\}\}")
failures, pending = [], []

def fail(msg): failures.append(msg)

def load(name):
    p = os.path.join(BASE, name)
    raw = open(p, "rb").read()
    if b"\r" in raw: fail(f"{name}: contains CR (must be LF)")
    try: raw.decode("ascii")
    except UnicodeDecodeError: fail(f"{name}: non-ASCII bytes")
    return raw.decode("utf-8", "replace")

def scan_placeholders(name, text, allow=()):
    for m in PLACEHOLDER.findall(text):
        pending.append(f"{name}: {m}")
        if MODE == "final" and m not in allow: fail(f"{name}: placeholder {m} not substituted")

def typ(v, t): return isinstance(v, t) and not isinstance(v, bool) if t in (int, float) else isinstance(v, t)

def check_keys(obj, allowed, where, required=()):
    if not isinstance(obj, dict): fail(f"{where}: must be an object"); return False
    for k in obj:
        if k.startswith("_"): continue
        if k not in allowed: fail(f"{where}: unsupported field '{k}'")
    for k in required:
        if k not in obj: fail(f"{where}: missing required '{k}'")
    return True

RES = ("cpuLimit", "cpuReservation", "memoryLimit", "memoryReservation")
APP_ALLOWED = {"basicAuth", "build", "deploy", "domains", "dotEnvPath", "env", "maintenance", "mounts", "ports", "resources", "scripts", "serviceName", "source"}
PG_ALLOWED = {"backup", "command", "databaseName", "dbGate", "env", "exposedPort", "image", "password", "pgWeb", "resources", "serviceName", "user"}
DOM_ALLOWED = {"certificateResolver", "host", "https", "internalProtocol", "middlewares", "path", "port", "service", "wildcard"}
DEPLOY_ALLOWED = {"capAdd", "capDrop", "command", "groups", "replicas", "sysctls", "tiniInit", "zeroDowntime"}

def check_resources(r, expect, where):
    if not check_keys(r, set(RES), where, RES): return
    for k in RES:
        if not typ(r.get(k), (int, float)) if False else not isinstance(r.get(k), (int, float)) or isinstance(r.get(k), bool):
            fail(f"{where}.{k}: must be a number")
        elif r[k] != expect[k]:
            fail(f"{where}.{k}: {r[k]} != locked plan value {expect[k]}")
    if r.get("cpuReservation", 0) > r.get("cpuLimit", 0) or r.get("memoryReservation", 0) > r.get("memoryLimit", 0):
        fail(f"{where}: reservation exceeds limit")

contract = json.loads(load("contract.json"))
L = contract["limits"]

# ---- app createFromSchema: staging (02) and production (02p), r3.2 (PM ruling plan v2.8: separate images per origin) ----
ENVS = contract["environments"]
ROUTED, APP_DIGEST = {}, {}
def check_app(envname):
    E = ENVS[envname]; fname = E["app_json"]; w = fname
    t = load(fname); scan_placeholders(fname, t)
    d = json.loads(t); inp = d.get("input", {})
    check_keys(inp, {"projectName", "name", "schema"}, w + ".input", ("projectName", "schema"))
    if inp.get("projectName") != "uplink": fail(f"{w}: projectName must be 'uplink'")
    svcs = inp.get("schema", {}).get("services", [])
    ROUTED[envname] = []
    if len(svcs) != 1 or svcs[0].get("type") != "app": fail(f"{w}: exactly one app service expected"); return
    a = svcs[0]["data"]
    check_keys(a, APP_ALLOWED, w + ".app", ("serviceName",))
    if not NAME.match(a.get("serviceName", "")) or a.get("serviceName") != E["service"]: fail(f"{w}: serviceName must be {E['service']}")
    src = a.get("source", {})
    if src.get("type") != "image": fail(f"{w}: source.type must be image")
    img = src.get("image", ""); repo = contract["image_contract"]["repository"]
    if "@sha256:" not in img: fail(f"{w}: image must be pinned by @sha256 digest (no mutable tag)")
    elif not img.startswith(repo + "@sha256:"): fail(f"{w}: image repository must be {repo}")
    elif PLACEHOLDER.search(img):
        if img != repo + "@sha256:" + E["image_digest_placeholder"]: fail(f"{w}: image must carry the {envname} digest placeholder {E['image_digest_placeholder']} (each environment has its own image)")
    elif not re.search(r"@sha256:[0-9a-f]{64}$", img): fail(f"{w}: image digest must be 64 hex chars")
    else: APP_DIGEST[envname] = img.rsplit(":", 1)[1]
    if re.search(r":(latest|main|master|dev|stable)(@|$)", img): fail(f"{w}: mutable tag present")
    if "env" in a: fail(f"{w}: env must be OMITTED (owner enters the environment; agents never write app env)")
    for k in ("mounts", "ports"):
        if a.get(k): fail(f"{w}: {k} must be empty/absent")
    doms = a.get("domains", [])
    ROUTED[envname] = [x.get("host") for x in doms]
    if ROUTED[envname] != [E["routed_host"]]: fail(f"{w}: only {E['routed_host']} may be routed for {envname}")
    for x in doms:
        check_keys(x, DOM_ALLOWED, w + ".domain", ("host",))
        for other, OE in ENVS.items():
            if other != envname and x.get("host") == OE["routed_host"]: fail(f"{w}: {other} host {OE['routed_host']} must not be routed by the {envname} service")
        mw = x.get("middlewares", [])
        if E["operator_only"] and "uplink-operators" not in mw: fail(f"{w}: domain must carry middleware uplink-operators (operator-only staging)")
        if not E["operator_only"] and "uplink-operators" in mw: fail(f"{w}: the production domain must not carry the operator-only middleware")
        if x.get("https") is not True or x.get("port") != 3000: fail(f"{w}: domain must be https on port 3000")
    check_resources(a.get("resources"), L["app"], w + ".resources")
    dep = a.get("deploy", {})
    check_keys(dep, DEPLOY_ALLOWED, w + ".deploy")
    if dep.get("replicas") != 1: fail(f"{w}: replicas must be 1")
for _e in ENVS: check_app(_e)

# ---- 01 middleware ----
t = load("01-middleware-uplink-operators.createMiddleware.json"); scan_placeholders("01-middleware", t)
m = json.loads(t)["input"]
check_keys(m, {"name", "type", "sourceRange", "ipStrategy", "rejectedStatusCode"}, "01.input", ("name", "type"))
if m.get("type") != "ipAllowList" or m.get("name") != "uplink-operators": fail("01: must be ipAllowList named uplink-operators")
for c in m.get("sourceRange", []):
    if PLACEHOLDER.search(c): continue
    if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}/\d{1,2}", c): fail(f"01: bad CIDR {c}")
    elif c in ("0.0.0.0/0",) or int(c.split("/")[1]) < 16: fail(f"01: CIDR {c} is too broad for operator-only staging")

# ---- 03 DB owner spec ----
t = load("03-uplink-db.owner-ui-spec.json"); scan_placeholders("03-db", t)
db = json.loads(t)["service"]["data"]
check_keys(db, PG_ALLOWED, "03.db", ("serviceName",))
if "password" in db: fail("03: password must not appear in any artifact")
if db.get("serviceName") != "uplink-db": fail("03: serviceName must be uplink-db")
img = db.get("image", "")
if "@sha256:" not in img: fail("03: image must be pinned by digest")
elif not PLACEHOLDER.search(img):
    if not re.search(r"@sha256:[0-9a-f]{64}$", img): fail("03: image digest must be 64 hex chars")
    if img != contract["postgres_image_candidate"]: fail("03: digest differs from the approved candidate in contract.json")
if not img.startswith("postgres:16"): fail("03: PostgreSQL 16 required")
if db.get("exposedPort"): fail("03: no published port allowed")
check_resources(db.get("resources"), L["db"], "03.resources")
for flag in ("dbGate", "pgWeb"):
    if db.get(flag, {}).get("enabled"): fail(f"03: {flag} must be disabled")
cmd = db.get("command", "")
mc = re.search(r"max_connections=(\d+)", cmd)
if not mc or int(mc.group(1)) < 11 + 5: fail("03: max_connections too small for DB_POOL_MAX plus admin sessions")
sb = re.search(r"shared_buffers=(\d+)GB", cmd)
if sb and int(sb.group(1)) * 1024 > L["db"]["memoryLimit"] * 0.3: fail("03: shared_buffers above 30 percent of the memory limit")

# ---- environment templates (one per environment) vs contract ----
host = lambda u: re.sub(r"^https?://", "", u).split("/")[0]
O = contract["origin"]; ENVVALS = {}
def check_env(envname):
    E = ENVS[envname]; fn = E["env_template"]
    t = load(fn); scan_placeholders(fn, t, allow=("{{OWNER_ENTERS}}",))   # secret markers stay: the owner types those values himself
    env = {}
    for ln in t.splitlines():
        if not ln.strip() or ln.lstrip().startswith("#"): continue
        if "=" not in ln: continue                          # a bare pending line such as {{CODEX_READINESS_PATH_NOTE}}
        k, v = ln.split("=", 1)
        if k in env: fail(f"{fn}: duplicate key {k}")
        env[k] = v
    for k, v in contract["expected_config"].items():
        if k not in env: fail(f"{fn}: missing required key {k}")
        elif env[k] != v: fail(f"{fn}: {k}={env[k]!r} expected {v!r}")
    for k in contract["owner_value_keys"]:
        if k not in env: fail(f"{fn}: missing owner key {k}")
    for k in contract["secret_keys"]:
        if k not in env: fail(f"{fn}: missing secret key name {k}")
        elif env[k] != "{{OWNER_ENTERS}}": fail(f"{fn}: {k} must carry only the OWNER_ENTERS marker (a value would be a secret in a file)")
    for k in env:
        if k in contract["forbidden_keys"] or any(k.startswith(p) for p in contract["forbidden_key_prefixes"]):
            fail(f"{fn}: forbidden key {k} (integration/AI/SMTP/billing must be absent)")
        for bad in contract["forbidden_value_substrings"]:
            if bad.lower() in env[k].lower(): fail(f"{fn}: {k} value contains forbidden substring {bad!r}")
    # origin: the four keys agree within the environment AND equal this environment's origin (PM ruling v2.8; the Codex source throws on a mismatch),
    # and that origin's host is the host the environment's app service is routed on
    for k in O["keys_must_equal"]:
        if k not in env: fail(f"{fn}: missing origin key {k}")
    for k in O["keys_must_equal"] + [k for k in O["optional_equal_keys"] if k in env]:
        if env.get(k) != E["origin"]: fail(f"{fn}: {k}={env.get(k)!r} must equal the {envname} origin {E['origin']!r} (all four origin keys agree within an environment)")
    if host(E["origin"]) not in ROUTED.get(envname, []): fail(f"{fn}: origin host {host(E['origin'])!r} is not routed by the {envname} app (routed: {ROUTED.get(envname)}); auth and redirects would target an unrouted host")
    if O["optional_host_list_key"] in env:
        for h in [x.strip() for x in env[O["optional_host_list_key"]].split(",") if x.strip()]:
            if h != host(E["origin"]): fail(f"{fn}: {O['optional_host_list_key']} host {h!r} is not the {envname} host (no alias host is authorized in r3.2)")
    if env.get("WORKSPACE_BASE_DOMAIN") != contract["production_host"]: fail(f"{fn}: WORKSPACE_BASE_DOMAIN must be uplink.epic.dm")
    ENVVALS[envname] = env
for _e in ENVS: check_env(_e)
S_, P_ = ENVVALS.get("staging", {}), ENVVALS.get("production", {})
if set(S_) != set(P_): fail(f"staging and production templates define different keys: {sorted(set(S_) ^ set(P_))}")
_allowed = set(O["keys_must_equal"]) | set(O["optional_equal_keys"]) | {O["optional_host_list_key"]}
_diff = {k for k in S_ if k in P_ and S_[k] != P_[k]}
if _diff - _allowed: fail(f"staging and production templates differ outside the origin keys: {sorted(_diff - _allowed)} (same inputs, different public origin only)")

# ---- Codex image/receipt contract: two origin-specific images from one source commit; every Codex-owned field explicit and fail-closed ----
IC = contract["image_contract"]
t = load(IC["file"]); scan_placeholders(IC["file"], t); ic = json.loads(t)
imgs = ic.get("images", {})
if set(imgs) != set(ENVS): fail(f"{IC['file']}: images must define exactly {sorted(ENVS)}")
sc = ic.get("source_commit", "")
if not PLACEHOLDER.search(sc) and not re.fullmatch(r"[0-9a-f]{40}", sc): fail(f"{IC['file']}: source_commit must be a 40-hex commit (one commit for both images)")
res_dg, res_tag = {}, {}
for e, E in ENVS.items():
    im = imgs.get(e, {})
    if im.get("public_url") != E["origin"]: fail(f"{IC['file']}: {e} public_url must be {E['origin']} (the build argument baked into the image)")
    if im.get("repository") != IC["repository"]: fail(f"{IC['file']}: {e} repository must be {IC['repository']}")
    dg = im.get("digest", "")
    if not PLACEHOLDER.search(dg):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", dg): fail(f"{IC['file']}: {e} digest must be sha256:<64 hex>")
        else:
            res_dg[e] = dg
            if e in APP_DIGEST and APP_DIGEST[e] != dg.split(":", 1)[1]: fail(f"{IC['file']}: {e} digest differs from the digest in {E['app_json']}")
    tg = im.get("tag", "")
    if not PLACEHOLDER.search(tg):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", tg) or tg in ("latest", "main", "master", "dev", "stable"): fail(f"{IC['file']}: {e} tag {tg!r} is not an immutable-style tag")
        elif not PLACEHOLDER.search(sc) and tg == "uplink-phase1-" + sc: fail(f"{IC['file']}: {e} tag is the source-only tag; origin-specific tags are required so the second build cannot overwrite the first")
        else: res_tag[e] = tg
if len(res_dg) == len(ENVS) and len(set(res_dg.values())) != len(res_dg): fail(f"{IC['file']}: staging and production images must be different builds (different digests)")
if len(res_tag) == len(ENVS) and len(set(res_tag.values())) != len(res_tag): fail(f"{IC['file']}: staging and production tags must differ")
rp = ic.get("readiness_path", "")
if not PLACEHOLDER.search(rp) and not re.fullmatch(r"/[A-Za-z0-9_./-]*", rp): fail(f"{IC['file']}: readiness_path must be an absolute path without query or credentials")
if not ic.get("fixture_command"): fail(f"{IC['file']}: fixture_command must be present (placeholder until the Codex receipt)")
for an, av in ic.get("adapters", {}).items():
    for part in ("key", "value"):
        if not av.get(part): fail(f"{IC['file']}: adapters.{an}.{part} must be present (placeholder until the Codex receipt)")
for an in ("ai_mode", "chatwoot_flag", "voice_flag"):
    if an not in ic.get("adapters", {}): fail(f"{IC['file']}: adapters.{an} missing")
for e in ENVS:
    for part in ("workflow_run_urls",):
        if e not in ic.get(part, {}): fail(f"{IC['file']}: {part}.{e} missing")
if len(contract["pending_codex_keys"]) and MODE == "final": fail("contract.json: pending_codex_keys must be substituted from the Codex receipt")
for pk in contract["pending_codex_keys"]: pending.append(f"contract: {pk['key']} ({pk['purpose']})")


# ---- EasyPanel-managed jobs, restore target, audit service, backup schedules (v2.4: every deployed object is an EasyPanel object) ----
import hashlib
TOOLS = os.path.dirname(os.path.abspath(__file__))
CONTENT_PH = ("{{JOB_SCRIPT_CONTENT}}", "{{BASELINE_SQL_CONTENT}}", "{{AUDIT_SCRIPT_CONTENT}}", "{{AUDIT_LOOP_CONTENT}}")

def read_json(dirpath, name, allow=CONTENT_PH):
    p = os.path.join(dirpath, name)
    if not os.path.exists(p): fail(f"{name}: missing"); return None
    raw = open(p, "rb").read().decode("utf-8", "replace")
    if dirpath == BASE: scan_placeholders(name, raw, allow=allow)
    return json.loads(raw)

def check_pg_image(name, img):
    if not img.startswith("postgres:16.15@sha256:"): fail(f"{name}: image must be postgres:16.15 pinned by digest"); return
    if not PLACEHOLDER.search(img):
        if not re.search(r"@sha256:[0-9a-f]{64}$", img): fail(f"{name}: digest must be 64 hex chars")
        elif img != contract["postgres_image_candidate"]: fail(f"{name}: digest differs from the approved candidate")

def check_job_service(name, svc, svcname, cmd, mounts_expected, generated):
    check_keys(svc, APP_ALLOWED, name + ".app", ("serviceName",))
    if svc.get("serviceName") != svcname: fail(f"{name}: serviceName must be {svcname}")
    if svc.get("source", {}).get("type") == "image": check_pg_image(name, svc["source"].get("image", ""))
    else: fail(f"{name}: source must be an image")
    for k in ("env", "domains", "ports"):
        if svc.get(k): fail(f"{name}: {k} must be absent (jobs have no route/ports; the owner enters env in the portal)")
    dep = svc.get("deploy", {}); check_keys(dep, DEPLOY_ALLOWED, name + ".deploy")
    if dep.get("command") != cmd: fail(f"{name}: command must be {cmd!r}")
    if dep.get("replicas") != 1 or dep.get("zeroDowntime") is not False: fail(f"{name}: replicas 1 and zeroDowntime false required for a one-shot job")
    r = svc.get("resources", {}); check_keys(r, set(RES), name + ".resources", RES)
    if r.get("memoryLimit", 10**9) > 1024 or r.get("cpuLimit", 99) > 1: fail(f"{name}: job limits must stay small (<=1 CPU, <=1 GiB)")
    ms = svc.get("mounts", [])
    if [m.get("mountPath") for m in ms] != list(mounts_expected): fail(f"{name}: mounts must be exactly {list(mounts_expected)}")
    for m in ms:
        check_keys(m, {"type", "mountPath", "content"}, name + ".mount", ("type", "mountPath", "content"))
        if m.get("type") != "file": fail(f"{name}: only file mounts allowed (no host paths)")
        c = m.get("content", "")
        if generated:
            if PLACEHOLDER.search(c): fail(f"{name}: unsubstituted placeholder inside mount {m.get('mountPath')}")
            want = {"/uplink/uplink_job.sh": os.path.join(TOOLS, "uplink_job.sh"), "/uplink/backup_audit.py": os.path.join(TOOLS, "backup_audit.py"),
                    "/uplink/audit_loop.sh": os.path.join(TOOLS, "audit_loop.sh")}.get(m.get("mountPath"))
            if want and c.encode() != open(want, "rb").read(): fail(f"{name}: {m['mountPath']} content differs from the repository file")
            if m.get("mountPath") == "/uplink/baseline.sql" and hashlib.sha256(c.encode()).hexdigest() != contract["baseline"]["sha256"]:
                fail(f"{name}: baseline mount content is not the approved baseline")

for fname, svcname, cmd, mounts in (
    ("04-uplink-baseline-import-job.template.json", "uplink-baseline-import", "sh /uplink/uplink_job.sh import", ("/uplink/uplink_job.sh", "/uplink/baseline.sql")),
    ("06-uplink-restore-verify-job.template.json", "uplink-restore-verify", "sh /uplink/uplink_job.sh verify", ("/uplink/uplink_job.sh",))):
    d = read_json(BASE, fname)
    if d: check_job_service(fname, d["input"]["schema"]["services"][0]["data"], svcname, cmd, mounts, False)
    if GEN:
        g = read_json(GEN, fname.replace(".template.json", ".createFromSchema.json"))
        if g: check_job_service("generated/" + fname, g["input"]["schema"]["services"][0]["data"], svcname, cmd, mounts, True)
    elif MODE == "final": fail(f"{fname}: final mode requires --generated DIR with the content-bearing file")

d = read_json(BASE, "05-uplink-restore-check-db.owner-ui-spec.json")
if d:
    db5 = d["service"]["data"]; check_keys(db5, PG_ALLOWED, "05.db", ("serviceName",))
    if "password" in db5: fail("05: password must not appear in any artifact")
    if db5.get("serviceName") != "uplink-restore-check": fail("05: serviceName must be uplink-restore-check")
    check_pg_image("05", db5.get("image", ""))
    if db5.get("exposedPort"): fail("05: no published port")
    if "backup" in db5: fail("05: the disposable target must not have its own backups")

d = read_json(BASE, "07-uplink-backup-audit-service.template.json")
if d:
    a7 = d["input"]["schema"]["services"][0]["data"]; check_keys(a7, APP_ALLOWED, "07.app", ("serviceName",))
    src = a7.get("source", {})
    if src.get("type") != "dockerfile": fail("07: source must be an EasyPanel-built inline Dockerfile")
    elif not re.search(r"^FROM python:3\.12-slim@sha256:(\{\{PYTHON_IMAGE_DIGEST_HEX\}\}|[0-9a-f]{64})$", src.get("dockerfile", "").split("\n")[0]): fail("07: Dockerfile base image must be pinned by digest")
    if "awscli==" not in src.get("dockerfile", ""): fail("07: awscli version must be pinned in the Dockerfile")
    for k in ("env", "domains", "ports"):
        if a7.get(k): fail(f"07: {k} must be absent")
    if [m.get("mountPath") for m in a7.get("mounts", [])] != ["/uplink/backup_audit.py", "/uplink/audit_loop.sh"]: fail("07: mounts must be the two audit files")

d = read_json(BASE, "08-uplink-backup-config.createDatabaseBackup.json")
if d:
    calls = d["calls"]
    if [c["procedure"] for c in calls] != ["createDatabaseBackup"] * 2: fail("08: two createDatabaseBackup calls required")
    want = {"uplink/daily": (14, "15 2 * * *"), "uplink/weekly": (8, "15 3 * * 0")}
    got = {}
    for c in calls:
        i = c["input"]
        check_keys(i, {"projectName", "serviceName", "databaseName", "enabled", "retention", "schedule", "storageProviderId", "storageProviderPath"}, "08.input", ("projectName", "serviceName", "databaseName", "enabled", "schedule", "storageProviderId", "storageProviderPath"))
        if i.get("serviceName") != "uplink-db" or i.get("projectName") != "uplink" or i.get("databaseName") != "uplink": fail("08: target must be uplink/uplink-db database uplink")
        if i.get("enabled") is not True: fail("08: backups must be enabled")
        if not re.fullmatch(r"[\w\-/.]+", i.get("storageProviderPath", "")): fail("08: bad storageProviderPath")
        got[i.get("storageProviderPath")] = (i.get("retention"), i.get("schedule"))
    if got != want: fail(f"08: daily/weekly entries must be {want}, got {got} (separate prefixes with count retention 14 and 8)")

for envf, must in (("job-import.env.template", ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD"]), ("audit.env.template", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "S3_ENDPOINT", "S3_BUCKET", "SERVICE_START"])):
    t = load(envf); scan_placeholders(envf, t, allow=("{{OWNER_ENTERS}}", "{{OWNER_STORAGE_REGION}}", "{{OWNER_STORAGE_ENDPOINT}}", "{{OWNER_STORAGE_BUCKET}}", "{{SERVICE_START_DATE}}"))
    kv = dict(ln.split("=", 1) for ln in t.splitlines() if ln.strip() and not ln.startswith("#") and "=" in ln)
    for k in must:
        if k not in kv: fail(f"{envf}: missing {k}")
    for k in ("PGPASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        if k in kv and kv[k] != "{{OWNER_ENTERS}}": fail(f"{envf}: {k} must carry only the OWNER_ENTERS marker")
    if envf == "job-import.env.template" and kv.get("PGHOST") != "uplink_uplink-db": fail("job-import.env.template: PGHOST must be the EasyPanel service host uplink_uplink-db")

# ---- secret hygiene: no long random-looking tokens, passwords or keys anywhere in the package ----
for fn in sorted(os.listdir(BASE)):
    txt = open(os.path.join(BASE, fn), encoding="utf-8").read()
    for m in re.finditer(r"[A-Za-z0-9+/=_-]{40,}", txt):
        s = m.group(0)
        if re.fullmatch(r"[0-9a-f]{64}", s) or "/" in s and not re.search(r"[0-9A-Za-z]{30}", s.replace("/", "")): continue
        if s.startswith(("ghcr.io", "postgres")) or "-" in s and re.fullmatch(r"[a-z0-9\-]+", s): continue
        if re.fullmatch(r"[0-9a-f]{40,}", s): continue
        if not (re.search(r"[A-Z]", s) and re.search(r"[a-z]", s) and re.search(r"\d", s)): continue   # random secrets mix cases and digits; config words do not
        fail(f"{fn}: long token-like string (possible secret): {s[:6]}...")
    if re.search(r"(?i)(password|secret|token)\"?\s*[:=]\s*\"[^\"{<]{8,}\"", txt): fail(f"{fn}: possible literal secret assignment")

print(f"mode={MODE} files={len(os.listdir(BASE))} failures={len(failures)} pending={len(pending)}")
for f in failures: print("FAIL", f)
for p in pending: print("PENDING", p)
sys.exit(1 if failures else 0)
