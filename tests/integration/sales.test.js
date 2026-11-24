import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { createInventoryEngine } from "../../src/modules/inventory/inventory-engine.js";
import { createSaleService } from "../../src/modules/sales/sale-service.js";
import { connectAdminTestDatabase } from "../support/test-database.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";

const origin = "http://127.0.0.1:5173";
const suffix = randomBytes(6).toString("hex").toUpperCase();
const password = "Clave-segura-ventas-2026!";
const roles = {
  administrator: "administrator",
  unassignedAdmin: "administrator",
  seller: "seller",
  secondSeller: "seller",
  auditor: "auditor",
  warehouse: "warehouse",
};
const emails = Object.fromEntries(
  Object.keys(roles).map((role) => [
    role,
    `sales-${role}-${suffix}@sigecom.invalid`,
  ]),
);
let pool;
let app;
let inventoryEngine;
let users = {};
let sessions = {};
let warehouseId;
let unassignedWarehouseId;
let customerId;
let inactiveCustomerId;
let productId;
let minimumProductId;
let inactiveProductId;
const fixtures = new IntegrationFixtures({ suite: "sales" });
let categoryId;
let reversalFixtureNumber = 0;

async function signIn(email) {
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const csrfCookie = csrf.headers["set-cookie"].find((value) =>
    value.startsWith("sigecom_csrf="),
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrfCookie.split(";", 1)[0])
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({ email, password })
    .expect(200);
  return {
    cookie: login.headers["set-cookie"]
      .map((value) => value.split(";", 1)[0])
      .join("; "),
    csrfToken: login.body.csrfToken,
  };
}

function get(path, session = sessions.administrator) {
  return request(app).get(path).set("Cookie", session.cookie);
}

function mutate(method, path, body, session = sessions.administrator, key) {
  const apiClient = request(app);
  const apiRequest = apiClient[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken);
  if (key) apiRequest.set("Idempotency-Key", key);
  return apiRequest.send(body);
}

function saleInput(overrides = {}) {
  return {
    customerId,
    warehouseId,
    saleDate: "2026-10-30",
    notes: null,
    lines: [
      { productId, quantity: 3, unitPrice: "1234.50" },
      { productId: minimumProductId, quantity: 5, unitPrice: "0.10" },
    ],
    ...overrides,
  };
}

async function createConfirmedReversalFixture(quantity = 2) {
  reversalFixtureNumber += 1;
  const fixture = `${suffix}-${reversalFixtureNumber}`;
  const [createdProduct] = await pool.execute(
    `INSERT INTO products
       (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 1.00, 10.00)`,
    [`RV-${fixture}`, `Producto anulación ${fixture}`, categoryId],
  );
  const fixtureProductId = String(createdProduct.insertId);
  await inventoryEngine.createOperation({
    userId: users.administrator,
    idempotencyKey: `reversal-stock-${fixture}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Existencia para prueba de anulación",
      reference: `RV-OPEN-${fixture}`,
      lines: [{ productId: fixtureProductId, quantity: quantity + 4 }],
    },
  });
  const createdSale = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [{ productId: fixtureProductId, quantity, unitPrice: "10.00" }],
    }),
    sessions.administrator,
    `reversal-create-${fixture}`,
  ).expect(201);
  const confirmationKey = `reversal-confirm-${fixture}`;
  const confirmedSale = await mutate(
    "post",
    `/api/v1/sales/${createdSale.body.id}/confirmation`,
    { expectedVersion: createdSale.body.version },
    sessions.administrator,
    confirmationKey,
  ).expect(200);
  return {
    fixture,
    productId: fixtureProductId,
    created: createdSale.body,
    confirmed: confirmedSale.body,
    confirmationKey,
  };
}

function reversalInput(sale, overrides = {}) {
  return {
    expectedVersion: sale.version,
    reason: "La mercancía permanece completa en la bodega",
    reference: `VERIFICACION-${sale.id}`,
    physicalObservation:
      "Conteo físico cotejado contra las unidades originales.",
    neverDispatched: true,
    allQuantitiesPresent: true,
    allProductsSaleable: true,
    ...overrides,
  };
}

function customerReturnInput(sale, lines, overrides = {}) {
  return {
    expectedVersion: sale.version,
    reference: `DEV-${sale.id}`,
    reason: "Mercancía recibida y revisada por el cliente",
    physicalObservation: "Conteo físico documentado en la recepción.",
    receivedPhysical: true,
    inspected: true,
    lines,
    ...overrides,
  };
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  app = createApp({
    dbPool: pool,
    authConfig: getAuthConfig({
      JWT_SECRET: randomBytes(48).toString("base64url"),
      FRONTEND_ORIGIN: origin,
      AUTH_RATE_LIMIT_MAX: "20",
    }),
    logger: createLogger({ level: "silent" }),
  });
  inventoryEngine = createInventoryEngine({ dbPool: pool });

  const passwordHash = await bcrypt.hash(password, 12);
  for (const [account, email] of Object.entries(emails)) {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      roles[account],
    ]);
    const [created] = await pool.execute(
      "INSERT INTO users (role_id, email, display_name, password_hash) VALUES (?, ?, ?, ?)",
      [role.id, email, `Ventas ${account} ${suffix}`, passwordHash],
    );
    users[account] = String(created.insertId);
    fixtures.user(users[account]);
  }
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`S-${suffix}`, `Bodega ventas ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  fixtures.warehouse(warehouseId);
  const [unassignedWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`SU-${suffix}`, `Bodega no asignada ${suffix}`],
  );
  unassignedWarehouseId = String(unassignedWarehouse.insertId);
  fixtures.warehouse(unassignedWarehouseId);
  for (const account of [
    "administrator",
    "seller",
    "secondSeller",
    "auditor",
    "warehouse",
  ]) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
      [users[account], warehouseId, users.administrator],
    );
    fixtures.assignment(users[account], warehouseId);
  }
  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Ventas ${suffix}`],
  );
  categoryId = String(category.insertId);
  const [customer] = await pool.execute(
    "INSERT INTO customers (identification_number, name) VALUES (?, ?)",
    [`CC-${suffix}`, `Cliente ventas ${suffix}`],
  );
  customerId = String(customer.insertId);
  const [inactiveCustomer] = await pool.execute(
    "INSERT INTO customers (identification_number, name, is_active) VALUES (?, ?, 0)",
    [`CI-${suffix}`, `Cliente inactivo ${suffix}`],
  );
  inactiveCustomerId = String(inactiveCustomer.insertId);
  const [product] = await pool.execute(
    "INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price) VALUES (?, ?, ?, 'unidad', 1.00, 2500.00)",
    [`SV-${suffix}`, `Producto ventas ${suffix}`, categoryId],
  );
  productId = String(product.insertId);
  const [minimumProduct] = await pool.execute(
    "INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price, minimum_sale_quantity, minimum_sale_enabled) VALUES (?, ?, ?, 'caja', 1.00, 0.10, 5, 1)",
    [`SM-${suffix}`, `Producto mínimo ${suffix}`, categoryId],
  );
  minimumProductId = String(minimumProduct.insertId);
  const [inactiveProduct] = await pool.execute(
    "INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price, is_active) VALUES (?, ?, ?, 'unidad', 1.00, 10.00, 0)",
    [`SI-${suffix}`, `Producto inactivo ${suffix}`, categoryId],
  );
  inactiveProductId = String(inactiveProduct.insertId);
  for (const [account, email] of Object.entries(emails))
    sessions[account] = await signIn(email);
});

after(async () => {
  if (!pool) return;
  try {
    await fixtures.cleanupUserAssignments(pool);
  } finally {
    await pool.end();
  }
});

test("creates an inventory-neutral draft with exact COP totals and idempotency", async () => {
  const [[before]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementBefore]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const key = `sales-create-${suffix}`;
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput(),
    sessions.administrator,
    key,
  ).expect(201);
  assert.equal(created.body.number, `VE-${created.body.id.padStart(6, "0")}`);
  assert.equal(created.body.total, "3704.00");
  assert.equal(created.body.status, "draft");
  assert.deepEqual(
    created.body.lines.map(({ lineTotal }) => lineTotal),
    ["3703.50", "0.50"],
  );
  const replay = await mutate(
    "post",
    "/api/v1/sales",
    saleInput(),
    sessions.administrator,
    key,
  ).expect(201);
  assert.equal(replay.body.id, created.body.id);
  await pool.execute("UPDATE customers SET name = ? WHERE id = ?", [
    "Nombre actualizado después",
    customerId,
  ]);
  await pool.execute("UPDATE warehouses SET name = ? WHERE id = ?", [
    "Bodega renombrada después",
    warehouseId,
  ]);
  await pool.execute(
    "UPDATE products SET name = ?, sale_price = 99999.99 WHERE id = ?",
    ["Producto renombrado después", productId],
  );
  const historical = await get(`/api/v1/sales/${created.body.id}`).expect(200);
  assert.equal(historical.body.customerName, `Cliente ventas ${suffix}`);
  assert.equal(historical.body.warehouseName, `Bodega ventas ${suffix}`);
  assert.equal(historical.body.lines[0].name, `Producto ventas ${suffix}`);
  assert.equal(historical.body.lines[0].unitPrice, "1234.50");
  const [[afterWrite]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementAfter]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(afterWrite, before);
  assert.equal(movementAfter.count, movementBefore.count);
  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM audit_events WHERE module = 'sales' AND entity_id = ?",
    [created.body.id],
  );
  assert.equal(Number(audit.count), 1);
});

test("confirms a persisted draft atomically, discounts exact stock, and replays idempotently", async () => {
  await inventoryEngine.createOperation({
    userId: users.administrator,
    idempotencyKey: `sales-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Existencia de prueba para confirmar venta",
      reference: `OPEN-${suffix}`,
      lines: [{ productId, quantity: 5 }],
    },
  });
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 3, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `confirm-create-${suffix}`,
  ).expect(201);
  const key = `confirm-once-${suffix}`;
  const confirmed = await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version },
    sessions.administrator,
    key,
  ).expect(200);

  assert.equal(confirmed.body.status, "confirmed");
  assert.equal(confirmed.body.version, created.body.version + 1);
  assert.equal(confirmed.body.confirmedBy, users.administrator);
  assert.ok(confirmed.body.confirmedAt);
  assert.equal(confirmed.body.total, created.body.total);
  assert.deepEqual(confirmed.body.lines, created.body.lines);
  const [[beforePdfReads]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_operations
         WHERE source_type = 'sale' AND source_id = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements movement
         JOIN inventory_operations operation ON operation.id = movement.operation_id
         WHERE operation.source_type = 'sale' AND operation.source_id = ?) AS movements,
       (SELECT COUNT(*) FROM audit_events
         WHERE module = 'sales' AND entity_id = ?) AS audit_events`,
    [created.body.id, created.body.id, created.body.id],
  );
  const salePdf = await get(`/api/v1/sales/${created.body.id}/pdf`).expect(200);
  assert.match(salePdf.headers["content-type"], /application\/pdf/);
  assert.match(salePdf.headers["content-disposition"], /attachment/);
  assert.match(
    salePdf.body.toString("latin1"),
    /Comprobante de venta confirmada/,
  );
  assert.match(salePdf.body.toString("latin1"), /1234\.50 COP/);
  await get(`/api/v1/sales/${created.body.id}/pdf`).expect(200);
  await get(
    `/api/v1/sales/${created.body.id}/pdf`,
    sessions.unassignedAdmin,
  ).expect(404);
  const [[afterPdfReads]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM inventory_operations
         WHERE source_type = 'sale' AND source_id = ?) AS operations,
       (SELECT COUNT(*) FROM inventory_movements movement
         JOIN inventory_operations operation ON operation.id = movement.operation_id
         WHERE operation.source_type = 'sale' AND operation.source_id = ?) AS movements,
       (SELECT COUNT(*) FROM audit_events
         WHERE module = 'sales' AND entity_id = ?) AS audit_events`,
    [created.body.id, created.body.id, created.body.id],
  );
  assert.deepEqual(afterPdfReads, beforePdfReads);
  await mutate(
    "patch",
    `/api/v1/sales/${created.body.id}`,
    {
      ...saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1.00" }] }),
      expectedVersion: confirmed.body.version,
    },
    sessions.administrator,
    `confirmed-edit-${suffix}`,
  ).expect(409);
  await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/cancellation`,
    { expectedVersion: confirmed.body.version, reason: "No debe cancelar" },
    sessions.administrator,
    `confirmed-cancel-${suffix}`,
  ).expect(409);

  const [[balance]] = await pool.execute(
    "SELECT quantity, CAST(version AS CHAR) AS version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.equal(Number(balance.quantity), 2);
  assert.equal(balance.version, "2");
  const [[operation]] = await pool.execute(
    "SELECT id, operation_type, source_type, source_id FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [created.body.id],
  );
  assert.equal(operation.operation_type, "sale_issue");
  const [movements] = await pool.execute(
    "SELECT direction, quantity, balance_before, balance_after, unit_snapshot FROM inventory_movements WHERE operation_id = ?",
    [operation.id],
  );
  assert.deepEqual(movements[0], {
    direction: "OUT",
    quantity: 3,
    balance_before: 5,
    balance_after: 2,
    unit_snapshot: "unidad",
  });

  const replayed = await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/confirmation`,
    { expectedVersion: created.body.version },
    sessions.administrator,
    key,
  ).expect(200);
  assert.equal(replayed.body.status, "confirmed");
  assert.equal(replayed.body.id, confirmed.body.id);
  await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/confirmation`,
    { expectedVersion: confirmed.body.version },
    sessions.administrator,
    key,
  ).expect(409);
  const [[operationCount]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [created.body.id],
  );
  assert.equal(Number(operationCount.count), 1);
  await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/confirmation`,
    { expectedVersion: confirmed.body.version },
    sessions.administrator,
    `confirm-second-key-${suffix}`,
  ).expect(409);
});

