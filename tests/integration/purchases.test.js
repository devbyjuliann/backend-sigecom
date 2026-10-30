import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { createInventoryService } from "../../src/modules/inventory/inventory-service.js";

const origin = "http://127.0.0.1:5173";
const suffix = randomBytes(6).toString("hex").toUpperCase();
const password = "Clave-segura-compras-2026!";
function productInput(unit) {
  return {
    sku: `PUR-${suffix}`,
    name: `Producto compras ${suffix}`,
    description: "",
    categoryId,
    unit,
    purchasePrice: "100.00",
    salePrice: "150.00",
    minimumSaleQuantity: null,
    minimumSaleEnabled: false,
    minimumStock: 0,
    isActive: true,
  };
}

function orderInput(overrides = {}) {
  return {
    supplierId,
    warehouseId,
    orderDate: "2026-10-29",
    reference: null,
    notes: null,
    lines: [{ productId, quantity: 4, unitCost: "100.25" }],
    ...overrides,
  };
}
const accountRoles = {
  administrator: "administrator",
  secondAdministrator: "administrator",
  unassignedAdministrator: "administrator",
  warehouse: "warehouse",
  auditor: "auditor",
  seller: "seller",
};
const accounts = Object.fromEntries(
  Object.keys(accountRoles).map((account) => [
    account,
    `purchases-${account}-${suffix}@sigecom.invalid`,
  ]),
);

let pool;
let app;
let authConfig;
let users = {};
let sessions = {};
let supplierId;
let warehouseId;
let productId;
let zeroCostProductId;
let categoryId;

async function signIn(email) {
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"].find((item) =>
    item.startsWith("sigecom_csrf="),
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", cookie.split(";", 1)[0])
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({ email, password })
    .expect(200);
  return {
    cookie: login.headers["set-cookie"]
      .map((item) => item.split(";", 1)[0])
      .join("; "),
    csrfToken: login.body.csrfToken,
  };
}

function get(path, session = sessions.administrator) {
  return request(app).get(path).set("Cookie", session.cookie);
}

function mutate(method, path, body, session = sessions.administrator) {
  const apiRequest = request(app);
  return apiRequest[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken)
    .send(body);
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_RATE_LIMIT_MAX: "20",
  });
  app = createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });

  const passwordHash = await bcrypt.hash(password, 12);
  for (const [account, email] of Object.entries(accounts)) {
    const [[roleRow]] = await pool.execute(
      "SELECT id FROM roles WHERE code = ?",
      [accountRoles[account]],
    );
    const [created] = await pool.execute(
      "INSERT INTO users (role_id, email, display_name, password_hash) VALUES (?, ?, ?, ?)",
      [roleRow.id, email, `Compras ${account} ${suffix}`, passwordHash],
    );
    users[account] = String(created.insertId);
  }
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`P-${suffix}`, `Bodega compras ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  for (const role of [
    "administrator",
    "secondAdministrator",
    "warehouse",
    "auditor",
  ]) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
      [users[role], warehouseId, users.administrator],
    );
  }
  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (identification_number, business_name) VALUES (?, ?)",
    [`NIT-${suffix}`, `Proveedor compras ${suffix}`],
  );
  supplierId = String(supplier.insertId);
  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Categoría compras ${suffix}`],
  );
  categoryId = String(category.insertId);
  const [product] = await pool.execute(
    `INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'caja', 100.00, 150.00)`,
    [`PUR-${suffix}`, `Producto compras ${suffix}`, categoryId],
  );
  productId = String(product.insertId);
  const [zeroCostProduct] = await pool.execute(
    `INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 0.00, 150.00)`,
    [`PURZ-${suffix}`, `Producto costo cero ${suffix}`, categoryId],
  );
  zeroCostProductId = String(zeroCostProduct.insertId);
  for (const [account, email] of Object.entries(accounts)) {
    sessions[account] = await signIn(email);
  }
});

after(async () => {
  if (!pool) return;
  for (const userId of Object.values(users)) {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    );
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [userId]);
  }
  await pool.end();
});

