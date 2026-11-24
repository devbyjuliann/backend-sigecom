import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { createInventoryService } from "../../src/modules/inventory/inventory-service.js";
import { createInventoryEngine } from "../../src/modules/inventory/inventory-engine.js";
import {
  buildPurchaseOrdersEligibleQuery,
  createPurchaseOrdersService,
} from "../../src/modules/reports/purchase-orders-service.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";

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

async function createReceivedOrder({
  orderQuantity = 4,
  receiptQuantity = orderQuantity,
  selectedProductId = null,
} = {}) {
  if (!selectedProductId) {
    const [product] = await pool.execute(
      `INSERT INTO products
        (sku, name, category_id, unit, purchase_price, sale_price)
       VALUES (?, ?, ?, 'caja', 100.00, 150.00)`,
      [
        `RET-${randomBytes(6).toString("hex").toUpperCase()}`,
        `Producto devolución ${suffix}`,
        categoryId,
      ],
    );
    selectedProductId = String(product.insertId);
  }
  const created = await mutate("post", "/api/v1/purchase-orders", {
    ...orderInput({
      lines: [
        {
          productId: selectedProductId,
          quantity: orderQuantity,
          unitCost: "100.25",
        },
      ],
    }),
  }).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const receiptRequest = mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `REC-${suffix}-${randomBytes(3).toString("hex")}`,
      lines: [
        {
          purchaseOrderLineId: confirmed.body.lines[0].id,
          quantity: receiptQuantity,
        },
      ],
    },
  ).set("Idempotency-Key", `return-receipt-${randomBytes(12).toString("hex")}`);
  const receipt = await receiptRequest;
  assert.equal(receipt.status, 201);
  return { created, confirmed, receipt, productId: selectedProductId };
}

