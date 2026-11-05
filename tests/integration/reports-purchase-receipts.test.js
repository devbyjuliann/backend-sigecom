import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { createDatabasePool } from "../../src/db/pool.js";
import {
  buildPurchaseReceiptActivitiesQuery,
  createPurchaseReceiptsService,
} from "../../src/modules/reports/purchase-receipts-service.js";
import { bogotaUtcBoundaries } from "../../src/modules/reports/sales-activity-service.js";
import { createSalesActivityService } from "../../src/modules/reports/sales-activity-service.js";

const suffix = randomBytes(8).toString("hex");
const centsAsDecimal = (cents) =>
  `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
let pool;
let connection;
let service;
let auth;
let warehouseId;
let secondWarehouseId;
let foreignWarehouseId;
let supplierId;
let productIds;
let userIdsByRole;
let sessionIdsByRole;
let orderId;
let orderLineIds;
let rogueOrderId;
let rogueOrderLineId;
let rogueProductId;
let validReceiptForReturn;
let validReceiptLineIds;
let receiptWithInvalidMovements;
let invalidReceiptLineId;
let currentBogotaDate;
let app;
const httpOrigin = "http://127.0.0.1:5173";

async function createReceipt({
  reference,
  quantities,
  movementQuantities = quantities,
  receivedAt,
  omitOperation = false,
  omittedMovementIndexes = [],
  operationWarehouseId = warehouseId,
}) {
  const [receiptResult] = await connection.execute(
    `INSERT INTO purchase_receipts
       (purchase_order_id, reference, received_by, received_at)
     VALUES (?, ?, ?, ?)`,
    [orderId, reference, auth.user.id, receivedAt],
  );
  const receiptId = String(receiptResult.insertId);
  let operationId = null;
  if (!omitOperation) {
    const [operationResult] = await connection.execute(
      `INSERT INTO inventory_operations
         (operation_type, source_warehouse_id, created_by, reason, reference,
          source_type, source_id, idempotency_key, request_hash)
       VALUES ('purchase_receipt', ?, ?, 'Fixture de reporte', ?,
               'purchase_receipt', ?, ?, ?)`,
      [
        operationWarehouseId,
        auth.user.id,
        reference,
        receiptId,
        `report-receipt-${suffix}-${reference}`,
        "a".repeat(64),
      ],
    );
    operationId = String(operationResult.insertId);
    await connection.execute(
      "UPDATE purchase_receipts SET source_operation_id = ? WHERE id = ?",
      [operationId, receiptId],
    );
  }

  for (const [index, quantity] of quantities.entries()) {
    const productId = productIds[index];
    const orderLineId = orderLineIds[index];
    await connection.execute(
      `INSERT INTO purchase_receipt_lines
         (purchase_receipt_id, purchase_order_id, purchase_order_line_id, quantity)
       VALUES (?, ?, ?, ?)`,
      [receiptId, orderId, orderLineId, quantity],
    );
    if (omitOperation || omittedMovementIndexes.includes(index)) continue;
    const [[product]] = await connection.execute(
      "SELECT unit FROM products WHERE id = ?",
      [productId],
    );
    const [[prior]] = await connection.execute(
      `SELECT balance_after FROM inventory_movements
        WHERE product_id = ? AND warehouse_id = ?
        ORDER BY balance_version DESC LIMIT 1`,
      [productId, warehouseId],
    );
    const [[version]] = await connection.execute(
      `SELECT COALESCE(MAX(balance_version), 0) + 1 AS next_version
         FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?`,
      [productId, warehouseId],
    );
    const before = Number(prior?.balance_after || 0);
    await connection.execute(
      `INSERT INTO inventory_movements
         (operation_id, product_id, warehouse_id, direction, quantity,
          balance_before, balance_after, balance_version, unit_snapshot)
       VALUES (?, ?, ?, 'IN', ?, ?, ?, ?, ?)`,
      [
        operationId,
        productId,
        warehouseId,
        movementQuantities[index],
        before,
        before + movementQuantities[index],
        version.next_version,
        product.unit,
      ],
    );
  }
  return {
    id: receiptId,
    operationId,
    purchaseOrderId: String(orderId),
    warehouseId,
  };
}

async function addMismatchedReceiptLine(receipt, quantity) {
  await connection.execute(
    `INSERT INTO purchase_receipt_lines
       (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity)
     VALUES (?,?,?,?)`,
    [receipt.id, rogueOrderId, rogueOrderLineId, quantity],
  );
  await connection.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,
        balance_after,balance_version,unit_snapshot)
     VALUES (?, ?, ?, 'IN', ?, 0, ?, 1, 'unidad')`,
    [receipt.operationId, rogueProductId, warehouseId, quantity, quantity],
  );
}

