import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createDatabasePool } from "../../src/db/pool.js";
import { createInventoryEngine } from "../../src/modules/inventory/inventory-engine.js";
import { createInventoryReportsService } from "../../src/modules/reports/inventory-analytics-service.js";

let suffix;
let pool;
let dbPool;
let connection;
let engine;
let analytics;
let auth;
let auditorAuth;
let categoryId;
let warehouseId;
let productId;

const markerCounts = async (reader, value) => {
  const like = `%${value}%`;
  const [[counts]] = await reader.execute(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users,
       (SELECT COUNT(*) FROM user_sessions WHERE token_hash LIKE ?) AS sessions,
       (SELECT COUNT(*) FROM user_warehouses uw JOIN users u ON u.id=uw.user_id
          WHERE u.email LIKE ?) AS assignments,
       (SELECT COUNT(*) FROM categories WHERE name LIKE ?) AS categories,
       (SELECT COUNT(*) FROM warehouses WHERE code LIKE ? OR name LIKE ?) AS warehouses,
       (SELECT COUNT(*) FROM products WHERE sku LIKE ?) AS products,
       (SELECT COUNT(*) FROM customers WHERE identification_number LIKE ?) AS customers,
       (SELECT COUNT(*) FROM suppliers WHERE identification_number LIKE ?) AS suppliers,
       (SELECT COUNT(*) FROM inventory_operations WHERE idempotency_key LIKE ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements im JOIN inventory_operations io ON io.id=im.operation_id
          WHERE io.idempotency_key LIKE ?) AS movements,
       (SELECT COUNT(*) FROM inventory_balances ib JOIN products p ON p.id=ib.product_id
          WHERE p.sku LIKE ?) AS balances,
       (SELECT COUNT(*) FROM purchase_orders WHERE commercial_code LIKE ?) AS purchase_orders,
       (SELECT COUNT(*) FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
          WHERE po.commercial_code LIKE ?) AS purchase_order_lines,
       (SELECT COUNT(*) FROM purchase_receipts WHERE reference LIKE ?) AS purchase_receipts,
       (SELECT COUNT(*) FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id=prl.purchase_receipt_id
          WHERE pr.reference LIKE ?) AS purchase_receipt_lines,
       (SELECT COUNT(*) FROM sales WHERE commercial_code LIKE ?) AS sales,
       (SELECT COUNT(*) FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
          WHERE s.commercial_code LIKE ?) AS sale_lines,
       (SELECT COUNT(*) FROM sale_cancellations WHERE verification_reference LIKE ?) AS sale_cancellations,
       (SELECT COUNT(*) FROM customer_returns WHERE reference LIKE ?) AS customer_returns,
       (SELECT COUNT(*) FROM customer_return_lines crl JOIN customer_returns cr ON cr.id=crl.customer_return_id
          WHERE cr.reference LIKE ?) AS customer_return_lines,
       (SELECT COUNT(*) FROM supplier_returns WHERE reference LIKE ?) AS supplier_returns,
       (SELECT COUNT(*) FROM supplier_return_lines srl JOIN supplier_returns sr ON sr.id=srl.supplier_return_id
          WHERE sr.reference LIKE ?) AS supplier_return_lines`,
    Array(23).fill(like),
  );
  return Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [key, Number(count)]),
  );
};

before(async () => {
  dbPool = createDatabasePool("test");
  let savepointNumber = 0;
  pool = {
    execute: (...args) => {
      if (!connection) throw new Error("No hay fixture transaccional activo.");
      return connection.execute(...args);
    },
    query: (...args) => {
      if (!connection) throw new Error("No hay fixture transaccional activo.");
      return connection.query(...args);
    },
    getConnection: async () => {
      if (!connection) throw new Error("No hay fixture transaccional activo.");
      const savepoint = `report_fixture_${++savepointNumber}`;
      let active = false;
      const execute = (...args) => connection.execute(...args);
      const query = (...args) => connection.query(...args);
      return {
        execute,
        query,
        beginTransaction: async () => {
          if (active) throw new Error("Savepoint de fixture ya iniciado.");
          await connection.query(`SAVEPOINT ${savepoint}`);
          active = true;
        },
        commit: async () => {
          if (!active) throw new Error("No hay savepoint de fixture activo.");
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
          active = false;
        },
        rollback: async () => {
          if (!active) return;
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
          active = false;
        },
        release: async () => {
          if (!active) return;
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
          active = false;
        },
      };
    },
  };
  const [[database]] = await dbPool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  const inventoryEngine = createInventoryEngine({ dbPool });
  engine = {
    ...inventoryEngine,
    createOperation: ({ userId, idempotencyKey, payload, request }) =>
      inventoryEngine.applyWithinTransaction({
        connection,
        userId,
        idempotencyKey,
        payload,
        request,
      }),
  };
  const reports = createInventoryReportsService({ dbPool });
  analytics = {
    currentStock: (options) =>
      reports.currentStock({
        ...options,
        connection: options.connection ?? connection,
      }),
    periodActivity: (options) =>
      reports.periodActivity({
        ...options,
        connection: options.connection ?? connection,
      }),
  };
});

beforeEach(async () => {
  suffix = randomBytes(8).toString("hex").toUpperCase();
  connection = await dbPool.getConnection();
  try {
    const beforeCounts = await markerCounts(connection, suffix);
    assert.ok(Object.values(beforeCounts).every((count) => count === 0));
    await connection.beginTransaction();

    const [[role]] = await pool.execute(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    const [user] = await pool.execute(
      `INSERT INTO users (role_id,email,password_hash)
     VALUES (?,?,'reports-inventory-test-hash')`,
      [role.id, `reports-inventory-${suffix}@sigecom.invalid`],
    );
    const userId = String(user.insertId);
    const [session] = await pool.execute(
      `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
      [userId, `reports-inventory-${suffix}`],
    );
    auth = {
      user: { id: userId, role: "administrator" },
      sessionId: String(session.insertId),
    };
    const [[auditorRole]] = await pool.execute(
      "SELECT id FROM roles WHERE code='auditor'",
    );
    const [auditor] = await pool.execute(
      `INSERT INTO users (role_id,email,password_hash)
     VALUES (?,?,'reports-inventory-auditor-test-hash')`,
      [auditorRole.id, `reports-inventory-auditor-${suffix}@sigecom.invalid`],
    );
    const auditorId = String(auditor.insertId);
    const [auditorSession] = await pool.execute(
      `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
      [auditorId, `reports-inventory-auditor-${suffix}`],
    );
    auditorAuth = {
      user: { id: auditorId, role: "auditor" },
      sessionId: String(auditorSession.insertId),
    };

    const [category] = await pool.execute(
      "INSERT INTO categories (name) VALUES (?)",
      [`Reporte inventario ${suffix}`],
    );
    categoryId = String(category.insertId);
    const [warehouse] = await pool.execute(
      "INSERT INTO warehouses (code,name) VALUES (?,?)",
      [`RPT-${suffix}`, `Bodega reporte ${suffix}`],
    );
    warehouseId = String(warehouse.insertId);
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [userId, warehouseId],
    );
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [auditorId, warehouseId],
    );
    const [product] = await pool.execute(
      `INSERT INTO products
       (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 5)`,
      [`RPT-${suffix}`, `Producto reporte ${suffix}`, categoryId],
    );
    productId = String(product.insertId);
    const [[transactionState]] = await connection.query(
      "SELECT @@in_transaction AS active",
    );
    assert.equal(Number(transactionState.active), 1);
    assert.ok((await markerCounts(connection, suffix)).users >= 2);
  } catch (error) {
    await connection.rollback();
    connection.release();
    connection = undefined;
    throw error;
  }
});

afterEach(async () => {
  if (!connection) return;
  const activeConnection = connection;
  let failure;
  try {
    const [[transactionState]] = await activeConnection.query(
      "SELECT @@in_transaction AS active",
    );
    assert.equal(
      Number(transactionState.active),
      1,
      "fixture transaction was committed internally",
    );
  } catch (error) {
    failure = error;
  } finally {
    await activeConnection.rollback();
    activeConnection.release();
    connection = undefined;
  }
  const observer = await dbPool.getConnection();
  try {
    const persisted = await markerCounts(observer, suffix);
    assert.ok(
      Object.values(persisted).every((count) => count === 0),
      `El rollback dejó residuos de fixture: ${JSON.stringify(persisted)}`,
    );
  } finally {
    observer.release();
  }
  if (failure) throw failure;
});

after(async () => {
  if (dbPool) await dbPool.end();
});

async function createReporterAuth(label, assignedWarehouseIds = []) {
  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code='administrator'",
  );
  const [user] = await pool.execute(
    "INSERT INTO users (role_id,email,password_hash) VALUES (?,?,'analytics-report-test-hash')",
    [role.id, `reports-${label}-${suffix}@sigecom.invalid`],
  );
  const userId = String(user.insertId);
  const [session] = await pool.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
    [userId, `reports-${label}-${suffix}`],
  );
  for (const assignedWarehouseId of assignedWarehouseIds) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [userId, assignedWarehouseId],
    );
  }
  return {
    user: { id: userId, role: "administrator" },
    sessionId: String(session.insertId),
  };
}

async function createOneSidedTransfer({
  label,
  sourceWarehouseId,
  destinationWarehouseId,
  sourceOpening,
  destinationOpening,
  direction,
}) {
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`TR-${label}-${suffix}`, `Producto ${label} ${suffix}`, categoryId],
  );
  const oneSidedProductId = String(product.insertId);
  for (const [warehouse, quantity, key] of [
    [sourceWarehouseId, sourceOpening, "source"],
    [destinationWarehouseId, destinationOpening, "destination"],
  ]) {
    await engine.createOperation({
      userId: auth.user.id,
      idempotencyKey: `analytics-${label}-opening-${key}-${suffix}`,
      payload: {
        type: "initial_stock",
        sourceWarehouseId: warehouse,
        destinationWarehouseId: null,
        reason: `Saldo inicial del fixture ${label}`,
        reference: `TR-${label}-${key}-${suffix}`,
        lines: [{ productId: oneSidedProductId, quantity }],
      },
    });
  }

  const idempotencyKey = `analytics-${label}-operation-${suffix}`;
  const [operation] = await pool.execute(
    `INSERT INTO inventory_operations
      (operation_type,source_warehouse_id,destination_warehouse_id,created_by,reason,reference,
       idempotency_key,request_hash)
     VALUES ('transfer', ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceWarehouseId,
      destinationWarehouseId,
      auth.user.id,
      `Fixture sintético ${direction}-only ${label}`,
      `TR-${label}-${suffix}`,
      idempotencyKey,
      "d".repeat(64),
    ],
  );

  const warehouseId =
    direction === "OUT" ? sourceWarehouseId : destinationWarehouseId;
  const before = direction === "OUT" ? sourceOpening : destinationOpening;
  const after = direction === "OUT" ? before - 2 : before + 2;
  await pool.execute(
    `UPDATE inventory_balances SET quantity=?,version=2
      WHERE product_id=? AND warehouse_id=? AND version=1`,
    [after, oneSidedProductId, warehouseId],
  );
  const [movement] = await pool.execute(
    `INSERT INTO inventory_movements
      (operation_id,product_id,warehouse_id,direction,quantity,balance_before,balance_after,
       balance_version,unit_snapshot)
     VALUES (?, ?, ?, ?, 2, ?, ?, 2, 'unidad')`,
    [
      operation.insertId,
      oneSidedProductId,
      warehouseId,
      direction,
      before,
      after,
    ],
  );
  const [[persisted]] = await pool.execute(
    `SELECT io.id AS operation_id,im.id AS movement_id,ib.quantity,ib.version
       FROM inventory_operations io
       JOIN inventory_movements im ON im.operation_id=io.id
       JOIN inventory_balances ib ON ib.product_id=im.product_id AND ib.warehouse_id=im.warehouse_id
      WHERE io.id=? AND im.id=?`,
    [operation.insertId, movement.insertId],
  );
  assert.equal(String(persisted.operation_id), String(operation.insertId));
  assert.equal(String(persisted.movement_id), String(movement.insertId));
  assert.equal(String(persisted.quantity), String(after));
  assert.equal(String(persisted.version), "2");
  return {
    productId: oneSidedProductId,
    operationId: String(operation.insertId),
  };
}

