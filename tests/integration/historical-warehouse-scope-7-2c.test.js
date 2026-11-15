import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { getMigrations } from "../../src/db/migrations.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import {
  countOwnedRows,
  deleteOwnedRows,
} from "./historical-warehouse-scope-7-2c-cleanup.js";
import { trackReaderRole } from "./historical-warehouse-scope-7-2c-fixture.js";

const expectedDatabase = "sigecom_h2_concurrency";
const expectedUser = "sigecom_h2_runner";
const lockName = "sigecom_h2_concurrency_scope_7_2c";
const origin = "http://127.0.0.1:5173";
const runId = randomBytes(8).toString("hex").toUpperCase();
const prefix = `H2C7-${runId}`;
const env = process.env;

if (
  env.SIGECOM_H2_DATABASE !== expectedDatabase ||
  env.SIGECOM_H2_USER !== expectedUser ||
  !env.SIGECOM_H2_PASSWORD
) {
  throw new Error(
    "La prueba 7.2C requiere exclusivamente SIGECOM_H2_DATABASE, SIGECOM_H2_USER y SIGECOM_H2_PASSWORD para el esquema y la cuenta restringida aprobados.",
  );
}

const dbPool = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  database: expectedDatabase,
  user: expectedUser,
  password: env.SIGECOM_H2_PASSWORD,
  connectionLimit: 5,
  waitForConnections: true,
  timezone: "Z",
  supportBigNumbers: true,
  bigNumberStrings: true,
});

let lockConnection;
let lockAcquired = false;
let app;
let fixture;
let sessions;
let today;
let adminRoleId;
let readerRoleId;

function cookieFrom(response, name) {
  const cookie = (response.headers["set-cookie"] || []).find((value) =>
    value.startsWith(`${name}=`),
  );
  assert.ok(cookie, `La API no emitió la cookie ${name}.`);
  return cookie.split(";", 1)[0];
}

async function signIn(email, password) {
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const csrfCookie = cookieFrom(csrf, "sigecom_csrf");
  const response = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrfCookie)
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send({ email, password })
    .expect(200);

  return {
    cookie: [
      cookieFrom(response, "sigecom_session"),
      cookieFrom(response, "sigecom_csrf"),
    ].join("; "),
    csrfToken: response.body.csrfToken,
  };
}

function get(path, session) {
  return request(app).get(path).set("Cookie", session.cookie);
}

function mutate(method, path, body, session, key) {
  const api = request(app);
  const operation = api[method](path)
    .set("Origin", origin)
    .set("Cookie", session.cookie)
    .set("X-CSRF-Token", session.csrfToken);
  if (key) operation.set("Idempotency-Key", key);
  return operation.send(body);
}

async function expectTrackedCreation(response, { marker, type, ids }) {
  if (response.status !== 201) {
    const lookup =
      type === "sale"
        ? "SELECT id FROM sales WHERE notes = ?"
        : "SELECT id FROM purchase_orders WHERE reference = ?";
    const [rows] = await dbPool.execute(lookup, [marker]);
    ids.push(...rows.map(({ id }) => String(id)));
  }
  assert.equal(
    response.status,
    201,
    `Falló la creación sintética ${type}; código API: ${response.body?.error?.code || "no disponible"}.`,
  );
  return response;
}

