import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createSalesActivityService } from "../../src/modules/reports/sales-activity-service.js";
import { connectAdminTestDatabase } from "../support/test-database.js";
import { createLogger } from "../../src/shared/logger.js";

const suffix = randomBytes(6).toString("hex");
let pool;
let service;
let userId;
let roleId;
let auditorUserId;
let sellerUserId;
let warehouseUserId;
let auditorRoleId;
let warehouseId;
let categoryId;
let customerId;
let productIds = [];
let saleIds = [];
let cancellationId;
let returnIds = [];
let sessionId;
let auth;
let auditorSessionId;
let auditorAuth;
let app;
let adminCookie;
let auditorCookie;
let sellerCookie;
let warehouseCookie;
const httpPassword = "Clave-segura-actividad-2026!";
const origin = "http://127.0.0.1:5173";
let saleSequence = 0;

async function makeSale({
  status,
  confirmedAt = null,
  cancelledAt = null,
  reason = null,
}) {
  saleSequence += 1;
  const [result] = await pool.execute(
    `INSERT INTO sales
       (commercial_code, customer_id, customer_name_snapshot, customer_identification_snapshot,
        warehouse_id, warehouse_code_snapshot, warehouse_name_snapshot,
        sale_date, status, created_by, updated_by, confirmed_by, confirmed_at,
        cancelled_by, cancelled_at, cancellation_reason)
     VALUES (?, ?, 'Fixture cliente', 'FIXTURE', ?, 'FIXTURE', 'Fixture bodega',
             '2025-12-01', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `VE-RA-${suffix}-${saleSequence}`,
      customerId,
      warehouseId,
      status,
      userId,
      userId,
      confirmedAt ? userId : null,
      confirmedAt,
      cancelledAt ? userId : null,
      cancelledAt,
      reason,
    ],
  );
  const id = String(result.insertId);
  saleIds.push(id);
  return id;
}

async function makeReturn({ saleId, reference, returnedAt, lines }) {
  const [result] = await pool.execute(
    `INSERT INTO customer_returns
       (sale_id, reference, reason, physical_observation, received_physical,
        inspected, returned_by, returned_at)
     VALUES (?, ?, 'Fixture de prueba', 'Conteo físico de fixture', 1, 1, ?, ?)`,
    [saleId, reference, userId, returnedAt],
  );
  const returnId = String(result.insertId);
  returnIds.push(returnId);
  for (const line of lines) {
    await pool.execute(
      `INSERT INTO customer_return_lines
         (customer_return_id, sale_id, sale_line_id, product_id, sku_snapshot,
          product_name_snapshot, unit_snapshot, quantity_received,
          quantity_restocked, non_restock_reason)
       VALUES (?, ?, ?, ?, 'FIXTURE', 'Producto fixture', ?, ?, ?, ?)`,
      [
        returnId,
        saleId,
        line.saleLineId,
        line.productId,
        line.unit,
        line.received,
        line.restocked,
        line.restocked < line.received ? "No reintegrable en el fixture" : null,
      ],
    );
  }
}

before(async () => {
  pool = createDatabasePool("test");
  const [[identity]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(identity.name, "sigecom_test");
  service = createSalesActivityService({ dbPool: pool });
  app = createApp({
    dbPool: pool,
    authConfig: getAuthConfig({
      JWT_SECRET: randomBytes(48).toString("base64url"),
      FRONTEND_ORIGIN: origin,
      AUTH_RATE_LIMIT_MAX: "20",
    }),
    logger: createLogger({ level: "silent" }),
  });

  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code='administrator'",
  );
  roleId = String(role.id);
  const [[permissionCount]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM role_permissions rp
       JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=? AND p.code IN ('reports.read','sales.read','warehouses.read')`,
    [roleId],
  );
  assert.equal(
    Number(permissionCount.count),
    3,
    "Administrador debe conservar los tres permisos del fixture.",
  );
  const [[auditorRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='auditor'",
  );
  auditorRoleId = String(auditorRole.id);
  const [[auditorPermissionCount]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM role_permissions rp
       JOIN permissions p ON p.id=rp.permission_id
      WHERE rp.role_id=? AND p.code IN ('reports.read','sales.read','warehouses.read')`,
    [auditorRoleId],
  );
  assert.equal(Number(auditorPermissionCount.count), 3);

  const passwordHash = await bcrypt.hash(httpPassword, 4);
  const [user] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
    [
      roleId,
      `sales-activity-${suffix}@sigecom.invalid`,
      `Fixture ${suffix}`,
      passwordHash,
    ],
  );
  userId = String(user.insertId);
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code,name,is_active) VALUES (?, ?, 0)",
    [`RA-${suffix}`, `Bodega inactiva ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [userId, warehouseId],
  );
  const [session] = await pool.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)`,
    [userId, randomBytes(32).toString("hex")],
  );
  sessionId = String(session.insertId);
  auth = { user: { id: userId, role: "administrator" }, sessionId };
  const [auditorUser] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
    [
      auditorRoleId,
      `sales-activity-auditor-${suffix}@sigecom.invalid`,
      `Auditor ${suffix}`,
      passwordHash,
    ],
  );
  auditorUserId = String(auditorUser.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [auditorUserId, warehouseId],
  );
  const [auditorSession] = await pool.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)`,
    [auditorUserId, randomBytes(32).toString("hex")],
  );
  auditorSessionId = String(auditorSession.insertId);
  auditorAuth = {
    user: { id: auditorUserId, role: "auditor" },
    sessionId: auditorSessionId,
  };
  const [[sellerRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='seller'",
  );
  const [seller] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
    [
      sellerRole.id,
      `sales-activity-seller-${suffix}@sigecom.invalid`,
      `Vendedor ${suffix}`,
      passwordHash,
    ],
  );
  sellerUserId = String(seller.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [seller.insertId, warehouseId],
  );
  await pool.execute("UPDATE users SET password_change_required=0 WHERE id=?", [
    userId,
  ]);
  await pool.execute("UPDATE users SET password_change_required=0 WHERE id=?", [
    auditorUserId,
  ]);
  await pool.execute("UPDATE users SET password_change_required=0 WHERE id=?", [
    seller.insertId,
  ]);
  const [[warehouseRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code='warehouse'",
  );
  const [warehouseUser] = await pool.execute(
    "INSERT INTO users (role_id,email,display_name,password_hash) VALUES (?, ?, ?, ?)",
    [
      warehouseRole.id,
      `sales-activity-warehouse-${suffix}@sigecom.invalid`,
      `Bodega ${suffix}`,
      passwordHash,
    ],
  );
  warehouseUserId = String(warehouseUser.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [warehouseUserId, warehouseId],
  );
  await pool.execute("UPDATE users SET password_change_required=0 WHERE id=?", [
    warehouseUserId,
  ]);

  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Reporte ${suffix}`],
  );
  categoryId = String(category.insertId);
  const [customer] = await pool.execute(
    "INSERT INTO customers (identification_number,name) VALUES (?,?)",
    [`RA-${suffix}`, `Cliente ${suffix}`],
  );
  customerId = String(customer.insertId);
  for (const [sku, name, unit] of [
    [`RA-${suffix}`, "Producto unidad", "unidad"],
    [`RB-${suffix}`, "Producto caja", "caja"],
  ]) {
    const [product] = await pool.execute(
      `INSERT INTO products (sku,name,category_id,unit,purchase_price,sale_price)
       VALUES (?,?,?, ?,1.00,1.00)`,
      [sku, name, categoryId, unit],
    );
    productIds.push(String(product.insertId));
  }

  // A previous-period sale is returned in January. Its original price, not sale_date,
  // determines the return equivalent. A second sale has multiple lines and is later cancelled.
  const priorSaleId = await makeSale({
    status: "confirmed",
    confirmedAt: "2025-12-31 23:59:59.999",
  });
  const [priorLine] = await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 1, 'OLD', 'Producto antiguo', 'unidad', 5, 10.25, 51.25)`,
    [priorSaleId, productIds[0]],
  );
  await makeReturn({
    saleId: priorSaleId,
    reference: `RET-A-${suffix}`,
    returnedAt: "2026-01-10 04:59:59.999",
    lines: [
      {
        saleLineId: String(priorLine.insertId),
        productId: productIds[0],
        unit: "unidad",
        received: 2,
        restocked: 1,
      },
    ],
  });
  await makeReturn({
    saleId: priorSaleId,
    reference: `RET-B-${suffix}`,
    returnedAt: "2026-01-10 05:00:00.000",
    lines: [
      {
        saleLineId: String(priorLine.insertId),
        productId: productIds[0],
        unit: "unidad",
        received: 1,
        restocked: 0,
      },
    ],
  });

  const confirmedSaleId = await makeSale({
    status: "confirmed",
    confirmedAt: "2026-01-10 05:00:00.000",
  });
  await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 1, 'C', 'Venta del período', 'unidad', 1, 12.30, 12.30)`,
    [confirmedSaleId, productIds[0]],
  );
  await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 2, 'E', 'Venta del período', 'caja', 1, 0.10, 0.10)`,
    [confirmedSaleId, productIds[1]],
  );

  const cancelledSaleId = await makeSale({
    status: "cancelled",
    confirmedAt: "2025-12-31 23:59:59.999",
    cancelledAt: "2026-01-11 04:59:59.999",
    reason: "Anulación fixture",
  });
  const [lineOne] = await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 1, 'A', 'Producto unidad', 'unidad', 1, 9999999999999.99, 9999999999999.99)`,
    [cancelledSaleId, productIds[0]],
  );
  const [lineTwo] = await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 2, 'B', 'Producto caja', 'caja', 1, 0.01, 0.01)`,
    [cancelledSaleId, productIds[1]],
  );
  const [cancellation] = await pool.execute(
    `INSERT INTO sale_cancellations (sale_id,verification_reference,physical_observation,never_dispatched,all_quantities_present,all_products_saleable,created_at)
     VALUES (?, ?, 'Conteo fixture', 1, 1, 1, '2026-01-11 04:59:59.999')`,
    [cancelledSaleId, `CAN-${suffix}`],
  );
  cancellationId = String(cancellation.insertId);
  await makeReturn({
    saleId: cancelledSaleId,
    reference: `RET-C-${suffix}`,
    returnedAt: "2026-01-11 05:00:00.000",
    lines: [
      {
        saleLineId: String(lineOne.insertId),
        productId: productIds[0],
        unit: "unidad",
        received: 1,
        restocked: 0,
      },
      {
        saleLineId: String(lineTwo.insertId),
        productId: productIds[1],
        unit: "caja",
        received: 1,
        restocked: 1,
      },
    ],
  });
  const draftCancelled = await makeSale({
    status: "cancelled",
    cancelledAt: "2026-01-11 04:00:00.000",
    reason: "Borrador cancelado",
  });
  await pool.execute(
    `INSERT INTO sale_lines (sale_id,product_id,position,sku_snapshot,product_name_snapshot,unit_snapshot,quantity,unit_price,line_total)
     VALUES (?, ?, 1, 'D', 'Borrador', 'unidad', 1, 700.00, 700.00)`,
    [draftCancelled, productIds[0]],
  );
  const signIn = async (email) => {
    const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
    const csrfCookie = csrf.headers["set-cookie"].find((cookie) =>
      cookie.startsWith("sigecom_csrf="),
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", origin)
      .set("Cookie", csrfCookie.split(";", 1)[0])
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({ email, password: httpPassword })
      .expect(200);
    return login.headers["set-cookie"]
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
  };
  adminCookie = await signIn(`sales-activity-${suffix}@sigecom.invalid`);
  auditorCookie = await signIn(
    `sales-activity-auditor-${suffix}@sigecom.invalid`,
  );
  sellerCookie = await signIn(
    `sales-activity-seller-${suffix}@sigecom.invalid`,
  );
  warehouseCookie = await signIn(
    `sales-activity-warehouse-${suffix}@sigecom.invalid`,
  );
});