test("administrator can create, review, confirm and cancel orders without stock effects", async () => {
  const created = await mutate("post", "/api/v1/purchase-orders", {
    supplierId,
    warehouseId,
    orderDate: "2026-10-29",
    notes: "Entrega según disponibilidad",
    lines: [
      { productId, quantity: 3, unitCost: "1234.50" },
      { productId: zeroCostProductId, quantity: 2, unitCost: "0.00" },
    ],
  }).expect(201);
  assert.equal(created.body.number, `OC-${created.body.id.padStart(6, "0")}`);
  assert.ok(
    created.body.lines.every(
      (line) =>
        line.receivedQuantity === 0 && line.pendingQuantity === line.quantity,
    ),
  );

  assert.equal(created.body.status, "draft");
  assert.equal(created.body.total, "3703.50");
  const listed = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
  ).expect(200);
  assert.equal(listed.body.items[0].id, created.body.id);
  assert.equal(listed.body.items[0].lines.length, 2);
  for (const line of listed.body.items[0].lines) {
    const createdLine = created.body.lines.find(({ id }) => id === line.id);
    assert.ok(createdLine);
    assert.equal(line.sku, createdLine.sku);
    assert.equal(line.name, createdLine.name);
    assert.equal(line.unit, createdLine.unit);
    assert.equal(line.quantity, createdLine.quantity);
    assert.equal(line.receivedQuantity, 0);
    assert.equal(line.pendingQuantity, line.quantity);
  }
  const detail = await get(`/api/v1/purchase-orders/${created.body.id}`).expect(
    200,
  );
  assert.equal(detail.body.lines.length, 2);
  assert.equal(detail.body.lines[0].quantity, 3);
  assert.equal(detail.body.lines[0].unitCost, "1234.50");

  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: detail.body.version, confirmZeroCost: false },
  ).expect(409);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: detail.body.version, confirmZeroCost: true },
  ).expect(200);
  assert.equal(confirmed.body.status, "confirmed");
  assert.equal(confirmed.body.lines[0].unitCost, "1234.50");

  const unitChange = await mutate(
    "patch",
    `/api/v1/products/${productId}`,
    productInput("unidad"),
  );
  assert.equal(unitChange.status, 409, JSON.stringify(unitChange.body));

  const cancelled = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/cancellation`,
    {
      expectedVersion: confirmed.body.version,
      reason: "Pedido cancelado por pruebas",
    },
  ).expect(200);
  assert.equal(cancelled.body.status, "cancelled");
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: cancelled.body.version,
    reference: `CANCEL-${suffix}`,
    lines: [{ purchaseOrderLineId: created.body.lines[0].id, quantity: 1 }],
  })
    .set("Idempotency-Key", `cancelled-receipt-${suffix}`)
    .expect(409);

  const [[effects]] = await pool.execute(
    `SELECT
      (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ?) AS balances,
      (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) AS movements,
      (SELECT COUNT(*) FROM inventory_operations AS operation
       JOIN inventory_movements AS movement ON movement.operation_id = operation.id
       WHERE operation.operation_type = 'purchase_receipt' AND movement.product_id = ?) AS receipts`,
    [productId, productId, productId],
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(effects).map(([key, value]) => [key, Number(value)]),
    ),
    { balances: 0, movements: 0, receipts: 0 },
  );
});

test("an authorized administrator can change only the commercial order code and audit it", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 4, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const receipt = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `CODE-HISTORY-${suffix}`,
      lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
    },
  )
    .set("Idempotency-Key", `code-history-${suffix}`)
    .expect(201);
  const [[movementCountsBeforeCodeEdit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const changed = await mutate(
    "patch",
    `/api/v1/purchase-orders/${created.body.id}/commercial-code`,
    {
      commercialCode: `OC-COM-${suffix}`,
      expectedVersion: confirmed.body.version + 1,
    },
  ).expect(200);

  assert.equal(changed.body.id, created.body.id);
  assert.equal(changed.body.number, `OC-COM-${suffix}`);
  assert.equal(changed.body.supplierId, confirmed.body.supplierId);
  assert.equal(changed.body.warehouseId, confirmed.body.warehouseId);
  assert.deepEqual(
    [
      changed.body.lines[0].productId,
      changed.body.lines[0].quantity,
      changed.body.lines[0].receivedQuantity,
      changed.body.lines[0].pendingQuantity,
      changed.body.lines[0].unitCost,
      changed.body.lines[0].lineTotal,
    ],
    [productId, 4, 1, 3, "100.25", "401.00"],
  );
  const [[audit]] = await pool.execute(
    `SELECT action, entity_id, details FROM audit_events
     WHERE entity_type = 'purchase_order' AND entity_id = ?
       AND action = 'purchases.order_code_changed'
     ORDER BY id DESC LIMIT 1`,
    [created.body.id],
  );
  assert.ok(audit);
  assert.equal(audit.entity_id, created.body.id);
  assert.deepEqual(JSON.parse(audit.details), {
    previousCode: created.body.number,
    commercialCode: `OC-COM-${suffix}`,
  });

  const orderAgain = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.equal(orderAgain.body.id, created.body.id);
  assert.equal(orderAgain.body.number, `OC-COM-${suffix}`);
  assert.equal(orderAgain.body.lines[0].receivedQuantity, 1);
  const receiptHistory = await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
  ).expect(200);
  assert.equal(receiptHistory.body.items[0].id, receipt.body.id);
  assert.equal(receiptHistory.body.items[0].purchaseOrderId, created.body.id);
  assert.equal(
    receiptHistory.body.items[0].purchaseOrderNumber,
    `OC-COM-${suffix}`,
  );
  const [[movementCountsAfterCodeEdit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.equal(
    Number(movementCountsAfterCodeEdit.total),
    Number(movementCountsBeforeCodeEdit.total),
  );
});

test("commercial order codes reject invalid and duplicate values and reject stale versions", async () => {
  const first = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const second = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const invalidCode = await mutate(
    "patch",
    `/api/v1/purchase-orders/${first.body.id}/commercial-code`,
    { commercialCode: "   ", expectedVersion: first.body.version },
  ).expect(400);
  assert.equal(invalidCode.body.error.code, "INVALID_PURCHASE_ORDER");
  await mutate(
    "patch",
    `/api/v1/purchase-orders/${first.body.id}/commercial-code`,
    { commercialCode: "OC código", expectedVersion: first.body.version },
  ).expect(400);
  await mutate(
    "patch",
    `/api/v1/purchase-orders/${first.body.id}/commercial-code`,
    { commercialCode: `OC-DUP-${suffix}`, expectedVersion: first.body.version },
  ).expect(200);
  const duplicate = await mutate(
    "patch",
    `/api/v1/purchase-orders/${second.body.id}/commercial-code`,
    {
      commercialCode: `oc-dup-${suffix}`,
      expectedVersion: second.body.version,
    },
  ).expect(409);
  assert.equal(duplicate.body.error.code, "PURCHASE_ORDER_CODE_TAKEN");
  await mutate(
    "patch",
    `/api/v1/purchase-orders/${first.body.id}/commercial-code`,
    {
      commercialCode: `OC-STALE-${suffix}`,
      expectedVersion: first.body.version,
    },
  ).expect(409);
});

test("only an administrator with purchase edit permission can change the commercial code", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  await mutate(
    "patch",
    `/api/v1/purchase-orders/${created.body.id}/commercial-code`,
    {
      commercialCode: `OC-SELLER-${suffix}`,
      expectedVersion: created.body.version,
    },
    sessions.seller,
  ).expect(403);
  const unchanged = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.equal(unchanged.body.number, created.body.number);
});

test("concurrent commercial-code changes on one version accept only one update", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const results = await Promise.all([
    mutate(
      "patch",
      `/api/v1/purchase-orders/${created.body.id}/commercial-code`,
      {
        commercialCode: `OC-RACE-A-${suffix}`,
        expectedVersion: created.body.version,
      },
      sessions.administrator,
    ),
    mutate(
      "patch",
      `/api/v1/purchase-orders/${created.body.id}/commercial-code`,
      {
        commercialCode: `OC-RACE-B-${suffix}`,
        expectedVersion: created.body.version,
      },
      sessions.secondAdministrator,
    ),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  const current = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.ok(
    [`OC-RACE-A-${suffix}`, `OC-RACE-B-${suffix}`].includes(
      current.body.number,
    ),
  );
  assert.equal(current.body.id, created.body.id);
});

test("purchase list keeps filters and pagination while returning line details", async () => {
  const reference = `LIST-${randomBytes(6).toString("hex")}`;
  const first = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      reference,
      lines: [
        { productId, quantity: 5, unitCost: "100.00" },
        { productId: zeroCostProductId, quantity: 12, unitCost: "0.00" },
      ],
    }),
  ).expect(201);
  const second = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      reference,
      lines: [{ productId, quantity: 7, unitCost: "100.00" }],
    }),
  ).expect(201);

  const firstPage = await get(
    `/api/v1/purchase-orders?q=${reference}&warehouseId=${warehouseId}&status=draft&page=1&pageSize=1`,
  ).expect(200);
  const secondPage = await get(
    `/api/v1/purchase-orders?q=${reference}&warehouseId=${warehouseId}&status=draft&page=2&pageSize=1`,
  ).expect(200);
  assert.equal(firstPage.body.pagination.page, 1);
  assert.equal(firstPage.body.pagination.pageSize, 1);
  assert.equal(firstPage.body.pagination.total, 2);
  assert.equal(secondPage.body.pagination.page, 2);
  assert.notEqual(firstPage.body.items[0].id, secondPage.body.items[0].id);
  assert.deepEqual(
    [
      firstPage.body.items[0].id,
      firstPage.body.items[0].lines.map((line) => [
        line.sku,
        line.unit,
        line.quantity,
        line.receivedQuantity,
        line.pendingQuantity,
      ]),
      secondPage.body.items[0].id,
      secondPage.body.items[0].lines.map((line) => [
        line.sku,
        line.unit,
        line.quantity,
        line.receivedQuantity,
        line.pendingQuantity,
      ]),
    ],
    [
      second.body.id,
      [[`PUR-${suffix}`, "caja", 7, 0, 7]],
      first.body.id,
      [
        [`PUR-${suffix}`, "caja", 5, 0, 5],
        [`PURZ-${suffix}`, "unidad", 12, 0, 12],
      ],
    ],
  );
});

test("read-only roles can query authorized orders but cannot mutate them", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      lines: [
        { productId, quantity: 4, unitCost: "100.25" },
        { productId: zeroCostProductId, quantity: 7, unitCost: "0.00" },
      ],
    }),
  ).expect(201);
  const warehouseOrders = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
    sessions.warehouse,
  ).expect(200);
  assert.equal(warehouseOrders.body.items.length, 1);
  assert.equal(warehouseOrders.body.items[0].id, created.body.id);
  assert.deepEqual(
    warehouseOrders.body.items[0].lines.map((line) => [
      line.sku,
      line.unit,
      line.quantity,
      line.receivedQuantity,
      line.pendingQuantity,
    ]),
    [
      [`PUR-${suffix}`, "caja", 4, 0, 4],
      [`PURZ-${suffix}`, "unidad", 7, 0, 7],
    ],
  );
  const unassignedOrders = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
    sessions.unassignedAdministrator,
  ).expect(200);
  assert.deepEqual(unassignedOrders.body.items, []);
  await get("/api/v1/purchase-orders", sessions.auditor).expect(200);
  await get("/api/v1/purchase-orders", sessions.seller).expect(403);
  await mutate(
    "post",
    "/api/v1/purchase-orders",
    {},
    sessions.warehouse,
  ).expect(403);
  await mutate("post", "/api/v1/purchase-orders", {}, sessions.auditor).expect(
    403,
  );
});

test("draft edits use versions and reject duplicate, invalid, inactive, or unauthorized inputs", async () => {
  const duplicate = orderInput({
    lines: [
      { productId, quantity: 1, unitCost: "1.00" },
      { productId, quantity: 2, unitCost: "2.00" },
    ],
  });
  await mutate("post", "/api/v1/purchase-orders", duplicate).expect(400);
  await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      lines: [{ productId, quantity: 1.5, unitCost: "1.00" }],
    }),
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      lines: [{ productId, quantity: 1, unitCost: "1.001" }],
    }),
  ).expect(400);

  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const update = {
    ...orderInput({
      notes: "Borrador modificado",
      lines: [{ productId, quantity: 7, unitCost: "99.90" }],
    }),
    expectedVersion: created.body.version,
  };
  const changed = await mutate(
    "patch",
    `/api/v1/purchase-orders/${created.body.id}`,
    update,
  ).expect(200);
  assert.equal(changed.body.version, created.body.version + 1);
  assert.equal(changed.body.total, "699.30");
  assert.equal(changed.body.notes, "Borrador modificado");
  await mutate(
    "patch",
    `/api/v1/purchase-orders/${created.body.id}`,
    update,
  ).expect(409);
  const cancelledDraft = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/cancellation`,
    {
      expectedVersion: changed.body.version,
      reason: "No se requiere el pedido",
    },
  ).expect(200);
  assert.equal(cancelledDraft.body.status, "cancelled");

  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE module = 'purchases' AND entity_id = ? AND action IN ('purchases.order_created', 'purchases.order_updated')",
    [created.body.id],
  );
  assert.equal(Number(audit.total), 2);
});