test("current stock aggregates only authorized, fully verified balance pairs", async () => {
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-stock-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Fixture analítico de existencias",
      reference: `RPT-${suffix}`,
      lines: [{ productId, quantity: 9 }],
    },
  });
  const result = await analytics.currentStock({ auth, page: 1, pageSize: 20 });
  assert.equal(result.summary.candidatePairs, "1");
  assert.equal(result.summary.verifiedPairs, "1");
  assert.equal(result.summary.positivePairs, "1");
  assert.equal(result.summary.depletedPairs, "0");
  assert.equal(result.summary.belowMinimumPairs, "0");
  assert.equal(result.summary.units[0].quantity, "9");
  assert.equal(result.pagination.total, "1");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].warehouseId, warehouseId);
  assert.equal(result.groups[0].unit, "unidad");
});

test("current stock evaluates its integrity CTE in one SQL statement", async () => {
  const inventoryQueries = [];
  const monitoredConnection = {
    execute: (...args) => {
      if (String(args[0]).includes("WITH scoped_balances AS")) {
        inventoryQueries.push(args[0]);
      }
      return connection.execute(...args);
    },
    query: connection.query.bind(connection),
  };

  const result = await analytics.currentStock({
    auth,
    connection: monitoredConnection,
    page: 1,
    pageSize: 20,
  });

  assert.equal(inventoryQueries.length, 1);
  assert.equal(result.summary.candidatePairs, "0");
  assert.deepEqual(result.groups, []);
});

test("a confirmed sale without its issue movement makes only its product balance unverifiable", async () => {
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-a9-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Saldo previo para venta sin movimiento",
      reference: `A9-OPEN-${suffix}`,
      lines: [{ productId, quantity: 5 }],
    },
  });
  const [customer] = await pool.execute(
    "INSERT INTO customers (identification_number,name) VALUES (?,?)",
    [`A9-${suffix}`, `Cliente A9 ${suffix}`],
  );
  const [sale] = await pool.execute(
    `INSERT INTO sales
      (commercial_code,customer_id,customer_name_snapshot,customer_identification_snapshot,
       warehouse_id,warehouse_code_snapshot,warehouse_name_snapshot,sale_date,status,version,
       created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_DATE(), 'confirmed', 1, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      `A9-${suffix}`,
      customer.insertId,
      `Cliente A9 ${suffix}`,
      `A9-${suffix}`,
      warehouseId,
      `RPT-${suffix}`,
      `Bodega reporte ${suffix}`,
      auth.user.id,
      auth.user.id,
      auth.user.id,
    ],
  );
  await pool.execute(
    `INSERT INTO sale_lines
      (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,
       quantity,unit_price,line_total)
     VALUES (?, ?, 1, ?, ?, 'unidad', 2, 2, 4)`,
    [sale.insertId, productId, `RPT-${suffix}`, `Producto reporte ${suffix}`],
  );
  await pool.execute(
    `INSERT INTO inventory_operations
      (operation_type,source_warehouse_id,destination_warehouse_id,created_by,reason,reference,
       source_type,source_id,idempotency_key,request_hash)
     VALUES ('sale_issue', ?, NULL, ?, 'Venta sin movimiento A9', ?, 'sale', ?, ?, ?)`,
    [
      warehouseId,
      auth.user.id,
      `A9-${suffix}`,
      String(sale.insertId),
      `analytics-a9-sale-${suffix}`,
      "f".repeat(64),
    ],
  );
  const [unlinkedSale] = await pool.execute(
    `INSERT INTO sales
      (commercial_code,customer_id,customer_name_snapshot,customer_identification_snapshot,
       warehouse_id,warehouse_code_snapshot,warehouse_name_snapshot,sale_date,status,version,
       created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_DATE(), 'confirmed', 1, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      `A9-NO-OP-${suffix}`,
      customer.insertId,
      `Cliente A9 ${suffix}`,
      `A9-${suffix}`,
      warehouseId,
      `RPT-${suffix}`,
      `Bodega reporte ${suffix}`,
      auth.user.id,
      auth.user.id,
      auth.user.id,
    ],
  );
  await pool.execute(
    `INSERT INTO sale_lines
      (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,
       quantity,unit_price,line_total)
     VALUES (?, ?, 1, ?, ?, 'unidad', 1, 2, 2)`,
    [
      unlinkedSale.insertId,
      productId,
      `RPT-${suffix}`,
      `Producto reporte ${suffix}`,
    ],
  );
  const [unaffectedProduct] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`A9-OTHER-${suffix}`, `Producto no afectado ${suffix}`, categoryId],
  );
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-a9-unaffected-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Saldo independiente del caso A9",
      reference: `A9-OTHER-${suffix}`,
      lines: [{ productId: String(unaffectedProduct.insertId), quantity: 7 }],
    },
  });

  const stock = await analytics.currentStock({ auth, warehouseId });
  assert.equal(stock.summary.candidatePairs, "2");
  assert.equal(stock.summary.verifiedPairs, "1");
  assert.equal(stock.summary.excludedPairs, "1");
  assert.equal(stock.summary.insufficientPairs, "1");
  assert.equal(stock.summary.units[0].quantity, "7");
  assert.equal(stock.groups[0].quantity, "7");

  const [[eventDate]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(confirmed_at,'+00:00','-05:00'),'%Y-%m-%d') AS day
       FROM sales WHERE id=?`,
    [sale.insertId],
  );
  const activity = await analytics.periodActivity({
    auth,
    warehouseId,
    dateFrom: eventDate.day,
    dateTo: eventDate.day,
  });
  assert.equal(activity.summary.candidateMovements, "2");
  assert.equal(activity.summary.verifiedMovements, "2");
  assert.equal(activity.summary.units[0].exits, "0");
  assert.deepEqual(activity.summary.documentEffects, {
    observation: "commercial_document_line_effects",
    unit: "document_line_effects",
    candidateEffects: "2",
    uncreditedEffects: "2",
  });
  assert.equal(
    activity.coverage.documentEffects.completeWithinCandidates,
    false,
  );
});

test("current stock distinguishes a registered zero from an absent pair", async () => {
  const [emptyProduct] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'caja', 1, 2, 5)`,
    [`ZERO-${suffix}`, `Producto cero ${suffix}`, categoryId],
  );
  const emptyProductId = String(emptyProduct.insertId);
  await pool.execute(
    `INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version)
     VALUES (?, ?, 0, 0)`,
    [emptyProductId, warehouseId],
  );

  const result = await analytics.currentStock({ auth, page: 1, pageSize: 20 });
  assert.equal(result.summary.candidatePairs, "1");
  assert.equal(result.summary.verifiedPairs, "1");
  assert.equal(result.summary.depletedPairs, "1");
  assert.equal(result.summary.belowMinimumPairs, "1");
  assert.equal(result.summary.units.length, 1);
});

test("current quantities remain exact above JavaScript safe-integer range", async () => {
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`LARGE-${suffix}`, `Producto grande ${suffix}`, categoryId],
  );
  const largeProductId = String(product.insertId);
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-large-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Fixture de cantidad exacta",
      reference: `LG-${suffix}`,
      lines: [{ productId: largeProductId, quantity: 4_294_967_295 }],
    },
  });
  const result = await analytics.currentStock({ auth, page: 1, pageSize: 20 });
  assert.equal(
    result.summary.units.find((unit) => unit.unit === "unidad").quantity,
    "4294967295",
  );
});

