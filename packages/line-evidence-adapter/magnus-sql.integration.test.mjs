// Opt-in integration test of the SELECT-only database path against a SCRATCH MariaDB (never the production database).
// Required env: MAGNUS_SQL_TEST=scratch, MAGNUS_SQL_TEST_HOST/PORT, MAGNUS_SQL_TEST_RO_USER/RO_PASSWORD (the restricted account),
// MAGNUS_SQL_TEST_ROOT_PASSWORD (scratch admin, used only for the positive controls). Run: node --test magnus-sql.integration.test.mjs
//
// What it proves, each with a positive twin so that a refusal cannot be a broken harness:
//  - the real reader returns the facts through the restricted account (TLS);
//  - the engine refuses every write, DDL, other table, other column, SELECT *, file output and privilege change;
//  - the account cannot connect without TLS;
//  - an admin account CAN do the things the restricted one cannot (so the denial tests are not vacuous).
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { makeMysqlQuery, sqlSource } from "./magnus-sql.mjs";
import { readMagnusFrom } from "./evidence.mjs";

const e = process.env;
const enabled = e.MAGNUS_SQL_TEST === "scratch" && e.MAGNUS_SQL_TEST_HOST && /^zz-|^127\.|^localhost$|^172\.(1[6-9]|2\d|3[01])\./.test(e.MAGNUS_SQL_TEST_HOST);
const DID = "15550100001";