function returnRequest(orderId, receiptId, body, session, key) {
  return mutate(
    "post",
    `/api/v1/purchase-orders/${orderId}/receipts/${receiptId}/returns`,
    body,
    session,
  ).set("Idempotency-Key", key);
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
const fixtures = new IntegrationFixtures({ suite: "purchases" });

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
    fixtures.user(users[account]);
  }
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`P-${suffix}`, `Bodega compras ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  fixtures.warehouse(warehouseId);
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
  try {
    await fixtures.cleanupUserAssignments(pool);
  } finally {
    await pool.end();
  }
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
  await get(`/api/v1/purchase-orders/${created.body.id}/pdf`).expect(409);
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
  const [[orderBeforePdf]] = await pool.execute(
    `SELECT po.version, po.status,
       (SELECT COUNT(*) FROM purchase_receipts receipt
         WHERE receipt.purchase_order_id = po.id) AS receipts
     FROM purchase_orders po WHERE po.id = ?`,
    [created.body.id],
  );
  const orderPdf = await get(
    `/api/v1/purchase-orders/${created.body.id}/pdf`,
  ).expect(200);
  assert.match(orderPdf.headers["content-type"], /application\/pdf/);
  assert.match(orderPdf.headers["content-disposition"], /attachment/);
  assert.match(orderPdf.body.toString("latin1"), /Proveedor compras/);
  assert.match(orderPdf.body.toString("latin1"), /1234\.50 COP/);
  await get(`/api/v1/purchase-orders/${created.body.id}/pdf`).expect(200);
  await get(
    `/api/v1/purchase-orders/${created.body.id}/pdf`,
    sessions.unassignedAdministrator,
  ).expect(404);
  const [[orderAfterPdf]] = await pool.execute(
    `SELECT po.version, po.status,
       (SELECT COUNT(*) FROM purchase_receipts receipt
         WHERE receipt.purchase_order_id = po.id) AS receipts
     FROM purchase_orders po WHERE po.id = ?`,
    [created.body.id],
  );
  assert.deepEqual(orderAfterPdf, orderBeforePdf);

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
  fixtures.warehouse(String(warehouse.insertId));
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
  const [[receiptBeforePdf]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_operations
         WHERE source_type = 'purchase_receipt' AND source_id = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements movement
         JOIN inventory_operations operation ON operation.id = movement.operation_id
         WHERE operation.source_type = 'purchase_receipt' AND operation.source_id = ?) AS movements,
       (SELECT COUNT(*) FROM purchase_receipts
         WHERE purchase_order_id = ?) AS receipts`,
    [received.body.id, received.body.id, created.body.id],
  );
  const receiptPdfPath = `/api/v1/purchase-orders/${created.body.id}/receipts/${received.body.id}/pdf`;
  const receiptPdf = await get(receiptPdfPath).expect(200);
  assert.match(receiptPdf.headers["content-type"], /application\/pdf/);
  assert.match(receiptPdf.headers["content-disposition"], /attachment/);
  assert.match(
    receiptPdf.body.toString("latin1"),
    /Comprobante de recepción de compra/,
  );
  assert.match(receiptPdf.body.toString("latin1"), /100\.25 COP/);
  assert.match(receiptPdf.body.toString("latin1"), /200\.50 COP/);
  await get(receiptPdfPath).expect(200);
  await get(receiptPdfPath, sessions.unassignedAdministrator).expect(404);
  const [[receiptAfterPdf]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_operations
         WHERE source_type = 'purchase_receipt' AND source_id = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements movement
         JOIN inventory_operations operation ON operation.id = movement.operation_id
         WHERE operation.source_type = 'purchase_receipt' AND operation.source_id = ?) AS movements,
       (SELECT COUNT(*) FROM purchase_receipts
         WHERE purchase_order_id = ?) AS receipts`,
    [received.body.id, received.body.id, created.body.id],
  );
  assert.deepEqual(receiptAfterPdf, receiptBeforePdf);

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

test("partial purchase closure is idempotent, audited, versioned, and inventory-neutral", async () => {
  const created = await mutate("post", "/api/v1/purchase-orders", {
    ...orderInput({
      lines: [
        { productId, quantity: 4, unitCost: "100.25" },
        { productId: zeroCostProductId, quantity: 3, unitCost: "0.00" },
      ],
    }),
  }).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: true },
  ).expect(200);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: confirmed.body.version,
    reference: `CIERRE-${suffix}`,
    lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
  })
    .set("Idempotency-Key", `closure-receipt-${suffix}`)
    .expect(201);
  const beforeOrder = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  const [[beforeInventory]] = await pool.execute(
    `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances
             WHERE warehouse_id = ? AND product_id IN (?, ?)) AS quantity,
            (SELECT COUNT(*) FROM inventory_movements
             WHERE warehouse_id = ? AND product_id IN (?, ?)) AS movements`,
    [
      warehouseId,
      productId,
      zeroCostProductId,
      warehouseId,
      productId,
      zeroCostProductId,
    ],
  );

  const input = {
    expectedVersion: beforeOrder.body.version,
    reason: "Proveedor no entregará el saldo",
  };
  const closed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/closure`,
    input,
  )
    .set("Idempotency-Key", `purchase-closure-${suffix}`)
    .expect(200);
  assert.equal(closed.body.closure.reason, input.reason);
  assert.equal(closed.body.closure.closedBy, users.administrator);
  assert.equal(closed.body.version, beforeOrder.body.version + 1);
  assert.deepEqual(
    closed.body.lines.map(
      ({ quantity, receivedQuantity, closedQuantity, pendingQuantity }) => [
        quantity,
        receivedQuantity,
        closedQuantity,
        pendingQuantity,
      ],
    ),
    [
      [4, 1, 3, 0],
      [3, 0, 3, 0],
    ],
  );
  const [[reportSession]] = await pool.execute(
    "SELECT id FROM user_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) ORDER BY id DESC LIMIT 1",
    [users.administrator],
  );
  const orderReport = createPurchaseOrdersService({ dbPool: pool });
  const closedReport = await orderReport.summarize({
    auth: {
      user: { id: users.administrator, role: "administrator" },
      sessionId: String(reportSession.id),
    },
    mode: "period",
    dateFrom: "2026-10-29",
    dateTo: "2026-10-29",
    warehouseId,
  });
  const closedOrder = closedReport.orders.find(
    ({ id }) => id === String(created.body.id),
  );
  assert.equal(closedOrder.situation, "closed_with_remnant");
  assert.equal(closedOrder.receiptProgress, "partial");
  assert.equal(closedOrder.orderedValue, "401.00");
  assert.deepEqual(closedOrder.pendingByUnit, []);
  assert.deepEqual(closedOrder.closedByUnit, [
    { unit: "caja", quantity: "3" },
    { unit: "unidad", quantity: "3" },
  ]);
  assert.equal(
    closedOrder.lines.reduce(
      (sum, line) => sum + BigInt(line.receivedQuantity),
      0n,
    ),
    1n,
  );

  const readConnection = await pool.getConnection();
  try {
    await readConnection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    );
    await readConnection.query("SET TRANSACTION READ ONLY");
    await readConnection.beginTransaction();
    const criteria = {
      connection: readConnection,
      warehouseIds: [warehouseId],
      mode: "period",
      dateFrom: "2026-10-29",
      dateTo: "2026-10-29",
    };
    const sqlSummary = await orderReport.summarizeEligible(criteria);
    const sqlCount = await orderReport.countEligible(criteria);
    const sqlPage = await orderReport.pageEligible({
      ...criteria,
      pageSize: 1,
      offset: 0,
    });
    const sqlLines = await orderReport.linesForPage({
      ...criteria,
      ids: sqlPage.map(({ id }) => String(id)),
    });
    assert.equal(sqlSummary.verifiedOrders, sqlCount);
    assert.equal(sqlSummary.verifiedOrders, String(closedReport.orders.length));
    assert.equal(sqlPage.length, 1);
    assert.equal(String(sqlPage[0].id), String(created.body.id));
    assert.equal(sqlPage[0].situation, "closed_with_remnant");
    assert.equal(sqlPage[0].ordered_value, "401.00");
    assert.equal(sqlLines.length, 2);
    assert.deepEqual(sqlSummary.closedByUnit, [
      { unit: "caja", quantity: "3" },
      { unit: "unidad", quantity: "3" },
    ]);
    const firstQuery = buildPurchaseOrdersEligibleQuery({
      warehouseIds: [warehouseId],
      mode: "period",
      dateFrom: "2026-10-29",
      dateTo: "2026-10-29",
      pageSize: 1,
      offset: 0,
    });
    const secondQuery = buildPurchaseOrdersEligibleQuery({
      warehouseIds: [warehouseId],
      mode: "period",
      dateFrom: "2026-10-29",
      dateTo: "2026-10-29",
      pageSize: 1,
      offset: 1,
    });
    assert.equal(firstQuery.sql, secondQuery.sql);
    assert.deepEqual(
      firstQuery.params.slice(0, -2),
      secondQuery.params.slice(0, -2),
    );
    assert.deepEqual(firstQuery.params.slice(-2), [1, 0]);
    assert.deepEqual(secondQuery.params.slice(-2), [1, 1]);
    const laterPage = await orderReport.pageEligible({
      ...criteria,
      pageSize: 1,
      offset: 1,
    });
    const laterPageLines = await orderReport.linesForPage({
      ...criteria,
      ids: laterPage.map(({ id }) => String(id)),
    });
    const lastPage = await orderReport.pageEligible({
      ...criteria,
      pageSize: 1,
      offset: Number(sqlCount) - 1,
    });
    const beyondPage = await orderReport.pageEligible({
      ...criteria,
      pageSize: 1,
      offset: Number(sqlCount),
    });
    assert.equal(lastPage.length, 1);
    assert.equal(beyondPage.length, 0);
    assert.ok(Number(sqlCount) > 1);
    assert.equal(laterPage.length, 1);
    const laterPageOrder = closedReport.orders.find(
      ({ id }) => id === String(laterPage[0].id),
    );
    assert.ok(laterPageOrder);
    assert.deepEqual(
      laterPageLines.map(
        ({ product_id, quantity, received_quantity, unit_snapshot }) => [
          String(product_id),
          String(quantity),
          String(received_quantity),
          unit_snapshot,
        ],
      ),
      laterPageOrder.lines.map(
        ({ productId, quantity, receivedQuantity, unit }) => [
          productId,
          quantity,
          receivedQuantity,
          unit,
        ],
      ),
    );
    const pageIds = [sqlPage, laterPage].flat().map(({ id }) => String(id));
    assert.equal(new Set(pageIds).size, pageIds.length);
    const everyPageOrderId = [];
    for (let offset = 0; offset < Number(sqlCount); offset += 1) {
      const page = await orderReport.pageEligible({
        ...criteria,
        pageSize: 1,
        offset,
      });
      assert.equal(page.length, 1);
      everyPageOrderId.push(String(page[0].id));
    }
    assert.equal(everyPageOrderId.length, Number(sqlCount));
    assert.equal(new Set(everyPageOrderId).size, everyPageOrderId.length);
    assert.deepEqual(
      everyPageOrderId,
      [...closedReport.orders]
        .map(({ id }) => String(id))
        .sort((left, right) => (BigInt(left) > BigInt(right) ? -1 : 1)),
    );
    assert.equal(
      (await orderReport.summarizeEligible(criteria)).verifiedOrders,
      sqlSummary.verifiedOrders,
    );
    const pendingReport = await orderReport.summarize({
      auth: {
        user: { id: users.administrator, role: "administrator" },
        sessionId: String(reportSession.id),
      },
      mode: "pending",
      warehouseId,
    });
    const pendingCriteria = {
      connection: readConnection,
      warehouseIds: [warehouseId],
      mode: "pending",
    };
    const pendingCount = await orderReport.countEligible(pendingCriteria);
    assert.equal(pendingCount, String(pendingReport.orders.length));
    const pendingIds = [];
    for (let offset = 0; offset < Number(pendingCount); offset += 1) {
      const [order] = await orderReport.pageEligible({
        ...pendingCriteria,
        pageSize: 1,
        offset,
      });
      assert.ok(order);
      pendingIds.push(String(order.id));
    }
    assert.deepEqual(
      pendingIds,
      pendingReport.orders.map(({ id }) => String(id)),
    );
    await readConnection.commit();
  } catch (error) {
    await readConnection.rollback();
    throw error;
  } finally {
    readConnection.release();
  }

  const closedOverHttp = await get(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2026-10-29&dateTo=2026-10-29&warehouseId=${warehouseId}&q=${created.body.number}`,
  ).expect(200);
  assert.equal(closedOverHttp.body.summary.ordersClosedWithRemnant, "1");
  assert.deepEqual(closedOverHttp.body.summary.pendingByUnit, []);
  assert.deepEqual(closedOverHttp.body.summary.closedByUnit, [
    { unit: "caja", quantity: "3" },
    { unit: "unidad", quantity: "3" },
  ]);
  assert.equal(closedOverHttp.body.orders[0].situation, "closed_with_remnant");
  assert.equal(closedOverHttp.body.orders[0].receiptProgress, "partial");
  assert.equal(closedOverHttp.body.orders[0].orderedValue, "401.00");
  assert.ok(
    closedOverHttp.body.orders[0].lines.every(
      ({ pendingQuantity, closedQuantity }) =>
        pendingQuantity === "0" && BigInt(closedQuantity) >= 0n,
    ),
  );

  const replay = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/closure`,
    input,
  )
    .set("Idempotency-Key", `purchase-closure-${suffix}`)
    .expect(200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.version, closed.body.version);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/closure`, {
    ...input,
    reason: "Otro motivo diferente",
  })
    .set("Idempotency-Key", `purchase-closure-${suffix}`)
    .expect(409);
  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/closure`,
    input,
  )
    .set("Idempotency-Key", `purchase-closure-otra-${suffix}`)
    .expect(409);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: closed.body.version,
    reference: `POST-CIERRE-${suffix}`,
    lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
  })
    .set("Idempotency-Key", `receipt-after-closure-${suffix}`)
    .expect(409);

  const detail = await get(`/api/v1/purchase-orders/${created.body.id}`).expect(
    200,
  );
  assert.equal(detail.body.closure.reason, input.reason);
  const listed = await get(
    `/api/v1/purchase-orders?q=${created.body.number}`,
  ).expect(200);
  assert.deepEqual(
    listed.body.items[0].lines.map(({ closedQuantity, pendingQuantity }) => [
      closedQuantity,
      pendingQuantity,
    ]),
    [
      [3, 0],
      [3, 0],
    ],
  );
  const [[afterInventory]] = await pool.execute(
    `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances
             WHERE warehouse_id = ? AND product_id IN (?, ?)) AS quantity,
            (SELECT COUNT(*) FROM inventory_movements
             WHERE warehouse_id = ? AND product_id IN (?, ?)) AS movements`,
    [
      warehouseId,
      productId,
      zeroCostProductId,
      warehouseId,
      productId,
      zeroCostProductId,
    ],
  );
  assert.deepEqual(
    [afterInventory.quantity, afterInventory.movements],
    [beforeInventory.quantity, beforeInventory.movements],
  );
  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'purchases.order_closed' AND entity_id = ?",
    [created.body.id],
  );
  assert.equal(Number(audit.total), 1);
});

