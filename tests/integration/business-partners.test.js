import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import { createConnection } from "mysql2/promise";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";
const suffix = randomBytes(6).toString("hex").toUpperCase();
const password = "Clave-segura-para-terceros-2026!";
const accounts = {
  administrator: `partners-admin-${suffix}@sigecom.invalid`,
  seller: `partners-seller-${suffix}@sigecom.invalid`,
  auditor: `partners-auditor-${suffix}@sigecom.invalid`,
  warehouse: `partners-warehouse-${suffix}@sigecom.invalid`,
};

let pool;
let app;
let userIds = {};
let sessions = {};

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

function get(path, session) {
  const result = request(app).get(path);
  return session ? result.set("Cookie", session.cookie) : result;
}

function mutate(method, path, body, session = sessions.administrator) {
  const apiRequest = request(app);
  return apiRequest[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken)
    .send(body);
}

function customerInput(overrides = {}) {
  return {
    identificationType: "CC",
    identificationNumber: `CC ${suffix.slice(0, 4)}.${suffix.slice(4)}-7`,
    name: `Cliente de pruebas ${suffix}`,
    phone: "+57 (601) 555-0142 ext. 8",
    email: `cliente-${suffix.toLowerCase()}@example.com`,
    address: "Carrera 10 # 20-30, Bogotá",
    ...overrides,
  };
}

function supplierInput(overrides = {}) {
  return {
    identificationType: "NIT",
    identificationNumber: ` 90.${suffix.slice(0, 4)}-${suffix.slice(4)}-1 `,
    businessName: `Proveedor ${suffix} S.A.S.`,
    contactName: "",
    phone: null,
    email: null,
    address: null,
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
  for (const [roleCode, email] of Object.entries(accounts)) {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      roleCode,
    ]);
    const [result] = await pool.execute(
      "INSERT INTO users (role_id, email, password_hash) VALUES (?, ?, ?)",
      [role.id, email, passwordHash],
    );
    userIds[roleCode] = String(result.insertId);
  }
  for (const [roleCode, email] of Object.entries(accounts)) {
    sessions[roleCode] = await signIn(email);
  }
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