after(async () => {
  if (!pool) return;
  let cleanup;
  try {
    cleanup = await connectAdminTestDatabase();
    for (const returnId of returnIds) {
      await cleanup.execute(
        "DELETE FROM customer_return_lines WHERE customer_return_id=?",
        [returnId],
      );
      await cleanup.execute("DELETE FROM customer_returns WHERE id=?", [
        returnId,
      ]);
    }
    if (cancellationId)
      await cleanup.execute("DELETE FROM sale_cancellations WHERE id=?", [
        cancellationId,
      ]);
    for (const saleId of saleIds) {
      await cleanup.execute("DELETE FROM sale_lines WHERE sale_id=?", [saleId]);
      await cleanup.execute("DELETE FROM sales WHERE id=?", [saleId]);
    }
    if (userId) {
      await cleanup.execute("DELETE FROM user_warehouses WHERE user_id=?", [
        userId,
      ]);
      await cleanup.execute("DELETE FROM user_sessions WHERE user_id=?", [
        userId,
      ]);
      await cleanup.execute("DELETE FROM users WHERE id=?", [userId]);
    }
    if (auditorUserId) {
      await cleanup.execute("DELETE FROM user_warehouses WHERE user_id=?", [
        auditorUserId,
      ]);
      await cleanup.execute("DELETE FROM user_sessions WHERE user_id=?", [
        auditorUserId,
      ]);
      await cleanup.execute("DELETE FROM users WHERE id=?", [auditorUserId]);
    }
    if (sellerUserId) {
      await cleanup.execute("DELETE FROM user_warehouses WHERE user_id=?", [
        sellerUserId,
      ]);
      await cleanup.execute("DELETE FROM user_sessions WHERE user_id=?", [
        sellerUserId,
      ]);
      await cleanup.execute("DELETE FROM users WHERE id=?", [sellerUserId]);
    }
    if (warehouseUserId) {
      await cleanup.execute("DELETE FROM user_warehouses WHERE user_id=?", [
        warehouseUserId,
      ]);
      await cleanup.execute("DELETE FROM user_sessions WHERE user_id=?", [
        warehouseUserId,
      ]);
      await cleanup.execute("DELETE FROM users WHERE id=?", [warehouseUserId]);
    }
    if (warehouseId)
      await cleanup.execute("DELETE FROM warehouses WHERE id=?", [warehouseId]);
    if (customerId)
      await cleanup.execute("DELETE FROM customers WHERE id=?", [customerId]);
    for (const id of productIds)
      await cleanup.execute("DELETE FROM products WHERE id=?", [id]);
    if (categoryId)
      await cleanup.execute("DELETE FROM categories WHERE id=?", [categoryId]);
  } finally {
    await cleanup?.end();
    await pool.end();
  }
});

