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
const password = "Clave-segura-dashboard-2026!";
const limitedRoleCode = `dashboard-reader-${suffix.toLowerCase()}`;
const noDashboardRoleCode = `no-dashboard-${suffix.toLowerCase()}`;
const emails = {
  administrator: `dashboard-admin-${suffix}@sigecom.invalid`,
  seller: `dashboard-seller-${suffix}@sigecom.invalid`,
  auditor: `dashboard-auditor-${suffix}@sigecom.invalid`,
  warehouse: `dashboard-warehouse-${suffix}@sigecom.invalid`,
  limited: `dashboard-limited-${suffix}@sigecom.invalid`,
  noDashboard: `dashboard-denied-${suffix}@sigecom.invalid`,
};

let pool;
let app;
let users = {};
let sessions = {};
let roleIds = {};
let warehouseIds = {};

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
  return login.headers["set-cookie"]
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function getDashboard(session) {
  const result = request(app).get("/api/v1/dashboard");
  return session ? result.set("Cookie", session) : result;
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

  for (const code of ["administrator", "seller", "auditor", "warehouse"]) {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
      code,
    ]);
    roleIds[code] = String(role.id);
  }
  const [[dashboardRead]] = await pool.execute(
    "SELECT id FROM permissions WHERE code = 'dashboard.read'",
  );
  const [[productsRead]] = await pool.execute(
    "SELECT id FROM permissions WHERE code = 'products.read'",
  );
  const [limitedRole] = await pool.execute(
    "INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)",
    [
      limitedRoleCode,
      `Lector de dashboard ${suffix}`,
      "Rol temporal de pruebas.",
    ],
  );
  roleIds.limited = String(limitedRole.insertId);
  const [noDashboardRole] = await pool.execute(
    "INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)",
    [
      noDashboardRoleCode,
      `Sin dashboard ${suffix}`,
      "Rol temporal sin acceso al dashboard.",
    ],
  );
  roleIds.noDashboard = String(noDashboardRole.insertId);
  await pool.execute(
    "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?), (?, ?)",
    [roleIds.limited, dashboardRead.id, roleIds.limited, productsRead.id],
  );

  const passwordHash = await bcrypt.hash(password, 12);
  for (const [roleCode, email] of Object.entries(emails)) {
    const [result] = await pool.execute(
      "INSERT INTO users (role_id, email, password_hash) VALUES (?, ?, ?)",
      [roleIds[roleCode], email, passwordHash],
    );
    users[roleCode] = String(result.insertId);
  }

  const [category] = await pool.execute(
    "INSERT INTO categories (name, description) VALUES (?, ?)",
    [`Dashboard ${suffix}`, "Categoría de prueba para el dashboard."],
  );
  const [inactiveCategory] = await pool.execute(
    "INSERT INTO categories (name, description, is_active) VALUES (?, ?, 0)",
    [`Dashboard inactiva ${suffix}`, "Categoría inactiva de prueba."],
  );
  await pool.execute(
    `INSERT INTO products
      (sku, name, category_id, unit, purchase_price, sale_price, is_active)
     VALUES (?, ?, ?, 'unidad', 100, 150, 1),
            (?, ?, ?, 'unidad', 100, 150, 1),
            (?, ?, ?, 'unidad', 100, 150, 0)`,
    [
      `DASH-${suffix}-1`,
      `Producto activo ${suffix} A`,
      category.insertId,
      `DASH-${suffix}-2`,
      `Producto activo ${suffix} B`,
      category.insertId,
      `DASH-${suffix}-3`,
      `Producto inactivo ${suffix}`,
      inactiveCategory.insertId,
    ],
  );
  await pool.execute(
    "INSERT INTO customers (identification_number, name) VALUES (?, ?)",
    [`DASH-C-${suffix}`, `Cliente dashboard ${suffix}`],
  );
  await pool.execute(
    "INSERT INTO suppliers (identification_number, business_name) VALUES (?, ?)",
    [`DASH-S-${suffix}`, `Proveedor dashboard ${suffix}`],
  );

  for (const [code, label] of [
    ["A", "asignada"],
    ["U", "no asignada"],
  ]) {
    const [warehouse] = await pool.execute(
      "INSERT INTO warehouses (code, name) VALUES (?, ?)",
      [`DASH-${suffix}-${code}`, `Bodega ${label} ${suffix}`],
    );
    warehouseIds[code] = String(warehouse.insertId);
  }
  await pool.execute(
    `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by)
     VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    [
      users.administrator,
      warehouseIds.A,
      users.administrator,
      users.seller,
      warehouseIds.A,
      users.administrator,
      users.warehouse,
      warehouseIds.U,
      users.administrator,
      users.limited,
      warehouseIds.U,
      users.administrator,
    ],
  );

  for (const [roleCode, email] of Object.entries(emails)) {
    sessions[roleCode] = await signIn(email);
  }
});

after(async () => {
  if (!pool) return;
  let cleanupConnection;
  try {
    cleanupConnection = await createConnection({
      host: "127.0.0.1",
      port: 3306,
      user: process.env.XAMPP_ADMIN_USER || "root",
      password: process.env.XAMPP_ADMIN_PASSWORD || "",
      database: "sigecom_test",
    });
    const [[database]] = await cleanupConnection.query(
      "SELECT DATABASE() AS name",
    );
    assert.equal(database.name, "sigecom_test");
    await cleanupConnection.execute("DELETE FROM products WHERE sku LIKE ?", [
      `DASH-${suffix}-%`,
    ]);
    await cleanupConnection.execute(
      "DELETE FROM categories WHERE name LIKE ?",
      [`Dashboard%${suffix}%`],
    );
    await cleanupConnection.execute(
      "DELETE FROM customers WHERE identification_number = ?",
      [`DASH-C-${suffix}`],
    );
    await cleanupConnection.execute(
      "DELETE FROM suppliers WHERE identification_number = ?",
      [`DASH-S-${suffix}`],
    );
    if (warehouseIds.A && warehouseIds.U) {
      await cleanupConnection.execute(
        "DELETE FROM user_warehouses WHERE warehouse_id IN (?, ?)",
        [warehouseIds.A, warehouseIds.U],
      );
      await cleanupConnection.execute(
        "DELETE FROM warehouses WHERE id IN (?, ?)",
        [warehouseIds.A, warehouseIds.U],
      );
    }
    for (const userId of Object.values(users)) {
      await pool.execute(
        `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [userId],
      );
      await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
        userId,
      ]);
    }
    if (users.limited && users.noDashboard) {
      await pool.execute(`UPDATE users SET role_id = ? WHERE id IN (?, ?)`, [
        roleIds.seller,
        users.limited,
        users.noDashboard,
      ]);
    }
    if (roleIds.limited && roleIds.noDashboard) {
      await cleanupConnection.execute(
        "DELETE FROM role_permissions WHERE role_id IN (?, ?)",
        [roleIds.limited, roleIds.noDashboard],
      );
      await cleanupConnection.execute("DELETE FROM roles WHERE id IN (?, ?)", [
        roleIds.limited,
        roleIds.noDashboard,
      ]);
    }
  } catch (error) {
    console.error("Dashboard integration cleanup failed:", error);
    throw error;
  } finally {
    await pool.end();
    await cleanupConnection?.end();
  }
});