test("purchase closure rejects invalid state, version, authorization, and reason", async () => {
  const draft = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput(),
  ).expect(201);
  const path = `/api/v1/purchase-orders/${draft.body.id}/closure`;
  const closure = (
    body,
    session = sessions.administrator,
    key = `reject-${suffix}`,
  ) => mutate("post", path, body, session).set("Idempotency-Key", key);

  await closure({
    expectedVersion: draft.body.version,
    reason: "No aplica",
  }).expect(409);
  await closure({ expectedVersion: draft.body.version, reason: " " }).expect(
    400,
  );
  await closure(
    { expectedVersion: draft.body.version, reason: "Motivo válido" },
    sessions.warehouse,
  ).expect(403);
  await closure(
    { expectedVersion: draft.body.version, reason: "Motivo válido" },
    sessions.auditor,
  ).expect(403);
  await closure(
    { expectedVersion: draft.body.version, reason: "Motivo válido" },
    sessions.seller,
  ).expect(403);
  await closure(
    { expectedVersion: draft.body.version, reason: "Motivo válido" },
    sessions.unassignedAdministrator,
  ).expect(404);

  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${draft.body.id}/confirmation`,
    { expectedVersion: draft.body.version, confirmZeroCost: false },
  ).expect(200);
  await closure(
    { expectedVersion: confirmed.body.version + 1, reason: "Motivo válido" },
    sessions.administrator,
    `stale-${suffix}`,
  ).expect(409);
  await closure(
    { expectedVersion: confirmed.body.version, reason: "Motivo válido" },
    sessions.administrator,
    `empty-${suffix}`,
  ).expect(409);

  await mutate(
    "post",
    `/api/v1/purchase-orders/${draft.body.id}/cancellation`,
    {
      expectedVersion: confirmed.body.version,
      reason: "Cancelación previa",
    },
  ).expect(200);
  await closure(
    { expectedVersion: confirmed.body.version + 1, reason: "Motivo válido" },
    sessions.administrator,
    `cancelled-${suffix}`,
  ).expect(409);
});

test("purchase closure rejects an order whose quantities were fully received", async () => {
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({ lines: [{ productId, quantity: 2, unitCost: "100.25" }] }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
    expectedVersion: confirmed.body.version,
    reference: `FULL-${suffix}`,
    lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 2 }],
  })
    .set("Idempotency-Key", `full-receipt-${suffix}`)
    .expect(201);
  const current = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/closure`, {
    expectedVersion: current.body.version,
    reason: "No queda saldo",
  })
    .set("Idempotency-Key", `full-closure-${suffix}`)
    .expect(409);
});

