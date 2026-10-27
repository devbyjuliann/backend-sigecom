import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import { createConnection } from "mysql2/promise";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getDatabaseConfig } from "../../src/db/config.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";
const suffix = randomBytes(6).toString("hex").toUpperCase();
const password = "Clave-segura-para-bodegas-2026!";
const accounts = {
  administrator: `warehouses-admin-${suffix}@sigecom.invalid`,
  secondAdministrator: `warehouses-admin-second-${suffix}@sigecom.invalid`,
  assignedOperator: `warehouses-assigned-${suffix}@sigecom.invalid`,
  unassignedOperator: `warehouses-unassigned-${suffix}@sigecom.invalid`,
  responsible: `warehouses-responsible-${suffix}@sigecom.invalid`,
};

let pool;
let app;
let userIds = {};
let adminSession;
let assignedOperatorSession;
let unassignedOperatorSession;

async function signIn(email) {
  const csrfResponse = await request(app).get("/api/v1/auth/csrf").expect(200);
  const csrfCookie = csrfResponse.headers["set-cookie"].find((cookie) =>
    cookie.startsWith("sigecom_csrf="),
  );
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrfCookie.split(";", 1)[0])
    .set("X-CSRF-Token", csrfResponse.body.csrfToken)
    .send({ email, password })
    .expect(200);

  return {
    cookie: login.headers["set-cookie"]
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
    csrfToken: login.body.csrfToken,
  };
}

function get(path, session = adminSession) {
  return request(app).get(path).set("Cookie", session.cookie);
}

function mutate(method, path, body, session = adminSession) {
  const testRequest = request(app);
  return testRequest[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken)
    .send(body);
}

function createWarehouse(input, session = adminSession) {
  return mutate("post", "/api/v1/warehouses", input, session);
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");

  const authConfig = getAuthConfig({
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
  for (const [key, email] of Object.entries(accounts)) {
    const roleCode =
      key === "administrator" || key === "secondAdministrator"
        ? "administrator"
        : key === "responsible"
          ? "seller"
          : "warehouse";
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      roleCode,
    ]);
    const [result] = await pool.execute(
      `INSERT INTO users (role_id, email, display_name, password_hash)
       VALUES (?, ?, ?, ?)`,
      [role.id, email, `Prueba ${key} ${suffix}`, passwordHash],
    );
    userIds[key] = String(result.insertId);
  }

  adminSession = await signIn(accounts.administrator);
  assignedOperatorSession = await signIn(accounts.assignedOperator);
  unassignedOperatorSession = await signIn(accounts.unassignedOperator);
});

after(async () => {
  if (!pool) return;
  for (const userId of Object.values(userIds)) {
    await pool.execute(
      `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
       WHERE user_id = ? AND revoked_at IS NULL`,
      [userId],
    );
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [userId]);
  }
  await pool.end();
});

