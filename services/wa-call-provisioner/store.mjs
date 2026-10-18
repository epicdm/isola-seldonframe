// Durable state for the provisioner: idempotent operations and per-resource leases with FENCING TOKENS. SQLite file (node:sqlite): a restart, a second
// process or a stalled holder all see the same rows. Every statement here is synchronous, so each claim is atomic.
import { DatabaseSync } from "node:sqlite";

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    create table if not exists ops (
      key text primary key, step text not null, state text not null,           -- state: claimed | writing | done | unknown | needs_review
      result text, error text, updated_at integer not null
    );
    create table if not exists locks (
      resource text primary key, owner text not null, token integer not null, expires_at integer not null
    );
  `);
  const q = (sql) => db.prepare(sql);
  const s = {
    getOp: q("select * from ops where key = ?"),
    insOp: q("insert or ignore into ops (key, step, state, updated_at) values (?, ?, 'claimed', ?)"),
    setOp: q("update ops set state = ?, result = ?, error = ?, updated_at = ? where key = ?"),
    getLock: q("select * from locks where resource = ?"),
    putLock: q("insert into locks (resource, owner, token, expires_at) values (?, ?, ?, ?) on conflict(resource) do update set owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at"),
    delLock: q("delete from locks where resource = ? and token = ?"),
    inFlight: q("select * from ops where state in ('writing','claimed','unknown')"),
  };
  return {
    claimOp(key, step, now) { s.insOp.run(key, step, now); return s.getOp.get(key); },
    getOp: (key) => s.getOp.get(key),
    setOp(key, state, result, error, now) { s.setOp.run(state, result == null ? null : JSON.stringify(result), error ?? null, now, key); },
    /** Atomic: takes the lease when free or expired; returns the new fencing token, or null when someone else holds an unexpired lease. */
    acquire(resource, owner, now, leaseMs) {
      db.exec("begin immediate");
      try {
        const cur = s.getLock.get(resource);
        if (cur && cur.expires_at > now) { db.exec("rollback"); return null; }
        const token = (cur?.token ?? 0) + 1;
        s.putLock.run(resource, owner, token, now + leaseMs);
        db.exec("commit");
        return { token, expiresAt: now + leaseMs };
      } catch (e) { try { db.exec("rollback"); } catch { /* */ } throw e; }
    },
    /** True only while THIS token is still the current holder and unexpired: re-checked immediately before every upstream write. */
    stillHolds(resource, token, now, needMs) { const cur = s.getLock.get(resource); return !!cur && cur.token === token && cur.expires_at - now >= needMs; },
    release(resource, token) { s.delLock.run(resource, token); },
    inFlight: () => s.inFlight.all(),
    close: () => db.close(),
    _db: db,
  };
}