async function addUnjustifiedMovement(
  receipt,
  productId,
  destinationWarehouseId,
) {
  await connection.execute(
    `INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version)
     VALUES (?, ?, 1, 1)`,
    [productId, destinationWarehouseId],
  );
  await connection.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,
        balance_after,balance_version,unit_snapshot)
     VALUES (?, ?, ?, 'IN', 1, 0, 1, 1, 'caja')`,
    [receipt.operationId, productId, destinationWarehouseId],
  );
}

async function createWarehouseReceipt({
  targetWarehouseId,
  tag,
  quantity,
  unitCost,
}) {
  const code = targetWarehouseId === secondWarehouseId ? "MS" : "FR";
  const [order] = await connection.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,
        updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, UTC_DATE(), 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3)-INTERVAL 1 DAY)`,
    [
      `OC-${code}-${suffix.slice(0, 8)}`,
      supplierId,
      targetWarehouseId,
      auth.user.id,
      auth.user.id,
      auth.user.id,
    ],
  );
  const warehouseOrderId = String(order.insertId);
  const [[product]] = await connection.execute(
    "SELECT sku,name,unit FROM products WHERE id=?",
    [rogueProductId],
  );
  const [line] = await connection.execute(
    `INSERT INTO purchase_order_lines
       (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,
        unit_snapshot,quantity,unit_cost,line_total)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      warehouseOrderId,
      rogueProductId,
      product.sku,
      product.name,
      product.unit,
      quantity,
      unitCost,
      centsAsDecimal(BigInt(quantity) * BigInt(unitCost.replace(".", ""))),
    ],
  );
  await connection.execute(
    `INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version)
     VALUES (?, ?, 0, 0)`,
    [rogueProductId, targetWarehouseId],
  );
  const [receipt] = await connection.execute(
    `INSERT INTO purchase_receipts
       (purchase_order_id,reference,received_by,received_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3)-INTERVAL 20 MINUTE)`,
    [warehouseOrderId, `receipt-${tag}-${suffix}`, auth.user.id],
  );
  const receiptId = String(receipt.insertId);
  const [operation] = await connection.execute(
    `INSERT INTO inventory_operations
       (operation_type,source_warehouse_id,created_by,reason,reference,
        source_type,source_id,idempotency_key,request_hash)
     VALUES ('purchase_receipt', ?, ?, 'Fixture multibodega', ?,
             'purchase_receipt', ?, ?, ?)`,
    [
      targetWarehouseId,
      auth.user.id,
      `receipt-${tag}-${suffix}`,
      receiptId,
      `receipt-op-${tag}-${suffix}`,
      "e".repeat(64),
    ],
  );
  await connection.execute(
    "UPDATE purchase_receipts SET source_operation_id=? WHERE id=?",
    [operation.insertId, receiptId],
  );
  await connection.execute(
    `INSERT INTO purchase_receipt_lines
       (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity)
     VALUES (?, ?, ?, ?)`,
    [receiptId, warehouseOrderId, line.insertId, quantity],
  );
  await connection.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,
        balance_after,balance_version,unit_snapshot)
     VALUES (?, ?, ?, 'IN', ?, 0, ?, 1, ?)`,
    [
      operation.insertId,
      rogueProductId,
      targetWarehouseId,
      quantity,
      quantity,
      product.unit,
    ],
  );
  return {
    id: receiptId,
    operationId: String(operation.insertId),
    purchaseOrderId: warehouseOrderId,
    warehouseId: targetWarehouseId,
  };
}

