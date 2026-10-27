import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";
const suffix = randomBytes(6).toString("hex").toUpperCase();
const password = "Clave-segura-para-productos-2026!";
const emails = {
  administrator: `products-admin-${suffix}@sigecom.invalid`,
  seller: `products-seller-${suffix}@sigecom.invalid`,
  unassigned: `products-unassigned-${suffix}@sigecom.invalid`,
};

let pool;
let app;
let userIds = {};
let adminSession;
let sellerSession;
let unassignedSession;
let categoryId;
let warehouseId;

async function signIn(email) {
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const csrfCookie = csrf.headers["set-cookie"].find((cookie) =>
    cookie.startsWith("sigecom_csrf="),
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
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
    csrfToken: login.body.csrfToken,
  };
}

function get(path, session = adminSession) {
  return request(app).get(path).set("Cookie", session.cookie);
}

function mutate(method, path, body, session = adminSession) {
  const apiRequest = request(app);
  return apiRequest[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken)
    .send(body);
}

function productInput(overrides = {}) {
  return {
    sku: ` SKU-${suffix} `,
    name: `Producto de prueba ${suffix}`,
    description: "Registro controlado de integración",
    categoryId,
    unit: "unidad",
    purchasePrice: "1250.50",
    salePrice: "1800.25",
    minimumSaleQuantity: null,
    minimumSaleEnabled: false,
    minimumStock: 0,
    isActive: true,
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
  const passwordHash = await bcrypt.hash(password, 12);
  for (const [key, email] of Object.entries(emails)) {
    const roleCode = key === "administrator" ? "administrator" : "seller";
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      roleCode,
    ]);
    const [result] = await pool.execute(
      `INSERT INTO users (role_id, email, password_hash)
       VALUES (?, ?, ?)`,
      [role.id, email, passwordHash],
    );
    userIds[key] = String(result.insertId);
  }
  const [category] = await pool.execute(
    "INSERT INTO categories (name, description) VALUES (?, ?)",
    [`Productos ${suffix}`, "Categoría de pruebas"],
  );
  categoryId = String(category.insertId);
  const [warehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name) VALUES (?, ?)",
    [`PRD-${suffix}`, `Bodega productos ${suffix}`],
  );
  warehouseId = String(warehouse.insertId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?), (?, ?)",
    [userIds.seller, warehouseId, userIds.administrator, warehouseId],
  );
  adminSession = await signIn(emails.administrator);
  sellerSession = await signIn(emails.seller);
  unassignedSession = await signIn(emails.unassigned);
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

test("administrator creates, lists, filters and updates products with exact prices", async () => {
  const created = await mutate(
    "post",
    "/api/v1/products",
    productInput(),
  ).expect(201);
  const id = created.body.id;
  assert.equal(created.body.sku, `SKU-${suffix}`);
  assert.equal(created.body.purchasePrice, "1250.50");
  assert.equal(created.body.salePrice, "1800.25");
  assert.equal(created.body.minimumSaleEnabled, false);
  assert.equal(created.body.minimumSaleQuantity, null);
  assert.equal(created.body.unit, "unidad");

  const detail = await get(`/api/v1/products/${id}`).expect(200);
  assert.equal(detail.body.id, id);
  const list = await get(
    `/api/v1/products?q=${suffix}&categoryId=${categoryId}&status=active&page=1&pageSize=1&sortBy=sku&sortOrder=asc`,
  ).expect(200);
  assert.deepEqual(
    list.body.items.map(({ id: itemId }) => itemId),
    [id],
  );
  assert.equal(list.body.pagination.pageSize, 1);

  await mutate(
    "patch",
    `/api/v1/products/${id}`,
    productInput({
      sku: `SKU-${suffix}`,
      name: `Producto editado ${suffix}`,
      purchasePrice: "2000.10",
      salePrice: "3000.99",
      minimumSaleEnabled: true,
      minimumSaleQuantity: 6,
      minimumStock: 4,
    }),
  ).expect(200);
  const stored = await get(`/api/v1/products/${id}`).expect(200);
  assert.equal(stored.body.purchasePrice, "2000.10");
  assert.equal(stored.body.salePrice, "3000.99");
  assert.equal(stored.body.minimumSaleEnabled, true);
  assert.equal(stored.body.minimumSaleQuantity, 6);
  assert.equal(stored.body.minimumStock, 4);

  await mutate(
    "patch",
    `/api/v1/products/${id}`,
    productInput({
      sku: `SKU-${suffix}`,
      name: `Producto editado ${suffix}`,
      purchasePrice: "2000.10",
      salePrice: "3000.99",
      isActive: false,
      minimumSaleEnabled: true,
      minimumSaleQuantity: 6,
      minimumStock: 4,
    }),
  ).expect(200);
  assert.equal(
    (await get(`/api/v1/products/${id}`).expect(200)).body.isActive,
    false,
  );

  const [[audit]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE module = 'products' AND entity_id = ?
       AND action IN ('products.created', 'products.updated', 'products.deactivated')`,
    [id],
  );
  assert.equal(Number(audit.count), 3);
});

test("SKU normalization, category state and quantity/price validation are enforced", async () => {
  const created = await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `DUP-${suffix}` }),
  ).expect(201);
  await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: ` dup-${suffix} ` }),
  ).expect(409);

  const invalidInputs = [
    productInput({ salePrice: "1.001" }),
    productInput({ purchasePrice: "-1.00" }),
    productInput({ minimumSaleEnabled: true, minimumSaleQuantity: 0 }),
    productInput({ minimumSaleEnabled: true, minimumSaleQuantity: 1.5 }),
    productInput({ minimumSaleEnabled: false, minimumSaleQuantity: 5 }),
    productInput({ minimumStock: -1 }),
    productInput({ minimumStock: 1.25 }),
    productInput({ unit: "kilogramo" }),
    productInput({ inventory: [{ warehouseId, quantity: 40 }] }),
  ];
  for (const input of invalidInputs) {
    const response = await mutate("post", "/api/v1/products", input).expect(
      400,
    );
    assert.equal(response.body.error.code, "INVALID_REQUEST");
  }
  const missingCategory = await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `NOCAT-${suffix}`, categoryId: "999999999999" }),
  ).expect(400);
  assert.equal(missingCategory.body.error.code, "INVALID_PRODUCT_CATEGORY");

  const concurrentSku = `RACE-${suffix}`;
  const results = await Promise.all([
    mutate("post", "/api/v1/products", productInput({ sku: concurrentSku })),
    mutate("post", "/api/v1/products", productInput({ sku: concurrentSku })),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);

  const category = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Inactiva ${suffix}`],
  );
  const inactiveCategoryId = String(category[0].insertId);
  await pool.execute("UPDATE categories SET is_active = 0 WHERE id = ?", [
    inactiveCategoryId,
  ]);
  await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `INACT-${suffix}`, categoryId: inactiveCategoryId }),
  ).expect(400);

  await mutate(
    "patch",
    `/api/v1/products/${created.body.id}`,
    productInput({
      sku: `DUP-${suffix}`,
      categoryId: inactiveCategoryId,
      isActive: true,
    }),
  ).expect(400);
});