test("administrator creates warehouses with explicit administrator assignments", async () => {
  const input = {
    code: `BOD-${suffix}`,
    name: `Bodega principal ${suffix}`,
    location: "Zona industrial",
    responsibleUserId: userIds.responsible,
  };
  const created = await createWarehouse(input).expect(201);
  const warehouse = created.body;

  assert.equal(warehouse.code, input.code);
  assert.equal(warehouse.name, input.name);
  assert.equal(warehouse.location, input.location);
  assert.equal(warehouse.responsibleUserId, userIds.responsible);
  assert.equal(warehouse.responsibleName, `Prueba responsible ${suffix}`);
  assert.equal(warehouse.isActive, true);
  assert.ok(warehouse.createdAt);
  assert.ok(warehouse.updatedAt);

  const [[assignments]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM user_warehouses
     WHERE warehouse_id = ? AND user_id IN (?, ?, ?)`,
    [
      warehouse.id,
      userIds.administrator,
      userIds.secondAdministrator,
      userIds.responsible,
    ],
  );
  assert.equal(Number(assignments.count), 2);

  const [[creatorAssignment]] = await pool.execute(
    `SELECT assigned_by FROM user_warehouses
     WHERE warehouse_id = ? AND user_id = ?`,
    [warehouse.id, userIds.administrator],
  );
  assert.equal(String(creatorAssignment.assigned_by), userIds.administrator);
  const [[activeAdministratorCount]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'administrator' AND u.is_active = 1`,
  );
  const [[assignedAdministratorCount]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM user_warehouses uw
     JOIN users u ON u.id = uw.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE uw.warehouse_id = ? AND r.code = 'administrator' AND u.is_active = 1`,
    [warehouse.id],
  );
  assert.equal(
    Number(assignedAdministratorCount.count),
    Number(activeAdministratorCount.count),
  );

  const [[audit]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE module = 'warehouses' AND entity_id = ?
       AND action = 'warehouses.created'`,
    [warehouse.id],
  );
  assert.equal(Number(audit.count), 1);

  const [[responsibleAccess]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM user_warehouses
     WHERE warehouse_id = ? AND user_id = ?`,
    [warehouse.id, userIds.responsible],
  );
  assert.equal(Number(responsibleAccess.count), 0);
});

test("assigned warehouse operators are scoped by explicit assignments, not responsible status", async () => {
  const assigned = await createWarehouse({
    code: `ASI-${suffix}`,
    name: `Bodega asignada ${suffix}`,
  }).expect(201);
  const unassigned = await createWarehouse({
    code: `SIN-${suffix}`,
    name: `Bodega sin asignar ${suffix}`,
    responsibleUserId: userIds.assignedOperator,
  }).expect(201);

  await pool.execute(
    `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by)
     VALUES (?, ?, ?)`,
    [userIds.assignedOperator, assigned.body.id, userIds.administrator],
  );

  const visible = await get(
    `/api/v1/warehouses?q=${suffix}&page=1&pageSize=10&status=all`,
    assignedOperatorSession,
  ).expect(200);
  assert.deepEqual(
    visible.body.items.map(({ id }) => id),
    [assigned.body.id],
  );

  await get(
    `/api/v1/warehouses/${assigned.body.id}`,
    assignedOperatorSession,
  ).expect(200);
  await get(
    `/api/v1/warehouses/${unassigned.body.id}`,
    assignedOperatorSession,
  ).expect(404);
  await get(
    `/api/v1/warehouses/${unassigned.body.id}`,
    unassignedOperatorSession,
  ).expect(404);
});

test("warehouse management validates codes, responsible users, filters, and pagination", async () => {
  const existing = await createWarehouse({
    code: `VAL-${suffix}`,
    name: `Bodega de validación ${suffix}`,
  }).expect(201);

  const duplicate = await createWarehouse({
    code: `val-${suffix}`,
    name: "Código duplicado",
  }).expect(409);
  assert.equal(duplicate.body.error.code, "WAREHOUSE_CODE_TAKEN");

  const invalidResponsible = await createWarehouse({
    code: `INV-${suffix}`,
    name: "Responsable inválido",
    responsibleUserId: "999999999999",
  }).expect(400);
  assert.equal(invalidResponsible.body.error.code, "INVALID_RESPONSIBLE_USER");

  await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
    userIds.responsible,
  ]);
  const inactiveResponsible = await createWarehouse({
    code: `IUS-${suffix}`,
    name: "Responsable inactivo",
    responsibleUserId: userIds.responsible,
  }).expect(400);
  assert.equal(inactiveResponsible.body.error.code, "INVALID_RESPONSIBLE_USER");
  await pool.execute("UPDATE users SET is_active = 1 WHERE id = ?", [
    userIds.responsible,
  ]);

  const other = await createWarehouse({
    code: `OTR-${suffix}`,
    name: "Código ocupado para actualizar",
  }).expect(201);
  const duplicateUpdate = await mutate(
    "patch",
    `/api/v1/warehouses/${existing.body.id}`,
    {
      code: other.body.code,
      name: "Actualización duplicada",
      location: null,
      responsibleUserId: null,
    },
  ).expect(409);
  assert.equal(duplicateUpdate.body.error.code, "WAREHOUSE_CODE_TAKEN");

  const invalidPayload = await createWarehouse({
    code: "",
    name: " ",
    isActive: false,
    unexpected: true,
  }).expect(400);
  assert.equal(invalidPayload.body.error.code, "INVALID_REQUEST");

  const filtered = await get(
    `/api/v1/warehouses?q=${suffix}&status=active&page=1&pageSize=2&sortBy=code&sortOrder=desc`,
  ).expect(200);
  assert.ok(filtered.body.items.length <= 2);
  assert.ok(
    filtered.body.items.every(
      ({ code, isActive }) => code.endsWith(suffix) && isActive,
    ),
  );
  assert.equal(filtered.body.pagination.pageSize, 2);
  assert.ok(filtered.body.pagination.total >= 1);

  const firstPage = await get(
    `/api/v1/warehouses?q=${suffix}&status=all&page=1&pageSize=2&sortBy=code&sortOrder=asc`,
  ).expect(200);
  const secondPage = await get(
    `/api/v1/warehouses?q=${suffix}&status=all&page=2&pageSize=2&sortBy=code&sortOrder=asc`,
  ).expect(200);
  assert.equal(firstPage.body.pagination.page, 1);
  assert.equal(secondPage.body.pagination.page, 2);
  assert.equal(firstPage.body.items.length, 2);
  assert.ok(secondPage.body.items.length >= 1);
  assert.ok(
    firstPage.body.items.every(
      ({ id }) => !secondPage.body.items.some((item) => item.id === id),
    ),
  );

  await get("/api/v1/warehouses?sortBy=name%20DESC%3BSELECT").expect(400);
  await get("/api/v1/warehouses?page=0").expect(400);
  await get(`/api/v1/warehouses/${existing.body.id}x`).expect(400);
});

test("assigned administrator can query and reactivate an inactive warehouse", async () => {
  const created = await createWarehouse({
    code: `INA-${suffix}`,
    name: `Bodega reactivable ${suffix}`,
  }).expect(201);
  const warehouseId = created.body.id;

  const deactivated = await mutate(
    "patch",
    `/api/v1/warehouses/${warehouseId}/status`,
    { isActive: false },
  ).expect(200);
  assert.equal(deactivated.body.isActive, false);

  const inactiveDetail = await get(`/api/v1/warehouses/${warehouseId}`).expect(
    200,
  );
  assert.equal(inactiveDetail.body.isActive, false);
  const inactiveList = await get(
    `/api/v1/warehouses/${warehouseId}?status=inactive`,
  ).expect(200);
  assert.equal(inactiveList.body.isActive, false);

  const reactivated = await mutate(
    "patch",
    `/api/v1/warehouses/${warehouseId}/status`,
    { isActive: true },
  ).expect(200);
  assert.equal(reactivated.body.isActive, true);

  const update = await mutate("patch", `/api/v1/warehouses/${warehouseId}`, {
    code: `INA-${suffix}`,
    name: `Bodega reactivable editada ${suffix}`,
    location: "Nueva ubicación",
    responsibleUserId: null,
  }).expect(200);
  assert.equal(update.body.name, `Bodega reactivable editada ${suffix}`);
  assert.equal(update.body.location, "Nueva ubicación");
  assert.equal(update.body.responsibleUserId, null);

  const [[audit]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE module = 'warehouses' AND entity_id = ?`,
    [warehouseId],
  );
  assert.equal(Number(audit.count), 4);
});

