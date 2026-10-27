import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createDatabasePool } from "../../src/db/pool.js";
import { createInventoryEngine } from "../../src/modules/inventory/inventory-engine.js";
import { createInventoryService } from "../../src/modules/inventory/inventory-service.js";
import { createProductService } from "../../src/modules/products/product-service.js";

const suffix = randomBytes(6).toString("hex").toUpperCase();
let pool;
let engine;
let userId;
let categoryId;
let warehouseId;
let productId;

function initialPayload(quantity = 8) {
  return {
    type: "initial_stock",
    sourceWarehouseId: warehouseId,
    destinationWarehouseId: null,
    reason: "Conteo físico de apertura de pruebas",
    reference: `ACTA-${suffix}`,
    lines: [{ productId, quantity }],
  };
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  engine = createInventoryEngine({ dbPool: pool });

  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'administrator'",
  );
  const [user] = await pool.execute(
    `INSERT INTO users (role_id, email, password_hash)
     VALUES (?, ?, 'inventory-engine-test-hash')`,
    [role.id, `inventory-engine-${suffix}@sigecom.invalid`],
  );
  userId = String(user.insertId);
  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Inventario ${suffix}`],
  );
  categoryId = String(category.insertId);
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`INV-${suffix}`, `Bodega inventario ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [userId, warehouseId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price, minimum_stock)
     VALUES (?, ?, ?, 'unidad', 100.00, 150.00, 3)`,
    [`INV-${suffix}`, `Producto inventario ${suffix}`, categoryId],
  );
  productId = String(product.insertId);
});

after(async () => {
  if (pool) await pool.end();
});

test("internal ledger operations are atomic, versioned and idempotent", async () => {
  const key = `initial-${suffix}`;
  const created = await engine.createOperation({
    userId,
    idempotencyKey: key,
    payload: initialPayload(),
  });
  assert.equal(created.replayed, false);
  assert.equal(created.movements[0].balanceBefore, 0);
  assert.equal(created.movements[0].balanceAfter, 8);
  assert.equal(created.movements[0].balanceVersion, "1");

  const replay = await engine.createOperation({
    userId,
    idempotencyKey: key,
    payload: initialPayload(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operationId, created.operationId);
  assert.equal(replay.movements.length, 1);

  await assert.rejects(
    engine.createOperation({
      userId,
      idempotencyKey: key,
      payload: initialPayload(9),
    }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );

  const adjusted = await engine.createOperation({
    userId,
    idempotencyKey: `out-${suffix}`,
    payload: {
      type: "adjustment_out",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Conteo de verificación",
      reference: null,
      lines: [{ productId, quantity: 8, expectedVersion: "1" }],
    },
  });
  assert.equal(adjusted.movements[0].balanceAfter, 0);

  await assert.rejects(
    engine.createOperation({
      userId,
      idempotencyKey: `underflow-${suffix}`,
      payload: {
        type: "adjustment_out",
        sourceWarehouseId: warehouseId,
        destinationWarehouseId: null,
        reason: "No debe quedar negativo",
        reference: null,
        lines: [{ productId, quantity: 1, expectedVersion: "2" }],
      },
    }),
    (error) => error.code === "INSUFFICIENT_STOCK",
  );

  const [[balance]] = await pool.execute(
    `SELECT quantity, version FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  assert.equal(balance.quantity, 0);
  assert.equal(String(balance.version), "2");
  const [[count]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM inventory_movements
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  assert.equal(Number(count.total), 2);
});

test("an outer transaction remains owned by its caller", async () => {
  const [product] = await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`ROLL-${suffix}`, `Producto rollback ${suffix}`, categoryId],
  );
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await engine.applyWithinTransaction({
      connection,
      userId,
      idempotencyKey: `rollback-${suffix}`,
      payload: {
        ...initialPayload(4),
        lines: [{ productId: String(product.insertId), quantity: 4 }],
      },
    });
    await connection.rollback();
  } finally {
    connection.release();
  }
  const [[counts]] = await pool.execute(
    `SELECT
      (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ?) AS balances,
      (SELECT COUNT(*) FROM inventory_operations WHERE created_by = ? AND idempotency_key = ?) AS operations,
      (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) AS movements`,
    [
      String(product.insertId),
      userId,
      `rollback-${suffix}`,
      String(product.insertId),
    ],
  );
  assert.deepEqual(
    [
      Number(counts.balances),
      Number(counts.operations),
      Number(counts.movements),
    ],
    [0, 0, 0],
  );
});