test("summarizes scoped commercial facts exactly, including event-date boundaries", async (context) => {
  const [[beforeWrites]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM sales WHERE warehouse_id=?) AS sales,
       (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audit,
       (SELECT COUNT(*) FROM inventory_operations WHERE created_by=?) AS inventory`,
    [warehouseId, userId, userId],
  );
  const priorConfirmation = await service.summarize({
    auth,
    dateFrom: "2025-12-31",
    dateTo: "2025-12-31",
  });
  assert.equal(priorConfirmation.summary.grossConfirmed, "10000000000051.25");
  assert.equal(priorConfirmation.summary.cancellations, "0.00");

  const before = await service.summarize({
    auth,
    dateFrom: "2026-01-10",
    dateTo: "2026-01-10",
  });
  assert.deepEqual(before.summary, {
    grossConfirmed: "12.40",
    cancellations: "10000000000000.00",
    returnEquivalent: "10.25",
    referenceCommercialBalance: "-9999999999997.85",
    quantitiesByUnit: [
      { unit: "unidad", quantityReceived: "1", quantityRestocked: "0" },
    ],
  });
  const cancellationDay = await service.summarize({
    auth,
    dateFrom: "2026-01-11",
    dateTo: "2026-01-11",
  });
  assert.equal(cancellationDay.summary.cancellations, "0.00");
  assert.equal(cancellationDay.summary.returnEquivalent, "10000000000000.00");
  assert.equal(
    cancellationDay.summary.quantitiesByUnit.find((row) => row.unit === "caja")
      .quantityRestocked,
    "1",
  );
  assert.equal(
    cancellationDay.summary.quantitiesByUnit.find(
      (row) => row.unit === "unidad",
    ).quantityRestocked,
    "0",
  );
  const multipleReturns = await service.summarize({
    auth,
    dateFrom: "2026-01-09",
    dateTo: "2026-01-10",
  });
  assert.equal(multipleReturns.summary.returnEquivalent, "30.75");
  assert.deepEqual(multipleReturns.summary.quantitiesByUnit, [
    { unit: "unidad", quantityReceived: "3", quantityRestocked: "1" },
  ]);
  const [[afterWrites]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM sales WHERE warehouse_id=?) AS sales,
       (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audit,
       (SELECT COUNT(*) FROM inventory_operations WHERE created_by=?) AS inventory`,
    [warehouseId, userId, userId],
  );
  assert.deepEqual(afterWrites, beforeWrites);

  const latencySamples = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const startedAt = performance.now();
    await service.summarize({
      auth,
      dateFrom: "2026-01-10",
      dateTo: "2026-01-10",
    });
    latencySamples.push(performance.now() - startedAt);
  }
  latencySamples.sort((left, right) => left - right);
  const percentile = (rank) =>
    latencySamples[Math.ceil(rank * latencySamples.length) - 1];
  context.diagnostic(
    `summarize latency (${latencySamples.length} sequential calls, fixture warehouse): p50=${percentile(0.5).toFixed(2)}ms p95=${percentile(0.95).toFixed(2)}ms max=${latencySamples.at(-1).toFixed(2)}ms`,
  );
});