test("seller and administrator manage customers with normalized unique identification and audit", async () => {
  const created = await mutate(
    "post",
    "/api/v1/customers",
    customerInput(),
    sessions.seller,
  ).expect(201);
  const id = created.body.id;
  assert.equal(
    created.body.identificationNumber,
    customerInput().identificationNumber.trim(),
  );
  assert.equal(created.body.name, customerInput().name);
  assert.equal(created.body.email, customerInput().email);
  await mutate(
    "post",
    "/api/v1/customers",
    customerInput({
      identificationNumber: `PAGE-${suffix}`,
      name: `Cliente secundario ${suffix}`,
    }),
    sessions.seller,
  ).expect(201);

  const duplicate = await mutate(
    "post",
    "/api/v1/customers",
    customerInput({
      identificationType: "Pasaporte",
      identificationNumber: `cc${suffix.slice(0, 4)}${suffix.slice(4)}7`,
    }),
    sessions.administrator,
  ).expect(409);
  assert.equal(duplicate.body.error.code, "CUSTOMER_IDENTIFICATION_TAKEN");

  const detail = await get(`/api/v1/customers/${id}`, sessions.auditor).expect(
    200,
  );
  assert.equal(detail.body.id, id);
  const filtered = await get(
    `/api/v1/customers?q=${suffix}&status=active&sortBy=identification&sortOrder=desc&page=1&pageSize=1`,
    sessions.seller,
  ).expect(200);
  assert.equal(filtered.body.items.length, 1);
  assert.equal(filtered.body.pagination.total, 2);
  assert.equal(filtered.body.pagination.pageCount, 2);
  await get("/api/v1/customers?sortBy=unknown", sessions.seller).expect(400);

  const updated = await mutate(
    "patch",
    `/api/v1/customers/${id}`,
    customerInput({
      name: `Cliente actualizado ${suffix}`,
      phone: null,
      email: null,
    }),
    sessions.seller,
  ).expect(200);
  assert.equal(updated.body.phone, null);
  assert.equal(updated.body.email, null);
  assert.equal(updated.body.name, `Cliente actualizado ${suffix}`);

  const [[beforeNoop]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE module = 'customers' AND entity_id = ?",
    [id],
  );
  await mutate(
    "patch",
    `/api/v1/customers/${id}`,
    customerInput({
      name: `Cliente actualizado ${suffix}`,
      phone: null,
      email: null,
    }),
    sessions.seller,
  ).expect(200);
  const [[afterNoop]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE module = 'customers' AND entity_id = ?",
    [id],
  );
  assert.equal(Number(afterNoop.total), Number(beforeNoop.total));

  await mutate(
    "patch",
    `/api/v1/customers/${id}/status`,
    { isActive: false },
    sessions.seller,
  ).expect(200);
  await mutate(
    "patch",
    `/api/v1/customers/${id}/status`,
    { isActive: true },
    sessions.seller,
  ).expect(200);
  await mutate(
    "patch",
    `/api/v1/customers/${id}/status`,
    { isActive: true },
    sessions.seller,
  ).expect(200);
  const [[audit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE module = 'customers' AND entity_id = ?",
    [id],
  );
  assert.equal(Number(audit.total), 4);
});

test("supplier records allow optional contact fields and enforce normalized unique identification", async () => {
  const created = await mutate(
    "post",
    "/api/v1/suppliers",
    supplierInput(),
  ).expect(201);
  const id = created.body.id;
  assert.equal(
    created.body.identificationNumber,
    supplierInput().identificationNumber.trim(),
  );
  assert.equal(created.body.contactName, null);
  assert.equal(created.body.phone, null);
  assert.equal(created.body.email, null);
  assert.equal(created.body.address, null);

  const duplicate = await mutate(
    "post",
    "/api/v1/suppliers",
    supplierInput({
      identificationNumber: `90${suffix.slice(0, 4)}${suffix.slice(4)}1`,
    }),
  ).expect(409);
  assert.equal(duplicate.body.error.code, "SUPPLIER_IDENTIFICATION_TAKEN");

  const updated = await mutate(
    "patch",
    `/api/v1/suppliers/${id}`,
    supplierInput({
      businessName: `Suministros ${suffix}`,
      contactName: "María López",
      phone: "+57 300 555 0101",
      email: `ventas-${suffix.toLowerCase()}@example.com`,
    }),
  ).expect(200);
  assert.equal(updated.body.businessName, `Suministros ${suffix}`);
  assert.equal(updated.body.contactName, "María López");

  const found = await get(
    `/api/v1/suppliers?q=${suffix}&page=1&pageSize=1`,
    sessions.auditor,
  ).expect(200);
  assert.equal(found.body.items[0].id, id);
  await mutate("patch", `/api/v1/suppliers/${id}/status`, {
    isActive: false,
  }).expect(200);
  await mutate("patch", `/api/v1/suppliers/${id}/status`, {
    isActive: true,
  }).expect(200);
});

test("customer and supplier schemas reject invalid input, extra fields and malformed identifiers", async () => {
  const invalidCustomers = [
    customerInput({ name: "   " }),
    customerInput({ identificationNumber: "---..." }),
    customerInput({ email: "correo-invalido" }),
    customerInput({ phone: "teléfono 🚀" }),
    { ...customerInput(), unexpected: "no permitido" },
  ];
  for (const input of invalidCustomers) {
    const response = await mutate("post", "/api/v1/customers", input).expect(
      400,
    );
    assert.equal(response.body.error.code, "INVALID_REQUEST");
  }
  const invalidSuppliers = [
    supplierInput({ businessName: " " }),
    supplierInput({ identificationNumber: "...---" }),
    supplierInput({ email: "no-es-correo" }),
    supplierInput({ contactName: "x".repeat(121) }),
    { ...supplierInput(), productId: "10" },
  ];
  for (const input of invalidSuppliers) {
    const response = await mutate("post", "/api/v1/suppliers", input).expect(
      400,
    );
    assert.equal(response.body.error.code, "INVALID_REQUEST");
  }
  await mutate(
    "post",
    "/api/v1/customers",
    customerInput({ identificationNumber: "\t" }),
  ).expect(400);
  await get("/api/v1/customers/invalid", sessions.seller).expect(400);
  await get("/api/v1/suppliers/invalid", sessions.auditor).expect(400);
});

test("RBAC protects collection, detail and mutations for each partner resource", async () => {
  const customer = await mutate(
    "post",
    "/api/v1/customers",
    customerInput({ identificationNumber: `RBAC-${suffix}` }),
  ).expect(201);
  const supplier = await mutate(
    "post",
    "/api/v1/suppliers",
    supplierInput({ identificationNumber: `RBAC-S-${suffix}` }),
  ).expect(201);

  for (const session of [
    sessions.administrator,
    sessions.seller,
    sessions.auditor,
  ]) {
    await get(`/api/v1/customers/${customer.body.id}`, session).expect(200);
  }
  for (const session of [sessions.administrator, sessions.auditor]) {
    await get(`/api/v1/suppliers/${supplier.body.id}`, session).expect(200);
  }

  await get(`/api/v1/customers/${customer.body.id}`, sessions.warehouse).expect(
    403,
  );
  await get("/api/v1/customers", sessions.warehouse).expect(403);
  await mutate(
    "post",
    "/api/v1/customers",
    customerInput({ identificationNumber: `DENY-C-${suffix}` }),
    sessions.auditor,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/customers/${customer.body.id}`,
    customerInput({ identificationNumber: `RBAC-${suffix}` }),
    sessions.auditor,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/customers/${customer.body.id}/status`,
    { isActive: false },
    sessions.auditor,
  ).expect(403);
  await get(`/api/v1/suppliers/${supplier.body.id}`, sessions.seller).expect(
    403,
  );
  await get("/api/v1/suppliers", sessions.warehouse).expect(403);
  await mutate(
    "post",
    "/api/v1/suppliers",
    supplierInput({ identificationNumber: `DENY-S-${suffix}` }),
    sessions.auditor,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/suppliers/${supplier.body.id}`,
    supplierInput({ identificationNumber: `RBAC-S-${suffix}` }),
    sessions.seller,
  ).expect(403);
  await mutate(
    "patch",
    `/api/v1/suppliers/${supplier.body.id}/status`,
    { isActive: false },
    sessions.auditor,
  ).expect(403);

  await get("/api/v1/customers").expect(401);
  await get("/api/v1/suppliers").expect(401);
  await mutate("post", "/api/v1/customers", customerInput(), {
    cookie: "",
    csrfToken: "",
  }).expect(403);
});

test("mutations require trusted origin and CSRF and audit failures roll back the partner write", async () => {
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  await request(app)
    .post("/api/v1/customers")
    .set("Origin", "https://untrusted.invalid")
    .set("Cookie", `${sessions.administrator.cookie}; ${cookie}`)
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send(customerInput({ identificationNumber: `CSRF-${suffix}` }))
    .expect(403);
  await request(app)
    .post("/api/v1/suppliers")
    .set("Origin", origin)
    .set("Cookie", sessions.administrator.cookie)
    .send(supplierInput({ identificationNumber: `CSRF-S-${suffix}` }))
    .expect(403);

  const privileged = await createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: process.env.XAMPP_ADMIN_USER || "root",
    password: process.env.XAMPP_ADMIN_PASSWORD || "",
    database: "sigecom_test",
  });
  const triggerName = `trg_test_partner_audit_${suffix.toLowerCase()}`;
  const identificationNumber = `ROLLBACK-${suffix}`;
  try {
    await privileged.query(
      `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON audit_events
       FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit failure probe'`,
    );
    await mutate(
      "post",
      "/api/v1/customers",
      customerInput({ identificationNumber }),
    ).expect(500);
    const [[customer]] = await pool.execute(
      "SELECT COUNT(*) AS total FROM customers WHERE identification_number = ?",
      [identificationNumber],
    );
    assert.equal(Number(customer.total), 0);
  } finally {
    await privileged.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
    await privileged.end();
  }
});
