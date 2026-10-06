#!/usr/bin/env python3
"""Backup restore-point audit (r3). Stdlib only. Counts SUCCESSFUL restore points; an expiry period alone is not evidence.

usage: backup_audit.py --listing FILE [--now ISO8601] [--service-start YYYY-MM-DD]
                       [--daily-prefix uplink/daily/] [--weekly-prefix uplink/weekly/]
                       [--daily-need 14] [--weekly-need 8] [--min-bytes 20000]
                       [--ttl-sim DAYS] [--prune-plan] [--selftest]
FILE is JSON: a list of {"Key","LastModified","Size"} or {"Contents": [...]} (shape of `aws s3api list-objects-v2`).
Exit 0 = every requirement met, 1 = at least one ALERT, 2 = usage/input error. Never deletes anything; --prune-plan only prints candidates.
Rules:
  * a restore point = an object under the prefix with Size >= --min-bytes (empty/tiny objects are failed backups, not points);
  * daily points = distinct UTC days with a good object; weekly points = distinct ISO weeks with a good object;
  * required counts are min(need, elapsed periods since --service-start) so a young system is not falsely failed;
  * ALERT missing-job: newest good daily older than 26 h, newest good weekly older than 8 days;
  * ALERT gap: a missing calendar day between the newest daily point and (need) days back;
  * --ttl-sim shows how many points would remain if ONLY an age-based expiry ran after the given outage (why TTL is not retention);
  * --prune-plan keeps the newest N good points per class and lists older objects as candidates ONLY when N good points exist.
"""
import argparse, datetime as dt, json, sys

def parse_time(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)

def load(path):
    d = json.load(open(path))
    items = d["Contents"] if isinstance(d, dict) else d
    out = []
    for o in items or []:
        out.append({"Key": o["Key"], "T": parse_time(o["LastModified"]), "Size": int(o["Size"])})
    return out

def points(objs, prefix, min_bytes, weekly):
    good = [o for o in objs if o["Key"].startswith(prefix) and o["Size"] >= min_bytes]
    bad = [o for o in objs if o["Key"].startswith(prefix) and o["Size"] < min_bytes]
    keyf = (lambda o: o["T"].isocalendar()[:2]) if weekly else (lambda o: o["T"].date())
    byk = {}
    for o in sorted(good, key=lambda o: o["T"], reverse=True):
        byk.setdefault(keyf(o), o)
    return byk, bad, good

