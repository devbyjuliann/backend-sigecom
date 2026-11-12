import assert from "node:assert/strict";
import test from "node:test";
import { createWarehouseService } from "../../src/modules/warehouses/warehouse-service.js";

function warehousePool({ blockingOrders = 0, hasStock = 0 } = {}) {
  const calls = [];
  let active = true;
  const warehouseRow = {
    id: "42",
    code: "BOD-42",
    name: "Bodega central",
    location: null,
    responsible_user_id: null,
    responsible_name: null,
    is_active: 1,
    created_at: "2026-11-11 12:00:00.000",
    updated_at: "2026-11-11 12:00:00.000",
  };
  const connection = {
    async beginTransaction() {
      calls.push({ kind: "begin" });
    },
    async commit() {
      calls.push({ kind: "commit" });
    },
    async rollback() {
      calls.push({ kind: "rollback" });
    },
    release() {
      calls.push({ kind: "release" });
    },
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (sql.includes("FROM warehouses AS w") && sql.includes("FOR UPDATE")) {
        return [[{ ...warehouseRow, is_active: Number(active) }]];
      }
      if (sql.includes("inventory_balances"))
        return [[{ has_stock: hasStock }]];
      if (sql.includes("FROM purchase_orders AS po")) {
        return [[{ blocking_orders: blockingOrders }]];
      }
      if (sql.startsWith("UPDATE warehouses SET is_active")) {
        active = Boolean(values[0]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO audit_events"))
        return [{ affectedRows: 1 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  return {
    calls,
    async getConnection() {
      return connection;
    },
    async execute(sql, values = []) {
      calls.push({ kind: "poolExecute", sql, values });
      if (sql.includes("FROM warehouses AS w")) {
        return [[{ ...warehouseRow, is_active: Number(active) }]];
      }
      throw new Error(`Consulta inesperada fuera de transacción: ${sql}`);
    },
  };
}

const request = { ip: "127.0.0.1", get: () => "unit-test" };

test("warehouse deactivation rejects and rolls back when receivable purchase orders remain", async () => {
  const dbPool = warehousePool({ blockingOrders: 2 });
  const service = createWarehouseService({ dbPool });

  await assert.rejects(
    service.setStatus({
      id: "42",
      isActive: false,
      userId: "7",
      request,
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "WAREHOUSE_HAS_PENDING_PURCHASES");
      assert.match(error.message, /2 órdenes de compra/);
      return true;
    },
  );

  assert.ok(dbPool.calls.some(({ kind }) => kind === "rollback"));
  assert.ok(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" && sql?.includes("FROM purchase_orders AS po"),
    ),
  );
  assert.equal(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" && sql?.includes("inventory_balances"),
    ),
    false,
    "las compras pendientes se informan antes de evaluar el saldo",
  );
  assert.equal(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" &&
        sql?.startsWith("UPDATE warehouses SET is_active"),
    ),
    false,
  );
  assert.equal(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" && sql?.includes("INSERT INTO audit_events"),
    ),
    false,
  );
});

test("warehouse deactivation allows resolved purchases and checks pending quantities without locking orders", async () => {
  const dbPool = warehousePool();
  const service = createWarehouseService({ dbPool });

  const result = await service.setStatus({
    id: "42",
    isActive: false,
    userId: "7",
    request,
  });

  assert.equal(result.isActive, false);
  const pendingCheck = dbPool.calls.find(
    ({ kind, sql }) =>
      kind === "execute" && sql?.includes("FROM purchase_orders AS po"),
  );
  assert.ok(pendingCheck, "consulta las compras dentro de la transacción");
  assert.doesNotMatch(pendingCheck.sql, /FOR UPDATE|LOCK IN SHARE MODE/i);
  assert.match(pendingCheck.sql, /po\.status\s*=\s*'confirmed'/i);
  assert.match(pendingCheck.sql, /closed_at\s+IS\s+NULL/i);
  assert.match(pendingCheck.sql, /purchase_receipt_lines/i);
  assert.match(pendingCheck.sql, /pol\.quantity\s*>/i);
  assert.deepEqual(pendingCheck.values, ["42"]);

  const transactionQueries = dbPool.calls.filter(
    ({ kind }) => kind === "execute",
  );
  assert.match(transactionQueries[0].sql, /FOR UPDATE/i);
  assert.match(transactionQueries[0].sql, /FROM warehouses AS w/i);
  const stockCheckIndex = transactionQueries.findIndex(({ sql }) =>
    sql.includes("inventory_balances"),
  );
  assert.ok(stockCheckIndex > transactionQueries.indexOf(pendingCheck));

  const warehouseLockIndex = dbPool.calls.findIndex(
    ({ kind, sql }) =>
      kind === "execute" &&
      sql?.includes("FROM warehouses AS w") &&
      sql.includes("FOR UPDATE"),
  );
  const pendingCheckIndex = dbPool.calls.indexOf(pendingCheck);
  assert.ok(warehouseLockIndex >= 0 && warehouseLockIndex < pendingCheckIndex);
  assert.ok(dbPool.calls.some(({ kind }) => kind === "commit"));
});

test("warehouse deactivation still rejects positive inventory after purchase obligations are resolved", async () => {
  const dbPool = warehousePool({ hasStock: 1 });
  const service = createWarehouseService({ dbPool });

  await assert.rejects(
    service.setStatus({
      id: "42",
      isActive: false,
      userId: "7",
      request,
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "WAREHOUSE_HAS_STOCK");
      return true;
    },
  );

  assert.ok(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" && sql?.includes("FROM purchase_orders AS po"),
    ),
  );
  assert.ok(dbPool.calls.some(({ kind }) => kind === "rollback"));
  assert.equal(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" &&
        sql?.startsWith("UPDATE warehouses SET is_active"),
    ),
    false,
  );
  assert.equal(
    dbPool.calls.some(
      ({ kind, sql }) =>
        kind === "execute" && sql?.includes("INSERT INTO audit_events"),
    ),
    false,
  );
});
