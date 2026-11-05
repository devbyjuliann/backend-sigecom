import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { connectAdminTestDatabase } from "../support/test-database.js";

const suffix = randomBytes(8).toString("hex");
const origin = "http://127.0.0.1:5173";
let pool;
let app;
let config;
let userId;
let warehouseId;
let secondWarehouseId;
let foreignWarehouseId;
let sessionId;
let cookie;
let date;
let supplierId;
let categoryId;
let productId;
let orderId;
let orderLineId;
let receiptId;
let operationId;
let receiptLineId;
let movementId;
let returnId;
let returnOperationId;
let returnLineId;
let returnMovementId;
let noWarehouseUserId;
let noWarehouseSessionId;
let noWarehouseCookie;
let invalidReceiptOrderId;
let invalidReceiptOrderLineId;
let invalidReceiptId;

const purchasePath = () =>
  `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}`;
const selectorPath = "/api/v1/reports/purchase-receipts/warehouses";
const salesPath = () =>
  `/api/v1/reports/sales-activity?dateFrom=${date}&dateTo=${date}`;

async function expectDenied(
  path,
  {
    status = 403,
    cookieValue = cookie,
    code = status === 401 ? "AUTHENTICATION_REQUIRED" : "PERMISSION_DENIED",
  } = {},
) {
  let call = request(app).get(path);
  if (cookieValue) call = call.set("Cookie", cookieValue);
  const response = await call.expect(status);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.body.error.code, code);
  for (const forbidden of [
    "summary",
    "activities",
    "items",
    "warehouse",
    "amount",
    "quantitiesByUnit",
  ]) {
    assert.equal(
      Object.hasOwn(response.body, forbidden),
      false,
      `Respuesta denegada expone ${forbidden}`,
    );
  }
  assert.equal(
    JSON.stringify(response.body).includes(`Bodega HTTP ${suffix}`),
    false,
  );
  assert.equal(JSON.stringify(response.body).includes("12.34"), false);
  return response;
}