def audit(objs, now, start, a):
    res = {"alerts": [], "notes": []}
    ds = (now.date() - start).days if start else a.daily_need
    ws = ((now.date() - start).days // 7) if start else a.weekly_need
    need_d = min(a.daily_need, max(ds, 0)); need_w = min(a.weekly_need, max(ws, 0))
    dpts, dbad, dgood = points(objs, a.daily_prefix, a.min_bytes, False)
    wpts, wbad, wgood = points(objs, a.weekly_prefix, a.min_bytes, True)
    horizon = now.date() - dt.timedelta(days=a.daily_need + 1)
    drecent = sorted(k for k in dpts if k >= horizon)
    res.update(daily_points=len(drecent), daily_need=need_d, weekly_points=len(wpts), weekly_need=need_w,
               invalid_objects=len(dbad) + len(wbad))
    if len(drecent) < need_d: res["alerts"].append(f"daily restore points {len(drecent)} < required {need_d}")
    if len(wpts) < need_w: res["alerts"].append(f"weekly restore points {len(wpts)} < required {need_w}")
    if dgood:
        age = now - max(o["T"] for o in dgood)
        res["newest_daily_age_h"] = round(age.total_seconds() / 3600, 1)
        if age > dt.timedelta(hours=26): res["alerts"].append(f"missing-job: newest daily backup is {res['newest_daily_age_h']} h old (> 26 h)")
    elif need_d > 0: res["alerts"].append("missing-job: no good daily backup exists")
    if wgood:
        age = now - max(o["T"] for o in wgood)
        res["newest_weekly_age_h"] = round(age.total_seconds() / 3600, 1)
        if age > dt.timedelta(days=8): res["alerts"].append(f"missing-job: newest weekly backup is {res['newest_weekly_age_h']} h old (> 8 d)")
    elif need_w > 0: res["alerts"].append("missing-job: no good weekly backup exists")
    if drecent and need_d:
        newest = max(drecent); span = [newest - dt.timedelta(days=i) for i in range(need_d)]
        missing = [str(d) for d in span if d not in dpts]
        if missing: res["alerts"].append(f"gap: missing daily day(s) {', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}")
    if dbad or wbad: res["notes"].append(f"{len(dbad) + len(wbad)} object(s) below --min-bytes are failed backups and are not counted")
    return res, (dpts, wpts, dgood, wgood)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--listing"); p.add_argument("--now"); p.add_argument("--service-start")
    p.add_argument("--daily-prefix", default="uplink/daily/"); p.add_argument("--weekly-prefix", default="uplink/weekly/")
    p.add_argument("--daily-need", type=int, default=14); p.add_argument("--weekly-need", type=int, default=8)
    p.add_argument("--min-bytes", type=int, default=20000); p.add_argument("--ttl-sim", type=int)
    p.add_argument("--prune-plan", action="store_true"); p.add_argument("--selftest", action="store_true")
    a = p.parse_args()
    if a.selftest: return selftest()
    if not a.listing: p.error("--listing required")
    try:
        objs = load(a.listing)
        now = parse_time(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
        start = dt.date.fromisoformat(a.service_start) if a.service_start else None
    except Exception as e:
        print("input error:", e); return 2
    res, (dpts, wpts, dgood, wgood) = audit(objs, now, start, a)
    print(json.dumps({k: v for k, v in res.items()}, sort_keys=True))
    if a.ttl_sim is not None:
        cutoff = now - dt.timedelta(days=a.ttl_sim)
        kept = [o for o in objs if o["T"] >= cutoff]
        r2, _ = audit(kept, now, start, a)
        print(f"TTL-SIM only age-expiry of {a.ttl_sim} d: daily points {r2['daily_points']} (need {r2['daily_need']}), weekly points {r2['weekly_points']} (need {r2['weekly_need']})")
    if a.prune_plan:
        for label, pts, need, good in (("daily", dpts, a.daily_need, dgood), ("weekly", wpts, a.weekly_need, wgood)):
            keep = sorted(pts.values(), key=lambda o: o["T"], reverse=True)[:need]
            if len(keep) < need: print(f"PRUNE {label}: only {len(keep)} good points (< {need}); NO deletion candidates"); continue
            keepkeys = {o["Key"] for o in keep}
            cands = [o["Key"] for o in good if o["Key"] not in keepkeys and o["T"] < min(k["T"] for k in keep)]
            print(f"PRUNE {label}: keep newest {need} points; {len(cands)} candidate(s) (dry-run, nothing deleted)")
            for k in cands[:20]: print("  candidate", k)
    for al in res["alerts"]: print("ALERT", al)
    for n in res["notes"]: print("NOTE", n)
    print("AUDIT", "FAIL" if res["alerts"] else "PASS")
    return 1 if res["alerts"] else 0

def selftest():
    T = dt.datetime(2026, 10, 30, 3, 0, tzinfo=dt.timezone.utc)
    def obj(prefix, t, size=300000): return {"Key": f"{prefix}{t:%Y%m%dT%H%M}.dump", "LastModified": t.isoformat(), "Size": size}
    def listing(daily_days, weekly_weeks, last_daily=None, size=300000):
        L = []
        for i in daily_days: L.append(obj("uplink/daily/", (T - dt.timedelta(days=i)).replace(hour=2, minute=15), size))
        for i in weekly_weeks: L.append(obj("uplink/weekly/", (T - dt.timedelta(days=i * 7)).replace(hour=3, minute=15), size))
        return L
    import tempfile, os
    def run(L, extra=()):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(L, f); f.close()
        a = argparse.Namespace(daily_prefix="uplink/daily/", weekly_prefix="uplink/weekly/", daily_need=14, weekly_need=8, min_bytes=20000)
        for k, v in dict(extra).items(): setattr(a, k, v)
        r, _ = audit(load(f.name), T, dt.date(2026, 8, 1), a); os.unlink(f.name); return r
    fails = 0
    def check(label, cond):
        nonlocal fails
        print(("PASS" if cond else "FAIL"), label); fails += 0 if cond else 1
    ok = run(listing(range(0, 14), range(0, 8)))
    check("positive control: 14 daily + 8 weekly good points -> no alerts", not ok["alerts"] and ok["daily_points"] >= 14 and ok["weekly_points"] == 8)
    check("one missing day is reported as a gap and a shortfall", any("gap" in x for x in run(listing([d for d in range(0, 15) if d != 5], range(0, 8)))["alerts"]))
    check("only 13 daily points -> shortfall alert", any("daily restore points" in x for x in run(listing(range(0, 13), range(0, 8)))["alerts"]))
    check("only 7 weekly points -> shortfall alert", any("weekly restore points" in x for x in run(listing(range(0, 14), range(0, 7)))["alerts"]))
    check("stale newest daily (3 days) -> missing-job alert", any("missing-job" in x for x in run(listing(range(3, 17), range(0, 8)))["alerts"]))
    zero = run(listing(range(0, 14), range(0, 8), size=0))
    check("zero-byte objects are NOT restore points (all failed backups)", len(zero["alerts"]) >= 2 and zero["invalid_objects"] == 22)
    # TTL is not retention: simulate an outage, then an age-only 14d/56d expiry
    outage = listing(range(20, 34), range(3, 11))
    a = argparse.Namespace(daily_prefix="uplink/daily/", weekly_prefix="uplink/weekly/", daily_need=14, weekly_need=8, min_bytes=20000)
    cut = T - dt.timedelta(days=14); kept = [o for o in load_from(outage) if o["T"] >= cut]
    r, _ = audit(kept, T, dt.date(2026, 8, 1), a)
    check("TTL-only expiry after a 20-day outage leaves ZERO daily restore points (why TTL is not a count)", r["daily_points"] == 0)
    young = run(listing(range(0, 3), range(0, 1)), {})
    a2 = argparse.Namespace(daily_prefix="uplink/daily/", weekly_prefix="uplink/weekly/", daily_need=14, weekly_need=8, min_bytes=20000)
    ry, _ = audit(load_from(listing(range(0, 3), range(0, 1))), T, dt.date(2026, 10, 27), a2)
    check("young system (3 days old) needs only 3 daily points", ry["daily_need"] == 3 and not ry["alerts"])
    # prune plan never reduces below the requirement
    import io, contextlib
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(listing(range(0, 20), range(0, 12)), f); f.close()
    buf = io.StringIO()
    sys.argv = ["x", "--listing", f.name, "--now", T.isoformat(), "--prune-plan", "--service-start", "2026-08-01"]
    with contextlib.redirect_stdout(buf): rc = main()
    check("prune plan on 20 daily/12 weekly keeps newest 14/8 and lists candidates", "PRUNE daily: keep newest 14 points; 6 candidate" in buf.getvalue() and "PRUNE weekly: keep newest 8 points; 4 candidate" in buf.getvalue())
    f2 = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(listing(range(0, 10), range(0, 5)), f2); f2.close()
    buf = io.StringIO(); sys.argv = ["x", "--listing", f2.name, "--now", T.isoformat(), "--prune-plan", "--service-start", "2026-08-01"]
    with contextlib.redirect_stdout(buf): main()
    check("prune plan refuses to propose deletions below the requirement", "NO deletion candidates" in buf.getvalue() and "candidate " not in buf.getvalue().replace("candidate(s)", ""))
    os.unlink(f.name); os.unlink(f2.name)
    print(f"SUMMARY selftest failed={fails}"); return 1 if fails else 0

def load_from(L):
    return [{"Key": o["Key"], "T": parse_time(o["LastModified"]), "Size": int(o["Size"])} for o in L]

if __name__ == "__main__":
    sys.exit(main())