test("dashboard returns real authorized counts and category aggregation", async () => {
  const response = await getDashboard(sessions.administrator).expect(200);
  const [[activeProducts]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM products WHERE is_active = 1",
  );
  const [[customers]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM customers",
  );
  const [[suppliers]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM suppliers",
  );
  const [[warehouses]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM user_warehouses WHERE user_id = ?",
    [users.administrator],
  );
  const [[categoryProducts]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM products
     WHERE category_id = (SELECT id FROM categories WHERE name = ?)
       AND is_active = 1`,
    [`Dashboard ${suffix}`],
  );

  assert.deepEqual(response.body.indicators.activeProducts, {
    available: true,
    value: Number(activeProducts.total),
  });
  assert.deepEqual(response.body.indicators.customers, {
    available: true,
    value: Number(customers.total),
  });
  assert.deepEqual(response.body.indicators.suppliers, {
    available: true,
    value: Number(suppliers.total),
  });
  assert.deepEqual(response.body.indicators.accessibleWarehouses, {
    available: true,
    value: Number(warehouses.total),
  });
  assert.equal(response.body.productsByCategory.available, true);
  assert.ok(
    response.body.productsByCategory.items.some(
      (item) =>
        item.categoryName === `Dashboard ${suffix}` &&
        item.activeProducts === Number(categoryProducts.total),
    ),
  );
  assert.ok(
    !Object.hasOwn(response.body, "sales") &&
      !Object.hasOwn(response.body, "purchases") &&
      !Object.hasOwn(response.body, "inventoryValue") &&
      !Object.hasOwn(response.body, "recentActivity"),
  );
});

test("dashboard requires an active authenticated session and dashboard.read", async () => {
  await getDashboard().expect(401);
  await getDashboard(sessions.noDashboard).expect(403);
  await request(app)
    .get("/api/v1/dashboard?unexpected=true")
    .set("Cookie", sessions.administrator)
    .expect(400);
});

test("dashboard metrics are independently unavailable without their module permissions", async () => {
  const response = await getDashboard(sessions.limited).expect(200);
  assert.deepEqual(response.body.indicators.activeProducts, {
    available: true,
    value: Number(
      (
        await pool.execute(
          "SELECT COUNT(*) AS total FROM products WHERE is_active = 1",
        )
      )[0][0].total,
    ),
  });
  assert.deepEqual(response.body.indicators.customers, {
    available: false,
    value: null,
  });
  assert.deepEqual(response.body.indicators.suppliers, {
    available: false,
    value: null,
  });
  assert.deepEqual(response.body.indicators.accessibleWarehouses, {
    available: false,
    value: null,
  });
  assert.deepEqual(response.body.productsByCategory, {
    available: false,
    items: null,
  });
});

test("warehouse counts use explicit assignments for each principal, including administrators", async () => {
  const administrator = await getDashboard(sessions.administrator).expect(200);
  const seller = await getDashboard(sessions.seller).expect(200);
  const warehouse = await getDashboard(sessions.warehouse).expect(200);

  assert.equal(administrator.body.indicators.accessibleWarehouses.value, 1);
  assert.equal(seller.body.indicators.accessibleWarehouses.value, 1);
  assert.equal(warehouse.body.indicators.accessibleWarehouses.value, 1);
  assert.notEqual(warehouseIds.A, warehouseIds.U);
});

test("each module metric requires its own permission independently", async () => {
  const seller = await getDashboard(sessions.seller).expect(200);
  const warehouse = await getDashboard(sessions.warehouse).expect(200);

  assert.equal(seller.body.indicators.activeProducts.available, true);
  assert.equal(seller.body.indicators.customers.available, true);
  assert.equal(seller.body.indicators.suppliers.available, false);
  assert.equal(seller.body.indicators.accessibleWarehouses.available, true);
  assert.equal(seller.body.productsByCategory.available, true);

  assert.equal(warehouse.body.indicators.activeProducts.available, true);
  assert.equal(warehouse.body.indicators.customers.available, false);
  assert.equal(warehouse.body.indicators.suppliers.available, false);
  assert.equal(warehouse.body.indicators.accessibleWarehouses.available, true);
  assert.equal(warehouse.body.productsByCategory.available, true);
});

test("dashboard authorization reloads role permissions and honors revoked sessions", async () => {
  await getDashboard(sessions.limited).expect(200);
  await pool.execute("UPDATE users SET role_id = ? WHERE id = ?", [
    roleIds.noDashboard,
    users.limited,
  ]);
  await getDashboard(sessions.limited).expect(403);

  await pool.execute(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
     WHERE user_id = ? AND revoked_at IS NULL`,
    [users.seller],
  );
  await getDashboard(sessions.seller).expect(401);
});