async function setRolePermissions(roleCode, codes) {
  const [[role]] = await pool.execute("SELECT id FROM roles WHERE code=?", [
    roleCode,
  ]);
  const [original] = await pool.execute(
    "SELECT permission_id,created_at FROM role_permissions WHERE role_id=?",
    [role.id],
  );
  try {
    await pool.execute("DELETE FROM role_permissions WHERE role_id=?", [
      role.id,
    ]);
    if (codes.length) {
      const [grants] = await pool.execute(
        `SELECT id,code FROM permissions WHERE code IN (${codes.map(() => "?").join(",")})`,
        codes,
      );
      assert.deepEqual(
        grants.map(({ code }) => code).sort(),
        [...codes].sort(),
      );
      for (const grant of grants) {
        await pool.execute(
          "INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)",
          [role.id, grant.id],
        );
      }
    }
    return async () => {
      await pool.execute("DELETE FROM role_permissions WHERE role_id=?", [
        role.id,
      ]);
      for (const grant of original) {
        await pool.execute(
          "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
          [role.id, grant.permission_id, grant.created_at],
        );
      }
    };
  } catch (error) {
    await pool.execute("DELETE FROM role_permissions WHERE role_id=?", [
      role.id,
    ]);
    for (const grant of original) {
      await pool.execute(
        "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
        [role.id, grant.permission_id, grant.created_at],
      );
    }
    throw error;
  }
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  config = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
  });
  app = createApp({
    dbPool: pool,
    authConfig: config,
    logger: createLogger({ level: "silent" }),
  });

  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code='administrator'",
  );
  const [user] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash,password_change_required) VALUES (?,?,?,'fixture-hash',0)",
    [role.id, `purchase-http-${suffix}@sigecom.invalid`, `HTTP ${suffix}`],
  );
  userId = String(user.insertId);
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?,?,0)",
    [`PH-${suffix}`, `Bodega HTTP ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  const [secondWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?,?,1)",
    [`P2-${suffix}`, `Segunda bodega HTTP ${suffix}`],
  );
  secondWarehouseId = String(secondWarehouse.insertId);
  const [foreignWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?,?,1)",
    [`PF-${suffix}`, `Bodega ajena HTTP ${suffix}`],
  );
  foreignWarehouseId = String(foreignWarehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [userId, warehouseId],
  );
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [userId, secondWarehouseId],
  );
  const jti = randomUUID();
  const token = jwt.sign(
    { sub: userId, jti, iss: config.jwtIssuer, aud: config.jwtAudience },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.ttlSeconds },
  );
  const decoded = jwt.decode(token);
  const [session] = await pool.execute(
    "INSERT INTO user_sessions (user_id,token_hash,expires_at) VALUES (?,?,FROM_UNIXTIME(?))",
    [userId, createHash("sha256").update(jti).digest("hex"), decoded.exp],
  );
  sessionId = String(session.insertId);
  cookie = `${config.cookieName}=${token}`;
  const nowBogota = new Date(Date.now() - 5 * 60 * 60 * 1000);
  date = nowBogota.toISOString().slice(0, 10);

  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (identification_number,business_name) VALUES (?,?)",
    [`PH-${suffix}`, `Proveedor HTTP ${suffix}`],
  );
  supplierId = String(supplier.insertId);
  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Categoría HTTP ${suffix}`],
  );
  categoryId = String(category.insertId);
  const [product] = await pool.execute(
    `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price)
     VALUES (?,?,?,'unidad',6.17,10.00)`,
    [`PH-${suffix}`, `Producto HTTP ${suffix}`, categoryId],
  );
  productId = String(product.insertId);
  await pool.execute(
    "INSERT INTO inventory_balances (product_id,warehouse_id,quantity,version) VALUES (?,?,0,0)",
    [productId, warehouseId],
  );
  const [order] = await pool.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?,?,?,UTC_DATE(),'confirmed',?,?,?,UTC_TIMESTAMP(3)-INTERVAL 1 MINUTE)`,
    [`OC-PH-${suffix}`, supplierId, warehouseId, userId, userId, userId],
  );
  orderId = String(order.insertId);
  const [orderLine] = await pool.execute(
    `INSERT INTO purchase_order_lines
       (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,quantity,unit_cost,line_total)
     VALUES (?,?,1,?,?,'unidad',2,6.17,12.34)`,
    [orderId, productId, `PH-${suffix}`, `Producto HTTP ${suffix}`],
  );
  orderLineId = String(orderLine.insertId);
  const [receipt] = await pool.execute(
    `INSERT INTO purchase_receipts (purchase_order_id,reference,received_by,received_at)
     VALUES (?,?,?,UTC_TIMESTAMP(3))`,
    [orderId, `REC-PH-${suffix}`, userId],
  );
  receiptId = String(receipt.insertId);
  const [operation] = await pool.execute(
    `INSERT INTO inventory_operations
       (operation_type,source_warehouse_id,created_by,reason,reference,source_type,source_id,idempotency_key,request_hash)
     VALUES ('purchase_receipt',?,?,'Fixture HTTP',?,'purchase_receipt',?,?,?)`,
    [
      warehouseId,
      userId,
      `REC-PH-${suffix}`,
      receiptId,
      `http-${suffix}`,
      "a".repeat(64),
    ],
  );
  operationId = String(operation.insertId);
  await pool.execute(
    "UPDATE purchase_receipts SET source_operation_id=? WHERE id=?",
    [operationId, receiptId],
  );
  const [receiptLine] = await pool.execute(
    `INSERT INTO purchase_receipt_lines (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity)
     VALUES (?,?,?,2)`,
    [receiptId, orderId, orderLineId],
  );
  receiptLineId = String(receiptLine.insertId);
  const [movement] = await pool.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,balance_after,balance_version,unit_snapshot)
     VALUES (?,?,?,'IN',2,0,2,1,'unidad')`,
    [operationId, productId, warehouseId],
  );
  movementId = String(movement.insertId);

  const [supplierReturn] = await pool.execute(
    `INSERT INTO supplier_returns
       (purchase_order_id,purchase_receipt_id,reference,reason,idempotency_key,request_hash,returned_by)
     VALUES (?,?,?,'Fixture HTTP','http-return-${suffix}',?,?)`,
    [orderId, receiptId, `DEV-PH-${suffix}`, "b".repeat(64), userId],
  );
  returnId = String(supplierReturn.insertId);
  const [returnOperation] = await pool.execute(
    `INSERT INTO inventory_operations
       (operation_type,source_warehouse_id,created_by,reason,reference,source_type,source_id,idempotency_key,request_hash)
     VALUES ('supplier_return',?,?,'Fixture HTTP',?,'supplier_return',?,?,?)`,
    [
      warehouseId,
      userId,
      `DEV-PH-${suffix}`,
      returnId,
      `http-return-operation-${suffix}`,
      "c".repeat(64),
    ],
  );
  returnOperationId = String(returnOperation.insertId);
  await pool.execute(
    "UPDATE supplier_returns SET source_operation_id=? WHERE id=?",
    [returnOperationId, returnId],
  );
  const [returnLine] = await pool.execute(
    `INSERT INTO supplier_return_lines
       (supplier_return_id,purchase_order_id,purchase_receipt_id,purchase_receipt_line_id,purchase_order_line_id,product_id,sku_snapshot,name_snapshot,unit_snapshot,quantity)
     VALUES (?,?,?,?,?,?,?,?,'unidad',1)`,
    [
      returnId,
      orderId,
      receiptId,
      receiptLineId,
      orderLineId,
      productId,
      `PH-${suffix}`,
      `Producto HTTP ${suffix}`,
    ],
  );
  returnLineId = String(returnLine.insertId);
  const [returnMovement] = await pool.execute(
    `INSERT INTO inventory_movements
       (operation_id,product_id,warehouse_id,direction,quantity,balance_before,balance_after,balance_version,unit_snapshot)
     VALUES (?,?,?,'OUT',1,2,1,2,'unidad')`,
    [returnOperationId, productId, warehouseId],
  );
  returnMovementId = String(returnMovement.insertId);

  const [noWarehouseUser] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash,password_change_required) VALUES (?,?,?,'fixture-hash',0)",
    [
      role.id,
      `purchase-http-empty-${suffix}@sigecom.invalid`,
      `Sin bodega ${suffix}`,
    ],
  );
  noWarehouseUserId = String(noWarehouseUser.insertId);
  const noWarehouseJti = randomUUID();
  const noWarehouseToken = jwt.sign(
    {
      sub: noWarehouseUserId,
      jti: noWarehouseJti,
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
    },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.ttlSeconds },
  );
  const noWarehouseClaims = jwt.decode(noWarehouseToken);
  const [noWarehouseSession] = await pool.execute(
    "INSERT INTO user_sessions (user_id,token_hash,expires_at) VALUES (?,?,FROM_UNIXTIME(?))",
    [
      noWarehouseUserId,
      createHash("sha256").update(noWarehouseJti).digest("hex"),
      noWarehouseClaims.exp,
    ],
  );
  noWarehouseSessionId = String(noWarehouseSession.insertId);
  noWarehouseCookie = `${config.cookieName}=${noWarehouseToken}`;

  const [invalidOrder] = await pool.execute(
    `INSERT INTO purchase_orders
       (commercial_code,supplier_id,warehouse_id,order_date,status,created_by,updated_by,confirmed_by,confirmed_at)
     VALUES (?,?,?,UTC_DATE(),'confirmed',?,?,?,UTC_TIMESTAMP(3)-INTERVAL 1 MINUTE)`,
    [`OC-PH-BAD-${suffix}`, supplierId, warehouseId, userId, userId, userId],
  );
  invalidReceiptOrderId = String(invalidOrder.insertId);
  const [invalidLine] = await pool.execute(
    `INSERT INTO purchase_order_lines
       (purchase_order_id,product_id,position,sku_snapshot,name_snapshot,unit_snapshot,quantity,unit_cost,line_total)
     VALUES (?,?,1,?,?,'unidad',3,100.00,300.00)`,
    [
      invalidReceiptOrderId,
      productId,
      `BAD-${suffix}`,
      `Recepción inválida ${suffix}`,
    ],
  );
  invalidReceiptOrderLineId = String(invalidLine.insertId);
  const [invalidReceipt] = await pool.execute(
    "INSERT INTO purchase_receipts (purchase_order_id,reference,received_by,received_at) VALUES (?,?,?,UTC_TIMESTAMP(3))",
    [invalidReceiptOrderId, `REC-PH-BAD-${suffix}`, userId],
  );
  invalidReceiptId = String(invalidReceipt.insertId);
  await pool.execute(
    "INSERT INTO purchase_receipt_lines (purchase_receipt_id,purchase_order_id,purchase_order_line_id,quantity) VALUES (?,?,?,3)",
    [invalidReceiptId, invalidReceiptOrderId, invalidReceiptOrderLineId],
  );
});