async function createSupplierReturn({
  receipt,
  receiptLineIds,
  quantities,
  returnTag = "first",
  operationType = "supplier_return",
  sourceType = "supplier_return",
  sourceId,
  operationWarehouseId,
  snapshotUnit,
  omitOperation = false,
  omittedMovementIndexes = [],
}) {
  const [returnResult] = await connection.execute(
    `INSERT INTO supplier_returns
       (purchase_order_id, purchase_receipt_id, reference, reason,
        idempotency_key, request_hash, returned_by)
     VALUES (?, ?, ?, 'Fixture de reporte', ?, ?, ?)`,
    [
      receipt.purchaseOrderId ?? orderId,
      receipt.id,
      `return-${suffix}-${returnTag}`,
      `report-return-${suffix}-${returnTag}`,
      "b".repeat(64),
      auth.user.id,
    ],
  );
  const returnId = String(returnResult.insertId);
  const returnWarehouseId = receipt.warehouseId ?? warehouseId;
  let operationId = null;
  if (!omitOperation) {
    const [operationResult] = await connection.execute(
      `INSERT INTO inventory_operations
         (operation_type, source_warehouse_id, created_by, reason, reference,
          source_type, source_id, idempotency_key, request_hash)
       VALUES (?, ?, ?, 'Fixture de reporte', ?, ?, ?, ?, ?)`,
      [
        operationType,
        operationWarehouseId ?? returnWarehouseId,
        auth.user.id,
        `return-${suffix}-${returnTag}`,
        sourceType,
        sourceId ?? returnId,
        `report-return-operation-${suffix}-${returnTag}`,
        "c".repeat(64),
      ],
    );
    operationId = String(operationResult.insertId);
    await connection.execute(
      "UPDATE supplier_returns SET source_operation_id = ? WHERE id = ?",
      [operationId, returnId],
    );
  }

  for (let index = 0; index < quantities.length; index += 1) {
    const receiptLineId = receiptLineIds[index];
    const quantity = quantities[index];
    const [[source]] = await connection.execute(
      `SELECT prl.purchase_order_id, prl.purchase_order_line_id,
              pol.product_id, pol.sku_snapshot, pol.name_snapshot,
              pol.unit_snapshot
         FROM purchase_receipt_lines prl
         JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
        WHERE prl.id = ?`,
      [receiptLineId],
    );
    await connection.execute(
      `INSERT INTO supplier_return_lines
         (supplier_return_id, purchase_order_id, purchase_receipt_id,
          purchase_receipt_line_id, purchase_order_line_id, product_id,
          sku_snapshot, name_snapshot, unit_snapshot, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnId,
        source.purchase_order_id,
        receipt.id,
        receiptLineId,
        source.purchase_order_line_id,
        source.product_id,
        source.sku_snapshot,
        source.name_snapshot,
        snapshotUnit ?? source.unit_snapshot,
        quantity,
      ],
    );
    if (!operationId || omittedMovementIndexes.includes(index)) continue;
    const [[prior]] = await connection.execute(
      `SELECT balance_after FROM inventory_movements
        WHERE product_id = ? AND warehouse_id = ?
        ORDER BY balance_version DESC LIMIT 1`,
      [source.product_id, returnWarehouseId],
    );
    const [[version]] = await connection.execute(
      `SELECT COALESCE(MAX(balance_version), 0) + 1 AS next_version
         FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?`,
      [source.product_id, returnWarehouseId],
    );
    const before = Number(prior?.balance_after || 0);
    await connection.execute(
      `INSERT INTO inventory_movements
         (operation_id, product_id, warehouse_id, direction, quantity,
          balance_before, balance_after, balance_version, unit_snapshot)
       VALUES (?, ?, ?, 'OUT', ?, ?, ?, ?, ?)`,
      [
        operationId,
        source.product_id,
        returnWarehouseId,
        quantity,
        before,
        before - quantity,
        version.next_version,
        snapshotUnit ?? source.unit_snapshot,
      ],
    );
  }
  return returnId;
}

async function createPriorPeriodReturn() {
  const savedOrderId = orderId;
  const savedOrderLineIds = orderLineIds;
  const [orderResult] = await connection.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, UTC_DATE() - INTERVAL 12 DAY, 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3) - INTERVAL 12 DAY)`,
    [
      `OC-RPH-${suffix}`,
      supplierId,
      warehouseId,
      auth.user.id,
      auth.user.id,
      auth.user.id,
    ],
  );
  orderId = String(orderResult.insertId);
  const [[product]] = await connection.execute(
    "SELECT sku,name,unit FROM products WHERE id = ?",
    [productIds[0]],
  );
  const [lineResult] = await connection.execute(
    `INSERT INTO purchase_order_lines
       (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,quantity,unit_cost,line_total)
     VALUES (?, ?, 1, ?, ?, ?, 5, 7.00, 35.00)`,
    [orderId, productIds[0], product.sku, product.name, product.unit],
  );
  orderLineIds = [String(lineResult.insertId)];
  const receipt = await createReceipt({
    reference: `prior-${suffix}`,
    quantities: [5],
    receivedAt: new Date(Date.now() - 10 * 86400000),
  });
  const [[receiptLine]] = await connection.execute(
    "SELECT id FROM purchase_receipt_lines WHERE purchase_receipt_id = ?",
    [receipt.id],
  );
  await createSupplierReturn({
    receipt,
    receiptLineIds: [String(receiptLine.id)],
    quantities: [5],
    returnTag: "prior-period-receipt",
  });
  orderId = savedOrderId;
  orderLineIds = savedOrderLineIds;
}

before(async () => {
  pool = createDatabasePool("test");
  connection = await pool.getConnection();
  await connection.query("SET time_zone = '+00:00'");
  const [[identity]] = await connection.query("SELECT DATABASE() AS name");
  assert.equal(identity.name, "sigecom_test");
  await connection.beginTransaction();

  const [[role]] = await connection.execute(
    "SELECT id FROM roles WHERE code = 'administrator'",
  );
  const [permissionRows] = await connection.execute(
    `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ? AND p.code IN ('reports.read','purchases.read','warehouses.read')`,
    [role.id],
  );
  assert.deepEqual(
    permissionRows.map(({ code }) => code).sort(),
    ["purchases.read", "reports.read", "warehouses.read"],
    "El fixture requiere asignaciones existentes; no concede permisos.",
  );

  const [roles] = await connection.execute(
    "SELECT id,code FROM roles WHERE code IN ('administrator','auditor','seller','warehouse')",
  );
  const roleIds = Object.fromEntries(roles.map((row) => [row.code, row.id]));

  const [userResult] = await connection.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
    [
      role.id,
      `report-purchases-${suffix}@sigecom.invalid`,
      "Fixture reportes",
      "not-used",
    ],
  );
  const userId = String(userResult.insertId);
  userIdsByRole = { administrator: userId };
  const [warehouseResult] = await connection.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?, ?, 0)",
    [`RP-${suffix}`, `Bodega reporte ${suffix}`],
  );
  warehouseId = String(warehouseResult.insertId);
  await connection.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id,assigned_by) VALUES (?, ?, ?)",
    [userId, warehouseId, userId],
  );
  const [secondWarehouse] = await connection.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?, ?, 1)",
    [`RP2-${suffix}`, `Segunda bodega reporte ${suffix}`],
  );
  secondWarehouseId = String(secondWarehouse.insertId);
  await connection.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id,assigned_by) VALUES (?, ?, ?)",
    [userId, secondWarehouseId, userId],
  );
  const [foreignWarehouse] = await connection.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?, ?, 1)",
    [`RF-${suffix}`, `Bodega ajena ${suffix}`],
  );
  foreignWarehouseId = String(foreignWarehouse.insertId);
  const [sessionResult] = await connection.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)`,
    [userId, randomBytes(32).toString("hex")],
  );
  auth = {
    user: { id: userId, role: "administrator" },
    sessionId: String(sessionResult.insertId),
  };
  sessionIdsByRole = { administrator: auth.sessionId };
  for (const roleCode of ["auditor", "seller", "warehouse"]) {
    const [result] = await connection.execute(
      "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
      [
        roleIds[roleCode],
        `report-purchases-${roleCode}-${suffix}@sigecom.invalid`,
        `Fixture ${roleCode}`,
        "not-used",
      ],
    );
    const fixtureUserId = String(result.insertId);
    userIdsByRole[roleCode] = fixtureUserId;
    await connection.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id,assigned_by) VALUES (?, ?, ?)",
      [fixtureUserId, warehouseId, userId],
    );
    const [session] = await connection.execute(
      `INSERT INTO user_sessions (user_id,token_hash,expires_at)
       VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)`,
      [fixtureUserId, randomBytes(32).toString("hex")],
    );
    sessionIdsByRole[roleCode] = String(session.insertId);
  }

  const [supplierResult] = await connection.execute(
    "INSERT INTO suppliers (identification_number,business_name) VALUES (?, ?)",
    [`RP-${suffix}`, `Proveedor reporte ${suffix}`],
  );
  supplierId = String(supplierResult.insertId);
  const [categoryResult] = await connection.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Categoría reporte ${suffix}`],
  );
  productIds = [];
  for (const [index, unit] of ["caja", "unidad", "unidad"].entries()) {
    const [productResult] = await connection.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price)
       VALUES (?, ?, ?, ?, 999999.99, 10.00)`,
      [
        `RP-${suffix}-${index}`,
        `Producto reporte ${index}`,
        categoryResult.insertId,
        unit,
      ],
    );
    productIds.push(String(productResult.insertId));
    await connection.execute(
      "INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version) VALUES (?, ?, 0, 0)",
      [productResult.insertId, warehouseId],
    );
  }
  rogueProductId = productIds[2];
  await connection.execute(
    `UPDATE inventory_balances SET quantity=1,version=1
      WHERE product_id=? AND warehouse_id=?`,
    [rogueProductId, warehouseId],
  );

  const [openingOperation] = await connection.execute(
    `INSERT INTO inventory_operations
       (operation_type,source_warehouse_id,created_by,reason,idempotency_key,request_hash)
     VALUES ('initial_stock', ?, ?, 'Fixture inventario previo', ?, ?)`,
    [warehouseId, userId, `opening-${suffix}`, "d".repeat(64)],
  );
  await connection.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,balance_after,balance_version,unit_snapshot)
     VALUES (?, ?, ?, 'IN', 5, 0, 5, 1, 'caja')`,
    [openingOperation.insertId, productIds[0], warehouseId],
  );

  const [orderResult] = await connection.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, UTC_DATE(), 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3) - INTERVAL 1 DAY)`,
    [
      `OC-RP-${suffix}`,
      supplierResult.insertId,
      warehouseId,
      userId,
      userId,
      userId,
    ],
  );
  orderId = String(orderResult.insertId);
  orderLineIds = [];
  for (const [index, item] of [
    { quantity: 4, unitCost: "12.34" },
    { quantity: 3, unitCost: "0.00" },
  ].entries()) {
    const [[product]] = await connection.execute(
      "SELECT sku,name,unit FROM products WHERE id = ?",
      [productIds[index]],
    );
    const [lineResult] = await connection.execute(
      `INSERT INTO purchase_order_lines
         (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,quantity,unit_cost,line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        productIds[index],
        index + 1,
        product.sku,
        product.name,
        product.unit,
        item.quantity,
        item.unitCost,
        centsAsDecimal(
          BigInt(item.quantity) * BigInt(item.unitCost.replace(".", "")),
        ),
      ],
    );
    orderLineIds.push(String(lineResult.insertId));
  }
  const [rogueOrder] = await connection.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?, ?, ?, UTC_DATE(), 'confirmed', ?, ?, ?, UTC_TIMESTAMP(3) - INTERVAL 1 DAY)`,
    [`OC-RPX-${suffix}`, supplierId, warehouseId, userId, userId, userId],
  );
  rogueOrderId = String(rogueOrder.insertId);
  const [rogueLine] = await connection.execute(
    `INSERT INTO purchase_order_lines
       (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,
        unit_snapshot,quantity,unit_cost,line_total)
     VALUES (?, ?, 1, ?, ?, 'unidad', 5, 4.00, 20.00)`,
    [
      rogueOrderId,
      rogueProductId,
      `RPX-${suffix}`,
      "Producto ajeno a la orden",
    ],
  );
  rogueOrderLineId = String(rogueLine.insertId);

  const now = new Date();
  const bogota = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  currentBogotaDate = bogota.toISOString().slice(0, 10);
  service = createPurchaseReceiptsService({ dbPool: pool });
  app = createApp({
    dbPool: pool,
    authConfig: getAuthConfig({
      JWT_SECRET: randomBytes(48).toString("base64url"),
      FRONTEND_ORIGIN: httpOrigin,
    }),
    logger: createLogger({ level: "silent" }),
  });
});

after(async () => {
  if (connection) {
    try {
      await connection.rollback();
    } finally {
      connection.release();
    }
  }
  if (pool) {
    try {
      const [[leftovers]] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users,
           (SELECT COUNT(*) FROM user_sessions us JOIN users u ON u.id=us.user_id WHERE u.email LIKE ?) AS sessions,
           (SELECT COUNT(*) FROM warehouses WHERE code IN (?, ?, ?)) AS warehouses,
           (SELECT COUNT(*) FROM suppliers WHERE identification_number=?) AS suppliers,
           (SELECT COUNT(*) FROM categories WHERE name=?) AS categories,
           (SELECT COUNT(*) FROM products WHERE sku LIKE ?) AS products,
           (SELECT COUNT(*) FROM purchase_orders WHERE commercial_code IN (?, ?, ?, ?, ?)) AS orders,
           (SELECT COUNT(*) FROM purchase_receipts WHERE reference LIKE ?) AS receipts,
           (SELECT COUNT(*) FROM supplier_returns WHERE reference LIKE ?) AS returns,
           (SELECT COUNT(*) FROM inventory_operations WHERE idempotency_key LIKE ?) AS operations`,
        [
          `%${suffix}@sigecom.invalid`,
          `%${suffix}@sigecom.invalid`,
          `RP-${suffix}`,
          `RP2-${suffix}`,
          `RF-${suffix}`,
          `RP-${suffix}`,
          `Categoría reporte ${suffix}`,
          `RP-${suffix}-%`,
          `OC-RP-${suffix}`,
          `OC-RPH-${suffix}`,
          `OC-RPX-${suffix}`,
          `OC-MS-${suffix.slice(0, 8)}`,
          `OC-FR-${suffix.slice(0, 8)}`,
          `%${suffix}%`,
          `%${suffix}%`,
          `%${suffix}%`,
        ],
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(leftovers).map(([key, value]) => [key, Number(value)]),
        ),
        {
          users: 0,
          sessions: 0,
          warehouses: 0,
          suppliers: 0,
          categories: 0,
          products: 0,
          orders: 0,
          receipts: 0,
          returns: 0,
          operations: 0,
        },
        "La transacción debe revertir todos los fixtures y no dejar sesiones.",
      );
    } finally {
      await pool.end();
    }
  }
});