test("order writes revalidate active suppliers, products, and assigned warehouses", async () => {
  await pool.execute("UPDATE suppliers SET is_active = 0 WHERE id = ?", [
    supplierId,
  ]);
  await mutate("post", "/api/v1/purchase-orders", orderInput()).expect(400);
  await pool.execute("UPDATE suppliers SET is_active = 1 WHERE id = ?", [
    supplierId,
  ]);

  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    productId,
  ]);
  await mutate("post", "/api/v1/purchase-orders", orderInput()).expect(400);
  await pool.execute("UPDATE products SET is_active = 1 WHERE id = ?", [
    productId,
  ]);

  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`UN-${suffix}`, `Bodega sin asignar ${suffix}`],
  );
  await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ warehouseId: String(warehouse.insertId) }),
  ).expect(403);
});

test("competing confirmation requests with the same version only confirm once", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const confirmation = {
    expectedVersion: created.body.version,
    confirmZeroCost: false,
  };
  const outcomes = await Promise.all([
    mutate(
      "post",
      `/api/v1/purchase-orders/${created.body.id}/confirmation`,
      confirmation,
    ),
    mutate(
      "post",
      `/api/v1/purchase-orders/${created.body.id}/confirmation`,
      confirmation,
    ),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [200, 409]);
  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE module = 'purchases' AND entity_id = ? AND action = 'purchases.order_confirmed'",
    [created.body.id],
  );
  assert.equal(Number(audit.total), 1);
});