test("insufficient stock and catalog changes reject confirmation without partial effects", async () => {
  const shortage = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 3, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `shortage-create-${suffix}`,
  ).expect(201);
  await get(`/api/v1/sales/${shortage.body.id}/pdf`).expect(409);
  const [[before]] = await pool.execute(
    `SELECT quantity, CAST(version AS CHAR) AS version FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  await mutate(
    "post",
    `/api/v1/sales/${shortage.body.id}/confirmation`,
    { expectedVersion: shortage.body.version },
    sessions.administrator,
    `shortage-confirm-${suffix}`,
  ).expect(409);
  const [[unchanged]] = await pool.execute(
    `SELECT quantity, CAST(version AS CHAR) AS version FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  assert.deepEqual(unchanged, before);

  const changedRule = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `changed-rule-create-${suffix}`,
  ).expect(201);
  await pool.execute(
    "UPDATE products SET minimum_sale_quantity = 2, minimum_sale_enabled = 1 WHERE id = ?",
    [productId],
  );
  try {
    await mutate(
      "post",
      `/api/v1/sales/${changedRule.body.id}/confirmation`,
      { expectedVersion: changedRule.body.version },
      sessions.administrator,
      `changed-rule-confirm-${suffix}`,
    ).expect(409);
  } finally {
    await pool.execute(
      "UPDATE products SET minimum_sale_quantity = NULL, minimum_sale_enabled = 0 WHERE id = ?",
      [productId],
    );
  }
  const [[stillDraft]] = await pool.execute(
    "SELECT status, version FROM sales WHERE id = ?",
    [changedRule.body.id],
  );
  assert.equal(stillDraft.status, "draft");
  assert.equal(Number(stillDraft.version), changedRule.body.version);
});

test("inactive customers and products invalidate persisted confirmation candidates", async () => {
  const customerDraft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `inactive-customer-create-${suffix}`,
  ).expect(201);
  await pool.execute("UPDATE customers SET is_active = 0 WHERE id = ?", [
    customerId,
  ]);
  try {
    await mutate(
      "post",
      `/api/v1/sales/${customerDraft.body.id}/confirmation`,
      { expectedVersion: customerDraft.body.version },
      sessions.administrator,
      `inactive-customer-confirm-${suffix}`,
    ).expect(409);
  } finally {
    await pool.execute("UPDATE customers SET is_active = 1 WHERE id = ?", [
      customerId,
    ]);
  }

  const productDraft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `inactive-product-create-${suffix}`,
  ).expect(201);
  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    productId,
  ]);
  try {
    await mutate(
      "post",
      `/api/v1/sales/${productDraft.body.id}/confirmation`,
      { expectedVersion: productDraft.body.version },
      sessions.administrator,
      `inactive-product-confirm-${suffix}`,
    ).expect(409);
  } finally {
    await pool.execute("UPDATE products SET is_active = 1 WHERE id = ?", [
      productId,
    ]);
  }
});