test("an audit insert failure leaves rollback responsibility with the caller", async () => {
  const [product] = await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`AUD-${suffix}`, `Producto auditoría ${suffix}`, categoryId],
  );
  const auditProductId = String(product.insertId);
  const connection = await pool.getConnection();
  const execute = connection.execute.bind(connection);
  try {
    await connection.beginTransaction();
    connection.execute = async (sql, values) => {
      if (String(sql).includes("INSERT INTO audit_events")) {
        throw new Error("injected audit write failure");
      }
      return execute(sql, values);
    };
    await assert.rejects(
      engine.applyWithinTransaction({
        connection,
        userId,
        idempotencyKey: `audit-failure-${suffix}`,
        payload: {
          ...initialPayload(5),
          lines: [{ productId: auditProductId, quantity: 5 }],
        },
      }),
      /injected audit write failure/,
    );
    await connection.rollback();
  } finally {
    connection.release();
  }
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_operations WHERE created_by = ? AND idempotency_key = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) AS movements,
       (SELECT COUNT(*) FROM audit_events WHERE entity_type = 'inventory_operation'
          AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.operationId')) IN (
            SELECT CAST(id AS CHAR) FROM inventory_operations
            WHERE created_by = ? AND idempotency_key = ?
          )) AS auditEvents`,
    [
      auditProductId,
      userId,
      `audit-failure-${suffix}`,
      auditProductId,
      userId,
      `audit-failure-${suffix}`,
    ],
  );
  assert.deepEqual(
    [
      Number(counts.balances),
      Number(counts.operations),
      Number(counts.movements),
      Number(counts.auditEvents),
    ],
    [0, 0, 0, 0],
  );
});

test("a product unit cannot change after inventory history exists", async () => {
  const [products] = await pool.execute(
    `SELECT sku, name, description, category_id, purchase_price, sale_price,
            minimum_sale_quantity, minimum_sale_enabled, minimum_stock, is_active
     FROM products WHERE id = ?`,
    [productId],
  );
  const current = products[0];
  const productService = createProductService({ dbPool: pool });
  await assert.rejects(
    productService.update({
      id: productId,
      userId,
      input: {
        sku: current.sku,
        name: current.name,
        description: current.description,
        categoryId,
        unit: "caja",
        purchasePrice: String(current.purchase_price),
        salePrice: String(current.sale_price),
        minimumSaleQuantity: null,
        minimumSaleEnabled: false,
        minimumStock: Number(current.minimum_stock),
        isActive: Boolean(current.is_active),
      },
    }),
    (error) => error.code === "PRODUCT_UNIT_HAS_INVENTORY_HISTORY",
  );
});

test("simultaneous operations use independent connections and reject a stale version", async () => {
  const [product] = await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`RACE-${suffix}`, `Producto concurrencia ${suffix}`, categoryId],
  );
  const raceProductId = String(product.insertId);
  await engine.createOperation({
    userId,
    idempotencyKey: `race-init-${suffix}`,
    payload: {
      ...initialPayload(8),
      lines: [{ productId: raceProductId, quantity: 8 }],
    },
  });

  const baseGetConnection = pool.getConnection.bind(pool);
  let checkedOut = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  const concurrentPool = {
    getConnection: async () => {
      const connection = await baseGetConnection();
      checkedOut += 1;
      if (checkedOut === 2) releaseBarrier();
      await barrier;
      return connection;
    },
  };
  const concurrentEngine = createInventoryEngine({ dbPool: concurrentPool });
  const makePayload = () => ({
    type: "adjustment_out",
    sourceWarehouseId: warehouseId,
    destinationWarehouseId: null,
    reason: "Prueba concurrente con saldo protegido",
    reference: null,
    lines: [{ productId: raceProductId, quantity: 5, expectedVersion: "1" }],
  });
  const outcomes = await Promise.allSettled([
    concurrentEngine.createOperation({
      userId,
      idempotencyKey: `race-a-${suffix}`,
      payload: makePayload(),
    }),
    concurrentEngine.createOperation({
      userId,
      idempotencyKey: `race-b-${suffix}`,
      payload: makePayload(),
    }),
  ]);
  assert.equal(checkedOut, 2);
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(({ status }) => status === "rejected").length,
    1,
  );
  const rejected = outcomes.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "INVENTORY_VERSION_CONFLICT");

  const [[balance]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [raceProductId, warehouseId],
  );
  assert.equal(balance.quantity, 3);
  assert.equal(String(balance.version), "2");
});

test("simultaneous retries with one idempotency key return the same committed result", async () => {
  const [product] = await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`IDEM-${suffix}`, `Producto idempotencia ${suffix}`, categoryId],
  );
  const retryProductId = String(product.insertId);
  const originalGetConnection = pool.getConnection.bind(pool);
  let checkedOut = 0;
  let openBarrier;
  const barrier = new Promise((resolve) => {
    openBarrier = resolve;
  });
  const concurrentPool = {
    getConnection: async () => {
      const connection = await originalGetConnection();
      checkedOut += 1;
      if (checkedOut === 2) openBarrier();
      await barrier;
      return connection;
    },
  };
  const concurrentEngine = createInventoryEngine({ dbPool: concurrentPool });
  const outcomes = await Promise.all([
    concurrentEngine.createOperation({
      userId,
      idempotencyKey: `same-key-${suffix}`,
      payload: {
        ...initialPayload(6),
        lines: [{ productId: retryProductId, quantity: 6 }],
      },
    }),
    concurrentEngine.createOperation({
      userId,
      idempotencyKey: `same-key-${suffix}`,
      payload: {
        ...initialPayload(6),
        lines: [{ productId: retryProductId, quantity: 6 }],
      },
    }),
  ]);
  assert.equal(checkedOut, 2);
  assert.deepEqual(outcomes.map(({ replayed }) => replayed).sort(), [
    false,
    true,
  ]);
  assert.equal(outcomes[0].operationId, outcomes[1].operationId);
  const [[counts]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM inventory_movements
     WHERE product_id = ? AND warehouse_id = ?`,
    [retryProductId, warehouseId],
  );
  assert.equal(Number(counts.total), 1);
});