test("receipt and closure serialize on the order and cannot both consume one version", async () => {
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
  const outcomes = await Promise.all([
    mutate("post", `/api/v1/purchase-orders/${created.body.id}/closure`, {
      expectedVersion: confirmed.body.version,
      reason: "Cierre por carrera",
    }).set("Idempotency-Key", `race-closure-${suffix}`),
    mutate("post", `/api/v1/purchase-orders/${created.body.id}/receipts`, {
      expectedVersion: confirmed.body.version,
      reference: `RACE-${suffix}`,
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }).set("Idempotency-Key", `race-receipt-${suffix}`),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [201, 409]);
  const finalOrder = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.equal(finalOrder.body.version, confirmed.body.version + 1);
  assert.ok(
    finalOrder.body.closure || finalOrder.body.lines[0].receivedQuantity === 1,
  );
  if (finalOrder.body.closure)
    assert.equal(finalOrder.body.lines[0].pendingQuantity, 0);
});

test("closure audit failure rolls back metadata and document version", async () => {
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
  const receipt = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts`,
    {
      expectedVersion: confirmed.body.version,
      reference: `ROLLBACK-${suffix}`,
      lines: [{ purchaseOrderLineId: confirmed.body.lines[0].id, quantity: 1 }],
    },
  )
    .set("Idempotency-Key", `rollback-receipt-${suffix}`)
    .expect(201);
  const current = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);

  const failingPool = {
    execute: pool.execute.bind(pool),
    query: pool.query.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = (sql, values) => {
        if (
          String(sql).includes("INSERT INTO audit_events") &&
          values?.includes("purchases.order_closed")
        )
          throw new Error("Injected purchase closure audit failure.");
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
    .post(`/api/v1/purchase-orders/${created.body.id}/closure`)
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `rollback-closure-${suffix}`)
    .send({
      expectedVersion: current.body.version,
      reason: "La auditoría debe confirmar",
    });
  assert.equal(response.status, 500);
  const unchanged = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.equal(unchanged.body.closure, null);
  assert.equal(unchanged.body.version, current.body.version);
  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'purchases.order_closed' AND entity_id = ?",
    [created.body.id],
  );
  assert.equal(Number(audit.total), 0);
  assert.equal(receipt.status, 201);
});

test("supplier returns consume only a receipt's received quantity and remain idempotent", async () => {
  const {
    created,
    receipt,
    productId: returnedProductId,
  } = await createReceivedOrder({
    orderQuantity: 6,
    receiptQuantity: 4,
  });
  const receiptLine = receipt.body.lines[0];
  const requestBody = {
    reference: `DEV-${suffix}-A`,
    reason: "Mercancía averiada al llegar",
    lines: [{ purchaseReceiptLineId: receiptLine.id, quantity: 1 }],
  };
  const key = `return-once-${suffix}`;
  const first = await returnRequest(
    created.body.id,
    receipt.body.id,
    requestBody,
    sessions.administrator,
    key,
  ).expect(201);
  assert.equal(first.body.reference, requestBody.reference);
  assert.equal(first.body.reason, requestBody.reason);
  assert.equal(first.body.purchaseReceiptId, receipt.body.id);
  assert.equal(first.body.purchaseOrderId, created.body.id);
  assert.equal(first.body.sourceOperationId !== null, true);
  assert.equal(first.body.lines[0].quantity, 1);

  const [[balanceAfterFirst]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [returnedProductId, warehouseId],
  );
  assert.deepEqual(
    [balanceAfterFirst.quantity, String(balanceAfterFirst.version)],
    [3, "2"],
  );
  const [[operation]] = await pool.execute(
    `SELECT io.operation_type, io.source_type, io.source_id,
            im.direction, im.quantity, im.balance_before, im.balance_after
     FROM inventory_operations io
     JOIN inventory_movements im ON im.operation_id = io.id
     WHERE io.id = ?`,
    [first.body.sourceOperationId],
  );
  assert.deepEqual(
    [
      operation.operation_type,
      operation.source_type,
      operation.source_id,
      operation.direction,
      operation.quantity,
      operation.balance_before,
      operation.balance_after,
    ],
    ["supplier_return", "supplier_return", first.body.id, "OUT", 1, 4, 3],
  );

  const replay = await returnRequest(
    created.body.id,
    receipt.body.id,
    requestBody,
    sessions.administrator,
    key,
  ).expect(200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.replayed, true);
  const receiptAfter = await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}`,
  ).expect(200);
  assert.deepEqual(
    [
      receiptAfter.body.lines[0].quantity,
      receiptAfter.body.lines[0].returnedQuantity,
      receiptAfter.body.lines[0].returnableQuantity,
    ],
    [4, 1, 3],
  );
  const orderAfter = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  assert.deepEqual(
    [
      orderAfter.body.lines[0].quantity,
      orderAfter.body.lines[0].receivedQuantity,
      orderAfter.body.lines[0].pendingQuantity,
    ],
    [6, 4, 2],
  );
  const listed = await get(
    `/api/v1/purchase-orders/${created.body.id}/returns`,
  ).expect(200);
  assert.equal(listed.body.items.length, 1);
  const detail = await get(
    `/api/v1/purchase-orders/${created.body.id}/returns/${first.body.id}`,
  ).expect(200);
  assert.equal(detail.body.sourceOperationId, first.body.sourceOperationId);

  const second = await returnRequest(
    created.body.id,
    receipt.body.id,
    {
      ...requestBody,
      reference: `DEV-${suffix}-B`,
      lines: [{ purchaseReceiptLineId: receiptLine.id, quantity: 2 }],
    },
    sessions.administrator,
    `return-twice-${suffix}`,
  ).expect(201);
  const finalReturn = await returnRequest(
    created.body.id,
    receipt.body.id,
    {
      ...requestBody,
      reference: `DEV-${suffix}-C`,
      lines: [{ purchaseReceiptLineId: receiptLine.id, quantity: 1 }],
    },
    sessions.administrator,
    `return-complete-${suffix}`,
  ).expect(201);
  assert.notEqual(second.body.id, finalReturn.body.id);
  const [[finalBalance]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [returnedProductId, warehouseId],
  );
  assert.deepEqual(
    [finalBalance.quantity, String(finalBalance.version)],
    [0, "4"],
  );
  const exhausted = await get(
    `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}`,
  ).expect(200);
  assert.equal(exhausted.body.lines[0].returnableQuantity, 0);
  assert.equal(exhausted.body.lines[0].quantity, 4);
});