test("only administrators may create, edit, or change warehouse status", async () => {
  const created = await createWarehouse({
    code: `SEC-${suffix}`,
    name: `Bodega segura ${suffix}`,
  }).expect(201);

  await createWarehouse(
    { code: `NO-${suffix}`, name: "No autorizada" },
    assignedOperatorSession,
  ).expect(403);

  const editDenied = await mutate(
    "patch",
    `/api/v1/warehouses/${created.body.id}`,
    {
      code: `SEC-${suffix}`,
      name: "Cambio no autorizado",
      location: null,
      responsibleUserId: null,
    },
    assignedOperatorSession,
  ).expect(403);
  assert.equal(editDenied.body.error.code, "PERMISSION_DENIED");

  await mutate(
    "patch",
    `/api/v1/warehouses/${created.body.id}/status`,
    { isActive: false },
    assignedOperatorSession,
  ).expect(403);

  await get("/api/v1/warehouses", { cookie: "" }).expect(401);
});

test("warehouse API gains inventory ledger tables without operational write endpoints", async () => {
  const [tables] = await pool.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = 'sigecom_test'
       AND TABLE_NAME IN ('inventory_balances', 'inventory_movements', 'inventory_operations', 'purchase_orders', 'sales')`,
  );
  assert.deepEqual(
    tables.map(({ TABLE_NAME }) => TABLE_NAME),
    ["inventory_balances", "inventory_movements", "inventory_operations"],
  );
});

test("warehouse with positive stock cannot be deactivated", async () => {
  const created = await createWarehouse({
    code: `STK-${suffix}`,
    name: `Bodega con saldo ${suffix}`,
  }).expect(201);
  const product = await pool.execute(
    `INSERT INTO products
       (sku, name, category_id, unit, purchase_price, sale_price)
     SELECT ?, ?, id, 'unidad', 1.00, 2.00
     FROM categories WHERE is_active = 1 ORDER BY id LIMIT 1`,
    [`STK-${suffix}`, `Producto saldo ${suffix}`],
  );
  const productId = String(product[0].insertId);
  const privileged = await createConnection(
    getDatabaseConfig("test", process.env, "MIGRATOR"),
  );
  try {
    await privileged.execute(
      `INSERT INTO inventory_balances (product_id, warehouse_id, quantity)
       VALUES (?, ?, 7)`,
      [productId, created.body.id],
    );
    const blocked = await mutate(
      "patch",
      `/api/v1/warehouses/${created.body.id}/status`,
      { isActive: false },
    ).expect(409);
    assert.equal(blocked.body.error.code, "WAREHOUSE_HAS_STOCK");

    await privileged.execute(
      `UPDATE inventory_balances SET quantity = 0
       WHERE product_id = ? AND warehouse_id = ?`,
      [productId, created.body.id],
    );
    const zeroStock = await mutate(
      "patch",
      `/api/v1/warehouses/${created.body.id}/status`,
      { isActive: false },
    ).expect(200);
    assert.equal(zeroStock.body.isActive, false);
  } finally {
    await privileged.end();
  }
});