test("inventory reads are assignment-scoped and distinguish missing from zero balances", async () => {
  const service = createInventoryService({ dbPool: pool });
  const balances = await service.listBalances({
    userId,
    page: 1,
    pageSize: 100,
    query: suffix,
    warehouseId,
    categoryId: undefined,
    productStatus: "all",
    warehouseStatus: "all",
    stockStatus: "all",
    sortBy: "product",
    sortOrder: "asc",
  });
  const productBalance = balances.items.find(
    (row) => row.productId === productId,
  );
  assert.equal(productBalance.hasBalance, true);
  assert.equal(productBalance.quantity, 0);

  const movements = await service.listMovements({
    userId,
    page: 1,
    pageSize: 20,
    query: suffix,
    sortBy: "createdAt",
    sortOrder: "desc",
  });
  assert.ok(movements.items.every((row) => row.warehouseId === warehouseId));
  assert.ok(movements.items.length > 0);
  const movement = await service.getMovement({
    id: movements.items[0].id,
    userId,
  });
  assert.equal(movement.warehouseId, warehouseId);
  const operations = await service.listOperations({
    userId,
    page: 1,
    pageSize: 20,
    query: suffix,
  });
  assert.ok(operations.items.length > 0);
  const operation = await service.getOperation({
    id: operations.items[0].id,
    userId,
  });
  assert.ok(operation.movements.length > 0);
  const reconciliation = await service.reconcile({ userId, warehouseId });
  assert.equal(reconciliation.consistent, true);
  assert.deepEqual(reconciliation.items, []);

  const totals = await service.listTotals({
    userId,
    page: 1,
    pageSize: 100,
    query: suffix,
    warehouseId,
    categoryId: undefined,
    productStatus: "all",
    warehouseStatus: "all",
    stockStatus: "all",
  });
  assert.ok(
    totals.items.some(
      (row) => row.productId === productId && row.totalQuantity === 0,
    ),
  );

  const unassigned = await pool.execute(
    `INSERT INTO users (role_id, email, password_hash)
     SELECT role_id, ?, password_hash FROM users WHERE id = ?`,
    [`inventory-unassigned-${suffix}@sigecom.invalid`, userId],
  );
  const unassignedId = String(unassigned[0].insertId);
  const noAccess = await service.listBalances({
    userId: unassignedId,
    page: 1,
    pageSize: 100,
    query: suffix,
    productStatus: "all",
    warehouseStatus: "all",
    stockStatus: "all",
    sortBy: "product",
    sortOrder: "asc",
  });
  assert.equal(noAccess.items.length, 0);
  await assert.rejects(
    service.listBalances({
      userId,
      page: 1,
      pageSize: 20,
      query: "",
      warehouseId: "9999999999999999999",
      productStatus: "all",
      warehouseStatus: "all",
      stockStatus: "all",
      sortBy: "product",
      sortOrder: "asc",
    }),
    (error) => error.status === 404,
  );
});

test("historical reads permit assigned inactive warehouses", async () => {
  const [destination] = await pool.execute(
    "INSERT INTO warehouses (code, name, is_active) VALUES (?, ?, 0)",
    [`INVD-${suffix}`, `Bodega histórica ${suffix}`],
  );
  const destinationId = String(destination.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [userId, destinationId],
  );
  const historical = await createInventoryService({
    dbPool: pool,
  }).listBalances({
    userId,
    page: 1,
    pageSize: 100,
    query: suffix,
    warehouseId: destinationId,
    productStatus: "all",
    warehouseStatus: "all",
    stockStatus: "all",
    sortBy: "product",
    sortOrder: "asc",
  });
  assert.ok(historical.items.length > 0);
  assert.ok(historical.items.every((row) => row.warehouseIsActive === false));
});
