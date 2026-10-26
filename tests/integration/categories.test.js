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
const suffix = randomBytes(6).toString("hex");
const administratorEmail = `categories-admin-${suffix}@sigecom.invalid`;
const sellerEmail = `categories-seller-${suffix}@sigecom.invalid`;
const password = "Clave-segura-para-categorias-2026!";
let pool;
let app;
let userIds = [];
let adminSession;
let sellerSession;

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
  for (const roleCode of ["administrator", "seller"]) {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      roleCode,
    ]);
    const email =
      roleCode === "administrator" ? administratorEmail : sellerEmail;
    const [result] = await pool.execute(
      `INSERT INTO users (role_id, email, password_hash)
       VALUES (?, ?, ?)`,
      [role.id, email, passwordHash],
    );
    userIds.push(result.insertId);
  }
  adminSession = await signIn(administratorEmail);
  sellerSession = await signIn(sellerEmail);
});

after(async () => {
  if (pool) {
    for (const userId of userIds) {
      await pool.execute(
        `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [userId],
      );
      await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
        userId,
      ]);
    }
    await pool.end();
  }
});

test("administrator can create, list, search, update, and deactivate categories", async () => {
  const categoryName = `Línea ${suffix}`;
  const create = await mutate("post", "/api/v1/categories", {
    name: categoryName,
    description: "Clasificación de prueba",
  }).expect(201);
  const categoryId = create.body.id;

  assert.equal(create.body.name, categoryName);
  assert.equal(create.body.description, "Clasificación de prueba");
  assert.equal(create.body.isActive, true);
  assert.ok(create.body.createdAt);
  assert.ok(create.body.updatedAt);

  const detail = await get(`/api/v1/categories/${categoryId}`).expect(200);
  assert.equal(detail.body.id, categoryId);

  const search = await get(
    `/api/v1/categories?q=${encodeURIComponent(suffix)}&status=active&page=1&pageSize=1&sortBy=name&sortOrder=asc`,
  ).expect(200);
  assert.equal(search.body.items.length, 1);
  assert.equal(search.body.items[0].name, categoryName);
  assert.equal(search.body.pagination.pageSize, 1);
  assert.ok(search.body.pagination.total >= 1);

  const update = await mutate("patch", `/api/v1/categories/${categoryId}`, {
    name: `${categoryName} editada`,
    description: null,
  }).expect(200);
  assert.equal(update.body.name, `${categoryName} editada`);
  assert.equal(update.body.description, null);

  await mutate("patch", `/api/v1/categories/${categoryId}`, {
    name: `${categoryName} editada`,
    description: null,
  }).expect(200);

  const deactivate = await mutate(
    "patch",
    `/api/v1/categories/${categoryId}/status`,
    { isActive: false },
  ).expect(200);
  assert.equal(deactivate.body.isActive, false);

  const [[audit]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE module = 'categories' AND entity_id = ?
       AND action IN ('categories.created', 'categories.updated', 'categories.deactivated')`,
    [categoryId],
  );
  assert.equal(Number(audit.count), 3);

  const [[stored]] = await pool.execute(
    "SELECT is_active FROM categories WHERE id = ?",
    [categoryId],
  );
  assert.equal(Number(stored.is_active), 0);

  const wildcardCategory = `10% especial ${suffix}`;
  await mutate("post", "/api/v1/categories", { name: wildcardCategory }).expect(
    201,
  );
  const literalSearch = await get(
    `/api/v1/categories?q=${encodeURIComponent(`10% especial ${suffix}`)}`,
  ).expect(200);
  assert.deepEqual(
    literalSearch.body.items.map(({ name }) => name),
    [wildcardCategory],
  );
});

test("category mutations reject duplicate names and invalid fields", async () => {
  const categoryName = `Única ${suffix}`;
  await mutate("post", "/api/v1/categories", { name: categoryName }).expect(
    201,
  );
  const duplicate = await mutate("post", "/api/v1/categories", {
    name: categoryName.toLocaleUpperCase("es-CO"),
  }).expect(409);
  assert.equal(duplicate.body.error.code, "CATEGORY_NAME_TAKEN");

  const invalid = await mutate("post", "/api/v1/categories", {
    name: "   ",
    extraField: true,
  }).expect(400);
  assert.equal(invalid.body.error.code, "INVALID_REQUEST");

  await mutate("patch", "/api/v1/categories/invalid-id", {
    name: "Otra categoría",
  }).expect(400);
});

test("category permissions protect reads and writes at the API", async () => {
  const sellerList = await get("/api/v1/categories", sellerSession).expect(200);
  assert.ok(Array.isArray(sellerList.body.items));

  const denied = await mutate(
    "post",
    "/api/v1/categories",
    { name: `No autorizada ${suffix}` },
    sellerSession,
  ).expect(403);
  assert.equal(denied.body.error.code, "PERMISSION_DENIED");

  await get("/api/v1/categories", {
    cookie: "",
  }).expect(401);
});

test("category queries reject invalid sort and pagination parameters", async () => {
  await get("/api/v1/categories?sortBy=name%20DESC%3BSELECT").expect(400);
  await get("/api/v1/categories?page=0").expect(400);
  await get("/api/v1/categories?pageSize=101").expect(400);
});

test("PATCH category requests are allowed only from the configured frontend origin", async () => {
  const response = await request(app)
    .options("/api/v1/categories/1")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "PATCH")
    .set("Access-Control-Request-Headers", "content-type,x-csrf-token")
    .expect(204);
  assert.match(response.headers["access-control-allow-methods"], /PATCH/);
  assert.equal(response.headers["access-control-allow-origin"], origin);
});