test("HTTP sales activity returns scoped exact summaries and stable pagination", async (context) => {
  const url =
    "/api/v1/reports/sales-activity?dateFrom=2026-01-10&dateTo=2026-01-11";
  const [[beforeRead]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audit,
            (SELECT COUNT(*) FROM inventory_operations WHERE created_by=?) AS inventory`,
    [userId, userId],
  );
  const first = await request(app)
    .get(`${url}&page=1&pageSize=2`)
    .set("Cookie", adminCookie)
    .expect(200);
  assert.equal(first.headers["cache-control"], "private, no-store");
  assert.equal(first.body.period.timeZone, "America/Bogota");
  assert.equal(first.body.criteria.currency, "COP");
  assert.match(first.body.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(
    first.body.criteria.returnEquivalentMeaning,
    /No representa necesariamente/,
  );
  assert.match(
    first.body.criteria.referenceBalanceMeaning,
    /no es un resultado contable/,
  );
  assert.equal(
    first.body.summary.referenceCommercialBalance,
    "-19999999999997.85",
  );
  assert.equal(first.body.pagination.total, 4);
  assert.equal(first.body.activities.length, 2);
  assert.ok(
    first.body.activities.every(
      (activity) => typeof activity.sale.id === "string",
    ),
  );
  assert.ok(
    first.body.activities[0].occurredAt >= first.body.activities[1].occurredAt,
  );
  assert.ok(
    first.body.activities.every(
      (activity) => !("customer" in activity) && !("email" in activity),
    ),
  );
  const second = await request(app)
    .get(`${url}&page=2&pageSize=2`)
    .set("Cookie", adminCookie)
    .expect(200);
  assert.deepEqual(second.body.summary, first.body.summary);
  assert.equal(
    new Set(
      [...first.body.activities, ...second.body.activities].map(
        (row) => row.id,
      ),
    ).size,
    4,
  );
  const auditor = await request(app)
    .get(url)
    .set("Cookie", auditorCookie)
    .expect(200);
  assert.equal(auditor.body.summary.grossConfirmed, "12.40");
  const denied = await request(app)
    .get(url)
    .set("Cookie", sellerCookie)
    .expect(403);
  assert.equal(denied.body.error.code, "PERMISSION_DENIED");
  await request(app).get(url).set("Cookie", warehouseCookie).expect(403);
  const missing = await request(app).get(url).expect(401);
  assert.equal(missing.headers["cache-control"], "private, no-store");
  for (const query of [
    `${url}&surprise=1`,
    `${url}&dateTo=2026-02-30`,
    `${url}&page=0`,
    `${url}&pageSize=101`,
    "/api/v1/reports/sales-activity?dateFrom=2026-01-01&dateTo=2026-04-03",
    "/api/v1/reports/sales-activity?dateFrom=2026-01-01&dateTo=2026-01-01&page=502",
  ]) {
    const response = await request(app)
      .get(query)
      .set("Cookie", adminCookie)
      .expect(400);
    assert.ok(response.body.error.code);
  }
  const warehouses = await request(app)
    .get("/api/v1/reports/sales-activity/warehouses")
    .set("Cookie", adminCookie)
    .expect(200);
  assert.deepEqual(warehouses.body.items, [
    {
      id: warehouseId,
      code: `RA-${suffix}`,
      name: `Bodega inactiva ${suffix}`,
      isActive: false,
    },
  ]);
  const searchedWarehouses = await request(app)
    .get(
      `/api/v1/reports/sales-activity/warehouses?q=${encodeURIComponent(suffix)}&page=1&pageSize=1`,
    )
    .set("Cookie", adminCookie)
    .expect(200);
  assert.equal(searchedWarehouses.body.pagination.total, 1);
  assert.equal(searchedWarehouses.body.items[0].id, warehouseId);
  const outsider = await request(app)
    .get(`${url}&warehouseId=18446744073709551615`)
    .set("Cookie", adminCookie)
    .expect(404);
  assert.equal(outsider.body.error.code, "WAREHOUSE_NOT_FOUND");
  const exact92 = await request(app)
    .get(
      "/api/v1/reports/sales-activity?dateFrom=2026-01-01&dateTo=2026-04-02&pageSize=1",
    )
    .set("Cookie", adminCookie)
    .expect(200);
  assert.equal(exact92.body.period.dateTo, "2026-04-02");

  for (const permissionCode of [
    "reports.read",
    "sales.read",
    "warehouses.read",
  ]) {
    const [[grant]] = await pool.execute(
      `SELECT rp.role_id,rp.permission_id,rp.created_at FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code=?`,
      [roleId, permissionCode],
    );
    await pool.execute(
      "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
      [grant.role_id, grant.permission_id],
    );
    try {
      const response = await request(app)
        .get(url)
        .set("Cookie", adminCookie)
        .expect(403);
      assert.equal(response.body.error.code, "PERMISSION_DENIED");
    } finally {
      await pool.execute(
        "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
        [grant.role_id, grant.permission_id, grant.created_at],
      );
    }
  }

  const [[adminSession]] = await pool.execute(
    "SELECT id FROM user_sessions WHERE user_id=? ORDER BY id DESC LIMIT 1",
    [userId],
  );
  await pool.execute(
    "UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?",
    [adminSession.id],
  );
  try {
    await request(app).get(url).set("Cookie", adminCookie).expect(401);
  } finally {
    await pool.execute("UPDATE user_sessions SET revoked_at=NULL WHERE id=?", [
      adminSession.id,
    ]);
  }
  await pool.execute("UPDATE users SET is_active=0 WHERE id=?", [userId]);
  try {
    await request(app).get(url).set("Cookie", adminCookie).expect(401);
  } finally {
    await pool.execute("UPDATE users SET is_active=1 WHERE id=?", [userId]);
  }
  await pool.execute("UPDATE users SET password_change_required=1 WHERE id=?", [
    userId,
  ]);
  try {
    await request(app).get(url).set("Cookie", adminCookie).expect(403);
  } finally {
    await pool.execute(
      "UPDATE users SET password_change_required=0 WHERE id=?",
      [userId],
    );
  }

  await pool.execute("DELETE FROM user_warehouses WHERE user_id=?", [userId]);
  try {
    const empty = await request(app)
      .get(url)
      .set("Cookie", adminCookie)
      .expect(200);
    assert.equal(empty.body.pagination.total, 0);
    assert.equal(empty.body.summary.grossConfirmed, "0.00");
    const emptySelector = await request(app)
      .get("/api/v1/reports/sales-activity/warehouses")
      .set("Cookie", adminCookie)
      .expect(200);
    assert.deepEqual(emptySelector.body.items, []);
  } finally {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [userId, warehouseId],
    );
  }
  const [[afterRead]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM audit_events WHERE user_id=?) AS audit,
            (SELECT COUNT(*) FROM inventory_operations WHERE created_by=?) AS inventory`,
    [userId, userId],
  );
  assert.deepEqual(afterRead, beforeRead);
  for (const [label, query] of [
    [
      "one-day/page-1",
      "dateFrom=2026-01-10&dateTo=2026-01-10&page=1&pageSize=20",
    ],
    [
      "one-day/page-2",
      "dateFrom=2026-01-10&dateTo=2026-01-10&page=2&pageSize=2",
    ],
    [
      "92-day/page-1",
      "dateFrom=2026-01-01&dateTo=2026-04-02&page=1&pageSize=20",
    ],
  ]) {
    const samples = [];
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      await request(app)
        .get(`/api/v1/reports/sales-activity?${query}`)
        .set("Cookie", adminCookie)
        .expect(200);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    assert.ok(samples[9] < 1000, `${label} p95 preliminar debe ser <1s`);
    context.diagnostic(
      `${label}: p50=${samples[4].toFixed(2)}ms p95=${samples[9].toFixed(2)}ms`,
    );
  }
});