after(async () => {
  if (!pool) return;
  let cleanup;
  try {
    cleanup = await connectAdminTestDatabase();
    if (invalidReceiptId)
      await cleanup.execute(
        "DELETE FROM purchase_receipt_lines WHERE purchase_receipt_id=?",
        [invalidReceiptId],
      );
    if (invalidReceiptId)
      await cleanup.execute("DELETE FROM purchase_receipts WHERE id=?", [
        invalidReceiptId,
      ]);
    if (invalidReceiptOrderLineId)
      await cleanup.execute("DELETE FROM purchase_order_lines WHERE id=?", [
        invalidReceiptOrderLineId,
      ]);
    if (invalidReceiptOrderId)
      await cleanup.execute("DELETE FROM purchase_orders WHERE id=?", [
        invalidReceiptOrderId,
      ]);
    if (returnMovementId)
      await cleanup.execute("DELETE FROM inventory_movements WHERE id=?", [
        returnMovementId,
      ]);
    if (returnLineId)
      await cleanup.execute("DELETE FROM supplier_return_lines WHERE id=?", [
        returnLineId,
      ]);
    if (returnId)
      await cleanup.execute("DELETE FROM supplier_returns WHERE id=?", [
        returnId,
      ]);
    if (returnOperationId)
      await cleanup.execute("DELETE FROM inventory_operations WHERE id=?", [
        returnOperationId,
      ]);
    if (movementId)
      await cleanup.execute("DELETE FROM inventory_movements WHERE id=?", [
        movementId,
      ]);
    if (receiptLineId)
      await cleanup.execute("DELETE FROM purchase_receipt_lines WHERE id=?", [
        receiptLineId,
      ]);
    if (receiptId)
      await cleanup.execute("DELETE FROM purchase_receipts WHERE id=?", [
        receiptId,
      ]);
    if (operationId)
      await cleanup.execute("DELETE FROM inventory_operations WHERE id=?", [
        operationId,
      ]);
    if (orderLineId)
      await cleanup.execute("DELETE FROM purchase_order_lines WHERE id=?", [
        orderLineId,
      ]);
    if (orderId)
      await cleanup.execute("DELETE FROM purchase_orders WHERE id=?", [
        orderId,
      ]);
    if (productId)
      await cleanup.execute(
        "DELETE FROM inventory_balances WHERE product_id=? AND warehouse_id=?",
        [productId, warehouseId],
      );
    if (productId)
      await cleanup.execute("DELETE FROM products WHERE id=?", [productId]);
    if (categoryId)
      await cleanup.execute("DELETE FROM categories WHERE id=?", [categoryId]);
    if (supplierId)
      await cleanup.execute("DELETE FROM suppliers WHERE id=?", [supplierId]);
    if (sessionId)
      await cleanup.execute("DELETE FROM user_sessions WHERE id=?", [
        sessionId,
      ]);
    if (noWarehouseSessionId)
      await cleanup.execute("DELETE FROM user_sessions WHERE id=?", [
        noWarehouseSessionId,
      ]);
    if (userId)
      await cleanup.execute("DELETE FROM user_warehouses WHERE user_id=?", [
        userId,
      ]);
    if (warehouseId)
      await cleanup.execute("DELETE FROM warehouses WHERE id=?", [warehouseId]);
    if (secondWarehouseId)
      await cleanup.execute("DELETE FROM warehouses WHERE id=?", [
        secondWarehouseId,
      ]);
    if (foreignWarehouseId)
      await cleanup.execute("DELETE FROM warehouses WHERE id=?", [
        foreignWarehouseId,
      ]);
    if (userId) await cleanup.execute("DELETE FROM users WHERE id=?", [userId]);
    if (noWarehouseUserId)
      await cleanup.execute("DELETE FROM users WHERE id=?", [
        noWarehouseUserId,
      ]);
    const [[leftovers]] = await cleanup.execute(
      `SELECT (SELECT COUNT(*) FROM users WHERE email=?) AS users,
              (SELECT COUNT(*) FROM warehouses WHERE code IN (?,?,?)) AS warehouses,
              (SELECT COUNT(*) FROM user_sessions WHERE id IN (?,?)) AS sessions,
              (SELECT COUNT(*) FROM users WHERE email=?) AS empty_scope_users`,
      [
        `purchase-http-${suffix}@sigecom.invalid`,
        `PH-${suffix}`,
        `PF-${suffix}`,
        `P2-${suffix}`,
        sessionId || 0,
        noWarehouseSessionId || 0,
        `purchase-http-empty-${suffix}@sigecom.invalid`,
      ],
    );
    assert.deepEqual(Object.values(leftovers).map(Number), [0, 0, 0, 0]);
  } finally {
    await cleanup?.end();
    await pool.end();
  }
});