test("a persisted balance diverging from its latest movement is excluded as inconsistent", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`DIV-${suffix}`, `Bodega saldo divergente ${suffix}`],
  );
  const divergedWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, divergedWarehouseId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'paquete', 1, 2, 0)`,
    [`BROKEN-${suffix}`, `Producto inconsistente ${suffix}`, categoryId],
  );
  const brokenProductId = String(product.insertId);
  const operation = await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-broken-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: divergedWarehouseId,
      destinationWarehouseId: null,
      reason: "Fixture de divergencia de saldo",
      reference: `BR-${suffix}`,
      lines: [{ productId: brokenProductId, quantity: 7 }],
    },
  });
  await pool.execute(
    "UPDATE inventory_balances SET quantity=6 WHERE product_id=? AND warehouse_id=?",
    [brokenProductId, divergedWarehouseId],
  );
  const result = await analytics.currentStock({
    auth,
    warehouseId: divergedWarehouseId,
    page: 1,
    pageSize: 20,
  });
  assert.equal(result.summary.inconsistentPairs, "1");
  assert.equal(result.summary.verifiedPairs, "0");
  assert.equal(result.summary.excludedPairs, "1");
  assert.equal(result.coverage.completeWithinCandidates, false);
  assert.equal(result.summary.insufficientPairs, "0");
  assert.equal(
    result.summary.units.find((unit) => unit.unit === "paquete").quantity,
    "0",
  );
  const [[period]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','-05:00'),'%Y-%m-%d') AS bogota_date
     FROM inventory_operations WHERE id=?`,
    [operation.operationId],
  );
  const activity = await analytics.periodActivity({
    auth,
    warehouseId: divergedWarehouseId,
    dateFrom: period.bogota_date,
    dateTo: period.bogota_date,
  });
  const historicalOpening = activity.groups.find(
    (group) =>
      group.operationType === "initial_stock" && group.unit === "paquete",
  );
  assert.ok(historicalOpening);
  assert.equal(historicalOpening.verifiedMovements, "1");
  assert.equal(historicalOpening.entries, "7");
  assert.equal(activity.summary.verifiedMovements, "1");
  await pool.execute(
    "DELETE FROM user_warehouses WHERE user_id=? AND warehouse_id=?",
    [auth.user.id, divergedWarehouseId],
  );
});

test("a balance version with a missing historical sequence cannot be verified", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`GAP-${suffix}`, `Bodega hueco de versiones ${suffix}`],
  );
  const gapWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, gapWarehouseId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'caja', 1, 2, 0)`,
    [`GAP-${suffix}`, `Producto hueco versiones ${suffix}`, categoryId],
  );
  const gapProductId = String(product.insertId);
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-gap-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: gapWarehouseId,
      destinationWarehouseId: null,
      reason: "Fixture con hueco de versión",
      reference: `GAP-${suffix}`,
      lines: [{ productId: gapProductId, quantity: 5 }],
    },
  });
  await pool.execute(
    "UPDATE inventory_balances SET version=3 WHERE product_id=? AND warehouse_id=?",
    [gapProductId, gapWarehouseId],
  );
  const result = await analytics.currentStock({
    auth,
    warehouseId: gapWarehouseId,
  });
  assert.equal(result.summary.candidatePairs, "1");
  assert.equal(result.summary.verifiedPairs, "0");
  assert.equal(result.summary.inconsistentPairs, "1");
  assert.equal(result.summary.excludedPairs, "1");
  assert.equal(
    result.summary.units.find((row) => row.unit === "caja").quantity,
    "0",
  );
  assert.equal(result.coverage.completeWithinCandidates, false);
});

test("history gaps, broken handoffs and mixed historical units exclude only their balances", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`CHAIN-${suffix}`, `Bodega continuidad ${suffix}`],
  );
  const chainWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, chainWarehouseId],
  );
  const cases = [
    {
      code: "GAP",
      version: 3,
      before: 5,
      quantity: 2,
      after: 7,
      unit: "unidad",
    },
    {
      code: "HANDOFF",
      version: 2,
      before: 6,
      quantity: 2,
      after: 8,
      unit: "unidad",
    },
    {
      code: "UNIT",
      version: 2,
      before: 5,
      quantity: 2,
      after: 7,
      unit: "caja",
    },
  ];
  for (const scenario of cases) {
    const [product] = await pool.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
       VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
      [
        `CHAIN-${suffix}-${scenario.code}`,
        `Producto ${scenario.code} ${suffix}`,
        categoryId,
      ],
    );
    const chainProductId = String(product.insertId);
    await engine.createOperation({
      userId: auth.user.id,
      idempotencyKey: `analytics-chain-opening-${suffix}-${scenario.code}`,
      payload: {
        type: "initial_stock",
        sourceWarehouseId: chainWarehouseId,
        destinationWarehouseId: null,
        reason: "Inicio de cadena histórica controlada",
        reference: `CHAIN-OPEN-${suffix}-${scenario.code}`,
        lines: [{ productId: chainProductId, quantity: 5 }],
      },
    });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "UPDATE inventory_balances SET quantity=?,version=? WHERE product_id=? AND warehouse_id=?",
        [scenario.after, scenario.version, chainProductId, chainWarehouseId],
      );
      const [operation] = await connection.execute(
        `INSERT INTO inventory_operations
          (operation_type,source_warehouse_id,destination_warehouse_id,created_by,reason,
           reference,source_type,source_id,idempotency_key,request_hash)
         VALUES ('adjustment_in',?,NULL,?,? ,?,NULL,NULL,?,?)`,
        [
          chainWarehouseId,
          auth.user.id,
          `Fixture sintético de continuidad ${scenario.code}`,
          `CHAIN-${suffix}-${scenario.code}`,
          `analytics-chain-corrupt-${suffix}-${scenario.code}`,
          "b".repeat(64),
        ],
      );
      await connection.execute(
        `INSERT INTO inventory_movements
          (operation_id,product_id,warehouse_id,direction,quantity,balance_before,
           balance_after,balance_version,unit_snapshot)
         VALUES (?, ?, ?, 'IN', ?, ?, ?, ?, ?)`,
        [
          operation.insertId,
          chainProductId,
          chainWarehouseId,
          scenario.quantity,
          scenario.before,
          scenario.after,
          scenario.version,
          scenario.unit,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  const [validProduct] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`CHAIN-${suffix}-VALID`, `Producto cadena válida ${suffix}`, categoryId],
  );
  const validProductId = String(validProduct.insertId);
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-chain-valid-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: chainWarehouseId,
      destinationWarehouseId: null,
      reason: "Inicio de cadena válida",
      reference: `CHAIN-VALID-OPEN-${suffix}`,
      lines: [{ productId: validProductId, quantity: 5 }],
    },
  });
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-chain-valid-next-${suffix}`,
    payload: {
      type: "adjustment_in",
      sourceWarehouseId: chainWarehouseId,
      destinationWarehouseId: null,
      reason: "Continuidad consecutiva fixture",
      reference: `CHAIN-VALID-NEXT-${suffix}`,
      lines: [{ productId: validProductId, quantity: 2, expectedVersion: "1" }],
    },
  });
  const result = await analytics.currentStock({
    auth,
    warehouseId: chainWarehouseId,
    pageSize: 20,
  });
  assert.equal(result.summary.candidatePairs, "4");
  assert.equal(result.summary.verifiedPairs, "1");
  assert.equal(result.summary.inconsistentPairs, "3");
  assert.equal(result.summary.excludedPairs, "3");
  assert.equal(result.coverage.completeWithinCandidates, false);
  assert.equal(result.groups.length, 2);
  const valid = result.groups.find((group) => group.unit === "unidad");
  assert.equal(valid.verifiedPairs, "1");
  assert.equal(valid.quantity, "7");
  const invalid = result.groups.find((group) => group.unit === "caja");
  assert.equal(invalid.verifiedPairs, "0");
  assert.equal(invalid.quantity, "0");
});

test("historical movement units remain valid after the catalog unit changes", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`HU-${suffix}`, `Bodega unidad histórica ${suffix}`],
  );
  const historicalWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, historicalWarehouseId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`HIST-UNIT-${suffix}`, `Producto unidad histórica ${suffix}`, categoryId],
  );
  const historicalProductId = String(product.insertId);
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-historical-unit-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: historicalWarehouseId,
      destinationWarehouseId: null,
      reason: "Fixture de unidad histórica",
      reference: `HU-${suffix}`,
      lines: [{ productId: historicalProductId, quantity: 3 }],
    },
  });
  await pool.execute("UPDATE products SET unit='caja',is_active=0 WHERE id=?", [
    historicalProductId,
  ]);
  await pool.execute("UPDATE warehouses SET is_active=0 WHERE id=?", [
    historicalWarehouseId,
  ]);

  const result = await analytics.currentStock({
    auth,
    warehouseId: historicalWarehouseId,
    page: 1,
    pageSize: 50,
  });
  const historicalUnitGroup = result.groups.find(
    (group) =>
      group.unit === "unidad" && group.warehouseId === historicalWarehouseId,
  );
  assert.ok(historicalUnitGroup);
  assert.equal(historicalUnitGroup.verifiedPairs, "1");
  assert.equal(historicalUnitGroup.quantity, "3");
  assert.equal(historicalUnitGroup.warehouseActive, false);
  assert.equal(historicalUnitGroup.inactiveProductPairs, "1");
  await pool.execute(
    "DELETE FROM user_warehouses WHERE user_id=? AND warehouse_id=?",
    [auth.user.id, historicalWarehouseId],
  );
});