test("reverses a confirmed sale with verified evidence exactly once and preserves its original issue", async () => {
  const fixture = await createConfirmedReversalFixture(3);
  const { created, confirmed } = fixture;
  const confirmationKey = fixture.confirmationKey;

  const input = {
    expectedVersion: confirmed.version,
    reason: "La mercancía permanece completa en la bodega",
    reference: `VERIFICACION-${fixture.fixture}`,
    physicalObservation: "Conteo físico cotejado contra las tres unidades.",
    neverDispatched: true,
    allQuantitiesPresent: true,
    allProductsSaleable: true,
  };
  const reversalKey = `reversal-once-${suffix}`;
  const reversed = await mutate(
    "post",
    `/api/v1/sales/${created.id}/reversal`,
    input,
    sessions.administrator,
    reversalKey,
  );
  assert.equal(reversed.status, 200, JSON.stringify(reversed.body));

  assert.equal(reversed.body.sale.status, "cancelled");
  assert.equal(reversed.body.sale.version, confirmed.version + 1);
  assert.equal(reversed.body.reversal.saleId, created.id);
  assert.equal(reversed.body.reversal.verificationReference, input.reference);
  assert.equal(
    reversed.body.reversal.physicalObservation,
    input.physicalObservation,
  );
  assert.equal(reversed.body.reversal.neverDispatched, true);
  assert.equal(reversed.body.reversal.allQuantitiesPresent, true);
  assert.equal(reversed.body.reversal.allProductsSaleable, true);

  const [[originalOperation]] = await pool.execute(
    "SELECT id, operation_type FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [created.id],
  );
  assert.equal(originalOperation.operation_type, "sale_issue");
  const [originalMovements] = await pool.execute(
    "SELECT direction, quantity FROM inventory_movements WHERE operation_id = ?",
    [originalOperation.id],
  );
  assert.deepEqual(originalMovements, [{ direction: "OUT", quantity: 3 }]);

  const [[reversalDocument]] = await pool.execute(
    "SELECT id, sale_id, source_operation_id, verification_reference, never_dispatched, all_quantities_present, all_products_saleable FROM sale_cancellations WHERE sale_id = ?",
    [created.id],
  );
  assert.equal(String(reversalDocument.sale_id), created.id);
  assert.equal(reversed.body.sale.cancelledBy, users.administrator);
  assert.equal(reversalDocument.verification_reference, input.reference);
  assert.equal(Number(reversalDocument.never_dispatched), 1);
  assert.equal(Number(reversalDocument.all_quantities_present), 1);
  assert.equal(Number(reversalDocument.all_products_saleable), 1);
  const [[auditEvent]] = await pool.execute(
    `SELECT action, entity_type, entity_id, user_id
     FROM audit_events
     WHERE action = 'sales.reversed' AND entity_id = ?
     ORDER BY id DESC LIMIT 1`,
    [created.id],
  );
  assert.equal(auditEvent.action, "sales.reversed");
  assert.equal(auditEvent.entity_type, "sale");
  assert.equal(String(auditEvent.user_id), users.administrator);

  const [[compensation]] = await pool.execute(
    "SELECT id, operation_type, source_type, source_id FROM inventory_operations WHERE id = ?",
    [reversalDocument.source_operation_id],
  );
  assert.equal(compensation.operation_type, "sale_reversal");
  assert.equal(compensation.source_type, "sale_cancellation");
  assert.equal(compensation.source_id, String(reversalDocument.id));
  const [compensatingMovements] = await pool.execute(
    "SELECT direction, quantity, balance_before, balance_after FROM inventory_movements WHERE operation_id = ?",
    [compensation.id],
  );
  assert.deepEqual(compensatingMovements, [
    { direction: "IN", quantity: 3, balance_before: 4, balance_after: 7 },
  ]);
  const [[balance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.equal(Number(balance.quantity), 7);

  const replay = await mutate(
    "post",
    `/api/v1/sales/${created.id}/reversal`,
    input,
    sessions.administrator,
    reversalKey,
  ).expect(200);
  assert.equal(replay.body.reversal.id, reversed.body.reversal.id);
  await mutate(
    "post",
    `/api/v1/sales/${created.id}/reversal`,
    { ...input, reference: `OTRA-${suffix}` },
    sessions.administrator,
    reversalKey,
  ).expect(409);
  await mutate(
    "post",
    `/api/v1/sales/${created.id}/reversal`,
    { ...input, expectedVersion: reversed.body.sale.version },
    sessions.administrator,
    `reversal-second-${suffix}`,
  ).expect(409);

  const read = await get(`/api/v1/sales/${created.id}/reversal`).expect(200);
  assert.equal(read.body.id, reversed.body.reversal.id);
  const pdf = await get(`/api/v1/sales/${created.id}/reversal/pdf`).expect(200);
  assert.match(pdf.headers["content-type"], /application\/pdf/);
  assert.equal(pdf.body.subarray(0, 8).toString("ascii"), "%PDF-1.4");

  const confirmationReplay = await mutate(
    "post",
    `/api/v1/sales/${created.id}/confirmation`,
    { expectedVersion: created.version },
    sessions.administrator,
    confirmationKey,
  ).expect(200);
  assert.equal(confirmationReplay.body.status, "cancelled");
  const [[finalBalance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.equal(Number(finalBalance.quantity), 7);
});

test("reversal requires every physical declaration and rejects stale versions", async () => {
  const fixture = await createConfirmedReversalFixture();
  const base = reversalInput(fixture.confirmed);
  for (const declaration of [
    "neverDispatched",
    "allQuantitiesPresent",
    "allProductsSaleable",
  ]) {
    await mutate(
      "post",
      `/api/v1/sales/${fixture.created.id}/reversal`,
      { ...base, [declaration]: false },
      sessions.administrator,
      `reversal-evidence-${declaration}-${fixture.fixture}`,
    ).expect(400);
  }
  const stale = await mutate(
    "post",
    `/api/v1/sales/${fixture.created.id}/reversal`,
    { ...base, expectedVersion: fixture.confirmed.version - 1 },
    sessions.administrator,
    `reversal-stale-${fixture.fixture}`,
  ).expect(409);
  assert.equal(stale.body.error.code, "SALE_VERSION_CONFLICT");
  const [[sale]] = await pool.execute(
    "SELECT status, version FROM sales WHERE id = ?",
    [fixture.created.id],
  );
  assert.equal(sale.status, "confirmed");
  assert.equal(Number(sale.version), fixture.confirmed.version);
  const [[documents]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [fixture.created.id],
  );
  assert.equal(Number(documents.count), 0);
});

test("reversal endpoint enforces trusted origin and CSRF", async () => {
  const fixture = await createConfirmedReversalFixture();
  const path = `/api/v1/sales/${fixture.created.id}/reversal`;
  const input = reversalInput(fixture.confirmed);
  await request(app)
    .post(path)
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .set("Idempotency-Key", `reversal-no-csrf-${fixture.fixture}`)
    .send(input)
    .expect(403);
  await request(app)
    .post(path)
    .set("Origin", "https://untrusted.example")
    .set("Cookie", sessions.administrator.cookie)
    .set("X-CSRF-Token", sessions.administrator.csrfToken)
    .set("Idempotency-Key", `reversal-bad-origin-${fixture.fixture}`)
    .send(input)
    .expect(403);
  const [[documentCount]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [fixture.created.id],
  );
  assert.equal(Number(documentCount.count), 0);
});

test("reversal refuses drafts, cancelled drafts, and users without its permission", async () => {
  const draft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput(),
    sessions.administrator,
    `reversal-draft-${suffix}`,
  ).expect(201);
  const draftBody = reversalInput(draft.body);
  await mutate(
    "post",
    `/api/v1/sales/${draft.body.id}/reversal`,
    draftBody,
    sessions.administrator,
    `reversal-not-confirmed-${suffix}`,
  ).expect(409);
  await mutate(
    "post",
    `/api/v1/sales/${draft.body.id}/cancellation`,
    { expectedVersion: draft.body.version, reason: "Borrador duplicado" },
    sessions.administrator,
    `reversal-cancel-draft-${suffix}`,
  ).expect(200);
  await mutate(
    "post",
    `/api/v1/sales/${draft.body.id}/reversal`,
    draftBody,
    sessions.administrator,
    `reversal-cancelled-draft-${suffix}`,
  ).expect(409);

  const fixture = await createConfirmedReversalFixture();
  const input = reversalInput(fixture.confirmed);
  for (const account of ["seller", "auditor", "warehouse"])
    await mutate(
      "post",
      `/api/v1/sales/${fixture.created.id}/reversal`,
      input,
      sessions[account],
      `reversal-permission-${account}-${fixture.fixture}`,
    ).expect(403);

  await mutate(
    "post",
    `/api/v1/sales/${fixture.created.id}/reversal`,
    input,
    sessions.unassignedAdmin,
    `reversal-unassigned-${fixture.fixture}`,
  ).expect(404);
});

test("reversal rejects inactive products and warehouses without changing the sale or stock", async () => {
  const inactiveProductFixture = await createConfirmedReversalFixture();
  const [[beforeInactiveProduct]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [inactiveProductFixture.productId, warehouseId],
  );
  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    inactiveProductFixture.productId,
  ]);
  try {
    const response = await mutate(
      "post",
      `/api/v1/sales/${inactiveProductFixture.created.id}/reversal`,
      reversalInput(inactiveProductFixture.confirmed),
      sessions.administrator,
      `reversal-inactive-product-${inactiveProductFixture.fixture}`,
    ).expect(409);
    assert.equal(response.body.error.code, "INACTIVE_PRODUCT");
  } finally {
    await pool.execute("UPDATE products SET is_active = 1 WHERE id = ?", [
      inactiveProductFixture.productId,
    ]);
  }
  const [[afterInactiveProduct]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [inactiveProductFixture.productId, warehouseId],
  );
  assert.deepEqual(afterInactiveProduct, beforeInactiveProduct);
  const [[noProductCancellation]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [inactiveProductFixture.created.id],
  );
  assert.equal(Number(noProductCancellation.count), 0);

  const inactiveWarehouseFixture = await createConfirmedReversalFixture();
  await pool.execute("UPDATE warehouses SET is_active = 0 WHERE id = ?", [
    warehouseId,
  ]);
  try {
    const response = await mutate(
      "post",
      `/api/v1/sales/${inactiveWarehouseFixture.created.id}/reversal`,
      reversalInput(inactiveWarehouseFixture.confirmed),
      sessions.administrator,
      `reversal-inactive-warehouse-${inactiveWarehouseFixture.fixture}`,
    ).expect(409);
    assert.equal(response.body.error.code, "INACTIVE_WAREHOUSE");
  } finally {
    await pool.execute("UPDATE warehouses SET is_active = 1 WHERE id = ?", [
      warehouseId,
    ]);
  }
});

test("concurrent reversals create one compensation and no duplicate reintegration", async () => {
  const fixture = await createConfirmedReversalFixture(3);
  const race = await Promise.all([
    mutate(
      "post",
      `/api/v1/sales/${fixture.created.id}/reversal`,
      reversalInput(fixture.confirmed, { reference: "RACE-A" }),
      sessions.administrator,
      `reversal-race-a-${fixture.fixture}`,
    ),
    mutate(
      "post",
      `/api/v1/sales/${fixture.created.id}/reversal`,
      reversalInput(fixture.confirmed, { reference: "RACE-B" }),
      sessions.administrator,
      `reversal-race-b-${fixture.fixture}`,
    ),
  ]);
  assert.deepEqual(race.map(({ status }) => status).sort(), [200, 409]);
  const [[cancellations]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [fixture.created.id],
  );
  assert.equal(Number(cancellations.count), 1);
  const [[balances]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.equal(Number(balances.quantity), 7);
  const [[cancellation]] = await pool.execute(
    "SELECT id FROM sale_cancellations WHERE sale_id = ?",
    [fixture.created.id],
  );
  const [[operations]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale_cancellation' AND source_id = ?",
    [String(cancellation.id)],
  );
  assert.equal(Number(operations.count), 1);
});

test("an inventory audit failure rolls back the reversal document, stock, and sale state", async () => {
  const fixture = await createConfirmedReversalFixture();
  const [[before]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  const failingPool = {
    async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          const value = target[property];
          if (property === "execute")
            return async (sql, values) => {
              if (String(sql).includes("INSERT INTO audit_events"))
                throw new Error("Injected test-only audit failure");
              return value.call(target, sql, values);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const service = createSaleService({ dbPool: failingPool });
  await assert.rejects(
    service.reverse({
      id: fixture.created.id,
      input: reversalInput(fixture.confirmed),
      actor: {
        user: { id: users.administrator },
        warehouseIds: new Set([warehouseId]),
      },
      request: { ip: "127.0.0.1", get: () => "integration-test" },
      key: `reversal-audit-failure-${fixture.fixture}`,
    }),
    /Injected test-only audit failure/,
  );
  const [[sale]] = await pool.execute(
    "SELECT status, version FROM sales WHERE id = ?",
    [fixture.created.id],
  );
  assert.equal(sale.status, "confirmed");
  assert.equal(Number(sale.version), fixture.confirmed.version);
  const [[after]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.deepEqual(after, before);
  const [[documents]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [fixture.created.id],
  );
  assert.equal(Number(documents.count), 0);
  const [[compensations]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE idempotency_key = ?",
    [`reversal-audit-failure-${fixture.fixture}`],
  );
  assert.equal(Number(compensations.count), 0);
});

test("confirmation enforces ownership, permissions, version, and strict request shape", async () => {
  const ownDraft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.seller,
    `seller-confirm-create-${suffix}`,
  ).expect(201);
  const path = `/api/v1/sales/${ownDraft.body.id}/confirmation`;
  await mutate(
    "post",
    path,
    { expectedVersion: ownDraft.body.version },
    sessions.secondSeller,
    `seller-other-confirm-${suffix}`,
  ).expect(403);
  await mutate(
    "post",
    path,
    { expectedVersion: ownDraft.body.version },
    sessions.auditor,
    `auditor-confirm-${suffix}`,
  ).expect(403);
  await mutate(
    "post",
    path,
    { expectedVersion: ownDraft.body.version, lines: [] },
    sessions.seller,
    `confirm-payload-lines-${suffix}`,
  ).expect(400);
  await request(app)
    .post(`/api/v1/sales/${ownDraft.body.id}/confirmation`)
    .set("Origin", origin)
    .set("Cookie", sessions.seller.cookie)
    .set("X-CSRF-Token", sessions.seller.csrfToken)
    .send({ expectedVersion: ownDraft.body.version })
    .expect(400);
  await mutate(
    "post",
    path,
    { expectedVersion: ownDraft.body.version + 1 },
    sessions.seller,
    `confirm-stale-${suffix}`,
  ).expect(409);
  await mutate(
    "post",
    path,
    { expectedVersion: ownDraft.body.version },
    sessions.seller,
    `confirm-owner-${suffix}`,
  ).expect(200);
  const [[inventoryOperation]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [ownDraft.body.id],
  );
  assert.equal(Number(inventoryOperation.count), 1);
});

test("audit failure rolls back sale confirmation and all inventory writes", async () => {
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `audit-rollback-create-${suffix}`,
  ).expect(201);
  const [[before]] = await pool.execute(
    `SELECT quantity, CAST(version AS CHAR) AS version FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  const [[movementBefore]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM inventory_movements
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  const privileged = await connectAdminTestDatabase();
  const triggerName = `trg_test_sale_audit_${suffix.toLowerCase()}`;
  try {
    await privileged.query(
      `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON audit_events
       FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sale audit failure probe'`,
    );
    await mutate(
      "post",
      `/api/v1/sales/${created.body.id}/confirmation`,
      { expectedVersion: created.body.version },
      sessions.administrator,
      `audit-rollback-confirm-${suffix}`,
    ).expect(500);
  } finally {
    await privileged.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
    await privileged.end();
  }
  const [[sale]] = await pool.execute(
    "SELECT status, version, confirmed_by FROM sales WHERE id = ?",
    [created.body.id],
  );
  assert.equal(sale.status, "draft");
  assert.equal(Number(sale.version), created.body.version);
  assert.equal(sale.confirmed_by, null);
  const [[after]] = await pool.execute(
    `SELECT quantity, CAST(version AS CHAR) AS version FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  assert.deepEqual(after, before);
  const [[movementAfter]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM inventory_movements
     WHERE product_id = ? AND warehouse_id = ?`,
    [productId, warehouseId],
  );
  assert.equal(Number(movementAfter.count), Number(movementBefore.count));
  const [[operations]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [created.body.id],
  );
  assert.equal(Number(operations.count), 0);
});

test("confirmation revalidates the warehouse assignment and persisted unit snapshot", async () => {
  const assignedDraft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.seller,
    `warehouse-revoke-create-${suffix}`,
  ).expect(201);
  const privileged = await connectAdminTestDatabase();
  const [[sellerAssignment]] = await privileged.execute(
    "SELECT assigned_by, created_at FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [users.seller, warehouseId],
  );
  assert.ok(
    sellerAssignment,
    "The fixture assignment must exist before mutation",
  );
  try {
    await privileged.execute(
      "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
      [users.seller, warehouseId],
    );
    await mutate(
      "post",
      `/api/v1/sales/${assignedDraft.body.id}/confirmation`,
      { expectedVersion: assignedDraft.body.version },
      sessions.seller,
      `warehouse-revoke-confirm-${suffix}`,
    ).expect(404);
  } finally {
    await privileged.execute(
      `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by, created_at)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       assigned_by = VALUES(assigned_by), created_at = VALUES(created_at)`,
      [
        users.seller,
        warehouseId,
        sellerAssignment.assigned_by,
        sellerAssignment.created_at,
      ],
    );
    await privileged.end();
  }

  const warehouseAdmin = await connectAdminTestDatabase();
  await warehouseAdmin.execute(
    "INSERT IGNORE INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
    [users.administrator, unassignedWarehouseId, users.administrator],
  );
  let inactiveWarehouseDraft;
  try {
    inactiveWarehouseDraft = await mutate(
      "post",
      "/api/v1/sales",
      saleInput({
        warehouseId: unassignedWarehouseId,
        lines: [{ productId, quantity: 1, unitPrice: "1234.50" }],
      }),
      sessions.administrator,
      `inactive-warehouse-create-${suffix}`,
    ).expect(201);
    await warehouseAdmin.execute(
      "UPDATE warehouses SET is_active = 0 WHERE id = ?",
      [unassignedWarehouseId],
    );
    await mutate(
      "post",
      `/api/v1/sales/${inactiveWarehouseDraft.body.id}/confirmation`,
      { expectedVersion: inactiveWarehouseDraft.body.version },
      sessions.administrator,
      `inactive-warehouse-confirm-${suffix}`,
    ).expect(404);
  } finally {
    await warehouseAdmin.execute(
      "UPDATE warehouses SET is_active = 1 WHERE id = ?",
      [unassignedWarehouseId],
    );
    await warehouseAdmin.execute(
      "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
      [users.administrator, unassignedWarehouseId],
    );
    await warehouseAdmin.end();
  }

  const unitDraft = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [{ productId: minimumProductId, quantity: 5, unitPrice: "0.10" }],
    }),
    sessions.administrator,
    `unit-change-create-${suffix}`,
  ).expect(201);
  await pool.execute("UPDATE products SET unit = 'unidad' WHERE id = ?", [
    minimumProductId,
  ]);
  try {
    await mutate(
      "post",
      `/api/v1/sales/${unitDraft.body.id}/confirmation`,
      { expectedVersion: unitDraft.body.version },
      sessions.administrator,
      `unit-change-confirm-${suffix}`,
    ).expect(409);
  } finally {
    await pool.execute("UPDATE products SET unit = 'caja' WHERE id = ?", [
      minimumProductId,
    ]);
  }
});