test("a confirmed purchase order records a partial receipt through its inventory source", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 4, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const line = confirmed.body.lines[0];
  const [[inventoryBaseline]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const baselineQuantity = Number(inventoryBaseline?.quantity || 0);
  const baselineVersion = BigInt(inventoryBaseline?.version || 0);

  const history = await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
  ).expect(200);
  assert.ok(Array.isArray(history.body.items), JSON.stringify(history.body));
  assert.deepEqual(history.body.items, []);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: confirmed.body.version,
    reference: `REM-${suffix}`,
    lines: [{ purchaseOrderLineId: line.id, quantity: 2 }],
  }).expect(400);
  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `REM-${suffix}`,
      lines: [{ purchaseOrderLineId: line.id, quantity: 2 }],
    },
    sessions.warehouse,
  )
    .set("Idempotency-Key", `warehouse-receipt-${suffix}`)
    .expect(403);
  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `NO-WAREHOUSE-${suffix}`,
      lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
    },
    sessions.unassignedAdministrator,
  )
    .set("Idempotency-Key", `unassigned-receipt-${suffix}`)
    .expect(404);

  const received = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `REM-${suffix}`,
      notes: "Entrega parcial",
      lines: [{ purchaseOrderLineId: line.id, quantity: 2 }],
    },
  )
    .set("Idempotency-Key", `purchase-receipt-${suffix}`)
    .expect(201);

  assert.equal(received.body.lines[0].quantity, 2);
  assert.equal(received.body.replayed, false);
  assert.equal(received.body.lines[0].receivedBefore, 0);
  assert.equal(received.body.lines[0].receivedQuantity, 2);
  assert.equal(received.body.lines[0].pendingQuantity, 2);

  const replay = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `REM-${suffix}`,
      notes: "Entrega parcial",
      lines: [{ purchaseOrderLineId: line.id, quantity: 2 }],
    },
  )
    .set("Idempotency-Key", `purchase-receipt-${suffix}`)
    .expect(200);
  assert.equal(replay.body.id, received.body.id);
  assert.equal(replay.body.replayed, true);

  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: confirmed.body.version,
    reference: `OTRA-${suffix}`,
    notes: "Otra solicitud con la misma clave",
    lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
  })
    .set("Idempotency-Key", `purchase-receipt-${suffix}`)
    .expect(409);

  const partialOrder = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.equal(partialOrder.body.version, confirmed.body.version + 1);
  assert.equal(partialOrder.body.lines[0].receivedQuantity, 2);
  assert.equal(partialOrder.body.lines[0].pendingQuantity, 2);
  const listedPartial = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
  ).expect(200);
  assert.deepEqual(
    [
      listedPartial.body.items[0].lines[0].quantity,
      listedPartial.body.items[0].lines[0].receivedQuantity,
      listedPartial.body.items[0].lines[0].pendingQuantity,
    ],
    [4, 2, 2],
  );

  const [[firstBalance]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(
    [firstBalance.quantity, String(firstBalance.version)],
    [baselineQuantity + 2, (baselineVersion + 1n).toString()],
  );
  const [[operation]] = await pool.execute(
    `SELECT operation.operation_type, operation.source_type, operation.source_id,
            movement.direction, movement.balance_before, movement.balance_after
     FROM inventory_operations AS operation
     JOIN inventory_movements AS movement ON movement.operation_id = operation.id
     WHERE operation.id = ?`,
    [received.body.sourceOperationId],
  );
  assert.deepEqual(
    [
      operation.operation_type,
      operation.source_type,
      operation.source_id,
      operation.direction,
      operation.balance_before,
      operation.balance_after,
    ],
    [
      "purchase_receipt",
      "purchase_receipt",
      received.body.id,
      "IN",
      baselineQuantity,
      baselineQuantity + 2,
    ],
  );

  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: partialOrder.body.version,
    reference: `REM-${suffix}`,
    lines: [{ purchaseOrderLineId: line.id, quantity: 1 }],
  })
    .set("Idempotency-Key", `purchase-duplicate-reference-${suffix}`)
    .expect(409);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: partialOrder.body.version,
    reference: `SOBRE-${suffix}`,
    lines: [{ purchaseOrderLineId: line.id, quantity: 3 }],
  })
    .set("Idempotency-Key", `purchase-over-${suffix}`)
    .expect(409);

  const completed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: partialOrder.body.version,
      reference: `REM2-${suffix}`,
      lines: [{ purchaseOrderLineId: line.id, quantity: 2 }],
    },
  )
    .set("Idempotency-Key", `purchase-receipt-2-${suffix}`)
    .expect(201);
  assert.equal(completed.body.lines[0].receivedBefore, 2);
  assert.equal(completed.body.lines[0].pendingQuantity, 0);
  const listedCompleted = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
  ).expect(200);
  assert.deepEqual(
    [
      listedCompleted.body.items[0].lines[0].quantity,
      listedCompleted.body.items[0].lines[0].receivedQuantity,
      listedCompleted.body.items[0].lines[0].pendingQuantity,
    ],
    [4, 4, 0],
  );
  const [[completedBalance]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(
    [completedBalance.quantity, String(completedBalance.version)],
    [baselineQuantity + 4, (baselineVersion + 2n).toString()],
  );

  const receipts = await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    sessions.auditor,
  ).expect(200);
  assert.equal(receipts.body.items.length, 2);
  await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts/${completed.body.id}`,
    sessions.auditor,
  ).expect(200);
  await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    sessions.seller,
  ).expect(403);

  const reconciliation = await createInventoryService({
    dbPool: pool,
  }).reconcile({
    userId: users.administrator,
    warehouseId,
  });
  assert.equal(reconciliation.consistent, true);
});

test("simultaneous administrators cannot receive the same pending quantity twice", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 3, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const lineId = confirmed.body.lines[0].id;
  const [[balanceBefore]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const calls = [
    mutate(
      "post",
      `/api/v1/purchase-orders/${created.body.id}/receipts`,
      {
        expectedVersion: confirmed.body.version,
        reference: `CONC-A-${suffix}`,
        lines: [{ purchaseOrderLineId: lineId, quantity: 2 }],
      },
      sessions.administrator,
    ).set("Idempotency-Key", `concurrent-a-${suffix}`),
    mutate(
      "post",
      `/api/v1/purchase-orders/${created.body.id}/receipts`,
      {
        expectedVersion: confirmed.body.version,
        reference: `CONC-B-${suffix}`,
        lines: [{ purchaseOrderLineId: lineId, quantity: 2 }],
      },
      sessions.secondAdministrator,
    ).set("Idempotency-Key", `concurrent-b-${suffix}`),
  ];
  const results = await Promise.all(calls);
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
  const [[balance]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(
    [balance.quantity, String(balance.version)],
    [
      Number(balanceBefore?.quantity || 0) + 2,
      (BigInt(balanceBefore?.version || 0) + 1n).toString(),
    ],
  );
  const [[receiptCount]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM purchase_receipts WHERE purchase_order_id = ?",
    [created.body.id],
  );
  assert.equal(Number(receiptCount.total), 1);
});

test("receipt requests reject a line from another order without creating inventory history", async () => {
  const first = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 2, unitCost: "100.25" }] }),
  ).expect(201);
  const second = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      lines: [{ productId: zeroCostProductId, quantity: 2, unitCost: "0.00" }],
    }),
  ).expect(201);
  const firstConfirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${first.body.id}/confirmation`,
    { expectedVersion: first.body.version, confirmZeroCost: false },
  ).expect(200);
  const [[movementCountBefore]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  await mutate(
    "post",
    `/api/v1/purchase-orders/${second.body.id}/confirmation`,
    { expectedVersion: second.body.version, confirmZeroCost: true },
  ).expect(200);
  await mutate("post", `/api/v1/purchase-orders/${first.body.id}/receipts`, {
    expectedVersion: firstConfirmed.body.version,
    reference: `FOREIGN-${suffix}`,
    lines: [{ purchaseOrderLineId: second.body.lines[0].id, quantity: 1 }],
  })
    .set("Idempotency-Key", `foreign-line-${suffix}`)
    .expect(400);
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = ?) AS receipts,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) AS movements`,
    [first.body.id, productId],
  );
  assert.deepEqual(
    [Number(counts.receipts), Number(counts.movements)],
    [0, Number(movementCountBefore.total)],
  );
});

test("confirmed orders remain receivable after supplier deactivation, but inactive products roll back", async () => {
  const supplierOrder = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 1, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmedSupplierOrder = await mutate(
    "post",
    `/api/v1/purchase-orders/${supplierOrder.body.id}/confirmation`,
    { expectedVersion: supplierOrder.body.version, confirmZeroCost: false },
  ).expect(200);
  await pool.execute("UPDATE suppliers SET is_active = 0 WHERE id = ?", [
    supplierId,
  ]);
  const accepted = await mutate(
    "post",
    `/api/v1/purchase-orders/${supplierOrder.body.id}/receipts`,
    {
      expectedVersion: confirmedSupplierOrder.body.version,
      reference: `INACTIVE-SUPPLIER-${suffix}`,
      lines: [
        {
          purchaseOrderLineId: confirmedSupplierOrder.body.lines[0].id,
          quantity: 1,
        },
      ],
    },
  )
    .set("Idempotency-Key", `inactive-supplier-${suffix}`)
    .expect(201);
  assert.equal(accepted.body.lines[0].quantity, 1);
  await pool.execute("UPDATE suppliers SET is_active = 1 WHERE id = ?", [
    supplierId,
  ]);

  const productOrder = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      lines: [{ productId: zeroCostProductId, quantity: 1, unitCost: "0.00" }],
    }),
  ).expect(201);
  const confirmedProductOrder = await mutate(
    "post",
    `/api/v1/purchase-orders/${productOrder.body.id}/confirmation`,
    { expectedVersion: productOrder.body.version, confirmZeroCost: true },
  ).expect(200);
  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    zeroCostProductId,
  ]);
  await mutate(
    "post",
    `/api/v1/purchase-orders/${productOrder.body.id}/receipts`,
    {
      expectedVersion: confirmedProductOrder.body.version,
      reference: `INACTIVE-PRODUCT-${suffix}`,
      lines: [
        {
          purchaseOrderLineId: confirmedProductOrder.body.lines[0].id,
          quantity: 1,
        },
      ],
    },
  )
    .set("Idempotency-Key", `inactive-product-${suffix}`)
    .expect(409);
  await pool.execute("UPDATE products SET is_active = 1 WHERE id = ?", [
    zeroCostProductId,
  ]);
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = ?) AS receipts,
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) AS movements`,
    [productOrder.body.id, zeroCostProductId, warehouseId, zeroCostProductId],
  );
  assert.deepEqual(
    [
      Number(counts.receipts),
      Number(counts.balances),
      Number(counts.movements),
    ],
    [0, 0, 0],
  );
});