test("supplier returns reject over-return, duplicate references, invalid lines and missing keys", async () => {
  const { created, receipt } = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const lineId = receipt.body.lines[0].id;
  const base = {
    reference: `DEV-VALID-${suffix}`,
    reason: "Producto con empaque dañado",
    lines: [{ purchaseReceiptLineId: lineId, quantity: 2 }],
  };
  await returnRequest(
    created.body.id,
    receipt.body.id,
    base,
    sessions.administrator,
    `validate-return-${suffix}`,
  ).expect(201);

  await returnRequest(
    created.body.id,
    receipt.body.id,
    { ...base, reference: `DEV-DIFFERENT-${suffix}` },
    sessions.administrator,
    `validate-return-${suffix}`,
  ).expect(409);

  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}/returns`,
    { ...base, reference: `DEV-OVER-${suffix}` },
  )
    .set("Idempotency-Key", `over-return-${suffix}`)
    .expect(409);
  await returnRequest(
    created.body.id,
    receipt.body.id,
    {
      ...base,
      reference: `DEV-VALID-${suffix}`,
      lines: [{ purchaseReceiptLineId: lineId, quantity: 1 }],
    },
    sessions.administrator,
    `duplicate-return-reference-${suffix}`,
  ).expect(409);
  await returnRequest(
    created.body.id,
    receipt.body.id,
    {
      ...base,
      reference: `DEV-DUPLINE-${suffix}`,
      lines: [
        { purchaseReceiptLineId: lineId, quantity: 1 },
        { purchaseReceiptLineId: lineId, quantity: 1 },
      ],
    },
    sessions.administrator,
    `duplicate-return-line-${suffix}`,
  ).expect(400);
  await returnRequest(
    created.body.id,
    receipt.body.id,
    { ...base, reference: " ", reason: " ", lines: [] },
    sessions.administrator,
    `invalid-return-fields-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}/returns`,
    base,
  ).expect(400);
});

test("supplier returns enforce role, explicit warehouse assignment and receipt ownership", async () => {
  const first = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const second = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const body = {
    reference: `DEV-AUTH-${suffix}`,
    reason: "Devolución autorizada de prueba",
    lines: [
      { purchaseReceiptLineId: first.receipt.body.lines[0].id, quantity: 1 },
    ],
  };
  const url = `/api/v1/purchase-orders/${first.created.body.id}/receipts/${first.receipt.body.id}/returns`;
  for (const session of [
    sessions.warehouse,
    sessions.auditor,
    sessions.seller,
  ]) {
    await returnRequest(
      first.created.body.id,
      first.receipt.body.id,
      {
        ...body,
        reference: `${body.reference}-${session === sessions.warehouse ? "W" : session === sessions.auditor ? "A" : "S"}`,
      },
      session,
      `return-role-${randomBytes(5).toString("hex")}`,
    ).expect(403);
  }
  await returnRequest(
    first.created.body.id,
    first.receipt.body.id,
    { ...body, reference: `DEV-UNASSIGNED-${suffix}` },
    sessions.unassignedAdministrator,
    `return-unassigned-${suffix}`,
  ).expect(404);
  await returnRequest(
    first.created.body.id,
    first.receipt.body.id,
    {
      ...body,
      reference: `DEV-FOREIGN-${suffix}`,
      lines: [
        { purchaseReceiptLineId: second.receipt.body.lines[0].id, quantity: 1 },
      ],
    },
    sessions.administrator,
    `return-foreign-line-${suffix}`,
  ).expect(400);
  await get(
    `/api/v1/purchase-orders/${first.created.body.id}/returns`,
    sessions.seller,
  ).expect(403);
  const allowedRead = await get(
    `/api/v1/purchase-orders/${first.created.body.id}/returns`,
    sessions.auditor,
  ).expect(200);
  assert.deepEqual(allowedRead.body.items, []);
  assert.equal(url.includes("/returns"), true);
});

test("supplier returns remain available for closed orders and deactivated suppliers", async () => {
  const { created, receipt } = await createReceivedOrder({
    orderQuantity: 5,
    receiptQuantity: 2,
  });
  const current = await get(
    `/api/v1/purchase-orders/${created.body.id}`,
  ).expect(200);
  await mutate("post", `/api/v1/purchase-orders/${created.body.id}/closure`, {
    expectedVersion: current.body.version,
    reason: "Proveedor no enviará el saldo",
  })
    .set("Idempotency-Key", `close-before-return-${suffix}`)
    .expect(200);
  await pool.execute("UPDATE suppliers SET is_active = 0 WHERE id = ?", [
    supplierId,
  ]);
  const returned = await returnRequest(
    created.body.id,
    receipt.body.id,
    {
      reference: `DEV-CERRADA-${suffix}`,
      reason: "Mercancía recibida no corresponde",
      lines: [{ purchaseReceiptLineId: receipt.body.lines[0].id, quantity: 1 }],
    },
    sessions.administrator,
    `return-closed-order-${suffix}`,
  ).expect(201);
  assert.equal(returned.body.lines[0].quantity, 1);
  const order = await get(`/api/v1/purchase-orders/${created.body.id}`).expect(
    200,
  );
  assert.equal(order.body.closure.reason, "Proveedor no enviará el saldo");
  assert.deepEqual(
    [
      order.body.lines[0].quantity,
      order.body.lines[0].receivedQuantity,
      order.body.lines[0].pendingQuantity,
    ],
    [5, 2, 0],
  );
  await pool.execute("UPDATE suppliers SET is_active = 1 WHERE id = ?", [
    supplierId,
  ]);
});

test("supplier returns serialize competing requests and reject insufficient stock or inactive resources", async () => {
  const {
    created,
    receipt,
    productId: concurrentProductId,
  } = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const requestBody = {
    reason: "Devolución parcial concurrente",
    lines: [{ purchaseReceiptLineId: receipt.body.lines[0].id, quantity: 2 }],
  };
  const outcomes = await Promise.all([
    returnRequest(
      created.body.id,
      receipt.body.id,
      { ...requestBody, reference: `DEV-RACE-A-${suffix}` },
      sessions.administrator,
      `return-race-a-${suffix}`,
    ),
    returnRequest(
      created.body.id,
      receipt.body.id,
      { ...requestBody, reference: `DEV-RACE-B-${suffix}` },
      sessions.secondAdministrator,
      `return-race-b-${suffix}`,
    ),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), [201, 409]);
  const [[balance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [concurrentProductId, warehouseId],
  );
  assert.equal(balance.quantity, 1);

  const {
    created: stockOrder,
    receipt: stockReceipt,
    productId: stockProductId,
  } = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const engine = createInventoryEngine({ dbPool: pool });
  await engine.createOperation({
    userId: users.administrator,
    idempotencyKey: `return-stock-drain-${suffix}`,
    payload: {
      type: "adjustment_out",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Drenaje de stock para prueba de devolución",
      reference: null,
      lines: [{ productId: stockProductId, quantity: 3, expectedVersion: "1" }],
    },
  });
  const noStock = await returnRequest(
    stockOrder.body.id,
    stockReceipt.body.id,
    {
      reference: `DEV-SIN-STOCK-${suffix}`,
      reason: "Producto recibido defectuoso",
      lines: [
        { purchaseReceiptLineId: stockReceipt.body.lines[0].id, quantity: 1 },
      ],
    },
    sessions.administrator,
    `return-no-stock-${suffix}`,
  ).expect(409);
  assert.equal(noStock.body.error.code, "INSUFFICIENT_STOCK");

  const [[beforeInactive]] = await pool.execute(
    "SELECT is_active FROM products WHERE id = ?",
    [stockProductId],
  );
  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    stockProductId,
  ]);
  const inactive = await returnRequest(
    stockOrder.body.id,
    stockReceipt.body.id,
    {
      reference: `DEV-PRODUCT-INACTIVE-${suffix}`,
      reason: "Producto desactivado para prueba",
      lines: [
        { purchaseReceiptLineId: stockReceipt.body.lines[0].id, quantity: 1 },
      ],
    },
    sessions.administrator,
    `return-inactive-product-${suffix}`,
  ).expect(409);
  assert.equal(inactive.body.error.code, "INACTIVE_PRODUCT");
  await pool.execute("UPDATE products SET is_active = ? WHERE id = ?", [
    beforeInactive.is_active,
    stockProductId,
  ]);
  await pool.execute("UPDATE warehouses SET is_active = 0 WHERE id = ?", [
    warehouseId,
  ]);
  const inactiveWarehouse = await returnRequest(
    stockOrder.body.id,
    stockReceipt.body.id,
    {
      reference: `DEV-BODEGA-INACTIVA-${suffix}`,
      reason: "Validación de bodega inactiva",
      lines: [
        { purchaseReceiptLineId: stockReceipt.body.lines[0].id, quantity: 1 },
      ],
    },
    sessions.administrator,
    `return-inactive-warehouse-${suffix}`,
  ).expect(409);
  assert.equal(inactiveWarehouse.body.error.code, "INACTIVE_WAREHOUSE");
  await pool.execute("UPDATE warehouses SET is_active = 1 WHERE id = ?", [
    warehouseId,
  ]);
});

test("a supplier return audit failure rolls back its document, inventory and order version", async () => {
  const {
    created,
    receipt,
    productId: returnedProductId,
  } = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const before = await get(`/api/v1/purchase-orders/${created.body.id}`).expect(
    200,
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
          String(sql).includes("purchases.return_confirmed")
        )
          throw new Error("Injected supplier-return audit failure.");
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
    .post(
      `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}/returns`,
    )
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `return-audit-rollback-${suffix}`)
    .send({
      reference: `DEV-ROLLBACK-${suffix}`,
      reason: "La auditoría debe revertir todo",
      lines: [{ purchaseReceiptLineId: receipt.body.lines[0].id, quantity: 1 }],
    });
  assert.equal(response.status, 500);
  const after = await get(`/api/v1/purchase-orders/${created.body.id}`).expect(
    200,
  );
  assert.equal(after.body.version, before.body.version);
  const [[counts]] = await pool.execute(
    `SELECT
      (SELECT COUNT(*) FROM supplier_returns WHERE purchase_order_id = ?) AS returns,
      (SELECT COUNT(*) FROM inventory_operations WHERE source_type = 'supplier_return' AND idempotency_key = ?) AS operations,
      (SELECT COUNT(*) FROM audit_events WHERE action = 'purchases.return_confirmed' AND entity_id = ?) AS audits,
      (SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balance`,
    [
      created.body.id,
      `return-audit-rollback-${suffix}`,
      created.body.id,
      returnedProductId,
      warehouseId,
    ],
  );
  assert.deepEqual(
    [
      Number(counts.returns),
      Number(counts.operations),
      Number(counts.audits),
      Number(counts.balance),
    ],
    [0, 0, 0, 3],
  );
});

test("an inventory-engine failure rolls back a supplier-return document and stock", async () => {
  const {
    created,
    receipt,
    productId: returnedProductId,
  } = await createReceivedOrder({
    orderQuantity: 3,
    receiptQuantity: 3,
  });
  const failingPool = {
    execute: pool.execute.bind(pool),
    query: pool.query.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = (sql, values) => {
        if (String(sql).includes("INSERT INTO inventory_operations")) {
          const error = new Error("Injected supplier-return engine failure.");
          error.code = "INJECTED_ENGINE_FAILURE";
          throw error;
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
    .post(
      `/api/v1/purchase-orders/${created.body.id}/receipts/${receipt.body.id}/returns`,
    )
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `return-engine-rollback-${suffix}`)
    .send({
      reference: `DEV-ENGINE-ROLLBACK-${suffix}`,
      reason: "La operación de inventario falló",
      lines: [{ purchaseReceiptLineId: receipt.body.lines[0].id, quantity: 1 }],
    });
  assert.equal(response.status, 500);
  const [[state]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM supplier_returns WHERE purchase_order_id = ?) AS returns,
       (SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?) AS balance,
       (SELECT version FROM purchase_orders WHERE id = ?) AS version`,
    [created.body.id, returnedProductId, warehouseId, created.body.id],
  );
  assert.deepEqual(
    [Number(state.returns), Number(state.balance), Number(state.version)],
    [0, 3, created.body.version + 2],
  );
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