test("an authenticated report user without assignments receives an explicitly empty scope", async () => {
  const [assignments] = await pool.execute(
    "SELECT warehouse_id FROM user_warehouses WHERE user_id=?",
    [auth.user.id],
  );
  await pool.execute("DELETE FROM user_warehouses WHERE user_id=?", [
    auth.user.id,
  ]);
  try {
    const result = await analytics.currentStock({ auth });
    assert.equal(result.summary.candidatePairs, "0");
    assert.equal(result.coverage.scope, "no_assigned_warehouses");
    assert.equal(result.groups.length, 0);
    const activity = await analytics.periodActivity({
      auth,
      dateFrom: "2026-11-08",
      dateTo: "2026-11-08",
    });
    assert.equal(activity.summary.candidateMovements, "0");
    assert.deepEqual(activity.summary.documentEffects, {
      observation: "commercial_document_line_effects",
      unit: "document_line_effects",
      candidateEffects: "0",
      uncreditedEffects: "0",
    });
  } finally {
    for (const { warehouse_id: assignedWarehouseId } of assignments) {
      await pool.execute(
        "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
        [auth.user.id, assignedWarehouseId],
      );
    }
  }
});

test("seller and out-of-scope warehouse requests are rejected", async () => {
  await assert.rejects(
    analytics.currentStock({
      auth: { ...auth, user: { ...auth.user, role: "seller" } },
    }),
    { code: "PERMISSION_DENIED" },
  );
  await assert.rejects(
    analytics.currentStock({ auth, warehouseId: "18446744073709551615" }),
    { code: "WAREHOUSE_NOT_FOUND" },
  );
});

test("auditor accesses both views without commercial read permissions", async () => {
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-auditor-stock-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Fixture propio de consulta auditora",
      reference: `AUD-${suffix}`,
      lines: [{ productId, quantity: 1 }],
    },
  });
  const stock = await analytics.currentStock({ auth: auditorAuth });
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1))
    .toISOString()
    .slice(0, 10);
  const activity = await analytics.periodActivity({
    auth: auditorAuth,
    dateFrom: day,
    dateTo: next,
  });
  assert.ok(BigInt(stock.summary.candidatePairs) > 0n);
  assert.ok(BigInt(activity.summary.verifiedMovements) > 0n);
});