test("simultaneous retries of one confirmation with the same key replay one issue", async () => {
  const [createdProduct] = await pool.execute(
    `INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 1.00, 20.00)`,
    [`SC-${suffix}`, `Producto venta concurrente ${suffix}`, categoryId],
  );
  const concurrentProductId = String(createdProduct.insertId);
  await inventoryEngine.createOperation({
    userId: users.administrator,
    idempotencyKey: `same-sale-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Existencia para reintento concurrente de venta",
      reference: `SAME-SALE-${suffix}`,
      lines: [{ productId: concurrentProductId, quantity: 1 }],
    },
  });
  const createdSale = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [
        { productId: concurrentProductId, quantity: 1, unitPrice: "20.00" },
      ],
    }),
    sessions.administrator,
    `same-sale-create-${suffix}`,
  ).expect(201);
  const key = `same-sale-confirm-${suffix}`;
  const responses = await Promise.all(
    [1, 2].map(() =>
      mutate(
        "post",
        `/api/v1/sales/${createdSale.body.id}/confirmation`,
        { expectedVersion: createdSale.body.version },
        sessions.administrator,
        key,
      ),
    ),
  );
  assert.deepEqual(
    responses.map(({ status }) => status),
    [200, 200],
  );
  assert.equal(responses[0].body.id, responses[1].body.id);
  assert.equal(responses[0].body.status, "confirmed");
  const [[operation]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [createdSale.body.id],
  );
  assert.equal(Number(operation.count), 1);
  const [[balance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [concurrentProductId, warehouseId],
  );
  assert.equal(Number(balance.quantity), 0);
});

test("confirmation serializes against draft edits and cancellation", async () => {
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1234.50" }] }),
    sessions.administrator,
    `write-race-create-${suffix}`,
  ).expect(201);
  const [[before]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const outcomes = await Promise.all([
    mutate(
      "post",
      `/api/v1/sales/${created.body.id}/confirmation`,
      { expectedVersion: created.body.version },
      sessions.administrator,
      `write-race-confirm-${suffix}`,
    ),
    mutate(
      "patch",
      `/api/v1/sales/${created.body.id}`,
      {
        ...saleInput({
          lines: [{ productId, quantity: 1, unitPrice: "1200.00" }],
        }),
        expectedVersion: created.body.version,
      },
      sessions.administrator,
      `write-race-edit-${suffix}`,
    ),
    mutate(
      "post",
      `/api/v1/sales/${created.body.id}/cancellation`,
      {
        expectedVersion: created.body.version,
        reason: "Prueba de concurrencia",
      },
      sessions.administrator,
      `write-race-cancel-${suffix}`,
    ),
  ]);
  assert.deepEqual(
    outcomes.map(({ status }) => status).sort(),
    [200, 409, 409],
  );
  const [[sale]] = await pool.execute(
    "SELECT status, version FROM sales WHERE id = ?",
    [created.body.id],
  );
  assert.equal(Number(sale.version), created.body.version + 1);
  const [[operation]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ?",
    [created.body.id],
  );
  const [[after]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  if (sale.status === "confirmed") {
    assert.equal(Number(operation.count), 1);
    assert.equal(Number(after.quantity), Number(before.quantity) - 1);
  } else {
    assert.ok(["cancelled", "draft"].includes(sale.status));
    assert.equal(Number(operation.count), 0);
    assert.equal(Number(after.quantity), Number(before.quantity));
  }
});

test("sales confirmations serialize with purchase receipts and supplier returns", async () => {
  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (identification_number, business_name) VALUES (?, ?)",
    [`MIX-${suffix}`, `Proveedor ventas concurrentes ${suffix}`],
  );
  const supplierId = String(supplier.insertId);
  async function createOrder(productId, quantity, reference) {
    const order = await mutate("post", "/api/v1/purchase-orders", {
      supplierId,
      warehouseId,
      orderDate: "2026-10-30",
      reference: null,
      notes: null,
      lines: [{ productId, quantity, unitCost: "10.00" }],
    }).expect(201);
    const confirmed = await mutate(
      "post",
      `/api/v1/purchase-orders/${order.body.id}/confirmation`,
      { expectedVersion: order.body.version, confirmZeroCost: false },
    ).expect(200);
    return { order, confirmed, reference };
  }
  function receiveOrder({ order, confirmed, quantity, reference }) {
    return mutate(
      "post",
      `/api/v1/purchase-orders/${order.body.id}/receipts`,
      {
        expectedVersion: confirmed.body.version,
        reference,
        lines: [
          {
            purchaseOrderLineId: confirmed.body.lines[0].id,
            quantity,
          },
        ],
      },
      sessions.administrator,
      `mixed-receipt-${reference}`,
    );
  }
  const [receiptRaceProduct] = await pool.execute(
    `INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`MR-${suffix}`, `Producto recepción mixta ${suffix}`, categoryId],
  );
  const receiptRaceProductId = String(receiptRaceProduct.insertId);
  const receiptOrder = await createOrder(
    receiptRaceProductId,
    1,
    `RACE-RECEIPT-${suffix}`,
  );
  const receiptRaceSale = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [
        { productId: receiptRaceProductId, quantity: 1, unitPrice: "20.00" },
      ],
    }),
    sessions.administrator,
    `mixed-receipt-sale-create-${suffix}`,
  ).expect(201);
  const receiptRace = await Promise.all([
    receiveOrder({
      ...receiptOrder,
      productId: receiptRaceProductId,
      quantity: 1,
      reference: `RACE-RECEIPT-${suffix}`,
    }),
    mutate(
      "post",
      `/api/v1/sales/${receiptRaceSale.body.id}/confirmation`,
      { expectedVersion: receiptRaceSale.body.version },
      sessions.administrator,
      `mixed-receipt-sale-confirm-${suffix}`,
    ),
  ]);
  assert.equal(receiptRace[0].status, 201);
  assert.ok([200, 409].includes(receiptRace[1].status));
  const [[receiptRaceBalance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [receiptRaceProductId, warehouseId],
  );
  assert.equal(
    Number(receiptRaceBalance.quantity),
    receiptRace[1].status === 200 ? 0 : 1,
  );

  const [returnRaceProduct] = await pool.execute(
    `INSERT INTO products (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', 10.00, 20.00)`,
    [`MT-${suffix}`, `Producto devolución mixta ${suffix}`, categoryId],
  );
  const returnRaceProductId = String(returnRaceProduct.insertId);
  const returnOrder = await createOrder(
    returnRaceProductId,
    2,
    `RACE-RETURN-${suffix}`,
  );
  const receipt = await receiveOrder({
    ...returnOrder,
    productId: returnRaceProductId,
    quantity: 2,
    reference: `RACE-RETURN-SEED-${suffix}`,
  }).expect(201);
  const returnLineId = receipt.body.lines[0].id;
  const returnRaceSale = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [
        { productId: returnRaceProductId, quantity: 2, unitPrice: "20.00" },
      ],
    }),
    sessions.administrator,
    `mixed-return-sale-create-${suffix}`,
  ).expect(201);
  const returnRace = await Promise.all([
    mutate(
      "post",
      `/api/v1/purchase-orders/${returnOrder.order.body.id}/receipts/${receipt.body.id}/returns`,
      {
        reference: `RETURN-${suffix}`,
        reason: "Devolución concurrente de prueba",
        lines: [{ purchaseReceiptLineId: returnLineId, quantity: 1 }],
      },
      sessions.administrator,
      `mixed-return-${suffix}`,
    ),
    mutate(
      "post",
      `/api/v1/sales/${returnRaceSale.body.id}/confirmation`,
      { expectedVersion: returnRaceSale.body.version },
      sessions.administrator,
      `mixed-return-sale-confirm-${suffix}`,
    ),
  ]);
  assert.ok([201, 409].includes(returnRace[0].status));
  assert.ok([200, 409].includes(returnRace[1].status));
  assert.equal(
    Number(returnRace[0].status === 201) + Number(returnRace[1].status === 200),
    1,
  );
  const [[returnRaceBalance]] = await pool.execute(
    "SELECT quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [returnRaceProductId, warehouseId],
  );
  assert.equal(
    Number(returnRaceBalance.quantity),
    returnRace[1].status === 200 ? 0 : 1,
  );
});