test("purchase orders report returns a scoped, SQL-paginated pending order over HTTP", async () => {
  async function timedGet(path, session = sessions.administrator) {
    const started = performance.now();
    const response = await get(path, session).expect(200);
    return {
      response,
      latencyMs: Number((performance.now() - started).toFixed(2)),
    };
  }
  const created = await mutate(
    "post",
    "/api/v1/purchase-orders",
    orderInput({
      orderDate: "2025-01-02",
      lines: [{ productId, quantity: 4, unitCost: "100.25" }],
    }),
  ).expect(201);
  const confirmed = await mutate(
    "post",
    `/api/v1/purchase-orders/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version, confirmZeroCost: false },
  ).expect(200);
  const path =
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}` +
    `&q=${encodeURIComponent(created.body.number)}&page=1&pageSize=1`;
  const measuredSearch = await timedGet(path);
  const response = measuredSearch.response;
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.body.criteria, {
    mode: "pending",
    period: null,
    warehouseId,
    warehouseScope: "selected",
    filters: { situation: null, q: created.body.number },
    currency: "COP",
    timeZone: "America/Bogota",
    periodSemantics: null,
    pendingSemantics:
      "Pendientes operativos actuales, sin límite de antigüedad, dentro del alcance de bodegas autorizadas.",
    situationSemantics:
      "Situación actual del documento al momento de la consulta.",
    documentCoverage:
      "Solo incluye órdenes cuya integridad documental puede verificarse completamente.",
  });
  assert.equal(response.body.summary.verifiedOrders, "1");
  assert.equal(response.body.summary.ordersWithPending, "1");
  assert.equal(response.body.summary.originalConfirmedOrderValue, "401.00");
  assert.deepEqual(response.body.summary.pendingByUnit, [
    { unit: "caja", quantity: "4" },
  ]);
  assert.equal(response.body.orders.length, 1);
  assert.deepEqual(response.body.orders[0], {
    id: created.body.id,
    commercialCode: created.body.number,
    orderDate: "2025-01-02",
    warehouse: {
      id: warehouseId,
      code: `P-${suffix}`,
      name: `Bodega compras ${suffix}`,
      isActive: true,
    },
    status: "confirmed",
    situation: "confirmed_without_receipts",
    confirmedAt: confirmed.body.confirmedAt,
    cancelledAt: null,
    closedAt: null,
    orderedValue: "401.00",
    receiptProgress: "none",
    hasClosure: false,
    lines: [
      {
        id: created.body.lines[0].id,
        productId,
        sku: `PUR-${suffix}`,
        name: `Producto compras ${suffix}`,
        unit: "caja",
        quantity: "4",
        receivedQuantity: "0",
        pendingQuantity: "4",
        closedQuantity: "0",
        unitCost: "100.25",
        lineTotal: "401.00",
      },
    ],
  });
  assert.deepEqual(response.body.pagination, {
    page: 1,
    pageSize: 1,
    total: "1",
    totalPages: "1",
  });
  assert.equal(typeof response.body.generatedAt, "string");
  await get(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2025-01-02&dateTo=2025-01-02&warehouseId=${warehouseId}&q=${encodeURIComponent(created.body.number)}`,
  )
    .expect(200)
    .then(({ body }) => {
      assert.deepEqual(body.criteria.period, {
        dateFrom: "2025-01-02",
        dateTo: "2025-01-02",
      });
      assert.equal(body.orders[0].situation, "confirmed_without_receipts");
      assert.equal(body.summary.verifiedOrders, "1");
    });
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&page=1&pageSize=1&pageSize=2`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&dateFrom=2025-01-02`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2025-01-01&dateTo=2025-04-04&warehouseId=${warehouseId}`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2025-02-30&dateTo=2025-03-01&warehouseId=${warehouseId}`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&situation=closed_with_remnant`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&unknown=x`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&page=501&pageSize=50`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&pageSize=51`,
  ).expect(400);
  const escapedSearch = await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&q=%25_%5C`,
  ).expect(200);
  assert.equal(escapedSearch.body.summary.verifiedOrders, "0");
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&q=${"x".repeat(101)}`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&q=`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&q=${encodeURIComponent("\u0001")}`,
  ).expect(400);
  await get(
    `/api/v1/reports/purchase-orders?mode=unknown&warehouseId=${warehouseId}`,
  ).expect(400);
  const period92 = await timedGet(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2025-01-01&dateTo=2025-04-02&warehouseId=${warehouseId}`,
  );
  assert.deepEqual(period92.response.body.criteria.period, {
    dateFrom: "2025-01-01",
    dateTo: "2025-04-02",
  });
  const situationFilter = await timedGet(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=2025-01-02&dateTo=2025-01-02&warehouseId=${warehouseId}&situation=confirmed_without_receipts`,
  );
  assert.equal(situationFilter.response.body.summary.verifiedOrders, "1");
  assert.equal(
    situationFilter.response.body.orders[0].situation,
    "confirmed_without_receipts",
  );
  await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    sessions.auditor,
  ).expect(200);
  const sellerDenied = await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    sessions.seller,
  ).expect(403);
  assert.equal(sellerDenied.body.error.code, "PERMISSION_DENIED");
  assert.equal(sellerDenied.headers["cache-control"], "private, no-store");
  assert.equal(Object.hasOwn(sellerDenied.body, "summary"), false);
  const warehouseDenied = await get(
    `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    sessions.warehouse,
  ).expect(403);
  assert.equal(warehouseDenied.body.error.code, "PERMISSION_DENIED");
  assert.equal(Object.hasOwn(warehouseDenied.body, "orders"), false);
  const anonymous = await request(app)
    .get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    )
    .expect(401);
  assert.equal(anonymous.headers["cache-control"], "private, no-store");

  const pendingBase = "/api/v1/reports/purchase-orders?mode=pending&pageSize=1";
  const [[otherWarehouse]] = await pool.execute(
    `SELECT DISTINCT po.warehouse_id AS id FROM purchase_orders po
      WHERE po.warehouse_id<>? AND po.status='confirmed' AND po.closed_at IS NULL
      ORDER BY po.warehouse_id LIMIT 1`,
    [warehouseId],
  );
  assert.ok(
    otherWarehouse,
    "La prueba requiere una segunda bodega con órdenes abiertas candidatas.",
  );
  let temporaryWarehouseAssignment;
  if (otherWarehouse) {
    temporaryWarehouseAssignment = String(otherWarehouse.id);
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id,assigned_by) VALUES (?,?,?)",
      [users.administrator, temporaryWarehouseAssignment, users.administrator],
    );
  }
  const sqlMetrics = {
    executions: 0,
    transferredRows: 0,
    pageRows: 0,
    lineRows: 0,
  };
  const originalGetConnection = pool.getConnection;
  pool.getConnection = async (...args) => {
    const connection = await originalGetConnection.apply(pool, args);
    return new Proxy(connection, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "execute") {
          return async (...executeArgs) => {
            sqlMetrics.executions += 1;
            const [rows, ...rest] = await value.apply(target, executeArgs);
            sqlMetrics.transferredRows += Array.isArray(rows) ? rows.length : 0;
            if (
              executeArgs[0].includes(
                "ORDER BY order_date ASC, id ASC LIMIT ? OFFSET ?",
              )
            ) {
              sqlMetrics.pageRows += rows.length;
            }
            if (executeArgs[0].startsWith("SELECT po.id, po.commercial_code")) {
              sqlMetrics.lineRows += rows.length;
            }
            return [rows, ...rest];
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const [[writesBefore]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM purchase_orders) purchase_orders,
            (SELECT COUNT(*) FROM purchase_receipts) purchase_receipts,
            (SELECT COUNT(*) FROM inventory_operations) inventory_operations,
            (SELECT COUNT(*) FROM inventory_movements) inventory_movements,
            (SELECT COUNT(*) FROM audit_events) audit_events`,
  );
  const memoryBefore = process.memoryUsage().heapUsed;
  const requestStarted = performance.now();
  let measuredPendingPage;
  let measuredMultiWarehouse;
  let multiWarehouseLatencyMs;
  let measuredSqlMetrics;
  try {
    measuredPendingPage = await get(
      "/api/v1/reports/purchase-orders?mode=pending&pageSize=2&page=1",
    ).expect(200);
    measuredSqlMetrics = { ...sqlMetrics };
    sqlMetrics.executions = 0;
    sqlMetrics.transferredRows = 0;
    sqlMetrics.pageRows = 0;
    sqlMetrics.lineRows = 0;
    const multiWarehouseStarted = performance.now();
    measuredMultiWarehouse = await get(
      "/api/v1/reports/purchase-orders?mode=pending&pageSize=50&page=1",
    ).expect(200);
    multiWarehouseLatencyMs = Number(
      (performance.now() - multiWarehouseStarted).toFixed(2),
    );
  } finally {
    pool.getConnection = originalGetConnection;
    if (temporaryWarehouseAssignment) {
      await pool.execute(
        "DELETE FROM user_warehouses WHERE user_id=? AND warehouse_id=?",
        [users.administrator, temporaryWarehouseAssignment],
      );
    }
  }
  const httpLatencyMs = Number((performance.now() - requestStarted).toFixed(2));
  const memoryDeltaBytes = process.memoryUsage().heapUsed - memoryBefore;
  const [[writesAfter]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM purchase_orders) purchase_orders,
            (SELECT COUNT(*) FROM purchase_receipts) purchase_receipts,
            (SELECT COUNT(*) FROM inventory_operations) inventory_operations,
            (SELECT COUNT(*) FROM inventory_movements) inventory_movements,
            (SELECT COUNT(*) FROM audit_events) audit_events`,
  );
  assert.deepEqual(writesAfter, writesBefore);
  const pendingPageOne = await get(`${pendingBase}&page=1`).expect(200);
  const pendingPageTwoTimed = await timedGet(`${pendingBase}&page=2`);
  const pendingPageTwo = pendingPageTwoTimed.response;
  const pendingLast = await get(
    `${pendingBase}&page=${pendingPageOne.body.pagination.total}`,
  ).expect(200);
  const pendingBeyond = await get(`${pendingBase}&page=501`).expect(200);
  assert.deepEqual(pendingPageOne.body.summary, pendingPageTwo.body.summary);
  assert.equal(pendingPageOne.body.orders.length, 1);
  assert.equal(pendingPageTwo.body.orders.length, 1);
  assert.ok(pendingPageOne.body.orders[0].lines.length > 0);
  assert.ok(pendingPageTwo.body.orders[0].lines.length > 0);
  assert.notEqual(
    pendingPageOne.body.orders[0].id,
    pendingPageTwo.body.orders[0].id,
  );
  assert.equal(pendingLast.body.orders.length, 1);
  assert.deepEqual(pendingBeyond.body.orders, []);
  assert.equal(measuredPendingPage.body.orders.length, 2);
  assert.ok(
    new Set(
      measuredMultiWarehouse.body.orders.map(({ warehouse }) => warehouse.id),
    ).size >= 2,
    "El endpoint debe devolver órdenes pendientes de más de una bodega autorizada.",
  );
  assert.equal(measuredSqlMetrics.executions, 9);
  assert.equal(measuredSqlMetrics.pageRows, 2);
  assert.ok(measuredSqlMetrics.lineRows > 0);
  assert.ok(
    BigInt(measuredSqlMetrics.transferredRows) <
      BigInt(measuredPendingPage.body.summary.verifiedOrders) + 20n,
  );
  console.info(
    `ℹ purchase orders HTTP: pending page-1=${httpLatencyMs}ms, pending multi-warehouse=${multiWarehouseLatencyMs}ms, page-2=${pendingPageTwoTimed.latencyMs}ms, period-92-days=${period92.latencyMs}ms, situation=${situationFilter.latencyMs}ms, q=${measuredSearch.latencyMs}ms, SQL(page-1)=${measuredSqlMetrics.executions}, pageRows=${measuredSqlMetrics.pageRows}, lineRows=${measuredSqlMetrics.lineRows}, transferredRows=${measuredSqlMetrics.transferredRows}, heapDelta=${memoryDeltaBytes}B`,
  );

  const tiedPeriod =
    "/api/v1/reports/purchase-orders?mode=period&dateFrom=2026-10-29" +
    "&dateTo=2026-10-29&pageSize=1";
  const tiedPageOne = await get(`${tiedPeriod}&page=1`).expect(200);
  const tiedPageTwo = await get(`${tiedPeriod}&page=2`).expect(200);
  assert.ok(
    BigInt(tiedPageOne.body.orders[0].id) >
      BigInt(tiedPageTwo.body.orders[0].id),
  );
  assert.deepEqual(tiedPageOne.body.summary, tiedPageTwo.body.summary);

  const unassigned = await get(
    "/api/v1/reports/purchase-orders?mode=pending",
    sessions.unassignedAdministrator,
  ).expect(200);
  assert.deepEqual(unassigned.body.orders, []);
  assert.equal(unassigned.body.summary.verifiedOrders, "0");
  const foreignWarehouse = await get(
    "/api/v1/reports/purchase-orders?mode=pending&warehouseId=999999999999999999",
  ).expect(404);
  const missingWarehouse = await get(
    "/api/v1/reports/purchase-orders?mode=pending&warehouseId=999999999999999998",
  ).expect(404);
  assert.equal(
    foreignWarehouse.body.error.code,
    missingWarehouse.body.error.code,
  );
  assert.equal(Object.hasOwn(foreignWarehouse.body, "summary"), false);

  const [[auditorRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='auditor'",
  );
  const [[salesGrant]] = await pool.execute(
    `SELECT rp.permission_id,rp.created_at FROM role_permissions rp
       JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=? AND p.code='sales.read'`,
    [auditorRole.id],
  );
  if (salesGrant) {
    try {
      await pool.execute(
        "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
        [auditorRole.id, salesGrant.permission_id],
      );
      await get(
        `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
        sessions.auditor,
      ).expect(200);
    } finally {
      await pool.execute(
        "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
        [auditorRole.id, salesGrant.permission_id, salesGrant.created_at],
      );
    }
  }

  for (const permission of [
    "reports.read",
    "warehouses.read",
    "purchases.read",
  ]) {
    const [[role]] = await pool.execute(
      "SELECT id FROM roles WHERE code='auditor'",
    );
    const [[grant]] = await pool.execute(
      `SELECT rp.permission_id,rp.created_at FROM role_permissions rp
         JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=? AND p.code=?`,
      [role.id, permission],
    );
    assert.ok(grant, `El auditor debe tener inicialmente ${permission}`);
    try {
      await pool.execute(
        "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
        [role.id, grant.permission_id],
      );
      const denied = await get(
        `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
        sessions.auditor,
      ).expect(403);
      assert.equal(denied.body.error.code, "PERMISSION_DENIED");
      assert.equal(Object.hasOwn(denied.body, "summary"), false);
    } finally {
      await pool.execute(
        "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
        [role.id, grant.permission_id, grant.created_at],
      );
    }
  }

  const [[adminSession]] = await pool.execute(
    `SELECT id,expires_at,revoked_at FROM user_sessions
      WHERE user_id=? ORDER BY id DESC LIMIT 1`,
    [users.administrator],
  );
  try {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?",
      [adminSession.id],
    );
    await get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    ).expect(401);
  } finally {
    await pool.execute("UPDATE user_sessions SET revoked_at=? WHERE id=?", [
      adminSession.revoked_at,
      adminSession.id,
    ]);
  }
  try {
    await pool.execute(
      "UPDATE user_sessions SET expires_at='2000-01-01 00:00:00' WHERE id=?",
      [adminSession.id],
    );
    await get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    ).expect(401);
  } finally {
    await pool.execute("UPDATE user_sessions SET expires_at=? WHERE id=?", [
      adminSession.expires_at,
      adminSession.id,
    ]);
  }

  try {
    await pool.execute(
      "UPDATE users SET password_change_required=1 WHERE id=?",
      [users.administrator],
    );
    await get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    ).expect(403);
  } finally {
    await pool.execute(
      "UPDATE users SET password_change_required=0 WHERE id=?",
      [users.administrator],
    );
  }
  try {
    await pool.execute("UPDATE users SET is_active=0 WHERE id=?", [
      users.administrator,
    ]);
    await get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}`,
    ).expect(401);
  } finally {
    await pool.execute("UPDATE users SET is_active=1 WHERE id=?", [
      users.administrator,
    ]);
  }

  try {
    await pool.execute("UPDATE warehouses SET is_active=0 WHERE id=?", [
      warehouseId,
    ]);
    const inactiveAssigned = await get(
      `/api/v1/reports/purchase-orders?mode=pending&warehouseId=${warehouseId}&q=${created.body.number}`,
    ).expect(200);
    assert.equal(inactiveAssigned.body.orders[0].warehouse.isActive, false);
  } finally {
    await pool.execute("UPDATE warehouses SET is_active=1 WHERE id=?", [
      warehouseId,
    ]);
  }
});