async function assertSafeConnection() {
  lockConnection = await dbPool.getConnection();
  const [[lock]] = await lockConnection.execute(
    "SELECT GET_LOCK(?, 0) AS acquired",
    [lockName],
  );
  lockAcquired = Number(lock.acquired) === 1;
  assert.equal(
    lockAcquired,
    true,
    "Ya hay otra ejecución 7.2C usando el esquema.",
  );

  const [[identity]] = await lockConnection.query(
    `SELECT DATABASE() AS database_name, CURRENT_USER() AS account,
            VERSION() AS version, @@hostname AS hostname, @@port AS port,
            @@session.tx_isolation AS isolation_level`,
  );
  assert.equal(identity.database_name, expectedDatabase);
  assert.equal(identity.account, `${expectedUser}@127.0.0.1`);
  assert.match(identity.version, /^10\.4\.32(?:-|$)/);
  assert.equal(Number(identity.port), 3306);
  assert.equal(
    String(identity.isolation_level).toUpperCase().replaceAll("_", "-"),
    "REPEATABLE-READ",
  );

  const migrations = await getMigrations();
  assert.equal(migrations.length, 17);
  const [applied] = await lockConnection.query(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  assert.equal(applied.length, 17);
  assert.deepEqual(
    applied.map(({ version, name, checksum }) => ({ version, name, checksum })),
    migrations.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    })),
    "Los checksums aplicados deben coincidir exactamente con las migraciones locales.",
  );

  const [grants] = await lockConnection.query("SHOW GRANTS");
  const grantStatements = grants.map((row) => Object.values(row)[0]);
  const effectiveGrants = grantStatements.filter(
    (grant) => !/^GRANT USAGE ON \*\.\*/i.test(grant),
  );
  assert.ok(
    effectiveGrants.length > 0,
    "La cuenta necesita permisos de datos.",
  );
  assert.ok(
    effectiveGrants.every((grant) =>
      /ON `sigecom\\_h2\\_concurrency`\.`?\*`?/i.test(grant),
    ),
    `La cuenta tiene grants fuera del esquema temporal: ${grantStatements.join(" | ")}`,
  );

  const [[globalPrivileges]] = await lockConnection.query(
    `SELECT COUNT(*) AS total FROM information_schema.USER_PRIVILEGES
      WHERE GRANTEE = ? AND PRIVILEGE_TYPE <> 'USAGE'`,
    [`'${expectedUser}'@'127.0.0.1'`],
  );
  assert.equal(
    Number(globalPrivileges.total),
    0,
    "No se admiten privilegios globales.",
  );

  const [[otherSessions]] = await lockConnection.query(
    `SELECT COUNT(*) AS total FROM information_schema.PROCESSLIST
      WHERE USER = ? AND DB = ? AND ID <> CONNECTION_ID()`,
    [expectedUser, expectedDatabase],
  );
  assert.equal(
    Number(otherSessions.total),
    0,
    "Hay sesiones concurrentes de la cuenta H2.",
  );

  const [residues] = await lockConnection.query(
    `SELECT 'users' AS fixture_type, COUNT(*) AS total FROM users
       WHERE email LIKE 'h2-%@sigecom.invalid' OR email LIKE 'h2c7-%@sigecom.invalid'
     UNION ALL SELECT 'warehouses', COUNT(*) FROM warehouses
       WHERE code LIKE 'H2-%' OR code LIKE 'H2C7-%'
     UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers
       WHERE identification_number LIKE 'H2-%' OR identification_number LIKE 'H2C7-%'
     UNION ALL SELECT 'categories', COUNT(*) FROM categories
       WHERE name LIKE 'H2-%' OR name LIKE 'H2C7-%'
     UNION ALL SELECT 'products', COUNT(*) FROM products
       WHERE sku LIKE 'H2-%' OR sku LIKE 'H2C7-%'
     UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders
       WHERE reference LIKE 'H2-%' OR reference LIKE 'H2C7-%'
     UNION ALL SELECT 'sales', COUNT(*) FROM sales
       WHERE commercial_code LIKE 'H2-%' OR notes LIKE 'H2C7-%'`,
  );
  assert.deepEqual(
    residues.filter(({ total }) => Number(total) > 0),
    [],
    "Hay fixtures H2 previas o datos incompatibles; se aborta antes de escribir.",
  );

  const [[collision]] = await lockConnection.execute(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users,
       (SELECT COUNT(*) FROM warehouses WHERE code LIKE ?) AS warehouses,
       (SELECT COUNT(*) FROM purchase_orders WHERE reference LIKE ?) AS purchases,
       (SELECT COUNT(*) FROM sales WHERE notes LIKE ?) AS sales`,
    [`${prefix}-%`, `${prefix}-%`, `${prefix}-%`, `${prefix}-%`],
  );
  assert.deepEqual(
    Object.values(collision).map(Number),
    [0, 0, 0, 0],
    "El prefijo exclusivo de esta ejecución ya existe.",
  );

  console.log(
    "Preflight 7.2C aprobado: destino, cuenta, grants, migraciones y aislamiento verificados.",
  );
}

async function createFixtures() {
  const password = randomBytes(32).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 4);
  fixture = {
    adminId: null,
    userIds: [],
    roleIds: [],
    warehouseIds: [],
    categoryIds: [],
    customerIds: [],
    supplierIds: [],
    productIds: [],
    saleIds: [],
    purchaseIds: [],
  };
  const [[adminRole]] = await dbPool.execute(
    "SELECT id FROM roles WHERE code = 'administrator' LIMIT 1",
  );
  assert.ok(adminRole, "Falta el rol administrador semilla.");
  adminRoleId = String(adminRole.id);

  const roleCode = `h2c7_${runId.toLowerCase()}`;
  const [roleResult] = await dbPool.execute(
    "INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)",
    [
      roleCode,
      `${prefix} lector`,
      "Rol sintético temporal para prueba de alcance 7.2C",
    ],
  );
  readerRoleId = trackReaderRole(fixture, roleResult.insertId);

  const [permissions] = await dbPool.execute(
    `SELECT id, code FROM permissions
      WHERE code IN ('sales.read', 'purchases.read', 'warehouses.read')`,
  );
  assert.equal(permissions.length, 3, "Faltan permisos semilla requeridos.");
  for (const permission of permissions) {
    await dbPool.execute(
      "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
      [readerRoleId, permission.id],
    );
  }

  const [adminResult] = await dbPool.execute(
    `INSERT INTO users
       (role_id, email, display_name, password_hash, is_active, password_change_required)
     VALUES (?, ?, ?, ?, 1, 0)`,
    [
      adminRoleId,
      `${prefix.toLowerCase()}-admin@sigecom.invalid`,
      `${prefix} administrador`,
      passwordHash,
    ],
  );
  const adminId = String(adminResult.insertId);
  fixture.adminId = adminId;
  fixture.userIds.push(adminId);

  const [readerResult] = await dbPool.execute(
    `INSERT INTO users
       (role_id, email, display_name, password_hash, is_active, password_change_required, created_by)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
    [
      readerRoleId,
      `${prefix.toLowerCase()}-reader@sigecom.invalid`,
      `${prefix} lector`,
      passwordHash,
      adminId,
    ],
  );
  const readerId = String(readerResult.insertId);
  fixture.userIds.push(readerId);

  const [warehouseA] = await dbPool.execute(
    "INSERT INTO warehouses (code, name, location, is_active) VALUES (?, ?, ?, 1)",
    [`${prefix}-A`, `${prefix} Bodega A`, "Fixture 7.2C A"],
  );
  const warehouseAId = String(warehouseA.insertId);
  fixture.warehouseIds.push(warehouseAId);
  const [warehouseB] = await dbPool.execute(
    "INSERT INTO warehouses (code, name, location, is_active) VALUES (?, ?, ?, 1)",
    [`${prefix}-B`, `${prefix} Bodega B`, "Fixture 7.2C B"],
  );
  const warehouseBId = String(warehouseB.insertId);
  fixture.warehouseIds.push(warehouseBId);

  for (const warehouseId of [warehouseAId, warehouseBId]) {
    await dbPool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
      [adminId, warehouseId, adminId],
    );
  }
  await dbPool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
    [readerId, warehouseAId, adminId],
  );

  const [category] = await dbPool.execute(
    "INSERT INTO categories (name) VALUES (?)",
    [`${prefix} Categoría`],
  );
  const categoryId = String(category.insertId);
  fixture.categoryIds.push(categoryId);
  const [product] = await dbPool.execute(
    `INSERT INTO products
       (sku, name, category_id, unit, purchase_price, sale_price)
     VALUES (?, ?, ?, 'unidad', '1.00', '2.00')`,
    [`${prefix}-SKU`, `${prefix} Producto`, categoryId],
  );
  const productId = String(product.insertId);
  fixture.productIds.push(productId);
  const [customer] = await dbPool.execute(
    `INSERT INTO customers (identification_number, name)
     VALUES (?, ?)`,
    [`${prefix}-CC`, `${prefix} Cliente`],
  );
  const customerId = String(customer.insertId);
  fixture.customerIds.push(customerId);
  const [supplier] = await dbPool.execute(
    `INSERT INTO suppliers (identification_number, business_name)
     VALUES (?, ?)`,
    [`${prefix}-NIT`, `${prefix} Proveedor`],
  );
  const supplierId = String(supplier.insertId);
  fixture.supplierIds.push(supplierId);

  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    JWT_ISSUER: "sigecom-h2-scope-7-2c-test",
    JWT_AUDIENCE: "sigecom-h2-scope-7-2c-test",
    JWT_TTL_SECONDS: "900",
    FRONTEND_ORIGIN: origin,
    COOKIE_SECURE: "false",
  });
  app = createApp({
    dbPool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });
  sessions = {
    admin: await signIn(
      `${prefix.toLowerCase()}-admin@sigecom.invalid`,
      password,
    ),
    reader: await signIn(
      `${prefix.toLowerCase()}-reader@sigecom.invalid`,
      password,
    ),
  };

  const [[date]] = await dbPool.query(
    "SELECT DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today",
  );
  today = date.today;
  for (const [warehouseId, key] of [
    [warehouseAId, "a"],
    [warehouseBId, "b"],
  ]) {
    const purchaseMarker = `${prefix}-${key}-purchase`;
    const purchaseResponse = await mutate(
      "post",
      "/api/v1/purchase-orders",
      {
        supplierId,
        warehouseId,
        orderDate: today,
        reference: purchaseMarker,
        notes: null,
        lines: [{ productId, quantity: 1, unitCost: "1.00" }],
      },
      sessions.admin,
    );
    const purchase = await expectTrackedCreation(purchaseResponse, {
      marker: purchaseMarker,
      type: "purchase order",
      ids: fixture.purchaseIds,
    });
    fixture.purchaseIds.push(String(purchase.body.id));
    const cancelledPurchase = await mutate(
      "post",
      `/api/v1/purchase-orders/${purchase.body.id}/cancellation`,
      {
        expectedVersion: purchase.body.version,
        reason: `${prefix} prueba histórica`,
      },
      sessions.admin,
    ).expect(200);
    assert.equal(cancelledPurchase.body.status, "cancelled");

    const saleMarker = `${prefix}-${key}-sale`;
    const saleResponse = await mutate(
      "post",
      "/api/v1/sales",
      {
        customerId,
        warehouseId,
        saleDate: today,
        notes: saleMarker,
        lines: [{ productId, quantity: 1, unitPrice: "2.00" }],
      },
      sessions.admin,
      `${prefix}-sale-create-${key}`,
    );
    const sale = await expectTrackedCreation(saleResponse, {
      marker: saleMarker,
      type: "sale",
      ids: fixture.saleIds,
    });
    fixture.saleIds.push(String(sale.body.id));
    const cancelledSale = await mutate(
      "post",
      `/api/v1/sales/${sale.body.id}/cancellation`,
      {
        expectedVersion: sale.body.version,
        reason: `${prefix} prueba histórica`,
      },
      sessions.admin,
      `${prefix}-sale-cancel-${key}`,
    ).expect(200);
    assert.equal(cancelledSale.body.status, "cancelled");
  }

  fixture.readerId = readerId;
  fixture.warehouseAId = warehouseAId;
  fixture.warehouseBId = warehouseBId;
  fixture.productId = productId;
  fixture.customerId = customerId;
  fixture.supplierId = supplierId;
}

