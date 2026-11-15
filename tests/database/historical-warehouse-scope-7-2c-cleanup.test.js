import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countOwnedRows,
  deleteOwnedRows,
} from "../integration/historical-warehouse-scope-7-2c-cleanup.js";

test("limpieza 7.2C omite deletes y conteos cuando no hay IDs propios", async () => {
  const calls = [];
  const dbPool = {
    async execute(...args) {
      calls.push(args);
      return [{ affectedRows: 1 }];
    },
  };

  assert.equal(await deleteOwnedRows(dbPool, "sales", "id", []), 0);
  assert.equal(await countOwnedRows(dbPool, "users", "id", []), 0);
  assert.deepEqual(calls, []);
});

test("limpieza 7.2C usa solo IDs propios parametrizados en preparaciones parciales", async () => {
  const calls = [];
  const dbPool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("DELETE")) return [{ affectedRows: 1 }];
      return [[{ total: 1 }]];
    },
  };
  const ownUserIds = ["412", "413"];

  assert.equal(await deleteOwnedRows(dbPool, "users", "id", ownUserIds), 1);
  assert.equal(await countOwnedRows(dbPool, "sales", "id", ["871"]), 1);
  assert.deepEqual(calls, [
    {
      sql: "DELETE FROM users WHERE id IN (?,?)",
      values: ownUserIds,
    },
    {
      sql: "SELECT COUNT(*) AS total FROM sales WHERE id IN (?)",
      values: ["871"],
    },
  ]);
  assert.ok(calls.every(({ sql }) => !sql.includes("IN ()")));
});

test("limpieza 7.2C rechaza identificadores SQL que no están permitidos", async () => {
  const dbPool = {
    async execute() {
      assert.fail("No debe ejecutar SQL con identificadores no permitidos.");
    },
  };

  await assert.rejects(
    deleteOwnedRows(dbPool, "users; DROP TABLE users", "id", ["1"]),
    TypeError,
  );
});