test("HTTP report returns scoped empty summary and selector for an authorized inactive assigned warehouse", async () => {
  const [[beforeReads]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM purchase_receipts WHERE id=?) AS receipts,
            (SELECT COUNT(*) FROM inventory_movements WHERE operation_id IN (?,?)) AS movements,
            (SELECT COUNT(*) FROM supplier_returns WHERE id=?) AS returns,
            (SELECT COUNT(*) FROM inventory_operations WHERE id IN (?,?)) AS operations,
            (SELECT quantity FROM inventory_balances WHERE product_id=? AND warehouse_id=?) AS balance,
            (SELECT COUNT(*) FROM user_warehouses WHERE user_id=?) AS assignments,
            (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audits`,
    [
      receiptId,
      operationId,
      returnOperationId,
      returnId,
      operationId,
      returnOperationId,
      productId,
      warehouseId,
      userId,
      userId,
    ],
  );
  const startedAt = performance.now();
  const report = await request(app)
    .get(`/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}`)
    .set("Cookie", cookie)
    .expect(200);
  const oneDayHttpMs = performance.now() - startedAt;
  assert.equal(report.headers["cache-control"], "private, no-store");
  assert.deepEqual(report.body.summary, {
    receivedValue: "12.34",
    supplierReturnEquivalent: "6.17",
    referenceNetReceivedValue: "6.17",
    quantitiesByUnit: [
      {
        unit: "unidad",
        quantityReceived: "2",
        quantityReturned: "1",
        quantityDifference: "1",
      },
    ],
  });
  assert.equal(report.body.activities.length, 2);
  assert.deepEqual(report.body.pagination, {
    page: 1,
    pageSize: 20,
    total: 2,
    totalPages: 1,
  });
  assert.equal(report.body.period.timeZone, "America/Bogota");
  assert.equal(report.body.criteria.currency, "COP");
  const receiptActivity = report.body.activities.find(
    (activity) => activity.type === "purchase_receipt",
  );
  assert.ok(receiptActivity);
  assert.equal(receiptActivity.id, `purchase_receipt:${receiptId}`);
  assert.equal(receiptActivity.amount, "12.34");
  assert.deepEqual(receiptActivity.quantitiesByUnit, [
    { unit: "unidad", quantityReceived: "2" },
  ]);
  console.log(
    `Compras HTTP, 1 día/2 bodegas autorizadas/documento multilínea: ${oneDayHttpMs.toFixed(2)} ms`,
  );
  const singleWarehouseStartedAt = performance.now();
  const singleWarehouse = await request(app)
    .get(
      `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}&warehouseId=${warehouseId}`,
    )
    .set("Cookie", cookie)
    .expect(200);
  console.log(
    `Compras HTTP, 1 día/1 bodega/página inicial: ${(performance.now() - singleWarehouseStartedAt).toFixed(2)} ms`,
  );
  assert.deepEqual(singleWarehouse.body.summary, report.body.summary);
  assert.ok(report.body.generatedAt);
  assert.equal(JSON.stringify(report.body).includes("@sigecom.invalid"), false);

  const selector = await request(app)
    .get("/api/v1/reports/purchase-receipts/warehouses?q=PH-&page=1&pageSize=1")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(selector.body.pagination.total, 1);
  assert.equal(selector.body.items.length, 1);
  assert.equal(selector.body.items[0].id, warehouseId);
  assert.equal(selector.body.items[0].isActive, false);
  assert.equal(selector.body.items[0].name, `Bodega HTTP ${suffix}`);
  const selectorPage2 = await request(app)
    .get(
      "/api/v1/reports/purchase-receipts/warehouses?q=bodega%20HTTP&page=2&pageSize=1",
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(selectorPage2.body.pagination.total, 2);
  assert.equal(selectorPage2.body.items.length, 1);
  assert.notEqual(selectorPage2.body.items[0].id, selector.body.items[0].id);
  assert.equal(selectorPage2.body.items[0].id, secondWarehouseId);
  assert.equal(selectorPage2.body.items[0].isActive, true);
  const allAssignedSelector = await request(app)
    .get(`${selectorPath}?q=HTTP&page=1&pageSize=20`)
    .set("Cookie", cookie)
    .expect(200);
  assert.deepEqual(
    allAssignedSelector.body.items.map(({ id }) => id).sort(),
    [warehouseId, secondWarehouseId].sort(),
  );
  assert.equal(
    allAssignedSelector.body.items.some(({ id }) => id === foreignWarehouseId),
    false,
  );
  const start92 = new Date(`${date}T00:00:00.000Z`);
  start92.setUTCDate(start92.getUTCDate() - 91);
  const broadStartedAt = performance.now();
  const broad = await request(app)
    .get(
      `/api/v1/reports/purchase-receipts?dateFrom=${start92.toISOString().slice(0, 10)}&dateTo=${date}&page=1&pageSize=1`,
    )
    .set("Cookie", cookie)
    .expect(200);
  console.log(
    `Compras HTTP, 92 días/2 bodegas autorizadas/página inicial: ${(performance.now() - broadStartedAt).toFixed(2)} ms`,
  );
  assert.equal(broad.body.pagination.total, 2);
  const laterPage = await request(app)
    .get(
      `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}&page=2&pageSize=1`,
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(laterPage.body.pagination.total, 2);
  assert.equal(laterPage.body.activities.length, 1);
  assert.equal(laterPage.body.activities[0].type, "purchase_receipt");
  const [[afterReads]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM purchase_receipts WHERE id=?) AS receipts,
            (SELECT COUNT(*) FROM inventory_movements WHERE operation_id IN (?,?)) AS movements,
            (SELECT COUNT(*) FROM supplier_returns WHERE id=?) AS returns,
            (SELECT COUNT(*) FROM inventory_operations WHERE id IN (?,?)) AS operations,
            (SELECT quantity FROM inventory_balances WHERE product_id=? AND warehouse_id=?) AS balance,
            (SELECT COUNT(*) FROM user_warehouses WHERE user_id=?) AS assignments,
            (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audits`,
    [
      receiptId,
      operationId,
      returnOperationId,
      returnId,
      operationId,
      returnOperationId,
      productId,
      warehouseId,
      userId,
      userId,
    ],
  );
  assert.deepEqual(
    afterReads,
    beforeReads,
    "Los GET no deben generar escrituras ni auditoría.",
  );
});