test("receipt audit failure rolls back the document, operation, balance, and movement", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 1, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const [[inventoryBefore]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?) AS movements`,
    [productId, warehouseId, productId, warehouseId],
  );

  const failingPool = {
    execute: pool.execute.bind(pool),
    query: pool.query.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = (sql, values) => {
        if (
          String(sql).includes("INSERT INTO audit_events") &&
          String(sql).includes("purchases.receipt_confirmed")
        ) {
          throw new Error("Injected purchase receipt audit failure.");
        }
        return execute(sql, values);
      };
      return connection;
    },
  };
  const failingApp = createApp({
    dbPool: failingPool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });
  const response = await request(failingApp)
    .post(`/api/v1/purchase-orders/${created.body.id}/receipts`)
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `audit-failure-${suffix}`)
    .send({
      expectedVersion: confirmed.body.version,
      reference: `AUDIT-FAIL-${suffix}`,
      lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
    });
  assert.equal(response.status, 500);
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = ?) AS receipts,
       (SELECT COUNT(*) FROM inventory_operations WHERE created_by = ? AND idempotency_key = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?) AS movements`,
    [
      created.body.id,
      users.administrator,
      `audit-failure-${suffix}`,
      productId,
      warehouseId,
      productId,
      warehouseId,
    ],
  );
  assert.deepEqual(
    [
      Number(counts.receipts),
      Number(counts.operations),
      Number(counts.balances),
      Number(counts.movements),
    ],
    [0, 0, Number(inventoryBefore.balances), Number(inventoryBefore.movements)],
  );
});