test("stock and activity permissions are independent inside rollback-only fixtures", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`PERM-${suffix}`, `Bodega permisos analítica ${suffix}`],
  );
  const permissionWarehouseId = String(warehouse.insertId);
  for (const userId of [auth.user.id, auditorAuth.user.id]) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [userId, permissionWarehouseId],
    );
  }
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`PERM-AN-${suffix}`, `Producto permisos analítica ${suffix}`, categoryId],
  );
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-permission-fixture-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: permissionWarehouseId,
      destinationWarehouseId: null,
      reason: "Fixture para permisos independientes",
      reference: `PERM-AN-${suffix}`,
      lines: [{ productId: String(product.insertId), quantity: 1 }],
    },
  });
  const [[period]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','-05:00'),'%Y-%m-%d') AS day
     FROM inventory_operations WHERE source_warehouse_id=? ORDER BY id DESC LIMIT 1`,
    [permissionWarehouseId],
  );
  const connection = await pool.getConnection();
  try {
    const [[auditorRole]] = await connection.execute(
      "SELECT id FROM roles WHERE code='auditor'",
    );
    const [[movementPermission]] = await connection.execute(
      "SELECT id FROM permissions WHERE code='inventory.movements.read'",
    );
    await connection.beginTransaction();
    await connection.execute(
      "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
      [auditorRole.id, movementPermission.id],
    );
    const stockOnly = await analytics.currentStock({
      auth: auditorAuth,
      connection,
      warehouseId: permissionWarehouseId,
    });
    assert.ok(BigInt(stockOnly.summary.candidatePairs) > 0n);
    await assert.rejects(
      analytics.periodActivity({
        auth: auditorAuth,
        connection,
        warehouseId: permissionWarehouseId,
        dateFrom: period.day,
        dateTo: period.day,
      }),
      { code: "PERMISSION_DENIED" },
    );
    await connection.rollback();

    const [[stockPermission]] = await connection.execute(
      "SELECT id FROM permissions WHERE code='inventory.read'",
    );
    await connection.beginTransaction();
    await connection.execute(
      "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
      [auditorRole.id, stockPermission.id],
    );
    await assert.rejects(
      analytics.currentStock({
        auth: auditorAuth,
        connection,
        warehouseId: permissionWarehouseId,
      }),
      { code: "PERMISSION_DENIED" },
    );
    const activityOnly = await analytics.periodActivity({
      auth: auditorAuth,
      connection,
      warehouseId: permissionWarehouseId,
      dateFrom: period.day,
      dateTo: period.day,
    });
    assert.ok(BigInt(activityOnly.summary.verifiedMovements) > 0n);
  } finally {
    await connection.rollback();
    connection.release();
  }
});

test("a receipt contributes only when operation, document, line, unit and quantity agree", async () => {
  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (identification_number,business_name) VALUES (?,?)",
    [`SUP-${suffix}`, `Proveedor reporte ${suffix}`],
  );
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [order] = await connection.execute(
      `INSERT INTO purchase_orders
         (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
       VALUES (?, ?, ?, UTC_DATE(), 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3))`,
      [
        `OC-${suffix}`,
        supplier.insertId,
        warehouseId,
        auth.user.id,
        auth.user.id,
        auth.user.id,
      ],
    );
    const [line] = await connection.execute(
      `INSERT INTO purchase_order_lines
         (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,quantity,unit_cost,line_total)
       VALUES (?, ?, 1, ?, ?, 'unidad', 4, 1, 4)`,
      [
        order.insertId,
        productId,
        `RPT-${suffix}`,
        `Producto reporte ${suffix}`,
      ],
    );
    const [receipt] = await connection.execute(
      `INSERT INTO purchase_receipts (purchase_order_id,reference,received_by)
       VALUES (?, ?, ?)`,
      [order.insertId, `REC-${suffix}`, auth.user.id],
    );
    await connection.execute(
      `INSERT INTO purchase_receipt_lines
         (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity)
       VALUES (?, ?, ?, 4)`,
      [receipt.insertId, order.insertId, line.insertId],
    );
    const operation = await engine.applyWithinTransaction({
      connection,
      userId: auth.user.id,
      idempotencyKey: `analytics-receipt-${suffix}`,
      internal: true,
      payload: {
        type: "purchase_receipt",
        sourceWarehouseId: warehouseId,
        destinationWarehouseId: null,
        sourceType: "purchase_receipt",
        sourceId: String(receipt.insertId),
        reason: "Fixture de recepción documental",
        reference: `REC-${suffix}`,
        lines: [{ productId, quantity: 4, expectedVersion: "0" }],
      },
    });
    await connection.execute(
      "UPDATE purchase_receipts SET source_operation_id=? WHERE id=?",
      [operation.operationId, receipt.insertId],
    );
    await connection.commit();
    const stock = await analytics.currentStock({
      auth,
      warehouseId,
      page: 1,
      pageSize: 20,
    });
    assert.equal(
      stock.summary.units.find((unit) => unit.unit === "unidad").quantity,
      "4",
    );
    assert.equal(stock.summary.insufficientPairs, "0");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

test("sales issues, reversals and both customer-return outcomes match physical activity", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`SALE-RPT-${suffix}`, `Bodega ventas analítica ${suffix}`],
  );
  const scopedWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, scopedWarehouseId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`SALE-RPT-${suffix}`, `Producto ventas analítica ${suffix}`, categoryId],
  );
  const scopedProductId = String(product.insertId);
  const [customer] = await pool.execute(
    "INSERT INTO customers (identification_number,name) VALUES (?,?)",
    [`SALE-RPT-${suffix}`, `Cliente analítica ${suffix}`],
  );
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-sales-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: scopedWarehouseId,
      destinationWarehouseId: null,
      reason: "Existencia para fixtures de ventas",
      reference: `SALE-OPEN-${suffix}`,
      lines: [{ productId: scopedProductId, quantity: 30 }],
    },
  });

  async function insertSale({ index, quantity, status = "confirmed" }) {
    const [inserted] = await pool.execute(
      `INSERT INTO sales
        (commercial_code,customer_id,customer_name_snapshot,customer_identification_snapshot,
         warehouse_id,warehouse_code_snapshot,warehouse_name_snapshot,sale_date,status,version,
         created_by,updated_by,confirmed_by,confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-07', ?, 1, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [
        `V-AN-${suffix}-${index}`,
        customer.insertId,
        `Cliente analítica ${suffix}`,
        `SALE-RPT-${suffix}`,
        scopedWarehouseId,
        `SALE-RPT-${suffix}`,
        `Bodega ventas analítica ${suffix}`,
        status,
        auth.user.id,
        auth.user.id,
        auth.user.id,
      ],
    );
    const saleId = String(inserted.insertId);
    const [line] = await pool.execute(
      `INSERT INTO sale_lines
        (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,
         quantity,unit_price,line_total)
       VALUES (?, ?, 1, ?, ?, 'unidad', ?, 2, ?)`,
      [
        saleId,
        scopedProductId,
        `SALE-RPT-${suffix}`,
        `Producto ventas analítica ${suffix}`,
        quantity,
        quantity * 2,
      ],
    );
    return { saleId, saleLineId: String(line.insertId), quantity };
  }

  async function applySaleMovement({
    sale,
    type,
    idempotencyKey,
    sourceType,
    sourceId,
    allow,
  }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[balance]] = await connection.execute(
        "SELECT CAST(version AS CHAR) AS version FROM inventory_balances WHERE product_id=? AND warehouse_id=? FOR UPDATE",
        [scopedProductId, scopedWarehouseId],
      );
      const result = await engine.applyWithinTransaction({
        connection,
        userId: auth.user.id,
        idempotencyKey,
        internal: true,
        allowSaleIssue: allow === "sale_issue",
        allowSaleReversal: allow === "sale_reversal",
        allowCustomerReturn: allow === "customer_return",
        validateProducts: async () => {},
        payload: {
          type,
          sourceWarehouseId: scopedWarehouseId,
          destinationWarehouseId: null,
          sourceType,
          sourceId,
          reason: `Fixture comercial ${type}`,
          reference: `REF-${idempotencyKey}`,
          lines: [
            {
              productId: scopedProductId,
              quantity: sale.quantity,
              expectedVersion: balance.version,
            },
          ],
        },
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const reversedSale = await insertSale({ index: 1, quantity: 6 });
  const issue = await applySaleMovement({
    sale: reversedSale,
    type: "sale_issue",
    idempotencyKey: `analytics-sale-issue-${suffix}`,
    sourceType: "sale",
    sourceId: reversedSale.saleId,
    allow: "sale_issue",
  });
  await pool.execute(
    `UPDATE sales SET status='cancelled',version=version+1,cancelled_by=?,
       cancelled_at=UTC_TIMESTAMP(3),cancellation_reason='Anulación fixture'
     WHERE id=?`,
    [auth.user.id, reversedSale.saleId],
  );
  const [cancellation] = await pool.execute(
    `INSERT INTO sale_cancellations
      (sale_id,verification_reference,physical_observation,never_dispatched,
       all_quantities_present,all_products_saleable)
     VALUES (?, ?, 'Fixture físico verificado', 1, 1, 1)`,
    [reversedSale.saleId, `CANCEL-${suffix}`],
  );
  const reversal = await applySaleMovement({
    sale: reversedSale,
    type: "sale_reversal",
    idempotencyKey: `analytics-sale-reversal-${suffix}`,
    sourceType: "sale_cancellation",
    sourceId: String(cancellation.insertId),
    allow: "sale_reversal",
  });
  await pool.execute(
    "UPDATE sale_cancellations SET source_operation_id=? WHERE id=?",
    [reversal.operationId, cancellation.insertId],
  );

  const returnedSale = await insertSale({ index: 2, quantity: 5 });
  await applySaleMovement({
    sale: returnedSale,
    type: "sale_issue",
    idempotencyKey: `analytics-sale-issue-return-${suffix}`,
    sourceType: "sale",
    sourceId: returnedSale.saleId,
    allow: "sale_issue",
  });
  const [returnDoc] = await pool.execute(
    `INSERT INTO customer_returns
      (sale_id,reference,reason,physical_observation,received_physical,inspected,returned_by)
     VALUES (?, ?, 'Devolución fixture', 'Inspección fixture', 1, 1, ?)`,
    [returnedSale.saleId, `RETURN-${suffix}`, auth.user.id],
  );
  await pool.execute(
    `INSERT INTO customer_return_lines
      (customer_return_id,sale_id,sale_line_id,product_id,sku_snapshot,product_name_snapshot,
       unit_snapshot,quantity_received,quantity_restocked)
     VALUES (?, ?, ?, ?, ?, ?, 'unidad', 3, 3)`,
    [
      returnDoc.insertId,
      returnedSale.saleId,
      returnedSale.saleLineId,
      scopedProductId,
      `SALE-RPT-${suffix}`,
      `Producto ventas analítica ${suffix}`,
    ],
  );
  const restock = await applySaleMovement({
    sale: { ...returnedSale, quantity: 3 },
    type: "customer_return",
    idempotencyKey: `analytics-customer-return-${suffix}`,
    sourceType: "customer_return",
    sourceId: String(returnDoc.insertId),
    allow: "customer_return",
  });
  await pool.execute(
    "UPDATE customer_returns SET source_operation_id=? WHERE id=?",
    [restock.operationId, returnDoc.insertId],
  );

  const [noRestockDoc] = await pool.execute(
    `INSERT INTO customer_returns
      (sale_id,reference,reason,physical_observation,received_physical,inspected,returned_by)
     VALUES (?, ?, 'No reincorporable fixture', 'No apto fixture', 1, 1, ?)`,
    [returnedSale.saleId, `NO-RESTOCK-${suffix}`, auth.user.id],
  );
  await pool.execute(
    `INSERT INTO customer_return_lines
      (customer_return_id,sale_id,sale_line_id,product_id,sku_snapshot,product_name_snapshot,
       unit_snapshot,quantity_received,quantity_restocked,non_restock_reason)
     VALUES (?, ?, ?, ?, ?, ?, 'unidad', 2, 0, 'No apto para reincorporación')`,
    [
      noRestockDoc.insertId,
      returnedSale.saleId,
      returnedSale.saleLineId,
      scopedProductId,
      `SALE-RPT-${suffix}`,
      `Producto ventas analítica ${suffix}`,
    ],
  );

  const [[period]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','-05:00'),'%Y-%m-%d') AS day
     FROM inventory_operations WHERE id=?`,
    [issue.operationId],
  );
  const activity = await analytics.periodActivity({
    auth,
    warehouseId: scopedWarehouseId,
    dateFrom: period.day,
    dateTo: period.day,
  });
  const byType = new Map(
    activity.groups.map((group) => [group.operationType, group]),
  );
  assert.equal(byType.get("sale_issue").verifiedMovements, "2");
  assert.equal(byType.get("sale_issue").exits, "11");
  assert.equal(byType.get("sale_reversal").entries, "6");
  assert.equal(byType.get("customer_return").entries, "3");
  assert.equal(activity.summary.verifiedMovements, "5");
  assert.deepEqual(activity.summary.documentEffects, {
    observation: "commercial_document_line_effects",
    unit: "document_line_effects",
    candidateEffects: "4",
    uncreditedEffects: "0",
  });
  assert.equal(
    activity.groups.some(
      (group) =>
        group.operationType === "customer_return" && group.entries === "5",
    ),
    false,
  );
  const [[balance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id=? AND warehouse_id=?",
    [scopedProductId, scopedWarehouseId],
  );
  assert.equal(String(balance.quantity), "28");
});

test("receipts and supplier returns are tied to their persisted lines; extra movements are excluded whole", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`PUR-RPT-${suffix}`, `Bodega compras analítica ${suffix}`],
  );
  const scopedWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, scopedWarehouseId],
  );
  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (identification_number,business_name) VALUES (?,?)",
    [`PUR-RPT-${suffix}`, `Proveedor analítica ${suffix}`],
  );
  const productIds = [];
  for (const index of [0, 1]) {
    const [product] = await pool.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
       VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
      [
        `PUR-RPT-${suffix}-${index}`,
        `Producto compra ${suffix} ${index}`,
        categoryId,
      ],
    );
    productIds.push(String(product.insertId));
  }

  async function createOrder({ index, includeSecondLine }) {
    const [order] = await pool.execute(
      `INSERT INTO purchase_orders
        (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,
         confirmed_by,confirmed_at)
       VALUES (?, ?, ?, '2026-11-07', 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3))`,
      [
        `OC-AN-${suffix}-${index}`,
        supplier.insertId,
        scopedWarehouseId,
        auth.user.id,
        auth.user.id,
        auth.user.id,
      ],
    );
    const lines = [];
    const productIndexes = includeSecondLine ? [0, 1] : [0];
    for (const [position, productIndex] of productIndexes.entries()) {
      const [line] = await pool.execute(
        `INSERT INTO purchase_order_lines
          (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,
           quantity,unit_cost,line_total)
         VALUES (?, ?, ?, ?, ?, 'unidad', 10, 1, 10)`,
        [
          order.insertId,
          productIds[productIndex],
          position + 1,
          `PUR-RPT-${suffix}-${productIndex}`,
          `Producto compra ${suffix} ${productIndex}`,
        ],
      );
      lines.push({ id: String(line.insertId), productIndex });
    }
    return { id: String(order.insertId), lines };
  }

  async function receive({ order, index, movementLines, documentLines }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [receipt] = await connection.execute(
        `INSERT INTO purchase_receipts (purchase_order_id,reference,received_by)
         VALUES (?, ?, ?)`,
        [order.id, `REC-AN-${suffix}-${index}`, auth.user.id],
      );
      const receiptLineIds = [];
      for (const { orderLineIndex, quantity } of documentLines) {
        const [receiptLine] = await connection.execute(
          `INSERT INTO purchase_receipt_lines
            (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity)
           VALUES (?, ?, ?, ?)`,
          [
            receipt.insertId,
            order.id,
            order.lines[orderLineIndex].id,
            quantity,
          ],
        );
        receiptLineIds.push(String(receiptLine.insertId));
      }
      const lines = [];
      for (const { productIndex, quantity } of movementLines) {
        const [[balance]] = await connection.execute(
          `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
           WHERE product_id=? AND warehouse_id=?`,
          [productIds[productIndex], scopedWarehouseId],
        );
        lines.push({
          productId: productIds[productIndex],
          quantity,
          expectedVersion: balance?.version || "0",
        });
      }
      const operation = await engine.applyWithinTransaction({
        connection,
        userId: auth.user.id,
        idempotencyKey: `analytics-purchase-receipt-${suffix}-${index}`,
        internal: true,
        payload: {
          type: "purchase_receipt",
          sourceWarehouseId: scopedWarehouseId,
          destinationWarehouseId: null,
          sourceType: "purchase_receipt",
          sourceId: String(receipt.insertId),
          reason: "Fixture de recepción analítica",
          reference: `REC-AN-${suffix}-${index}`,
          lines,
        },
      });
      await connection.execute(
        "UPDATE purchase_receipts SET source_operation_id=? WHERE id=?",
        [operation.operationId, receipt.insertId],
      );
      await connection.commit();
      return { receiptId: String(receipt.insertId), receiptLineIds, operation };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function unlinkedReceiptMovement({ index, productIndex, quantity }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[balance]] = await connection.execute(
        `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
         WHERE product_id=? AND warehouse_id=? FOR UPDATE`,
        [productIds[productIndex], scopedWarehouseId],
      );
      const operation = await engine.applyWithinTransaction({
        connection,
        userId: auth.user.id,
        idempotencyKey: `analytics-unlinked-receipt-${suffix}-${index}`,
        internal: true,
        payload: {
          type: "purchase_receipt",
          sourceWarehouseId: scopedWarehouseId,
          destinationWarehouseId: null,
          sourceType: "purchase_receipt",
          sourceId: `missing-receipt-${suffix}-${index}`,
          reason: "Movimiento sin documento de recepción",
          reference: `MISSING-${suffix}-${index}`,
          lines: [
            {
              productId: productIds[productIndex],
              quantity,
              expectedVersion: balance?.version || "0",
            },
          ],
        },
      });
      await connection.commit();
      return operation;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const validOrder = await createOrder({ index: 1, includeSecondLine: false });
  const validReceipt = await receive({
    order: validOrder,
    index: 1,
    movementLines: [{ productIndex: 0, quantity: 4 }],
    documentLines: [{ orderLineIndex: 0, quantity: 4 }],
  });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [returnDoc] = await connection.execute(
      `INSERT INTO supplier_returns
        (purchase_order_id,purchase_receipt_id,reference,reason,idempotency_key,request_hash,returned_by)
       VALUES (?, ?, ?, 'Devolución fixture', ?, ?, ?)`,
      [
        validOrder.id,
        validReceipt.receiptId,
        `DEV-PROV-${suffix}`,
        `analytics-supplier-return-${suffix}`,
        "a".repeat(64),
        auth.user.id,
      ],
    );
    await connection.execute(
      `INSERT INTO supplier_return_lines
        (supplier_return_id,purchase_order_id,purchase_receipt_id,purchase_receipt_line_id,
         purchase_order_line_id,product_id,sku_snapshot,name_snapshot,unit_snapshot,quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unidad', 1)`,
      [
        returnDoc.insertId,
        validOrder.id,
        validReceipt.receiptId,
        validReceipt.receiptLineIds[0],
        validOrder.lines[0].id,
        productIds[0],
        `PUR-RPT-${suffix}-0`,
        `Producto compra ${suffix} 0`,
      ],
    );
    const [[balance]] = await connection.execute(
      `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
       WHERE product_id=? AND warehouse_id=? FOR UPDATE`,
      [productIds[0], scopedWarehouseId],
    );
    const returned = await engine.applyWithinTransaction({
      connection,
      userId: auth.user.id,
      idempotencyKey: `analytics-supplier-return-${suffix}`,
      internal: true,
      payload: {
        type: "supplier_return",
        sourceWarehouseId: scopedWarehouseId,
        destinationWarehouseId: null,
        sourceType: "supplier_return",
        sourceId: String(returnDoc.insertId),
        reason: "Fixture de devolución a proveedor",
        reference: `DEV-PROV-${suffix}`,
        lines: [
          {
            productId: productIds[0],
            quantity: 1,
            expectedVersion: balance.version,
          },
        ],
      },
    });
    await connection.execute(
      "UPDATE supplier_returns SET source_operation_id=? WHERE id=?",
      [returned.operationId, returnDoc.insertId],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const malformedOrder = await createOrder({
    index: 2,
    includeSecondLine: true,
  });
  const malformedReceipt = await receive({
    order: malformedOrder,
    index: 2,
    movementLines: [
      { productIndex: 0, quantity: 3 },
      { productIndex: 1, quantity: 2 },
    ],
    documentLines: [{ orderLineIndex: 0, quantity: 3 }],
  });
  const emptyDocumentOrder = await createOrder({
    index: 3,
    includeSecondLine: false,
  });
  const emptyDocumentReceipt = await receive({
    order: emptyDocumentOrder,
    index: 3,
    movementLines: [{ productIndex: 1, quantity: 1 }],
    documentLines: [],
  });
  const unlinkedOperation = await unlinkedReceiptMovement({
    index: 4,
    productIndex: 1,
    quantity: 1,
  });

  const quantityOrder = await createOrder({
    index: 5,
    includeSecondLine: false,
  });
  const quantityMismatch = await receive({
    order: quantityOrder,
    index: 5,
    movementLines: [{ productIndex: 0, quantity: 2 }],
    documentLines: [{ orderLineIndex: 0, quantity: 3 }],
  });
  const productOrder = await createOrder({ index: 6, includeSecondLine: true });
  const productMismatch = await receive({
    order: productOrder,
    index: 6,
    movementLines: [{ productIndex: 0, quantity: 1 }],
    documentLines: [{ orderLineIndex: 1, quantity: 1 }],
  });
  const unitOrder = await createOrder({ index: 7, includeSecondLine: false });
  await pool.execute(
    "UPDATE purchase_order_lines SET unit_snapshot='caja' WHERE id=?",
    [unitOrder.lines[0].id],
  );
  const unitMismatch = await receive({
    order: unitOrder,
    index: 7,
    movementLines: [{ productIndex: 0, quantity: 1 }],
    documentLines: [{ orderLineIndex: 0, quantity: 1 }],
  });
  const [foreignWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`PUR-FOREIGN-${suffix}`, `Bodega ajena de fixture ${suffix}`],
  );
  const warehouseOrder = await createOrder({
    index: 8,
    includeSecondLine: false,
  });
  await pool.execute("UPDATE purchase_orders SET warehouse_id=? WHERE id=?", [
    foreignWarehouse.insertId,
    warehouseOrder.id,
  ]);
  const warehouseMismatch = await receive({
    order: warehouseOrder,
    index: 8,
    movementLines: [{ productIndex: 0, quantity: 1 }],
    documentLines: [{ orderLineIndex: 0, quantity: 1 }],
  });
  const [[period]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','-05:00'),'%Y-%m-%d') AS day
     FROM inventory_operations WHERE id=?`,
    [validReceipt.operation.operationId],
  );
  const activity = await analytics.periodActivity({
    auth,
    warehouseId: scopedWarehouseId,
    dateFrom: period.day,
    dateTo: period.day,
  });
  assert.equal(activity.summary.candidateMovements, "10");
  assert.equal(activity.summary.verifiedMovements, "2");
  assert.equal(activity.summary.excludedMovements, "8");
  assert.equal(activity.summary.inconsistentMovements, "6");
  assert.equal(activity.summary.insufficientMovements, "2");
  assert.deepEqual(activity.summary.documentEffects, {
    observation: "commercial_document_line_effects",
    unit: "document_line_effects",
    candidateEffects: "6",
    uncreditedEffects: "4",
  });
  assert.equal(activity.coverage.completeWithinCandidates, false);
  const groups = new Map(
    activity.groups.map((group) => [group.operationType, group]),
  );
  assert.equal(groups.get("purchase_receipt").entries, "4");
  assert.equal(groups.get("supplier_return").exits, "1");
  assert.equal(groups.get("purchase_receipt").verifiedMovements, "1");
  assert.equal(activity.groups.length, 2);
  assert.equal(
    activity.groups.some(
      (group) => group.entries === "2" || group.entries === "3",
    ),
    false,
  );
  assert.ok(malformedReceipt.operation.operationId);
  assert.ok(emptyDocumentReceipt.operation.operationId);
  assert.ok(unlinkedOperation.operationId);
  assert.ok(quantityMismatch.operation.operationId);
  assert.ok(productMismatch.operation.operationId);
  assert.ok(unitMismatch.operation.operationId);
  assert.ok(warehouseMismatch.operation.operationId);
});

test("period activity aggregates physical movements by warehouse, type and historical unit", async () => {
  const [boxProduct] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'caja', 1, 2, 0)`,
    [`PERIOD-BOX-${suffix}`, `Producto caja período ${suffix}`, categoryId],
  );
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-period-unit-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Fixture unidad histórica del período",
      reference: `PERIOD-UNIT-${suffix}`,
      lines: [{ productId, quantity: 9 }],
    },
  });
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-period-box-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Fixture caja del período",
      reference: `PERIOD-BOX-${suffix}`,
      lines: [{ productId: String(boxProduct.insertId), quantity: 4 }],
    },
  });
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1))
    .toISOString()
    .slice(0, 10);
  const result = await analytics.periodActivity({
    auth,
    warehouseId,
    dateFrom: day,
    dateTo: next,
    page: 1,
    pageSize: 20,
  });
  assert.equal(result.summary.verifiedMovements, "2");
  assert.equal(result.pagination.total, "2");
  const unitGroup = result.groups.find((group) => group.unit === "unidad");
  assert.equal(unitGroup.warehouseId, warehouseId);
  assert.equal(unitGroup.operationType, "initial_stock");
  assert.equal(unitGroup.entries, "9");
  assert.equal(unitGroup.exits, "0");
  assert.equal(unitGroup.netChange, "9");
  const boxGroup = result.groups.find((group) => group.unit === "caja");
  assert.equal(boxGroup.entries, "4");
  assert.equal(boxGroup.netChange, "4");
});