test("competing confirmations cannot oversell the same balance", async () => {
  await inventoryEngine.createOperation({
    userId: users.administrator,
    idempotencyKey: `concurrent-opening-${suffix}`,
    payload: {
      type: "initial_stock",
      sourceWarehouseId: warehouseId,
      destinationWarehouseId: null,
      reason: "Existencia para prueba concurrente de ventas",
      reference: `CONCURRENT-${suffix}`,
      lines: [{ productId: minimumProductId, quantity: 5 }],
    },
  });
  const drafts = await Promise.all(
    ["administrator", "seller"].map((account) =>
      mutate(
        "post",
        "/api/v1/sales",
        saleInput({
          lines: [
            { productId: minimumProductId, quantity: 5, unitPrice: "0.10" },
          ],
        }),
        sessions[account],
        `concurrent-create-${account}-${suffix}`,
      ).expect(201),
    ),
  );
  const outcomes = await Promise.all(
    drafts.map((draft, index) =>
      mutate(
        "post",
        `/api/v1/sales/${draft.body.id}/confirmation`,
        { expectedVersion: draft.body.version },
        sessions[index === 0 ? "administrator" : "seller"],
        `concurrent-confirm-${index}-${suffix}`,
      ),
    ),
  );
  assert.deepEqual(
    outcomes.map((response) => response.status).sort(),
    [200, 409],
  );
  const [[balance]] = await pool.execute(
    `SELECT quantity FROM inventory_balances
     WHERE product_id = ? AND warehouse_id = ?`,
    [minimumProductId, warehouseId],
  );
  assert.equal(Number(balance.quantity), 0);
  const [states] = await pool.execute(
    `SELECT status FROM sales WHERE id IN (?, ?) ORDER BY id`,
    drafts.map((draft) => draft.body.id),
  );
  assert.deepEqual(states.map(({ status }) => status).sort(), [
    "confirmed",
    "draft",
  ]);
  const [operations] = await pool.execute(
    `SELECT operation_type, source_type, source_id FROM inventory_operations
     WHERE source_type = 'sale' AND source_id IN (?, ?)`,
    drafts.map((draft) => draft.body.id),
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation_type, "sale_issue");
});

