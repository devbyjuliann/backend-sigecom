import assert from "node:assert/strict";
import { test } from "node:test";
import { getMigrations } from "../../src/db/migrations.js";

test("loads versioned migrations in order with stable checksums", async () => {
  const migrations = await getMigrations();

  assert.deepEqual(
    migrations.map(({ version }) => version),
    [
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
    ],
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

  const purchases = migrations.find(({ version }) => version === "0010").sql;
  for (const table of [
    "purchase_orders",
    "purchase_order_lines",
    "purchase_receipts",
    "purchase_receipt_lines",
  ]) {
    assert.match(
      purchases,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"),
    );
  }
  assert.match(purchases, /DECIMAL\(15,2\)/i);
  assert.match(purchases, /source_operation_id/i);

  const purchasePermissions = migrations.find(
    ({ version }) => version === "0011",
  ).sql;
  assert.match(purchasePermissions, /purchases\.receive/i);
  assert.match(purchasePermissions, /warehouse/i);

  const purchaseCommercialCode = migrations.find(
    ({ version }) => version === "0012",
  ).sql;
  assert.match(
    purchaseCommercialCode,
    /ADD COLUMN commercial_code VARCHAR\(40\)/i,
  );
  assert.match(purchaseCommercialCode, /CONCAT\('OC-', LPAD/i);
  assert.match(
    purchaseCommercialCode,
    /UNIQUE KEY uq_purchase_orders_commercial_code/i,
  );

  const purchaseClosures = migrations.find(
    ({ version }) => version === "0013",
  ).sql;
  assert.match(purchaseClosures, /closure_reason VARCHAR\(500\)/i);
  assert.match(purchaseClosures, /closure_idempotency_key/i);
  assert.match(purchaseClosures, /closure_request_hash/i);
  assert.match(purchaseClosures, /purchases\.close/i);
  assert.match(purchaseClosures, /role\.code = 'administrator'/i);

  const supplierReturns = migrations.find(
    ({ version }) => version === "0014",
  ).sql;
  for (const table of ["supplier_returns", "supplier_return_lines"]) {
    assert.match(
      supplierReturns,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"),
    );
  }
  assert.match(supplierReturns, /uq_supplier_returns_receipt_reference/i);
  assert.match(supplierReturns, /uq_supplier_returns_actor_idempotency/i);
  assert.match(supplierReturns, /source_operation_id/i);
  assert.match(supplierReturns, /purchase_receipt_line_id/i);

  const sales = migrations.find(({ version }) => version === "0015").sql;
  for (const table of ["sales", "sale_lines", "sale_requests"]) {
    assert.match(sales, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }
  assert.match(sales, /ENUM\('draft', 'confirmed', 'cancelled'\)/i);
  assert.match(sales, /customer_name_snapshot/i);
  assert.match(sales, /product_name_snapshot/i);
  assert.match(sales, /DECIMAL\(22,2\)/i);
  assert.match(sales, /UNIQUE KEY uq_sale_lines_product/i);
  assert.match(sales, /UNIQUE KEY uq_sale_requests_actor_key/i);
  assert.doesNotMatch(sales, /CREATE TABLE IF NOT EXISTS inventory_/i);
});