test("enforces persisted assignment, inactive warehouse access, current role and permissions", async () => {
  const scoped = await service.summarize({
    auth,
    dateFrom: "2026-01-10",
    dateTo: "2026-01-11",
    warehouseId,
  });
  assert.equal(scoped.summary.grossConfirmed, "12.40");
  await assert.rejects(
    service.summarize({
      auth,
      dateFrom: "2026-01-10",
      dateTo: "2026-01-11",
      warehouseId: "18446744073709551615",
    }),
    (error) => error.status === 404 && error.code === "WAREHOUSE_NOT_FOUND",
  );
  await assert.rejects(
    service.summarize({
      auth: { ...auth, user: { ...auth.user, role: "seller" } },
      dateFrom: "2026-01-10",
      dateTo: "2026-01-11",
    }),
    (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
  );
  const auditor = await service.summarize({
    auth: auditorAuth,
    dateFrom: "2026-01-10",
    dateTo: "2026-01-11",
  });
  assert.equal(auditor.summary.grossConfirmed, "12.40");
  await assert.rejects(
    service.summarize({
      auth: { ...auth, user: { ...auth.user, role: "warehouse" } },
      dateFrom: "2026-01-10",
      dateTo: "2026-01-11",
    }),
    (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
  );
  for (const permissionCode of [
    "reports.read",
    "sales.read",
    "warehouses.read",
  ]) {
    const [[permission]] = await pool.execute(
      `SELECT rp.role_id, rp.permission_id,
              DATE_FORMAT(rp.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
         FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=? AND p.code=?`,
      [roleId, permissionCode],
    );
    assert.ok(permission, `Falta permiso base: ${permissionCode}`);
    await pool.execute(
      "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
      [permission.role_id, permission.permission_id],
    );
    try {
      await assert.rejects(
        service.summarize({
          auth,
          dateFrom: "2026-01-10",
          dateTo: "2026-01-11",
        }),
        (error) => error.status === 403 && error.code === "PERMISSION_DENIED",
      );
    } finally {
      await pool.execute(
        "INSERT INTO role_permissions (role_id,permission_id,created_at) VALUES (?,?,?)",
        [permission.role_id, permission.permission_id, permission.created_at],
      );
    }
  }
  try {
    const noWarehouse = await pool.execute(
      "DELETE FROM user_warehouses WHERE user_id=?",
      [userId],
    );
    assert.equal(noWarehouse[0].affectedRows, 1);
    const empty = await service.summarize({
      auth,
      dateFrom: "2026-01-10",
      dateTo: "2026-01-11",
    });
    assert.deepEqual(empty.summary, {
      grossConfirmed: "0.00",
      cancellations: "0.00",
      returnEquivalent: "0.00",
      referenceCommercialBalance: "0.00",
      quantitiesByUnit: [],
    });
  } finally {
    await pool.execute(
      "INSERT IGNORE INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
      [userId, warehouseId],
    );
  }
});
