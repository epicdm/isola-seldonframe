import { describe, test } from "node:test";
import assert from "node:assert/strict";
import pg, { Client, Pool } from "../../../src/db/pg-browser-stub";

describe("browser pg boundary", () => {
  test("browser stub keeps pg's expected shape but fails closed if executed", () => {
    assert.equal(pg.Pool, Pool);
    assert.equal(pg.Client, Client);
    assert.throws(() => new Pool(), /pg is not available in the browser/);
    assert.throws(() => new Client(), /pg is not available in the browser/);
  });
});
