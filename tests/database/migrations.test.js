import assert from "node:assert/strict";
import { test } from "node:test";
import { getMigrations } from "../../src/db/migrations.js";

test("loads versioned migrations in order with stable checksums", async () => {
  const migrations = await getMigrations();

  assert.deepEqual(
    migrations.map(({ version }) => version),
    ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009"],
  );
  for (const migration of migrations) {
    assert.match(migration.name, /^[a-z0-9-]+$/);
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(migration.sql.trim().length > 0);
    assert.doesNotMatch(
      migration.sql,
      /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i,
    );
  }

  const inventory = migrations.find(({ version }) => version === "0007").sql;
  assert.match(inventory, /version BIGINT UNSIGNED NOT NULL DEFAULT 0/i);
  assert.match(inventory, /CREATE TABLE IF NOT EXISTS inventory_operations/i);
  assert.match(inventory, /CREATE TABLE IF NOT EXISTS inventory_movements/i);
  assert.match(
    inventory,
    /FOREIGN KEY \(product_id, warehouse_id, balance_version\)/i,
  );
  assert.match(inventory, /UNIQUE KEY uq_inventory_movements_balance_version/i);

  const permissions = migrations.find(({ version }) => version === "0008").sql;
  assert.match(permissions, /inventory\.movements\.read/i);
  assert.match(permissions, /inventory\.initialize/i);

  const history = migrations.find(({ version }) => version === "0009").sql;
  assert.match(
    history,
    /DROP FOREIGN KEY fk_inventory_movements_balance_version/i,
  );
  assert.match(history, /FOREIGN KEY \(product_id, warehouse_id\)/i);
});