test("inventory-engine failure rolls back the pending receipt document", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 1, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const [[inventoryBefore]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?) AS movements`,
    [productId, warehouseId, productId, warehouseId],
  );
  const failingPool = {
    execute: pool.execute.bind(pool),
    query: pool.query.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = (sql, values) => {
        if (String(sql).includes("INSERT INTO inventory_operations")) {
          throw new Error("Injected inventory engine failure.");
        }
        return execute(sql, values);
      };
      return connection;
    },
  };
  const failingApp = createApp({
    dbPool: failingPool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });
  const response = await request(failingApp)
    .post(`/api/v1/purchase-orders/${created.body.id}/receipts`)
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `engine-failure-${suffix}`)
    .send({
      expectedVersion: confirmed.body.version,
      reference: `ENGINE-FAIL-${suffix}`,
      lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
    });
  assert.equal(response.status, 500);
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = ?) AS receipts,
       (SELECT COUNT(*) FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balances,
       (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?) AS movements`,
    [created.body.id, productId, warehouseId, productId, warehouseId],
  );
  assert.deepEqual(
    [
      Number(counts.receipts),
      Number(counts.balances),
      Number(counts.movements),
    ],
    [0, Number(inventoryBefore.balances), Number(inventoryBefore.movements)],
  );
});