test("HTTP serializes a traced supplier return exactly once with its historical references", async () => {
  const response = await request(app)
    .get(
      `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}&pageSize=1`,
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.deepEqual(response.body.summary, {
    receivedValue: "12.34",
    supplierReturnEquivalent: "6.17",
    referenceNetReceivedValue: "6.17",
    quantitiesByUnit: [
      {
        unit: "unidad",
        quantityReceived: "2",
        quantityReturned: "1",
        quantityDifference: "1",
      },
    ],
  });
  assert.equal(response.body.pagination.total, 2);
  const returnActivity = response.body.activities.find(
    (activity) => activity.type === "supplier_return",
  );
  assert.ok(returnActivity);
  assert.equal(returnActivity.id, `supplier_return:${returnId}`);
  assert.equal(returnActivity.sourceId, returnId);
  assert.equal(returnActivity.purchaseOrderId, orderId);
  assert.equal(returnActivity.purchaseReceiptId, receiptId);
  assert.equal(returnActivity.supplierReturnId, returnId);
  assert.equal(returnActivity.warehouse.id, warehouseId);
  assert.equal(returnActivity.amount, "6.17");
  assert.deepEqual(returnActivity.quantitiesByUnit, [
    { unit: "unidad", quantityReturned: "1" },
  ]);
  const [[stored]] = await pool.execute(
    "SELECT returned_at FROM supplier_returns WHERE id=?",
    [returnId],
  );
  assert.equal(
    new Date(returnActivity.occurredAt).getTime(),
    new Date(stored.returned_at).getTime(),
  );
  const allActivities = await request(app)
    .get(
      `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}&pageSize=20`,
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(
    allActivities.body.activities.filter(
      (activity) => activity.id === `supplier_return:${returnId}`,
    ).length,
    1,
  );
  assert.deepEqual(
    allActivities.body.activities.map((activity) => activity.type),
    ["supplier_return", "purchase_receipt"],
  );
});

test("HTTP report rejects invalid, unknown, repeated and over-limit query parameters without caching", async () => {
  const invalidQueries = [
    `dateFrom=2026-02-30&dateTo=${date}`,
    `dateFrom=${date}&dateTo=${date}&extra=1`,
    `dateFrom=${date}&dateFrom=${date}&dateTo=${date}`,
    `dateFrom=${date}&dateTo=${date}&page=1&page=2`,
    `dateFrom=${date}&dateTo=${date}&pageSize=101`,
    `dateFrom=2026-01-01&dateTo=2026-04-03`,
    `dateFrom=${date}&dateTo=${date}&page=1002&pageSize=10`,
  ];
  for (const query of invalidQueries) {
    const response = await request(app)
      .get(`/api/v1/reports/purchase-receipts?${query}`)
      .set("Cookie", cookie)
      .expect(400);
    assert.match(response.headers["cache-control"], /no-store/);
    assert.equal(typeof response.body.error.code, "string");
    assert.equal(JSON.stringify(response.body).includes("SELECT"), false);
  }
});

test("foreign and nonexistent warehouse IDs have the same public error", async () => {
  const query = (id) =>
    request(app)
      .get(
        `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}&warehouseId=${id}`,
      )
      .set("Cookie", cookie);
  const foreign = await query(foreignWarehouseId).expect(404);
  const missing = await query("18446744073709551615").expect(404);
  assert.equal(foreign.body.error.code, missing.body.error.code);
  assert.equal(foreign.body.error.message, missing.body.error.message);
  assert.match(foreign.headers["cache-control"], /no-store/);
});

test("HTTP authentication rejects anonymous, revoked, expired, inactive and password-pending sessions on both endpoints", async () => {
  const paths = [purchasePath(), selectorPath];
  for (const path of paths) {
    await expectDenied(path, { status: 401, cookieValue: null });
    const valid = await request(app)
      .get(path)
      .set("Cookie", cookie)
      .expect(200);
    assert.equal(valid.headers["cache-control"], "private, no-store");
  }

  try {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?",
      [sessionId],
    );
    for (const path of paths)
      await expectDenied(path, { status: 401, code: "SESSION_INVALID" });
  } finally {
    await pool.execute("UPDATE user_sessions SET revoked_at=NULL WHERE id=?", [
      sessionId,
    ]);
  }
  try {
    await pool.execute(
      "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?",
      [sessionId],
    );
    for (const path of paths)
      await expectDenied(path, { status: 401, code: "SESSION_INVALID" });
  } finally {
    await pool.execute(
      "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP(3)+INTERVAL 1 DAY WHERE id=?",
      [sessionId],
    );
  }
  try {
    await pool.execute("UPDATE users SET is_active=0 WHERE id=?", [userId]);
    for (const path of paths)
      await expectDenied(path, { status: 401, code: "SESSION_INVALID" });
  } finally {
    await pool.execute("UPDATE users SET is_active=1 WHERE id=?", [userId]);
  }
  try {
    await pool.execute(
      "UPDATE users SET password_change_required=1 WHERE id=?",
      [userId],
    );
    for (const path of paths)
      await expectDenied(path, {
        status: 403,
        code: "PASSWORD_CHANGE_REQUIRED",
      });
  } finally {
    await pool.execute(
      "UPDATE users SET password_change_required=0 WHERE id=?",
      [userId],
    );
  }
});

test("HTTP enforces independent purchase and sales permissions for administrator, auditor, seller and warehouse roles", async () => {
  const common = ["reports.read", "warehouses.read"];
  const purchase = [...common, "purchases.read"];
  const sales = [...common, "sales.read"];
  const full = [...purchase, "sales.read"];
  for (const roleCode of ["administrator", "auditor"]) {
    await pool.execute(
      "UPDATE users SET role_id=(SELECT id FROM roles WHERE code=?) WHERE id=?",
      [roleCode, userId],
    );
    const roleCodeForRequest = roleCode;
    for (const grants of [purchase, sales, full, common]) {
      const restore = await setRolePermissions(roleCode, grants);
      try {
        if (grants.includes("purchases.read")) {
          await request(app)
            .get(purchasePath())
            .set("Cookie", cookie)
            .expect(200);
          await request(app)
            .get(selectorPath)
            .set("Cookie", cookie)
            .expect(200);
          assert.equal(roleCodeForRequest, roleCode);
        } else {
          await expectDenied(purchasePath());
          await expectDenied(selectorPath);
        }
        if (grants.includes("sales.read")) {
          await request(app).get(salesPath()).set("Cookie", cookie).expect(200);
        } else {
          const deniedSales = await request(app)
            .get(salesPath())
            .set("Cookie", cookie)
            .expect(403);
          assert.equal(deniedSales.body.error.code, "PERMISSION_DENIED");
          assert.equal(Object.hasOwn(deniedSales.body, "summary"), false);
          assert.equal(
            deniedSales.headers["cache-control"],
            "private, no-store",
          );
        }
      } finally {
        await restore();
      }
    }
    for (const missing of [
      "reports.read",
      "warehouses.read",
      "purchases.read",
    ]) {
      const reduced = purchase.filter((code) => code !== missing);
      const restore = await setRolePermissions(roleCode, reduced);
      try {
        await expectDenied(purchasePath());
        await expectDenied(selectorPath);
      } finally {
        await restore();
      }
    }
  }

  for (const roleCode of ["seller", "warehouse"]) {
    await pool.execute(
      "UPDATE users SET role_id=(SELECT id FROM roles WHERE code=?) WHERE id=?",
      [roleCode, userId],
    );
    const restore = await setRolePermissions(roleCode, full);
    try {
      await expectDenied(purchasePath());
      await expectDenied(selectorPath);
      const deniedSales = await request(app)
        .get(salesPath())
        .set("Cookie", cookie)
        .expect(403);
      assert.equal(deniedSales.body.error.code, "PERMISSION_DENIED");
    } finally {
      await restore();
      await pool.execute(
        "UPDATE users SET role_id=(SELECT id FROM roles WHERE code='administrator') WHERE id=?",
        [userId],
      );
    }
  }
});

test("HTTP returns no global data to an authorized administrator without warehouse assignments", async () => {
  const report = await request(app)
    .get(purchasePath())
    .set("Cookie", noWarehouseCookie)
    .expect(200);
  assert.equal(report.headers["cache-control"], "private, no-store");
  assert.deepEqual(report.body.summary, {
    receivedValue: "0.00",
    supplierReturnEquivalent: "0.00",
    referenceNetReceivedValue: "0.00",
    quantitiesByUnit: [],
  });
  assert.deepEqual(report.body.activities, []);
  assert.deepEqual(report.body.pagination, {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  assert.equal(
    JSON.stringify(report.body).includes(`Bodega HTTP ${suffix}`),
    false,
  );
  assert.equal(JSON.stringify(report.body).includes("12.34"), false);
  const selector = await request(app)
    .get(selectorPath)
    .set("Cookie", noWarehouseCookie)
    .expect(200);
  assert.equal(selector.headers["cache-control"], "private, no-store");
  assert.deepEqual(selector.body.items, []);
  assert.deepEqual(selector.body.pagination, {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
});

test("HTTP excludes an inconsistent receipt from money, quantities, activities and pagination", async () => {
  const page1 = await request(app)
    .get(`${purchasePath()}&page=1&pageSize=1`)
    .set("Cookie", cookie)
    .expect(200);
  const page2 = await request(app)
    .get(`${purchasePath()}&page=2&pageSize=1`)
    .set("Cookie", cookie)
    .expect(200);
  assert.deepEqual(page1.body.summary, {
    receivedValue: "12.34",
    supplierReturnEquivalent: "6.17",
    referenceNetReceivedValue: "6.17",
    quantitiesByUnit: [
      {
        unit: "unidad",
        quantityReceived: "2",
        quantityReturned: "1",
        quantityDifference: "1",
      },
    ],
  });
  assert.equal(page1.body.pagination.total, 2);
  assert.equal(page1.body.pagination.totalPages, 2);
  assert.equal(page2.body.pagination.total, 2);
  const visible = [...page1.body.activities, ...page2.body.activities];
  assert.deepEqual(
    visible.map(({ id }) => id).sort(),
    [`purchase_receipt:${receiptId}`, `supplier_return:${returnId}`].sort(),
  );
  assert.equal(JSON.stringify(visible).includes(invalidReceiptId), false);
  assert.equal(JSON.stringify(visible).includes(`REC-PH-BAD-${suffix}`), false);
  const page3 = await request(app)
    .get(`${purchasePath()}&page=3&pageSize=1`)
    .set("Cookie", cookie)
    .expect(200);
  assert.deepEqual(page3.body.activities, []);
  assert.equal(page3.body.pagination.total, 2);
});

test("HTTP endpoints recheck persisted role authorization", async () => {
  const [[sellerRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='seller'",
  );
  try {
    await pool.execute("UPDATE users SET role_id=? WHERE id=?", [
      sellerRole.id,
      userId,
    ]);
    for (const path of [
      `/api/v1/reports/purchase-receipts?dateFrom=${date}&dateTo=${date}`,
      "/api/v1/reports/purchase-receipts/warehouses",
    ]) {
      const response = await request(app)
        .get(path)
        .set("Cookie", cookie)
        .expect(403);
      assert.equal(response.body.error.code, "PERMISSION_DENIED");
    }
  } finally {
    await pool.execute(
      "UPDATE users SET role_id=(SELECT id FROM roles WHERE code='administrator') WHERE id=?",
      [userId],
    );
  }
});
