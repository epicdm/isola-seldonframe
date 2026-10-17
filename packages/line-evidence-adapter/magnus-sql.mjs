// Option B Magnus source: a database account that can only SELECT a handful of columns, so "read-only" is enforced by the
// database engine and not by this code. The three statements below are the ONLY SQL this service can run: constants, with every
// value passed as a bound parameter. There is no function here that accepts SQL text from a caller.
//
// The database account (created by staff, never by this code) needs exactly these column grants and nothing else:
//   pkg_did(id, did, activated, reserved)
//   pkg_did_destination(id_did, destination, id_sip, activated)
//   pkg_cdr(calledstation, starttime, sessiontime, terminatecauseid)
// and should be created REQUIRE SSL, from the single source address the SSH forward arrives from.

export const SQL = Object.freeze({
  did: "SELECT id, did, activated, reserved FROM pkg_did WHERE did = ? LIMIT 6",
  destinations: "SELECT id_did, destination, id_sip, activated FROM pkg_did_destination WHERE id_did = ? LIMIT 5",
  calls: "SELECT calledstation, starttime, sessiontime, terminatecauseid FROM pkg_cdr WHERE calledstation = ? ORDER BY starttime DESC LIMIT 5",
});

export function sqlSource(query) {
  return {
    did: (did) => query(SQL.did, [String(did)]),
    destinations: (idDid) => query(SQL.destinations, [Number(idDid)]),
    calls: (did) => query(SQL.calls, [String(did)]),
  };
}

// Lazy import so the REST/test paths never need the driver. `db` = {host, port, user, password, database, ca?}.
export async function makeMysqlQuery(db, importer = () => import("mysql2/promise")) {
  const mysql = await importer();
  const pool = mysql.createPool({
    host: db.host,
    port: db.port ?? 3306,
    user: db.user,
    password: db.password,
    database: db.database ?? "mbilling",
    // TLS is mandatory. Over the SSH forward the server name is not the certificate name, so identity comes from the pinned SSH host
    // key and the permitopen-restricted forward; set MAGNUS_DB_CA to also verify the server certificate.
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: Boolean(db.ca), ...(db.ca ? { ca: db.ca } : {}) },
    connectionLimit: 2,
    connectTimeout: 5000,
    dateStrings: true, // keep pkg_cdr.starttime as the raw UTC string; toIso() interprets it
    multipleStatements: false,
  });
  pool.on("connection", (c) => { c.query("SET SESSION TRANSACTION READ ONLY"); });
  const query = async (text, params) => {
    const [rows] = await pool.execute({ sql: text, timeout: 8000 }, params);
    return Array.isArray(rows) ? rows : [];
  };
  query.end = () => pool.end();
  return query;
}