describe("option B: SELECT-only Magnus database account", { skip: !enabled && "set MAGNUS_SQL_TEST=scratch and the MAGNUS_SQL_TEST_* variables (scratch host only)" }, () => {
  let mysql, ro, admin;
  const base = () => ({ host: e.MAGNUS_SQL_TEST_HOST, port: Number(e.MAGNUS_SQL_TEST_PORT || 3306), database: "mbilling" });
  const tls = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
  const code = async (p) => { try { await p; return "OK"; } catch (err) { return err.code || String(err.message); } };

  before(async () => {
    mysql = await import("mysql2/promise");
    ro = await mysql.createConnection({ ...base(), user: e.MAGNUS_SQL_TEST_RO_USER, password: e.MAGNUS_SQL_TEST_RO_PASSWORD, ssl: tls, dateStrings: true });
    admin = await mysql.createConnection({ ...base(), user: "root", password: e.MAGNUS_SQL_TEST_ROOT_PASSWORD, ssl: tls });
  });
  after(async () => { await ro?.end(); await admin?.end(); });

  test("POSITIVE: the real reader returns the facts through the restricted account over TLS", async () => {
    const query = await makeMysqlQuery({ ...base(), user: e.MAGNUS_SQL_TEST_RO_USER, password: e.MAGNUS_SQL_TEST_RO_PASSWORD });
    const r = await readMagnusFrom(sqlSource(query), DID);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.destination.kind, "pjsip_trunk");
    assert.equal(r.destination.value, "PJSIP/15550100001@pbx-trunk");
    assert.equal(r.did.reserved, true);
    assert.equal(r.lastCalls[0].startedAt, "2026-10-17T12:57:27.000Z");
    assert.equal(r.lastCalls[0].answered, true);
    assert.equal(r.lastCalls.length, 2);
    await query.end();
  });

  test("a number that exists only for another customer is simply not found (no cross-number leakage through the query)", async () => {
    const query = await makeMysqlQuery({ ...base(), user: e.MAGNUS_SQL_TEST_RO_USER, password: e.MAGNUS_SQL_TEST_RO_PASSWORD });
    const r = await readMagnusFrom(sqlSource(query), "15550100999");
    assert.equal(r.ok, true); assert.equal(r.did, null); assert.deepEqual(r.lastCalls, []);
    await query.end();
  });

  test("the engine refuses writes to the granted tables (control: the admin account can write the same rows)", async () => {
    for (const q of [
      "INSERT INTO pkg_did (id, did, activated, reserved) VALUES (9001, '15550100777', 1, 0)",
      "UPDATE pkg_did SET reserved = 0 WHERE did = '15550100001'",
      "DELETE FROM pkg_did_destination WHERE id_did = 20",
      "UPDATE pkg_cdr SET sessiontime = 99 WHERE calledstation = '15550100001'",
    ]) assert.match(await code(ro.query(q)), /ER_(TABLE|COLUMN)ACCESS_DENIED_ERROR|ER_DBACCESS|1142|1143/, q);
    assert.equal(await code(admin.query("INSERT INTO pkg_did (id, did, activated, reserved, id_user, fixrate) VALUES (9001, '15550100777', 1, 0, 0, 0)")), "OK");
    assert.equal(await code(admin.query("DELETE FROM pkg_did WHERE id = 9001")), "OK");
  });

  test("DDL, file output, privilege changes and other schemas are refused", async () => {
    for (const q of [
      "CREATE TABLE zz_probe (a int)", "DROP TABLE pkg_cdr", "ALTER TABLE pkg_did ADD COLUMN x int", "TRUNCATE pkg_cdr",
      "SELECT did FROM pkg_did INTO OUTFILE '/tmp/zz-out.txt'", "GRANT ALL ON *.* TO 'x'@'%'", "CREATE USER 'zz'@'%'", "SET GLOBAL read_only = 0",
    ]) assert.notEqual(await code(ro.query(q)), "OK", q);
    assert.notEqual(await code(ro.query("SELECT user FROM mysql.user")), "OK");
    assert.equal(await code(admin.query("SELECT user FROM mysql.user")), "OK"); // control
  });

  test("unrelated data is unreachable: other tables, other columns of the granted tables, and SELECT *", async () => {
    for (const q of [
      "SELECT username, password FROM pkg_user", "SELECT * FROM pkg_user",
      "SELECT id_user FROM pkg_did", "SELECT fixrate, connection_charge FROM pkg_did", "SELECT * FROM pkg_did",
      "SELECT callerid FROM pkg_cdr", "SELECT * FROM pkg_cdr", "SELECT sessionbill FROM pkg_cdr",
      "SELECT secret FROM pkg_sip", "SELECT password FROM pkg_user", "SELECT credit FROM pkg_user",
    ]) assert.match(await code(ro.query(q)), /1142|1143|ER_(TABLE|COLUMN)ACCESS_DENIED_ERROR/, q);
    // controls: the granted columns work for the restricted account, and the admin account can read the sensitive ones
    assert.equal(await code(ro.query("SELECT id, did, activated, reserved FROM pkg_did LIMIT 1")), "OK");
    assert.equal(await code(admin.query("SELECT username, password FROM pkg_user LIMIT 1")), "OK");
    assert.equal(await code(admin.query("SELECT id_user, fixrate FROM pkg_did LIMIT 1")), "OK");
  });

  test("the account cannot connect without TLS (control: with TLS it connects)", async () => {
    const plain = await code(mysql.createConnection({ ...base(), user: e.MAGNUS_SQL_TEST_RO_USER, password: e.MAGNUS_SQL_TEST_RO_PASSWORD, ssl: undefined }).then((c) => c.end()));
    assert.match(plain, /ER_ACCESS_DENIED_ERROR|1045|ER_SECURE_TRANSPORT_REQUIRED/);
    assert.equal(await code(mysql.createConnection({ ...base(), user: e.MAGNUS_SQL_TEST_RO_USER, password: e.MAGNUS_SQL_TEST_RO_PASSWORD, ssl: tls }).then((c) => c.end())), "OK");
  });

  test("the session is read only and the reader's connection reports TLS", async () => {
    const [[row]] = await ro.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.ok(row.Value, "TLS cipher negotiated");
    const [grants] = await ro.query("SHOW GRANTS");
    const text = grants.map((g) => Object.values(g)[0]).join("\n");
    assert.ok(!/ALL PRIVILEGES|WITH GRANT OPTION/i.test(text), text);
    assert.match(text, /REQUIRE SSL/i);
    for (const t of text.split("\n").filter((l) => /^GRANT (?!USAGE)/.test(l))) {
      assert.match(t, /^GRANT SELECT \(/, `only column-level SELECT: ${t}`);
      assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|INDEX|EXECUTE|FILE|PROCESS|SUPER|ALL)\b/i.test(t.replace(/`[^`]*`/g, "")), `no other privilege letters: ${t}`);
    }
    const tables = [...text.matchAll(/ON `mbilling`\.`(\w+)`/g)].map((m) => m[1]).sort();
    assert.deepEqual(tables, ["pkg_cdr", "pkg_did", "pkg_did_destination"], "grants cover exactly the three tables");
  });
});
