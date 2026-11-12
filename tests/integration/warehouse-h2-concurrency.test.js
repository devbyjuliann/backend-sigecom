import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import mysql from "mysql2/promise";
import { createPurchaseService } from "../../src/modules/purchases/purchase-service.js";
import { createWarehouseService } from "../../src/modules/warehouses/warehouse-service.js";

const databaseName = process.env.SIGECOM_H2_DATABASE;
const databaseUser = process.env.SIGECOM_H2_USER;
const databasePassword = process.env.SIGECOM_H2_PASSWORD;
const enabled = Boolean(databaseName && databaseUser && databasePassword);

if (enabled && databaseName !== "sigecom_h2_concurrency") {
  throw new Error(
    "H2 integration tests only accept the dedicated sigecom_h2_concurrency schema.",
  );
}
if (enabled && databaseUser !== "sigecom_h2_runner") {
  throw new Error(
    "H2 integration tests only accept the restricted sigecom_h2_runner account.",
  );
}
if (enabled && /^(root|admin)$/i.test(databaseUser)) {
  throw new Error(
    "H2 integration tests must not connect as a database administrator.",
  );
}

let dbPool;
let fixture;

before(async () => {
  if (!enabled) return;
  dbPool = mysql.createPool({
    host: "127.0.0.1",
    port: 3306,
    database: databaseName,
    user: databaseUser,
    password: databasePassword,
    connectionLimit: 5,
    waitForConnections: true,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const [[identity]] = await dbPool.query("SELECT DATABASE() AS name");
  assert.equal(identity.name, "sigecom_h2_concurrency");
  const [[account]] = await dbPool.query("SELECT CURRENT_USER() AS name");
  assert.equal(account.name, "sigecom_h2_runner@127.0.0.1");
  const [[migrations]] = await dbPool.query(
    "SELECT COUNT(*) AS count FROM schema_migrations",
  );
  assert.equal(Number(migrations.count), 17);
  const [[isolation]] = await dbPool.query(
    "SELECT @@session.tx_isolation AS level",
  );
  assert.equal(
    String(isolation.level).toUpperCase().replaceAll("_", "-"),
    "REPEATABLE-READ",
  );
});

function gate() {
  let release;
  let signal;
  let signalled = false;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    signal = resolve;
  });
  return {
    opened,
    reached,
    open: release,
    signal() {
      if (signalled) return;
      signalled = true;
      signal();
    },
  };
}

function isWarehouseStatusLock(sql) {
  return (
    sql.includes("FROM warehouses AS w") &&
    sql.includes("access.warehouse_id = w.id") &&
    sql.includes("LIMIT 1 FOR UPDATE")
  );
}

function isPurchaseConfirmationWarehouseLock(sql) {
  return (
    sql.includes("FROM warehouses AS w") &&
    sql.includes("uw.warehouse_id = w.id") &&
    sql.includes("FOR UPDATE")
  );
}