test("seller edits only owned drafts, versions reject stale writes, and auditor is read-only", async () => {
  const [[inventoryBefore]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementsBefore]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "999.99" }] }),
    sessions.seller,
    `seller-${suffix}`,
  ).expect(201);
  const updated = await mutate(
    "patch",
    `/api/v1/sales/${created.body.id}`,
    {
      ...saleInput({
        lines: [{ productId, quantity: 2, unitPrice: "1000.01" }],
      }),
      expectedVersion: created.body.version,
    },
    sessions.seller,
    `seller-update-${suffix}`,
  ).expect(200);
  assert.equal(updated.body.total, "2000.02");
  assert.equal(updated.body.version, created.body.version + 1);
  await mutate(
    "patch",
    `/api/v1/sales/${created.body.id}`,
    {
      ...saleInput(),
      expectedVersion: created.body.version,
    },
    sessions.seller,
    `stale-${suffix}`,
  ).expect(409);
  await get(`/api/v1/sales/${created.body.id}`, sessions.auditor).expect(200);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput(),
    sessions.auditor,
    `auditor-${suffix}`,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/sales/${created.body.id}`,
    {
      ...saleInput(),
      expectedVersion: updated.body.version,
    },
    sessions.secondSeller,
    `other-owner-${suffix}`,
  ).expect(403);
  await get("/api/v1/sales", sessions.warehouse).expect(403);
  await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/cancellation`,
    {
      expectedVersion: updated.body.version,
      reason: "No autorizado",
    },
    sessions.seller,
    `seller-cancel-${suffix}`,
  ).expect(403);
  const [[inventoryAfter]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementsAfter]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(inventoryAfter, inventoryBefore);
  assert.equal(movementsAfter.count, movementsBefore.count);
  const [[audit]] = await pool.execute(
    "SELECT details FROM audit_events WHERE module = 'sales' AND action = 'sales.draft_updated' AND entity_id = ?",
    [created.body.id],
  );
  const auditDetails =
    typeof audit.details === "string"
      ? JSON.parse(audit.details)
      : audit.details;
  assert.equal(auditDetails.previous.lines[0].unitPrice, "999.99");
  assert.equal(auditDetails.current.lines[0].unitPrice, "1000.01");
});