async function cleanupFixtures() {
  if (!fixture) return;
  const userIds = fixture.userIds;
  const saleIds = fixture.saleIds;
  const purchaseIds = fixture.purchaseIds;

  const roleIds = fixture.roleIds;
  const productIds = fixture.productIds;
  const customerIds = fixture.customerIds;
  const supplierIds = fixture.supplierIds;
  const categoryIds = fixture.categoryIds;
  const warehouseIds = fixture.warehouseIds;

  for (const [table, column, ids] of [
    ["audit_events", "user_id", userIds],
    ["sale_requests", "actor_id", userIds],
    ["sale_cancellations", "sale_id", saleIds],
    ["sale_lines", "sale_id", saleIds],
    ["sales", "id", saleIds],
    ["purchase_order_lines", "purchase_order_id", purchaseIds],
    ["purchase_orders", "id", purchaseIds],
    ["user_warehouses", "user_id", userIds],
    ["users", "id", userIds],
    ["roles", "id", roleIds],
    ["products", "id", productIds],
    ["customers", "id", customerIds],
    ["suppliers", "id", supplierIds],
    ["categories", "id", categoryIds],
    ["warehouses", "id", warehouseIds],
  ]) {
    await deleteOwnedRows(dbPool, table, column, ids);
  }

  const remaining = {
    users: await countOwnedRows(dbPool, "users", "id", userIds),
    roles: await countOwnedRows(dbPool, "roles", "id", roleIds),
    warehouses: await countOwnedRows(dbPool, "warehouses", "id", warehouseIds),
    categories: await countOwnedRows(dbPool, "categories", "id", categoryIds),
    products: await countOwnedRows(dbPool, "products", "id", productIds),
    customers: await countOwnedRows(dbPool, "customers", "id", customerIds),
    suppliers: await countOwnedRows(dbPool, "suppliers", "id", supplierIds),
    sales: await countOwnedRows(dbPool, "sales", "id", saleIds),
    purchases: await countOwnedRows(
      dbPool,
      "purchase_orders",
      "id",
      purchaseIds,
    ),
    sessions: await countOwnedRows(dbPool, "user_sessions", "user_id", userIds),
    audit: await countOwnedRows(dbPool, "audit_events", "user_id", userIds),
    rolePermissions: await countOwnedRows(
      dbPool,
      "role_permissions",
      "role_id",
      roleIds,
    ),
    saleRequests: await countOwnedRows(
      dbPool,
      "sale_requests",
      "actor_id",
      userIds,
    ),
    saleLines: await countOwnedRows(dbPool, "sale_lines", "sale_id", saleIds),
    saleCancellations: await countOwnedRows(
      dbPool,
      "sale_cancellations",
      "sale_id",
      saleIds,
    ),
    purchaseLines: await countOwnedRows(
      dbPool,
      "purchase_order_lines",
      "purchase_order_id",
      purchaseIds,
    ),
    warehouseAssignments: await countOwnedRows(
      dbPool,
      "user_warehouses",
      "user_id",
      userIds,
    ),
  };
  assert.deepEqual(
    Object.values(remaining),
    Array(Object.keys(remaining).length).fill(0),
    `Quedaron residuos de la ejecución ${prefix}: ${JSON.stringify(remaining)}`,
  );

  const [[prefixedRemainders]] = await dbPool.execute(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE email LIKE ?) AS users,
       (SELECT COUNT(*) FROM warehouses WHERE code LIKE ?) AS warehouses,
       (SELECT COUNT(*) FROM products WHERE sku LIKE ?) AS products,
       (SELECT COUNT(*) FROM purchase_orders WHERE reference LIKE ?) AS purchases,
       (SELECT COUNT(*) FROM sales WHERE notes LIKE ?) AS sales`,
    Array(5).fill(`${prefix}-%`),
  );
  assert.deepEqual(
    Object.values(prefixedRemainders).map(Number),
    [0, 0, 0, 0, 0],
    `Quedaron registros con el prefijo sintético ${prefix}: ${JSON.stringify(prefixedRemainders)}`,
  );
  fixture = undefined;
}

before(async () => {
  await assertSafeConnection();
});

after(async () => {
  try {
    await cleanupFixtures();
  } finally {
    if (lockConnection && lockAcquired) {
      await lockConnection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    }
    lockConnection?.release();
    await dbPool.end();
  }
});

test("7.2C mantiene lecturas históricas autorizadas y separa el alcance operativo", async () => {
  await createFixtures();
  const { admin, reader } = sessions;
  const {
    warehouseAId,
    saleIds,
    purchaseIds,
    readerId,
    readerRoleId: syntheticReaderRoleId,
    productId,
    customerId,
    supplierId,
  } = fixture;
  const [saleA, saleB] = saleIds;
  const [purchaseA, purchaseB] = purchaseIds;

  const activeSales = await get(
    `/api/v1/sales?warehouseId=${warehouseAId}&status=cancelled`,
    admin,
  ).expect(200);
  assert.ok(activeSales.body.items.some((item) => item.id === saleA));
  await get(`/api/v1/sales/${saleA}`, admin).expect(200);
  const activePurchases = await get(
    `/api/v1/purchase-orders?warehouseId=${warehouseAId}&status=cancelled`,
    admin,
  ).expect(200);
  assert.ok(activePurchases.body.items.some((item) => item.id === purchaseA));
  await get(`/api/v1/purchase-orders/${purchaseA}`, admin).expect(200);

  await get(`/api/v1/sales/${saleA}`, reader).expect(200);
  await get(`/api/v1/purchase-orders/${purchaseA}`, reader).expect(200);
  const readerSales = await get(
    `/api/v1/sales?warehouseId=${warehouseAId}&status=cancelled`,
    reader,
  ).expect(200);
  assert.ok(readerSales.body.items.some((item) => item.id === saleA));
  await get(`/api/v1/sales/${saleB}`, reader).expect(404);
  await get(`/api/v1/purchase-orders/${purchaseB}`, reader).expect(404);

  await mutate(
    "patch",
    `/api/v1/warehouses/${warehouseAId}/status`,
    { isActive: false },
    admin,
  ).expect(200);
  const historicalSales = await get(
    `/api/v1/sales?warehouseId=${warehouseAId}&status=cancelled`,
    admin,
  ).expect(200);
  const historicalSale = historicalSales.body.items.find(
    (item) => item.id === saleA,
  );
  assert.ok(historicalSale);
  assert.equal(historicalSale.warehouseIsActive, false);
  await get(`/api/v1/sales/${saleA}`, admin).expect(200);
  const historicalPurchases = await get(
    `/api/v1/purchase-orders?warehouseId=${warehouseAId}&status=cancelled`,
    admin,
  ).expect(200);
  assert.ok(
    historicalPurchases.body.items.some((item) => item.id === purchaseA),
  );
  const historicalPurchase = await get(
    `/api/v1/purchase-orders/${purchaseA}`,
    admin,
  ).expect(200);
  assert.equal(historicalPurchase.body.warehouseIsActive, false);
  await get(`/api/v1/sales/${saleA}`, reader).expect(200);
  await get(`/api/v1/purchase-orders/${purchaseA}`, reader).expect(200);

  await mutate(
    "post",
    "/api/v1/sales",
    {
      customerId,
      warehouseId: warehouseAId,
      saleDate: today,
      notes: `${prefix}-forbidden-sale`,
      lines: [{ productId, quantity: 1, unitPrice: "2.00" }],
    },
    admin,
    `${prefix}-forbidden-sale`,
  ).expect(400);
  await mutate(
    "post",
    "/api/v1/purchase-orders",
    {
      supplierId,
      warehouseId: warehouseAId,
      orderDate: today,
      reference: `${prefix}-forbidden-purchase`,
      notes: null,
      lines: [{ productId, quantity: 1, unitCost: "1.00" }],
    },
    admin,
  ).expect(400);

  await dbPool.execute(
    "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [readerId, warehouseAId],
  );
  await get(`/api/v1/sales/${saleA}`, reader).expect(404);
  await get(`/api/v1/purchase-orders/${purchaseA}`, reader).expect(404);

  const reportQuery = `dateFrom=${today}&dateTo=${today}&warehouseId=${warehouseAId}`;
  const salesReport = await get(
    `/api/v1/reports/sales-activity?${reportQuery}`,
    admin,
  ).expect(200);
  assert.equal(JSON.stringify(salesReport.body).includes(`${prefix}-B`), false);
  const purchaseReport = await get(
    `/api/v1/reports/purchase-orders?mode=period&dateFrom=${today}&dateTo=${today}&warehouseId=${warehouseAId}&situation=cancelled`,
    admin,
  ).expect(200);
  assert.equal(
    JSON.stringify(purchaseReport.body).includes(`${prefix}-B`),
    false,
  );

  await dbPool.execute(
    `DELETE rp FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ? AND p.code IN ('sales.read', 'purchases.read')`,
    [syntheticReaderRoleId],
  );
  await get(`/api/v1/sales/${saleA}`, reader).expect(403);
  await get(`/api/v1/purchase-orders/${purchaseA}`, reader).expect(403);

  const [[ownedDocuments]] = await dbPool.execute(
    `SELECT
       (SELECT COUNT(*) FROM sales WHERE id IN (?, ?)) AS sales,
       (SELECT COUNT(*) FROM purchase_orders WHERE id IN (?, ?)) AS purchases`,
    [saleA, saleB, purchaseA, purchaseB],
  );
  assert.equal(Number(ownedDocuments.sales), 2);
  assert.equal(Number(ownedDocuments.purchases), 2);
  assert.ok(readerId);
});