test("MariaDB validates complete receipt and supplier-return facts without multiplying lines", async () => {
  const first = await createReceipt({
    reference: `first-${suffix}`,
    quantities: [2, 2],
    receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  const [firstLineRows] = await connection.execute(
    `SELECT id FROM purchase_receipt_lines WHERE purchase_receipt_id = ? ORDER BY id`,
    [first.id],
  );
  validReceiptForReturn = first;
  validReceiptLineIds = firstLineRows.map(({ id }) => String(id));
  const second = await createReceipt({
    reference: `second-${suffix}`,
    quantities: [2, 1],
    receivedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  validReceiptForReturn = second;
  const [secondLineRows] = await connection.execute(
    "SELECT id FROM purchase_receipt_lines WHERE purchase_receipt_id = ? ORDER BY id",
    [second.id],
  );
  validReceiptLineIds = secondLineRows.map(({ id }) => String(id));
  await createSupplierReturn({
    receipt: first,
    receiptLineIds: firstLineRows.map(({ id }) => String(id)),
    quantities: [1, 1],
  });
  await createSupplierReturn({
    receipt: first,
    receiptLineIds: [String(firstLineRows[0].id)],
    quantities: [1],
    returnTag: "second-partial",
  });
  await createPriorPeriodReturn();

  const boundaries = bogotaUtcBoundaries(currentBogotaDate, currentBogotaDate);
  const activityQuery = buildPurchaseReceiptActivitiesQuery({
    warehouseIds: [warehouseId],
    ...boundaries,
    pageSize: 2,
    offset: 0,
  });
  const [[activityCount]] = await connection.execute(
    activityQuery.countSql,
    activityQuery.params,
  );
  assert.equal(Number(activityCount.total), 5);
  const [firstActivityPage] = await connection.execute(
    activityQuery.pageSql,
    activityQuery.pageParams,
  );
  assert.equal(firstActivityPage.length, 2);
  assert.deepEqual(
    firstActivityPage.map(({ activity_type: type }) => type),
    ["supplier_return", "supplier_return"],
  );
  assert.equal(String(firstActivityPage[0].amount), "35.00");

  const result = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId,
    connection,
  });
  assert.equal(result.summary.receivedValue, "49.36");
  assert.equal(result.summary.supplierReturnEquivalent, "59.68");
  assert.equal(result.summary.referenceNetReceivedValue, "-10.32");
  assert.deepEqual(result.summary.quantitiesByUnit, [
    {
      unit: "caja",
      quantityReceived: "4",
      quantityReturned: "7",
      quantityDifference: "-3",
    },
    {
      unit: "unidad",
      quantityReceived: "3",
      quantityReturned: "1",
      quantityDifference: "2",
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
  const inconsistent = await createReceipt({
    reference: `inconsistent-${suffix}`,
    quantities: [1, 1],
    movementQuantities: [2, 1],
    receivedAt: new Date(Date.now() - 30 * 60 * 1000),
  });
  receiptWithInvalidMovements = inconsistent;
  const [[badReceiptLine]] = await connection.execute(
    "SELECT id FROM purchase_receipt_lines WHERE purchase_receipt_id = ? ORDER BY id LIMIT 1",
    [inconsistent.id],
  );
  invalidReceiptLineId = String(badReceiptLine.id);
  await createSupplierReturn({
    receipt: first,
    receiptLineIds: [String(firstLineRows[0].id)],
    quantities: [2],
    returnTag: "over-return",
  });
  let reportSql;
  let reportParams;
  const observedConnection = new Proxy(connection, {
    get(target, property) {
      if (property === "execute") {
        return async (sql, params) => {
          if (String(sql).startsWith("\nWITH scoped_receipts")) {
            reportSql = sql;
            reportParams = params;
          }
          return target.execute(sql, params);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const start = performance.now();
  const withExclusion = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId,
    connection: observedConnection,
  });
  const elapsedMilliseconds = performance.now() - start;
  assert.equal(withExclusion.summary.receivedValue, "49.36");
  assert.equal(withExclusion.summary.supplierReturnEquivalent, "59.68");
  assert.equal(withExclusion.summary.referenceNetReceivedValue, "-10.32");
  assert.deepEqual(
    withExclusion.summary.quantitiesByUnit,
    result.summary.quantitiesByUnit,
  );
  assert.deepEqual(
    withExclusion.diagnostics.sort((left, right) =>
      left.documentType.localeCompare(right.documentType),
    ),
    [
      {
        documentType: "purchase_receipt",
        reason: "inventory_movement_mismatch",
        count: "1",
      },
      {
        documentType: "supplier_return",
        reason: "invalid_return_reference_or_quantity",
        count: "1",
      },
    ],
  );
  assert.ok(
    reportSql,
    "La consulta combinada definitiva debe ejecutarse en MariaDB.",
  );
  const [explainRows] = await connection.execute(
    `EXPLAIN ${reportSql}`,
    reportParams,
  );
  assert.ok(explainRows.length > 0);
  console.log(
    `Reporte de Compras, alcance pequeño/1 día: ${elapsedMilliseconds.toFixed(2)} ms; EXPLAIN: ${explainRows.length} filas`,
  );
  const broadStart = performance.now();
  await service.summarize({
    auth,
    dateFrom: (() => {
      const startDate = new Date(`${currentBogotaDate}T00:00:00.000Z`);
      startDate.setUTCDate(startDate.getUTCDate() - 91);
      return startDate.toISOString().slice(0, 10);
    })(),
    dateTo: currentBogotaDate,
    connection,
  });
  console.log(
    `Reporte de Compras, alcance de 2 bodegas/92 días: ${(performance.now() - broadStart).toFixed(2)} ms`,
  );
  assert.ok(first.id && second.id);
  assert.ok(inconsistent.id);
});

test("purchase report permission is independent while sales still requires sales.read", async () => {
  await connection.execute(
    `DELETE rp FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?)
        AND p.code = 'sales.read'`,
    [auth.user.id],
  );
  const purchaseResult = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    connection,
  });
  assert.ok(purchaseResult.summary);

  const salesService = createSalesActivityService({ dbPool: pool });
  await assert.rejects(
    salesService.summarize({
      auth,
      dateFrom: currentBogotaDate,
      dateTo: currentBogotaDate,
      connection,
    }),
    (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
  );

  await connection.query("SAVEPOINT before_sales_only_permission_check");
  await connection.execute(
    `INSERT INTO role_permissions (role_id,permission_id)
     SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='sales.read'
      WHERE r.id=(SELECT role_id FROM users WHERE id=?)`,
    [auth.user.id],
  );
  await connection.execute(
    `DELETE rp FROM role_permissions rp
       JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?)
        AND p.code='purchases.read'`,
    [auth.user.id],
  );
  const salesOnly = await salesService.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    connection,
  });
  assert.ok(salesOnly.summary);
  await assert.rejects(
    service.summarize({
      auth,
      dateFrom: currentBogotaDate,
      dateTo: currentBogotaDate,
      connection,
    }),
    (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
  );
  await connection.query(
    "ROLLBACK TO SAVEPOINT before_sales_only_permission_check",
  );

  await connection.query("SAVEPOINT before_permission_revocation_checks");
  for (const code of ["purchases.read", "reports.read", "warehouses.read"]) {
    await connection.execute(
      `DELETE rp FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?)
          AND p.code = ?`,
      [auth.user.id, code],
    );
    await assert.rejects(
      service.summarize({
        auth,
        dateFrom: currentBogotaDate,
        dateTo: currentBogotaDate,
        connection,
      }),
      (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
      `Debe rechazarse al retirar ${code}`,
    );
  }
  await connection.query(
    "ROLLBACK TO SAVEPOINT before_permission_revocation_checks",
  );
});

test("receipts with missing operations, incomplete movements, or extra foreign-order lines are excluded whole", async () => {
  await createReceipt({
    reference: `no-operation-${suffix}`,
    quantities: [1],
    omitOperation: true,
    receivedAt: new Date(Date.now() - 20 * 60 * 1000),
  });
  await createReceipt({
    reference: `missing-movement-${suffix}`,
    quantities: [1, 1],
    omittedMovementIndexes: [1],
    receivedAt: new Date(Date.now() - 18 * 60 * 1000),
  });
  const wrongWarehouseOperation = await createReceipt({
    reference: `operation-other-warehouse-${suffix}`,
    quantities: [1],
    operationWarehouseId: secondWarehouseId,
    receivedAt: new Date(Date.now() - 17 * 60 * 1000),
  });
  const extraLineReceipt = await createReceipt({
    reference: `foreign-order-line-${suffix}`,
    quantities: [1],
    receivedAt: new Date(Date.now() - 16 * 60 * 1000),
  });
  await addMismatchedReceiptLine(extraLineReceipt, 1);
  const extraMovementReceipt = await createReceipt({
    reference: `extra-movement-${suffix}`,
    quantities: [1],
    receivedAt: new Date(Date.now() - 15 * 60 * 1000),
  });
  await addUnjustifiedMovement(
    extraMovementReceipt,
    productIds[0],
    secondWarehouseId,
  );
  assert.ok(wrongWarehouseOperation.operationId);

  const result = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId,
    connection,
  });
  assert.equal(result.summary.receivedValue, "49.36");
  assert.equal(result.summary.supplierReturnEquivalent, "59.68");
  assert.equal(result.summary.referenceNetReceivedValue, "-10.32");
  assert.deepEqual(result.summary.quantitiesByUnit, [
    {
      unit: "caja",
      quantityReceived: "4",
      quantityReturned: "7",
      quantityDifference: "-3",
    },
    {
      unit: "unidad",
      quantityReceived: "3",
      quantityReturned: "1",
      quantityDifference: "2",
    },
  ]);
  assert.deepEqual(
    result.diagnostics
      .map(({ documentType, reason, count }) => ({
        documentType,
        reason,
        count,
      }))
      .sort((a, b) =>
        `${a.documentType}:${a.reason}`.localeCompare(
          `${b.documentType}:${b.reason}`,
        ),
      ),
    [
      {
        documentType: "purchase_receipt",
        reason: "invalid_inventory_operation",
        count: "2",
      },
      {
        documentType: "purchase_receipt",
        reason: "inventory_movement_mismatch",
        count: "3",
      },
      {
        documentType: "purchase_receipt",
        reason: "receipt_line_order_mismatch",
        count: "1",
      },
      {
        documentType: "supplier_return",
        reason: "invalid_return_reference_or_quantity",
        count: "1",
      },
    ],
  );
});

test("supplier returns with contradictory operation, warehouse, or snapshot facts are excluded", async () => {
  const lineId = validReceiptLineIds[0];
  await createSupplierReturn({
    receipt: validReceiptForReturn,
    receiptLineIds: [lineId],
    quantities: [1],
    returnTag: "wrong-operation-type",
    operationType: "purchase_receipt",
  });
  await createSupplierReturn({
    receipt: validReceiptForReturn,
    receiptLineIds: [lineId],
    quantities: [1],
    returnTag: "wrong-source-id",
    sourceId: `not-the-return-${suffix}`,
  });
  await createSupplierReturn({
    receipt: validReceiptForReturn,
    receiptLineIds: [lineId],
    quantities: [1],
    returnTag: "missing-operation",
    omitOperation: true,
  });
  await createSupplierReturn({
    receipt: validReceiptForReturn,
    receiptLineIds: [lineId],
    quantities: [1],
    returnTag: "wrong-warehouse",
    operationWarehouseId: secondWarehouseId,
  });
  await createSupplierReturn({
    receipt: validReceiptForReturn,
    receiptLineIds: [lineId],
    quantities: [1],
    returnTag: "wrong-snapshot",
    snapshotUnit: "caja",
  });
  await createSupplierReturn({
    receipt: receiptWithInvalidMovements,
    receiptLineIds: [invalidReceiptLineId],
    quantities: [1],
    returnTag: "unverified-receipt",
  });

  const result = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId,
    connection,
  });
  assert.equal(result.summary.receivedValue, "49.36");
  assert.equal(result.summary.supplierReturnEquivalent, "59.68");
  assert.equal(result.summary.referenceNetReceivedValue, "-10.32");
  assert.deepEqual(result.summary.quantitiesByUnit, [
    {
      unit: "caja",
      quantityReceived: "4",
      quantityReturned: "7",
      quantityDifference: "-3",
    },
    {
      unit: "unidad",
      quantityReceived: "3",
      quantityReturned: "1",
      quantityDifference: "2",
    },
  ]);
  const excludedReturns = result.diagnostics
    .filter((item) => item.documentType === "supplier_return")
    .reduce((total, item) => total + Number(item.count), 0);
  assert.equal(excludedReturns, 7);
  assert.ok(
    result.diagnostics.some(
      (item) =>
        item.documentType === "supplier_return" &&
        item.reason === "unverified_source_receipt" &&
        item.count === "1",
    ),
    "La devolución respaldada por recepción inconsistente debe excluirse por completo.",
  );
});

test("assigned warehouses aggregate before totals while a foreign warehouse contributes no values or diagnostics", async () => {
  const secondReceipt = await createWarehouseReceipt({
    targetWarehouseId: secondWarehouseId,
    tag: "assigned-second-warehouse",
    quantity: 1,
    unitCost: "4.00",
  });
  const [secondReceiptLines] = await connection.execute(
    "SELECT id FROM purchase_receipt_lines WHERE purchase_receipt_id=?",
    [secondReceipt.id],
  );
  await createSupplierReturn({
    receipt: secondReceipt,
    receiptLineIds: [String(secondReceiptLines[0].id)],
    quantities: [1],
    returnTag: "missing-out-movement",
    omittedMovementIndexes: [0],
  });
  await createWarehouseReceipt({
    targetWarehouseId: foreignWarehouseId,
    tag: "unassigned-foreign-warehouse",
    quantity: 2,
    unitCost: "999.99",
  });

  const allAssigned = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    connection,
  });
  const primaryOnly = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId,
    connection,
  });
  assert.equal(allAssigned.summary.receivedValue, "53.36");
  assert.equal(allAssigned.summary.supplierReturnEquivalent, "59.68");
  assert.equal(allAssigned.summary.referenceNetReceivedValue, "-6.32");
  assert.deepEqual(allAssigned.summary.quantitiesByUnit, [
    {
      unit: "caja",
      quantityReceived: "4",
      quantityReturned: "7",
      quantityDifference: "-3",
    },
    {
      unit: "unidad",
      quantityReceived: "4",
      quantityReturned: "1",
      quantityDifference: "3",
    },
  ]);
  assert.equal(primaryOnly.summary.receivedValue, "49.36");
  assert.equal(primaryOnly.summary.supplierReturnEquivalent, "59.68");
  assert.deepEqual(
    allAssigned.diagnostics.filter(
      (item) =>
        item.documentType === "supplier_return" &&
        item.reason === "inventory_movement_mismatch",
    ),
    [
      {
        documentType: "supplier_return",
        reason: "inventory_movement_mismatch",
        count: "1",
      },
    ],
  );
  assert.deepEqual(
    allAssigned.diagnostics.filter(
      (item) =>
        item.documentType !== "supplier_return" ||
        item.reason !== "inventory_movement_mismatch",
    ),
    primaryOnly.diagnostics,
  );
});