test("transfers verify both effects while reports disclose only assigned warehouses", async () => {
  const [source] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`TR-SRC-${suffix}`, `Bodega origen traslado ${suffix}`],
  );
  const [destination] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`TR-DST-${suffix}`, `Bodega destino traslado ${suffix}`],
  );
  const sourceId = String(source.insertId);
  const destinationId = String(destination.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, sourceId],
  );
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, destinationId],
  );
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`TR-${suffix}`, `Producto traslado ${suffix}`, categoryId],
  );
  const transferProductId = String(product.insertId);
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-transfer-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: sourceId,
      destinationWarehouseId: null,
      reason: "Existencia de fixture para traslado",
      reference: `TR-OPEN-${suffix}`,
      lines: [{ productId: transferProductId, quantity: 8 }],
    },
  });
  await engine.createOperation({
    userId: auth.user.id,
    idempotencyKey: `analytics-transfer-${suffix}`,
    payload: {
      type: "transfer",
      sourceWarehouseId: sourceId,
      destinationWarehouseId: destinationId,
      reason: "Fixture de privacidad de traslado",
      reference: `TR-${suffix}`,
      lines: [
        { productId: transferProductId, quantity: 2, expectedVersion: "1" },
      ],
    },
  });
  const onlyExit = await createOneSidedTransfer({
    label: "out-only",
    sourceWarehouseId: sourceId,
    destinationWarehouseId: destinationId,
    sourceOpening: 8,
    destinationOpening: 4,
    direction: "OUT",
  });
  const onlyEntry = await createOneSidedTransfer({
    label: "in-only",
    sourceWarehouseId: sourceId,
    destinationWarehouseId: destinationId,
    sourceOpening: 5,
    destinationOpening: 2,
    direction: "IN",
  });
  const [[outOnlyEvidence]] = await pool.execute(
    `SELECT im.direction,im.warehouse_id,im.quantity,im.unit_snapshot
       FROM inventory_movements im WHERE im.operation_id=?`,
    [onlyExit.operationId],
  );
  const [[inOnlyEvidence]] = await pool.execute(
    `SELECT im.direction,im.warehouse_id,im.quantity,im.unit_snapshot
       FROM inventory_movements im WHERE im.operation_id=?`,
    [onlyEntry.operationId],
  );
  assert.deepEqual(
    {
      direction: outOnlyEvidence.direction,
      warehouseId: String(outOnlyEvidence.warehouse_id),
      quantity: String(outOnlyEvidence.quantity),
      unit: outOnlyEvidence.unit_snapshot,
    },
    { direction: "OUT", warehouseId: sourceId, quantity: "2", unit: "unidad" },
  );
  assert.deepEqual(
    {
      direction: inOnlyEvidence.direction,
      warehouseId: String(inOnlyEvidence.warehouse_id),
      quantity: String(inOnlyEvidence.quantity),
      unit: inOnlyEvidence.unit_snapshot,
    },
    {
      direction: "IN",
      warehouseId: destinationId,
      quantity: "2",
      unit: "unidad",
    },
  );
  await pool.execute(
    `INSERT INTO inventory_operations
      (operation_type,source_warehouse_id,destination_warehouse_id,created_by,reason,reference,
       idempotency_key,request_hash)
     VALUES ('transfer', ?, ?, ?, 'Traslado sintético sin efectos para diagnóstico', ?, ?, ?)`,
    [
      sourceId,
      destinationId,
      auth.user.id,
      `TR-MISSING-${suffix}`,
      `analytics-transfer-missing-${suffix}`,
      "e".repeat(64),
    ],
  );
  const [[period]] = await pool.execute(
    `SELECT DATE_FORMAT(CONVERT_TZ(MIN(created_at),'+00:00','-05:00'),'%Y-%m-%d') AS day
      FROM inventory_operations WHERE created_by=? AND idempotency_key IN (?,?)`,
    [
      auth.user.id,
      `analytics-transfer-${suffix}`,
      `analytics-transfer-missing-${suffix}`,
    ],
  );
  const bothAuth = await createReporterAuth(`transfer-both`, [
    sourceId,
    destinationId,
  ]);
  const sourceAuth = await createReporterAuth(`transfer-source`, [sourceId]);
  const destinationAuth = await createReporterAuth(`transfer-destination`, [
    destinationId,
  ]);
  const noWarehouseAuth = await createReporterAuth(`transfer-none`);
  const read = (reportAuth) =>
    analytics.periodActivity({
      auth: reportAuth,
      dateFrom: period.day,
      dateTo: period.day,
    });
  const both = await read(bothAuth);
  assert.equal(both.summary.candidateMovements, "9");
  assert.equal(both.summary.verifiedMovements, "7");
  assert.equal(both.summary.excludedMovements, "2");
  assert.deepEqual(both.summary.transferIntegrity, {
    observation: "transfer_operations",
    candidateOperations: "4",
    incompleteOperations: "3",
  });
  assert.deepEqual(both.coverage.transferIntegrity, {
    observation: "transfer_operations",
    candidateOperations: "4",
    incompleteOperations: "3",
    completeWithinCandidates: false,
  });
  assert.equal(
    both.groups.filter((group) => group.operationType === "transfer").length,
    2,
  );
  const fullTransferGroups = both.groups.filter(
    (group) => group.operationType === "transfer",
  );
  assert.equal(
    fullTransferGroups.reduce(
      (total, group) => total + Number(group.entries) + Number(group.exits),
      0,
    ),
    4,
  );
  const sourceStock = await analytics.currentStock({
    auth: bothAuth,
    warehouseId: sourceId,
  });
  const destinationStock = await analytics.currentStock({
    auth: bothAuth,
    warehouseId: destinationId,
  });
  assert.equal(sourceStock.summary.candidatePairs, "3");
  assert.equal(sourceStock.summary.verifiedPairs, "1");
  assert.equal(sourceStock.summary.excludedPairs, "2");
  assert.equal(sourceStock.summary.units[0].quantity, "6");
  assert.equal(destinationStock.summary.candidatePairs, "3");
  assert.equal(destinationStock.summary.verifiedPairs, "1");
  assert.equal(destinationStock.summary.excludedPairs, "2");
  assert.equal(destinationStock.summary.units[0].quantity, "2");

  const sourceOnly = await read(sourceAuth);
  const sourceTransfer = sourceOnly.groups.find(
    (group) => group.operationType === "transfer",
  );
  assert.ok(sourceTransfer);
  assert.equal(sourceTransfer.warehouseId, sourceId);
  assert.equal(sourceTransfer.exits, "2");
  assert.deepEqual(sourceOnly.summary.transferIntegrity, {
    observation: "transfer_operations",
    candidateOperations: "4",
    incompleteOperations: "3",
  });
  assert.equal(sourceOnly.summary.candidateMovements, "5");
  assert.equal(sourceOnly.summary.excludedMovements, "1");
  const sourceVisibleTransferGroups = sourceOnly.groups.filter(
    (group) => group.operationType === "transfer",
  );
  assert.equal(sourceVisibleTransferGroups.length, 1);
  assert.equal(sourceVisibleTransferGroups[0].exits, "2");
  assert.equal(sourceVisibleTransferGroups[0].entries, "0");
  assert.equal(JSON.stringify(sourceOnly).includes(destinationId), false);
  assert.equal(
    JSON.stringify(sourceOnly).includes(`Bodega destino traslado ${suffix}`),
    false,
  );
  assert.equal(JSON.stringify(sourceOnly).includes(`TR-DST-${suffix}`), false);
  const destinationOnly = await read(destinationAuth);
  const destinationTransfer = destinationOnly.groups.find(
    (group) => group.operationType === "transfer",
  );
  assert.ok(destinationTransfer);
  assert.equal(destinationTransfer.warehouseId, destinationId);
  assert.equal(destinationTransfer.entries, "2");
  assert.deepEqual(destinationOnly.summary.transferIntegrity, {
    observation: "transfer_operations",
    candidateOperations: "4",
    incompleteOperations: "3",
  });
  assert.equal(destinationOnly.summary.candidateMovements, "4");
  assert.equal(destinationOnly.summary.excludedMovements, "1");
  const destinationVisibleTransferGroups = destinationOnly.groups.filter(
    (group) => group.operationType === "transfer",
  );
  assert.equal(destinationVisibleTransferGroups.length, 1);
  assert.equal(destinationVisibleTransferGroups[0].entries, "2");
  assert.equal(destinationVisibleTransferGroups[0].exits, "0");
  assert.equal(JSON.stringify(destinationOnly).includes(sourceId), false);
  assert.equal(
    JSON.stringify(destinationOnly).includes(
      `Bodega origen traslado ${suffix}`,
    ),
    false,
  );
  assert.equal(
    JSON.stringify(destinationOnly).includes(`TR-SRC-${suffix}`),
    false,
  );
  const sourceStockOnly = await analytics.currentStock({
    auth: sourceAuth,
    warehouseId: sourceId,
  });
  const destinationStockOnly = await analytics.currentStock({
    auth: destinationAuth,
    warehouseId: destinationId,
  });
  assert.equal(sourceStockOnly.summary.excludedPairs, "2");
  assert.equal(destinationStockOnly.summary.excludedPairs, "2");
  assert.equal(JSON.stringify(sourceStockOnly).includes(destinationId), false);
  assert.equal(
    JSON.stringify(sourceStockOnly).includes(`TR-DST-${suffix}`),
    false,
  );
  assert.equal(JSON.stringify(destinationStockOnly).includes(sourceId), false);
  assert.equal(
    JSON.stringify(destinationStockOnly).includes(`TR-SRC-${suffix}`),
    false,
  );
  const none = await read(noWarehouseAuth);
  assert.equal(none.summary.candidateMovements, "0");
  assert.equal(none.summary.verifiedMovements, "0");
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.summary.transferIntegrity, {
    observation: "transfer_operations",
    candidateOperations: "0",
    incompleteOperations: "0",
  });
  assert.equal(JSON.stringify(none).includes(sourceId), false);
  assert.equal(JSON.stringify(none).includes(destinationId), false);
  const noWarehouseStock = await analytics.currentStock({
    auth: noWarehouseAuth,
  });
  assert.equal(noWarehouseStock.summary.candidatePairs, "0");
  assert.equal(noWarehouseStock.summary.verifiedPairs, "0");
  assert.deepEqual(noWarehouseStock.groups, []);
  assert.equal(JSON.stringify(noWarehouseStock).includes(sourceId), false);
  assert.equal(JSON.stringify(noWarehouseStock).includes(destinationId), false);
});