function observedPool(pool, observe) {
  const connectionIds = new Set();
  return {
    connectionIds,
    execute: (...args) => pool.execute(...args),
    async getConnection() {
      const connection = await pool.getConnection();
      connectionIds.add(connection.threadId);
      return new Proxy(connection, {
        get(target, property) {
          if (property === "execute") {
            return async (sql, values) => {
              const result = target.execute(sql, values);
              await observe({ sql, result });
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

async function createFixture() {
  const suffix = randomBytes(6).toString("hex").toUpperCase();
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const [[role]] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator' LIMIT 1",
    );
    assert.ok(role, "dedicated schema must have the project's seeded roles");

    const [userResult] = await connection.execute(
      `INSERT INTO users (role_id, email, display_name, password_hash)
       VALUES (?, ?, ?, 'not-used-by-this-service-test')`,
      [role.id, `h2-${suffix}@sigecom.invalid`, `Fixture H2 ${suffix}`],
    );
    const userId = String(userResult.insertId);
    const [warehouseResult] = await connection.execute(
      "INSERT INTO warehouses (code, name) VALUES (?, ?)",
      [`H2-${suffix}`, `Bodega H2 ${suffix}`],
    );
    const warehouseId = String(warehouseResult.insertId);
    await connection.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
      [userId, warehouseId, userId],
    );
    const [supplierResult] = await connection.execute(
      "INSERT INTO suppliers (identification_number, business_name) VALUES (?, ?)",
      [`H2${suffix}`, `Proveedor H2 ${suffix}`],
    );
    const [categoryResult] = await connection.execute(
      "INSERT INTO categories (name) VALUES (?)",
      [`Categoría H2 ${suffix}`],
    );
    const [productResult] = await connection.execute(
      `INSERT INTO products
         (sku, name, category_id, unit, purchase_price, sale_price)
       VALUES (?, ?, ?, 'unidad', 1.00, 2.00)`,
      [`H2-${suffix}`, `Producto H2 ${suffix}`, categoryResult.insertId],
    );
    const [orderResult] = await connection.execute(
      `INSERT INTO purchase_orders
         (commercial_code, supplier_id, warehouse_id, order_date, created_by, updated_by)
       VALUES (?, ?, ?, UTC_DATE(), ?, ?)`,
      [`H2-${suffix}`, supplierResult.insertId, warehouseId, userId, userId],
    );
    const orderId = String(orderResult.insertId);
    await connection.execute(
      `INSERT INTO purchase_order_lines
         (purchase_order_id, product_id, position, sku_snapshot, name_snapshot,
          unit_snapshot, quantity, unit_cost, line_total)
       VALUES (?, ?, 1, ?, ?, 'unidad', 1, 1.00, 1.00)`,
      [
        orderId,
        productResult.insertId,
        `H2-${suffix}`,
        `Producto H2 ${suffix}`,
      ],
    );
    await connection.commit();

    fixture = {
      userId,
      warehouseId,
      orderId,
      supplierId: String(supplierResult.insertId),
      categoryId: String(categoryResult.insertId),
      productId: String(productResult.insertId),
    };
    return fixture;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanupFixture() {
  if (!fixture) return;
  const { userId, warehouseId, orderId, supplierId, categoryId, productId } =
    fixture;
  await dbPool.execute(
    `DELETE FROM audit_events
     WHERE user_id = ? AND (
       (module = 'warehouses' AND entity_id = ?)
       OR (module = 'purchases' AND entity_id = ?)
     )`,
    [userId, warehouseId, orderId],
  );
  await dbPool.execute(
    "DELETE FROM purchase_order_lines WHERE purchase_order_id = ?",
    [orderId],
  );
  await dbPool.execute("DELETE FROM purchase_orders WHERE id = ?", [orderId]);
  await dbPool.execute(
    "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [userId, warehouseId],
  );
  await dbPool.execute("DELETE FROM suppliers WHERE id = ?", [supplierId]);
  await dbPool.execute("DELETE FROM products WHERE id = ?", [productId]);
  await dbPool.execute("DELETE FROM categories WHERE id = ?", [categoryId]);
  await dbPool.execute("DELETE FROM warehouses WHERE id = ?", [warehouseId]);
  await dbPool.execute("DELETE FROM users WHERE id = ?", [userId]);
  fixture = undefined;
}

async function readReceiptAndInventoryState() {
  const [[state]] = await dbPool.execute(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receipts
        WHERE purchase_order_id = ?) AS receipts,
       (SELECT COUNT(*) FROM purchase_receipt_lines
        WHERE purchase_order_id = ?) AS receipt_lines,
       (SELECT COUNT(*) FROM inventory_balances
        WHERE warehouse_id = ? AND product_id = ?) AS balance_rows,
       (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances
        WHERE warehouse_id = ? AND product_id = ?) AS balance_quantity,
       (SELECT COUNT(*) FROM inventory_movements
        WHERE warehouse_id = ? AND product_id = ?) AS movements,
       (SELECT COUNT(*) FROM inventory_operations
        WHERE source_warehouse_id = ?) AS operations`,
    [
      fixture.orderId,
      fixture.orderId,
      fixture.warehouseId,
      fixture.productId,
      fixture.warehouseId,
      fixture.productId,
      fixture.warehouseId,
      fixture.productId,
      fixture.warehouseId,
    ],
  );
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, Number(value)]),
  );
}

async function assertFixtureCommittedAndVisibleOnSeparateConnections() {
  const first = await dbPool.getConnection();
  const second = await dbPool.getConnection();
  try {
    assert.notEqual(first.threadId, second.threadId);
    for (const connection of [first, second]) {
      const [[state]] = await connection.execute(
        `SELECT w.is_active, po.status
         FROM warehouses w JOIN purchase_orders po ON po.warehouse_id = w.id
         WHERE w.id = ? AND po.id = ?`,
        [fixture.warehouseId, fixture.orderId],
      );
      assert.ok(state, "fixture rows are committed and visible");
      assert.equal(Number(state.is_active), 1);
      assert.equal(state.status, "draft");
    }
  } finally {
    first.release();
    second.release();
  }
}

async function servicesWith(observe) {
  const pool = observedPool(dbPool, observe);
  return {
    purchases: createPurchaseService({ dbPool: pool }),
    warehouses: createWarehouseService({ dbPool: pool }),
    connectionIds: pool.connectionIds,
  };
}

const request = { ip: "127.0.0.1", get: () => "H2 integration test" };

afterEach(cleanupFixture);

after(async () => {
  if (dbPool) await dbPool.end();
});

test(
  "confirmation committed first is observed by the waiting warehouse deactivation",
  { skip: !enabled },
  async () => {
    await createFixture();
    await assertFixtureCommittedAndVisibleOnSeparateConnections();
    const sideEffectsBefore = await readReceiptAndInventoryState();

    const confirmationHasWarehouseLock = gate();
    const deactivationRequestedLock = gate();
    const { purchases, warehouses, connectionIds } = await servicesWith(
      async ({ sql, result }) => {
        if (isPurchaseConfirmationWarehouseLock(sql)) {
          await result;
          confirmationHasWarehouseLock.signal();
          await confirmationHasWarehouseLock.opened;
          return;
        }
        if (isWarehouseStatusLock(sql)) {
          deactivationRequestedLock.signal();
        }
        await result;
      },
    );

    const confirmation = purchases.confirm({
      id: fixture.orderId,
      input: { expectedVersion: 1, confirmZeroCost: false },
      userId: fixture.userId,
      request,
    });
    await confirmationHasWarehouseLock.reached;
    const deactivation = warehouses.setStatus({
      id: fixture.warehouseId,
      isActive: false,
      userId: fixture.userId,
      request,
    });
    await deactivationRequestedLock.reached;
    confirmationHasWarehouseLock.open();

    const [confirmationResult, deactivationResult] = await Promise.allSettled([
      confirmation,
      deactivation,
    ]);
    assert.equal(confirmationResult.status, "fulfilled");
    assert.equal(deactivationResult.status, "rejected");
    assert.ok(connectionIds.size >= 2, "usa dos conexiones MariaDB distintas");
    assert.equal(
      deactivationResult.reason.code,
      "WAREHOUSE_HAS_PENDING_PURCHASES",
    );

    const [[state]] = await dbPool.execute(
      `SELECT w.is_active, po.status
       FROM warehouses w JOIN purchase_orders po ON po.warehouse_id = w.id
       WHERE w.id = ? AND po.id = ?`,
      [fixture.warehouseId, fixture.orderId],
    );
    assert.equal(Number(state.is_active), 1);
    assert.equal(state.status, "confirmed");
    assert.deepEqual(
      await readReceiptAndInventoryState(),
      sideEffectsBefore,
      "confirmación y rechazo no crean recepciones ni movimientos de inventario",
    );
    assert.deepEqual(sideEffectsBefore, {
      receipts: 0,
      receipt_lines: 0,
      balance_rows: 0,
      balance_quantity: 0,
      movements: 0,
      operations: 0,
    });
    const [[confirmationAudit]] = await dbPool.execute(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE module = 'purchases' AND entity_id = ?
         AND action = 'purchases.order_confirmed'`,
      [fixture.orderId],
    );
    assert.equal(Number(confirmationAudit.count), 1);
    const [[deactivationAudit]] = await dbPool.execute(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE module = 'warehouses' AND entity_id = ?
         AND action = 'warehouses.deactivated'`,
      [fixture.warehouseId],
    );
    assert.equal(Number(deactivationAudit.count), 0);
  },
);

test(
  "deactivation committed first prevents a waiting confirmation from creating an obligation",
  { skip: !enabled },
  async () => {
    await createFixture();
    await assertFixtureCommittedAndVisibleOnSeparateConnections();
    const sideEffectsBefore = await readReceiptAndInventoryState();

    const deactivationHasWarehouseLock = gate();
    const confirmationRequestedLock = gate();
    const { purchases, warehouses, connectionIds } = await servicesWith(
      async ({ sql, result }) => {
        if (isWarehouseStatusLock(sql)) {
          await result;
          deactivationHasWarehouseLock.signal();
          await deactivationHasWarehouseLock.opened;
          return;
        }
        if (isPurchaseConfirmationWarehouseLock(sql)) {
          confirmationRequestedLock.signal();
        }
        await result;
      },
    );

    const deactivation = warehouses.setStatus({
      id: fixture.warehouseId,
      isActive: false,
      userId: fixture.userId,
      request,
    });
    await deactivationHasWarehouseLock.reached;
    const confirmation = purchases.confirm({
      id: fixture.orderId,
      input: { expectedVersion: 1, confirmZeroCost: false },
      userId: fixture.userId,
      request,
    });
    await confirmationRequestedLock.reached;
    deactivationHasWarehouseLock.open();

    const [deactivationResult, confirmationResult] = await Promise.allSettled([
      deactivation,
      confirmation,
    ]);
    assert.equal(deactivationResult.status, "fulfilled");
    assert.equal(confirmationResult.status, "rejected");
    assert.ok(connectionIds.size >= 2, "usa dos conexiones MariaDB distintas");
    assert.equal(confirmationResult.reason.code, "INVALID_PURCHASE_ORDER");

    const [[state]] = await dbPool.execute(
      `SELECT w.is_active, po.status
       FROM warehouses w JOIN purchase_orders po ON po.warehouse_id = w.id
       WHERE w.id = ? AND po.id = ?`,
      [fixture.warehouseId, fixture.orderId],
    );
    assert.equal(Number(state.is_active), 0);
    assert.equal(state.status, "draft");
    assert.deepEqual(
      await readReceiptAndInventoryState(),
      sideEffectsBefore,
      "desactivación no crea recepciones ni modifica existencias",
    );
    assert.deepEqual(sideEffectsBefore, {
      receipts: 0,
      receipt_lines: 0,
      balance_rows: 0,
      balance_quantity: 0,
      movements: 0,
      operations: 0,
    });
    const [[confirmationAudit]] = await dbPool.execute(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE module = 'purchases' AND entity_id = ?
         AND action = 'purchases.order_confirmed'`,
      [fixture.orderId],
    );
    assert.equal(Number(confirmationAudit.count), 0);
    const [[deactivationAudit]] = await dbPool.execute(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE module = 'warehouses' AND entity_id = ?
         AND action = 'warehouses.deactivated'`,
      [fixture.warehouseId],
    );
    assert.equal(Number(deactivationAudit.count), 1);
  },
);