test("customer returns allow partial and complete quantities, restock only inspected apt units, and prevent over-return or cancellation", async () => {
  const fixture = await createConfirmedReversalFixture(10);
  const lineId = fixture.confirmed.lines[0].id;
  const path = `/api/v1/sales/${fixture.created.id}/returns`;
  const firstBody = customerReturnInput(
    fixture.confirmed,
    [
      {
        saleLineId: lineId,
        quantityReceived: 4,
        quantityRestocked: 3,
        nonRestockReason: "Una unidad llegó con el empaque abierto",
      },
    ],
    { reference: `DEV-PARCIAL-${fixture.fixture}` },
  );
  const first = await mutate(
    "post",
    path,
    firstBody,
    sessions.administrator,
    `customer-return-partial-${fixture.fixture}`,
  ).expect(201);
  assert.equal(first.body.customerReturn.lines[0].quantityReceived, 4);
  assert.equal(first.body.customerReturn.lines[0].quantityRestocked, 3);
  assert.equal(first.body.customerReturn.lines[0].quantityNotRestocked, 1);
  assert.equal(first.body.sale.status, "confirmed");
  const [[balanceAfterFirst]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.equal(Number(balanceAfterFirst.quantity), 7);
  assert.equal(first.body.sale.lines[0].returnedQuantity, 4);
  assert.equal(first.body.sale.lines[0].returnableQuantity, 6);
  const [[restockOperation]] = await pool.execute(
    "SELECT id, operation_type FROM inventory_operations WHERE source_type = 'customer_return' AND source_id = ?",
    [first.body.customerReturn.id],
  );
  assert.equal(restockOperation.operation_type, "customer_return");
  const [[restockMovement]] = await pool.execute(
    "SELECT direction, quantity FROM inventory_movements WHERE operation_id = ?",
    [restockOperation.id],
  );
  assert.equal(restockMovement.direction, "IN");
  assert.equal(Number(restockMovement.quantity), 3);
  await mutate(
    "post",
    path,
    { ...firstBody, reason: "Contenido diferente" },
    sessions.administrator,
    `customer-return-partial-${fixture.fixture}`,
  ).expect(409);
  await mutate(
    "post",
    path,
    customerReturnInput(
      first.body.sale,
      [{ saleLineId: lineId, quantityReceived: 1, quantityRestocked: 1 }],
      { reference: firstBody.reference },
    ),
    sessions.administrator,
    `customer-return-duplicate-reference-${fixture.fixture}`,
  ).expect(409);
  const pdf = await get(`${path}/${first.body.customerReturn.id}/pdf`).expect(
    200,
  );
  assert.match(pdf.headers["content-type"], /application\/pdf/);
  assert.ok(pdf.body.toString("latin1").startsWith("%PDF-1.4"));
  const replay = await mutate(
    "post",
    path,
    firstBody,
    sessions.administrator,
    `customer-return-partial-${fixture.fixture}`,
  ).expect(200);
  assert.equal(replay.body.customerReturn.id, first.body.customerReturn.id);
  await mutate(
    "post",
    `/api/v1/sales/${fixture.created.id}/reversal`,
    reversalInput(first.body.sale),
    sessions.administrator,
    `customer-return-block-reversal-${fixture.fixture}`,
  ).expect(409);

  const secondBody = customerReturnInput(
    first.body.sale,
    [
      {
        saleLineId: lineId,
        quantityReceived: 6,
        quantityRestocked: 0,
        nonRestockReason: "Mercancía no apta para reincorporación",
      },
    ],
    { reference: `DEV-COMPLETA-${fixture.fixture}` },
  );
  const second = await mutate(
    "post",
    path,
    secondBody,
    sessions.administrator,
    `customer-return-complete-${fixture.fixture}`,
  ).expect(201);
  assert.equal(second.body.sale.status, "confirmed");
  const [[balanceAfterZero]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.equal(Number(balanceAfterZero.quantity), 7);
  assert.deepEqual(balanceAfterZero, balanceAfterFirst);
  const [[sourceIssue]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'sale' AND source_id = ? AND operation_type = 'sale_issue'",
    [fixture.created.id],
  );
  assert.equal(Number(sourceIssue.count), 1);
  const [[operationCount]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE source_type = 'customer_return' AND source_id = ?",
    [second.body.customerReturn.id],
  );
  assert.equal(Number(operationCount.count), 0);
  const noRestockReplay = await mutate(
    "post",
    path,
    secondBody,
    sessions.administrator,
    `customer-return-complete-${fixture.fixture}`,
  ).expect(200);
  assert.equal(
    noRestockReplay.body.customerReturn.id,
    second.body.customerReturn.id,
  );
  await mutate(
    "post",
    path,
    customerReturnInput(
      second.body.sale,
      [{ saleLineId: lineId, quantityReceived: 1, quantityRestocked: 1 }],
      { reference: `DEV-EXCESO-${fixture.fixture}` },
    ),
    sessions.administrator,
    `customer-return-excess-${fixture.fixture}`,
  ).expect(409);
  const history = await get(path).expect(200);
  assert.equal(history.body.items.length, 2);
  const detail = await get(`${path}/${first.body.customerReturn.id}`).expect(
    200,
  );
  assert.equal(detail.body.id, first.body.customerReturn.id);
});

test("customer returns enforce manager permission, strict declarations, original lines, and required non-restock reason", async () => {
  const fixture = await createConfirmedReversalFixture(2);
  const path = `/api/v1/sales/${fixture.created.id}/returns`;
  const valid = customerReturnInput(fixture.confirmed, [
    {
      saleLineId: fixture.confirmed.lines[0].id,
      quantityReceived: 1,
      quantityRestocked: 0,
      nonRestockReason: "Empaque deteriorado",
    },
  ]);
  await mutate(
    "post",
    path,
    valid,
    sessions.seller,
    `customer-return-seller-${fixture.fixture}`,
  ).expect(403);
  await mutate(
    "post",
    path,
    { ...valid, inspected: false },
    sessions.administrator,
    `customer-return-not-inspected-${fixture.fixture}`,
  ).expect(400);
  await mutate(
    "post",
    path,
    { ...valid, lines: [{ ...valid.lines[0], quantityReceived: 0 }] },
    sessions.administrator,
    `customer-return-zero-quantity-${fixture.fixture}`,
  ).expect(400);
  await mutate(
    "post",
    path,
    { ...valid, lines: [{ ...valid.lines[0], saleLineId: "999999999" }] },
    sessions.administrator,
    `customer-return-foreign-line-${fixture.fixture}`,
  ).expect(400);
  await mutate(
    "post",
    path,
    { ...valid, lines: [{ ...valid.lines[0], nonRestockReason: "" }] },
    sessions.administrator,
    `customer-return-no-reason-${fixture.fixture}`,
  ).expect(400);
  await pool.execute("UPDATE products SET is_active = 0 WHERE id = ?", [
    fixture.productId,
  ]);
  try {
    const apt = {
      ...valid,
      reference: `INACTIVE-APT-${fixture.fixture}`,
      lines: [
        { ...valid.lines[0], quantityRestocked: 1, nonRestockReason: "" },
      ],
    };
    const inactiveApt = await mutate(
      "post",
      path,
      apt,
      sessions.administrator,
      `customer-return-inactive-apt-${fixture.fixture}`,
    );
    assert.equal(inactiveApt.status, 409, JSON.stringify(inactiveApt.body));
    const historical = {
      ...valid,
      reference: `INACTIVE-NO-RESTOCK-${fixture.fixture}`,
    };
    const result = await mutate(
      "post",
      path,
      historical,
      sessions.administrator,
      `customer-return-inactive-historical-${fixture.fixture}`,
    ).expect(201);
    assert.equal(result.body.customerReturn.lines[0].quantityNotRestocked, 1);
  } finally {
    await pool.execute("UPDATE products SET is_active = 1 WHERE id = ?", [
      fixture.productId,
    ]);
  }
});

test("cancelled confirmed sales cannot receive customer returns", async () => {
  const fixture = await createConfirmedReversalFixture(2);
  const reversed = await mutate(
    "post",
    `/api/v1/sales/${fixture.created.id}/reversal`,
    reversalInput(fixture.confirmed),
    sessions.administrator,
    `customer-return-cancelled-sale-reversal-${fixture.fixture}`,
  ).expect(200);
  await mutate(
    "post",
    `/api/v1/sales/${fixture.created.id}/returns`,
    customerReturnInput(reversed.body.sale, [
      {
        saleLineId: fixture.confirmed.lines[0].id,
        quantityReceived: 1,
        quantityRestocked: 1,
      },
    ]),
    sessions.administrator,
    `customer-return-cancelled-sale-${fixture.fixture}`,
  ).expect(409);
});

test("concurrent returns serialize with each other and with confirmed-sale reversal", async () => {
  const fixture = await createConfirmedReversalFixture(3);
  const path = `/api/v1/sales/${fixture.created.id}/returns`;
  const makeReturn = (sale, reference) =>
    customerReturnInput(
      sale,
      [
        {
          saleLineId: sale.lines[0].id,
          quantityReceived: 2,
          quantityRestocked: 2,
        },
      ],
      { reference },
    );
  const concurrent = await Promise.all([
    mutate(
      "post",
      path,
      makeReturn(fixture.confirmed, `RACE-A-${fixture.fixture}`),
      sessions.administrator,
      `customer-return-race-a-${fixture.fixture}`,
    ),
    mutate(
      "post",
      path,
      makeReturn(fixture.confirmed, `RACE-B-${fixture.fixture}`),
      sessions.administrator,
      `customer-return-race-b-${fixture.fixture}`,
    ),
  ]);
  assert.deepEqual(
    concurrent.map((response) => response.status).sort(),
    [201, 409],
  );
  const [[returnCount]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM customer_returns WHERE sale_id = ?",
    [fixture.created.id],
  );
  assert.equal(Number(returnCount.count), 1);

  const other = await createConfirmedReversalFixture(2);
  const race = await Promise.all([
    mutate(
      "post",
      `/api/v1/sales/${other.created.id}/returns`,
      makeReturn(other.confirmed, `RACE-C-${other.fixture}`),
      sessions.administrator,
      `customer-return-reverse-race-${other.fixture}`,
    ),
    mutate(
      "post",
      `/api/v1/sales/${other.created.id}/reversal`,
      reversalInput(other.confirmed),
      sessions.administrator,
      `customer-reversal-race-${other.fixture}`,
    ),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [
    race.some((response) => response.status === 201) ? 201 : 200,
    409,
  ]);
  const [[state]] = await pool.execute(
    "SELECT status FROM sales WHERE id = ?",
    [other.created.id],
  );
  const [[returns]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM customer_returns WHERE sale_id = ?",
    [other.created.id],
  );
  const [[reversals]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_cancellations WHERE sale_id = ?",
    [other.created.id],
  );
  assert.equal(Number(returns.count) + Number(reversals.count), 1);
  assert.equal(
    state.status,
    Number(reversals.count) ? "cancelled" : "confirmed",
  );
});

test("a customer-return audit failure rolls back document, inventory, sale version, and idempotency", async () => {
  const fixture = await createConfirmedReversalFixture(2);
  const [[before]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  const failingPool = {
    async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          const value = target[property];
          if (property === "execute")
            return async (sql, values) => {
              if (
                String(sql).includes("INSERT INTO audit_events") &&
                values?.[1] === "sales.return_confirmed"
              )
                throw new Error(
                  "Injected test-only customer-return audit failure",
                );
              return value.call(target, sql, values);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const service = createSaleService({ dbPool: failingPool });
  const key = `customer-return-audit-failure-${fixture.fixture}`;
  await assert.rejects(
    service.createCustomerReturn({
      id: fixture.created.id,
      input: customerReturnInput(fixture.confirmed, [
        {
          saleLineId: fixture.confirmed.lines[0].id,
          quantityReceived: 1,
          quantityRestocked: 1,
        },
      ]),
      actor: {
        user: { id: users.administrator, role: "administrator" },
        warehouseIds: new Set([warehouseId]),
      },
      request: { ip: "127.0.0.1", get: () => "integration-test" },
      key,
    }),
    /Injected test-only customer-return audit failure/,
  );
  const [[sale]] = await pool.execute(
    "SELECT status, version FROM sales WHERE id = ?",
    [fixture.created.id],
  );
  assert.equal(sale.status, "confirmed");
  assert.equal(Number(sale.version), fixture.confirmed.version);
  const [[after]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [fixture.productId, warehouseId],
  );
  assert.deepEqual(after, before);
  const [[documents]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM customer_returns WHERE sale_id = ?",
    [fixture.created.id],
  );
  const [[operations]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_operations WHERE created_by = ? AND idempotency_key = ?",
    [users.administrator, key],
  );
  const [[requests]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sale_requests WHERE actor_id = ? AND idempotency_key = ?",
    [users.administrator, key],
  );
  assert.equal(Number(documents.count), 0);
  assert.equal(Number(operations.count), 0);
  assert.equal(Number(requests.count), 0);
});

test("validates active references, assigned warehouses, unique products and wholesale minimums", async () => {
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ customerId: inactiveCustomerId }),
    sessions.administrator,
    `inactive-customer-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1.5, unitPrice: "1.00" }] }),
    sessions.administrator,
    `fractional-quantity-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1.001" }] }),
    sessions.administrator,
    `fractional-price-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ warehouseId: unassignedWarehouseId }),
    sessions.administrator,
    `unassigned-${suffix}`,
  ).expect(403);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [
        { productId: inactiveProductId, quantity: 1, unitPrice: "10.00" },
      ],
    }),
    sessions.administrator,
    `inactive-product-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [{ productId: minimumProductId, quantity: 4, unitPrice: "1.00" }],
    }),
    sessions.administrator,
    `below-minimum-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({
      lines: [
        { productId, quantity: 1, unitPrice: "1.00" },
        { productId, quantity: 2, unitPrice: "1.00" },
      ],
    }),
    sessions.administrator,
    `duplicate-${suffix}`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "0.00" }] }),
    sessions.administrator,
    `zero-price-${suffix}`,
  ).expect(400);
});

test("authorized cancellation is versioned and cancelled drafts cannot be edited", async () => {
  const [[inventoryBefore]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementsBefore]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const created = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "10.00" }] }),
    sessions.administrator,
    `cancel-create-${suffix}`,
  ).expect(201);
  const cancelled = await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/cancellation`,
    {
      expectedVersion: created.body.version,
      reason: "El cliente desistió",
    },
    sessions.administrator,
    `cancel-${suffix}`,
  ).expect(200);
  assert.equal(cancelled.body.status, "cancelled");
  await mutate(
    "patch",
    `/api/v1/sales/${created.body.id}`,
    {
      ...saleInput(),
      expectedVersion: cancelled.body.version,
    },
    sessions.administrator,
    `edit-cancelled-${suffix}`,
  ).expect(409);
  const [[inventoryAfter]] = await pool.execute(
    "SELECT quantity, version FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  const [[movementsAfter]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE product_id = ? AND warehouse_id = ?",
    [productId, warehouseId],
  );
  assert.deepEqual(inventoryAfter, inventoryBefore);
  assert.equal(movementsAfter.count, movementsBefore.count);
  await mutate(
    "post",
    `/api/v1/sales/${created.body.id}/cancellation`,
    {
      expectedVersion: created.body.version,
      reason: "Cancelación repetida",
    },
    sessions.administrator,
    `cancel-stale-${suffix}`,
  ).expect(409);
});

test("list filters, pagination, and idempotency key reuse are enforced", async () => {
  const first = await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "1.25" }] }),
    sessions.administrator,
    `list-first-${suffix}`,
  ).expect(201);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 2, unitPrice: "2.50" }] }),
    sessions.administrator,
    `list-second-${suffix}`,
  ).expect(201);
  const list = await get(
    "/api/v1/sales?page=1&pageSize=1&status=draft&sortBy=number&sortOrder=desc",
  ).expect(200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.pagination.pageSize, 1);
  assert.ok(list.body.pagination.total >= 2);
  const filtered = await get(
    `/api/v1/sales?q=${first.body.number}&status=draft`,
  ).expect(200);
  assert.equal(filtered.body.items.length, 1);
  assert.equal(filtered.body.items[0].id, first.body.id);
  assert.equal(filtered.body.items[0].total, first.body.total);

  const key = `same-key-${suffix}`;
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 1, unitPrice: "3.00" }] }),
    sessions.administrator,
    key,
  ).expect(201);
  await mutate(
    "post",
    "/api/v1/sales",
    saleInput({ lines: [{ productId, quantity: 2, unitPrice: "3.00" }] }),
    sessions.administrator,
    key,
  ).expect(409);
});