test("both analytical views paginate deterministically without changing summaries", async () => {
  const [[adminRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='administrator'",
  );
  const [pageUser] = await pool.execute(
    `INSERT INTO users (role_id,email,password_hash) VALUES (?,?,'reports-page-test-hash')`,
    [adminRole.id, `reports-page-${suffix}@sigecom.invalid`],
  );
  const pageUserId = String(pageUser.insertId);
  const [pageSession] = await pool.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
    [pageUserId, `reports-page-${suffix}`],
  );
  const pageAuth = {
    user: { id: pageUserId, role: "administrator" },
    sessionId: String(pageSession.insertId),
  };
  const units = ["unidad", "caja", "paquete"];
  const groupCodes = [];
  const scopedWarehouseIds = [];
  const scopedProductIds = [];
  let activityDate;
  for (const [index, unit] of units.entries()) {
    const [warehouse] = await pool.execute(
      "INSERT INTO warehouses (code,name) VALUES (?,?)",
      [`PG-${suffix}-${index}`, `Bodega paginación ${suffix} ${index}`],
    );
    const scopedWarehouseId = String(warehouse.insertId);
    scopedWarehouseIds.push(scopedWarehouseId);
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [pageAuth.user.id, scopedWarehouseId],
    );
    const [product] = await pool.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
       VALUES (?, ?, ?, ?, 1, 2, 0)`,
      [
        `PG-${suffix}-${index}`,
        `Producto paginación ${suffix} ${index}`,
        categoryId,
        unit,
      ],
    );
    const scopedProductId = String(product.insertId);
    scopedProductIds.push(scopedProductId);
    const operation = await engine.createOperation({
      userId: pageAuth.user.id,
      idempotencyKey: `analytics-page-${suffix}-${index}`,
      payload: {
        type: "initial_stock",
        sourceWarehouseId: scopedWarehouseId,
        destinationWarehouseId: null,
        reason: "Fixture de paginación analítica",
        reference: `PG-${suffix}-${index}`,
        lines: [{ productId: scopedProductId, quantity: index + 1 }],
      },
    });
    const [[created]] = await pool.execute(
      `SELECT DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','-05:00'),'%Y-%m-%d') AS bogota_date
       FROM inventory_operations WHERE id=?`,
      [operation.operationId],
    );
    activityDate ??= created.bogota_date;
    assert.equal(created.bogota_date, activityDate);
    groupCodes.push(`PG-${suffix}-${index}`);
  }
  const [unsupportedProduct] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
     VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
    [`PG-UNSUPPORTED-${suffix}`, `Saldo sin historial ${suffix}`, categoryId],
  );
  await pool.execute(
    `INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version)
     VALUES (?, ?, 99, 0)`,
    [unsupportedProduct.insertId, scopedWarehouseIds[0]],
  );

  const stockPage1 = await analytics.currentStock({
    auth: pageAuth,
    page: 1,
    pageSize: 2,
  });
  const stockPage2 = await analytics.currentStock({
    auth: pageAuth,
    page: 2,
    pageSize: 2,
  });
  const stockOutOfRange = await analytics.currentStock({
    auth: pageAuth,
    page: 3,
    pageSize: 2,
  });
  assert.equal(stockPage1.pagination.total, "3");
  assert.equal(stockPage1.summary.candidatePairs, "4");
  assert.equal(stockPage1.summary.verifiedPairs, "3");
  assert.equal(stockPage1.summary.excludedPairs, "1");
  assert.equal(stockPage1.summary.inconsistentPairs, "1");
  assert.equal(stockPage1.coverage.completeWithinCandidates, false);
  assert.equal(
    stockPage1.summary.units.find((row) => row.unit === "unidad").quantity,
    "1",
  );
  assert.equal(stockPage1.pagination.totalPages, "2");
  assert.deepEqual(
    stockPage1.groups.map((group) => group.warehouseCode),
    groupCodes.slice(0, 2),
  );
  assert.deepEqual(
    stockPage2.groups.map((group) => group.warehouseCode),
    groupCodes.slice(2),
  );
  assert.equal(stockOutOfRange.groups.length, 0);
  assert.deepEqual(stockPage1.summary, stockPage2.summary);
  assert.equal(
    new Set(
      [...stockPage1.groups, ...stockPage2.groups].map(
        (group) => group.warehouseId,
      ),
    ).size,
    3,
  );

  const invalidConnection = await pool.getConnection();
  try {
    await invalidConnection.beginTransaction();
    const [[balance]] = await invalidConnection.execute(
      `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
       WHERE product_id=? AND warehouse_id=? FOR UPDATE`,
      [scopedProductIds[0], scopedWarehouseIds[0]],
    );
    await engine.applyWithinTransaction({
      connection: invalidConnection,
      userId: pageUserId,
      idempotencyKey: `analytics-page-invalid-${suffix}`,
      internal: true,
      payload: {
        type: "purchase_receipt",
        sourceWarehouseId: scopedWarehouseIds[0],
        destinationWarehouseId: null,
        sourceType: "purchase_receipt",
        sourceId: `missing-receipt-${suffix}`,
        reason: "Movimiento sin respaldo documental",
        reference: `PG-INVALID-${suffix}`,
        lines: [
          {
            productId: scopedProductIds[0],
            quantity: 50,
            expectedVersion: balance.version,
          },
        ],
      },
    });
    await invalidConnection.commit();
  } catch (error) {
    await invalidConnection.rollback();
    throw error;
  } finally {
    invalidConnection.release();
  }

  const activityArgs = {
    auth: pageAuth,
    dateFrom: activityDate,
    dateTo: activityDate,
    pageSize: 2,
  };
  const activityPage1 = await analytics.periodActivity({
    ...activityArgs,
    page: 1,
  });
  const activityPage2 = await analytics.periodActivity({
    ...activityArgs,
    page: 2,
  });
  const activityOutOfRange = await analytics.periodActivity({
    ...activityArgs,
    page: 3,
  });
  assert.equal(activityPage1.pagination.total, "3");
  assert.equal(activityPage1.summary.candidateMovements, "4");
  assert.equal(activityPage1.summary.verifiedMovements, "3");
  assert.equal(activityPage1.summary.excludedMovements, "1");
  assert.equal(activityPage1.summary.insufficientMovements, "1");
  assert.equal(
    activityPage1.summary.units.find((row) => row.unit === "unidad").entries,
    "1",
  );
  assert.equal(activityPage1.pagination.totalPages, "2");
  assert.deepEqual(
    activityPage1.groups.map((group) => group.warehouseCode),
    groupCodes.slice(0, 2),
  );
  assert.deepEqual(
    activityPage2.groups.map((group) => group.warehouseCode),
    groupCodes.slice(2),
  );
  assert.equal(activityOutOfRange.groups.length, 0);
  assert.deepEqual(activityPage1.summary, activityPage2.summary);
  assert.equal(
    new Set(
      [...activityPage1.groups, ...activityPage2.groups].map(
        (group) => group.warehouseId,
      ),
    ).size,
    3,
  );
  assert.deepEqual(
    activityPage1.summary.units.map((row) => row.unit),
    [...units].sort(),
  );
});

test("Bogotá midnight assigns fixed UTC instants to exactly one activity day", async () => {
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name) VALUES (?,?)",
    [`MID-${suffix}`, `Bodega medianoche ${suffix}`],
  );
  const midnightWarehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auth.user.id, midnightWarehouseId],
  );
  const productIds = [];
  for (const index of [0, 1]) {
    const [product] = await pool.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price,minimum_stock)
       VALUES (?, ?, ?, 'unidad', 1, 2, 0)`,
      [
        `MID-${suffix}-${index}`,
        `Producto medianoche ${suffix} ${index}`,
        categoryId,
      ],
    );
    productIds.push(String(product.insertId));
  }

  const instants = ["2026-11-07 04:59:59", "2026-11-07 05:00:00"];
  for (const [index, instant] of instants.entries()) {
    const connection = await pool.getConnection();
    try {
      const [[timestamp]] = await connection.execute(
        "SELECT UNIX_TIMESTAMP(?) AS value",
        [instant],
      );
      await connection.execute("SET timestamp = ?", [Number(timestamp.value)]);
      await connection.beginTransaction();
      await engine.applyWithinTransaction({
        connection,
        userId: auth.user.id,
        idempotencyKey: `analytics-midnight-${suffix}-${index}`,
        payload: {
          type: "initial_stock",
          sourceWarehouseId: midnightWarehouseId,
          destinationWarehouseId: null,
          reason: "Fixture determinista de límite Bogotá",
          reference: `MID-${suffix}-${index}`,
          lines: [{ productId: productIds[index], quantity: index + 1 }],
        },
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.execute("SET timestamp = 0");
      connection.release();
    }
  }

  const beforeMidnight = await analytics.periodActivity({
    auth,
    warehouseId: midnightWarehouseId,
    dateFrom: "2026-11-06",
    dateTo: "2026-11-06",
  });
  const afterMidnight = await analytics.periodActivity({
    auth,
    warehouseId: midnightWarehouseId,
    dateFrom: "2026-11-07",
    dateTo: "2026-11-07",
  });
  assert.equal(beforeMidnight.summary.verifiedMovements, "1");
  assert.equal(beforeMidnight.summary.units[0].entries, "1");
  assert.equal(afterMidnight.summary.verifiedMovements, "1");
  assert.equal(afterMidnight.summary.units[0].entries, "2");
  assert.equal(
    BigInt(beforeMidnight.summary.units[0].entries) +
      BigInt(afterMidnight.summary.units[0].entries),
    3n,
  );
});

test("activity period enforces valid Bogotá calendar ranges up to 92 days", async () => {
  const { validateInventoryActivityPeriod } =
    await import("../../src/modules/reports/inventory-analytics-service.js");
  assert.deepEqual(
    validateInventoryActivityPeriod("2026-11-01", "2027-01-31"),
    {
      startUtc: "2026-11-01 05:00:00.000",
      endUtc: "2027-02-01 05:00:00.000",
    },
  );
  assert.throws(
    () => validateInventoryActivityPeriod("2026-11-02", "2026-11-01"),
    { code: "INVALID_REPORT_PERIOD" },
  );
  assert.throws(
    () => validateInventoryActivityPeriod("2026-01-01", "2026-04-03"),
    { code: "INVALID_REPORT_PERIOD" },
  );
});