test("purchase service revalidates live sessions, account state, role, and each required permission", async () => {
  const validAuth = auth;
  const summarize = (candidate = validAuth) =>
    service.summarize({
      auth: candidate,
      dateFrom: currentBogotaDate,
      dateTo: currentBogotaDate,
      warehouseId,
      connection,
    });
  assert.ok((await summarize()).summary);
  await assert.rejects(summarize(null), (error) => error.status === 403);
  await assert.rejects(
    summarize({
      user: { id: "0", role: "administrator" },
      sessionId: validAuth.sessionId,
    }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    summarize({ ...validAuth, sessionId: "not-a-session" }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    summarize({ ...validAuth, user: { ...validAuth.user, role: "auditor" } }),
    (error) => error.status === 403,
  );

  const assertDeniedAfter = async (sql, params) => {
    await connection.query("SAVEPOINT authorization_state_case");
    await connection.execute(sql, params);
    await assert.rejects(summarize(), (error) => error.status === 403);
    await connection.query("ROLLBACK TO SAVEPOINT authorization_state_case");
  };
  await assertDeniedAfter(
    "UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?",
    [validAuth.sessionId],
  );
  await assertDeniedAfter(
    "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?",
    [validAuth.sessionId],
  );
  await assertDeniedAfter("UPDATE users SET is_active=0 WHERE id=?", [
    validAuth.user.id,
  ]);
  await assertDeniedAfter(
    "UPDATE users SET password_change_required=1 WHERE id=?",
    [validAuth.user.id],
  );
  await assertDeniedAfter(
    "UPDATE users SET role_id=(SELECT id FROM roles WHERE code='seller') WHERE id=?",
    [validAuth.user.id],
  );

  for (const permission of [
    "reports.read",
    "warehouses.read",
    "purchases.read",
  ]) {
    await connection.query("SAVEPOINT authorization_permission_case");
    await connection.execute(
      `DELETE rp FROM role_permissions rp
         JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?) AND p.code=?`,
      [validAuth.user.id, permission],
    );
    await assert.rejects(summarize(), (error) => error.status === 403);
    await connection.query(
      "ROLLBACK TO SAVEPOINT authorization_permission_case",
    );
  }
  await connection.query("SAVEPOINT no_commercial_permission_case");
  await connection.execute(
    `DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?)
        AND p.code IN ('sales.read','purchases.read')`,
    [validAuth.user.id],
  );
  await assert.rejects(summarize(), (error) => error.status === 403);
  await connection.query("ROLLBACK TO SAVEPOINT no_commercial_permission_case");

  for (const roleCode of ["seller", "warehouse"]) {
    const roleUserId = userIdsByRole[roleCode];
    await connection.query("SAVEPOINT restricted_role_permission_case");
    await connection.execute(
      `INSERT IGNORE INTO role_permissions (role_id,permission_id)
       SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
        WHERE r.code=? AND p.code IN ('reports.read','purchases.read','warehouses.read')`,
      [roleCode],
    );
    await assert.rejects(
      summarize({
        user: { id: roleUserId, role: roleCode },
        sessionId: sessionIdsByRole[roleCode],
      }),
      (error) => error.status === 403,
    );
    await connection.query(
      "ROLLBACK TO SAVEPOINT restricted_role_permission_case",
    );
  }
  for (const roleCode of ["administrator", "auditor"]) {
    const authorized = await summarize({
      user: { id: userIdsByRole[roleCode], role: roleCode },
      sessionId: sessionIdsByRole[roleCode],
    });
    assert.ok(
      authorized.summary,
      `${roleCode} autorizado debe consultar Compras.`,
    );
  }
});

test("unassigned and foreign warehouses are not reported or distinguishable", async () => {
  await assert.rejects(
    service.summarize({
      auth,
      dateFrom: currentBogotaDate,
      dateTo: currentBogotaDate,
      warehouseId: foreignWarehouseId,
      connection,
    }),
    (error) => error.status === 404 && error.code === "WAREHOUSE_NOT_FOUND",
  );
  await assert.rejects(
    service.summarize({
      auth,
      dateFrom: currentBogotaDate,
      dateTo: currentBogotaDate,
      warehouseId: "18446744073709551615",
      connection,
    }),
    (error) => error.status === 404 && error.code === "WAREHOUSE_NOT_FOUND",
  );
  const secondAssignedWarehouse = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    warehouseId: secondWarehouseId,
    connection,
  });
  assert.equal(secondAssignedWarehouse.summary.receivedValue, "4.00");
  await connection.execute("DELETE FROM user_warehouses WHERE user_id = ?", [
    auth.user.id,
  ]);
  const empty = await service.summarize({
    auth,
    dateFrom: currentBogotaDate,
    dateTo: currentBogotaDate,
    connection,
  });
  assert.equal(empty.summary.receivedValue, "0.00");
  assert.deepEqual(empty.summary.quantitiesByUnit, []);
});

test("registered purchase report endpoints reject anonymous requests without caching", async () => {
  for (const path of [
    "/api/v1/reports/purchase-receipts",
    "/api/v1/reports/purchase-receipts/warehouses",
  ]) {
    const response = await request(app).get(path).expect(401);
    assert.match(response.headers["cache-control"], /private/);
    assert.match(response.headers["cache-control"], /no-store/);
    assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
  }
});