test("product readers cannot mutate and inventory queries are warehouse-scoped", async () => {
  const product = await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `BAL-${suffix}` }),
  ).expect(201);
  const read = await get(
    `/api/v1/products/${product.body.id}`,
    sellerSession,
  ).expect(200);
  assert.equal(read.body.id, product.body.id);
  await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `DEN-${suffix}` }),
    sellerSession,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/products/${product.body.id}`,
    productInput({ sku: `BAL-${suffix}` }),
    sellerSession,
  ).expect(403);

  const balances = await get(
    `/api/v1/products/${product.body.id}/balances`,
    sellerSession,
  ).expect(200);
  const item = balances.body.items.find(
    ({ warehouseId: id }) => id === warehouseId,
  );
  assert.ok(item);
  assert.equal(item.hasBalance, false);
  assert.equal(item.quantity, null);
  const scopedBalances = await get(
    `/api/v1/inventory/balances?warehouseId=${warehouseId}&q=${encodeURIComponent(`BAL-${suffix}`)}`,
    sellerSession,
  ).expect(200);
  assert.ok(
    scopedBalances.body.items.some(
      ({ productId }) => productId === product.body.id,
    ),
  );
  await get("/api/v1/inventory/movements", sellerSession).expect(403);
  await get(
    `/api/v1/inventory/movements?warehouseId=${warehouseId}`,
    adminSession,
  ).expect(200);
  await get("/api/v1/inventory/operations", adminSession).expect(200);
  await get("/api/v1/inventory/balances?unexpected=true", adminSession).expect(
    400,
  );
  await mutate(
    "post",
    "/api/v1/inventory/initialize",
    {
      productId: product.body.id,
      warehouseId,
      quantity: 1,
      reason: "No debe publicarse",
    },
    adminSession,
  ).expect(404);
  await pool.execute(
    `INSERT INTO inventory_balances (product_id, warehouse_id, quantity)
     VALUES (?, ?, 0)`,
    [product.body.id, warehouseId],
  );
  const registeredZero = await get(
    `/api/v1/products/${product.body.id}/balances?warehouseId=${warehouseId}`,
    sellerSession,
  ).expect(200);
  assert.equal(registeredZero.body.items[0].hasBalance, true);
  assert.equal(registeredZero.body.items[0].quantity, 0);
  await get(
    `/api/v1/products/${product.body.id}/balances?warehouseId=${warehouseId}`,
    unassignedSession,
  ).expect(404);
  await get(
    `/api/v1/products/${product.body.id}/balances?warehouseId=999999999999`,
    sellerSession,
  ).expect(404);
  await get(`/api/v1/products/${product.body.id}/balances`, {
    cookie: "",
  }).expect(401);
});

test("categories with active products cannot be deactivated", async () => {
  const [category] = await pool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`Bloqueo ${suffix}`],
  );
  const activeCategoryId = String(category.insertId);
  const product = await mutate(
    "post",
    "/api/v1/products",
    productInput({ sku: `CAT-${suffix}`, categoryId: activeCategoryId }),
  ).expect(201);
  const blocked = await mutate(
    "patch",
    `/api/v1/categories/${activeCategoryId}/status`,
    { isActive: false },
  ).expect(409);
  assert.equal(blocked.body.error.code, "CATEGORY_HAS_ACTIVE_PRODUCTS");

  await mutate(
    "patch",
    `/api/v1/products/${product.body.id}`,
    productInput({
      sku: `CAT-${suffix}`,
      categoryId: activeCategoryId,
      isActive: false,
    }),
  ).expect(200);
  await mutate("patch", `/api/v1/categories/${activeCategoryId}/status`, {
    isActive: false,
  }).expect(200);
  await mutate("patch", `/api/v1/categories/${activeCategoryId}/status`, {
    isActive: true,
  }).expect(200);
});
