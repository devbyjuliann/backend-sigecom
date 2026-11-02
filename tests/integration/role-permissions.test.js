import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";

const origin = "http://127.0.0.1:5173";
const unique = randomBytes(8).toString("hex");
let pool;
let app;
let adminId;
let sellerId;
let adminSession;
let sellerSession;
let sellerRoleId;
let originalAssignments;
let adminRoleId;
let originalAdminAssignments;
let originalRoleMetadata;
let originalAdminMetadata;
let adminPassword;
let sellerPassword;
const fixtures = new IntegrationFixtures({ suite: "role-permissions" });

async function csrf() {
  const response = await request(app).get("/api/v1/auth/csrf").expect(200);
  return {
    cookie: response.headers["set-cookie"]
      .find((value) => value.startsWith("sigecom_csrf="))
      .split(";", 1)[0],
    token: response.body.csrfToken,
  };
}

async function login(email, password) {
  const csrfState = await csrf();
  const response = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrfState.cookie)
    .set("X-CSRF-Token", csrfState.token)
    .send({ email, password })
    .expect(200);
  return {
    cookies: response.headers["set-cookie"].map(
      (value) => value.split(";", 1)[0],
    ),
    csrfToken: response.body.csrfToken,
  };
}

function api(method, path, body, session = adminSession) {
  const requestMethod = request(app)[method];
  const call = requestMethod(path)
    .set("Origin", origin)
    .set("Cookie", session.cookies.join("; "));
  if (body !== undefined)
    call.set("X-CSRF-Token", session.csrfToken).send(body);
  return call;
}

function sessionTokenHash(session) {
  const sessionCookie = session.cookies.find((cookie) =>
    cookie.startsWith("sigecom_session="),
  );
  assert.ok(sessionCookie, "login must issue a session cookie");
  const token = sessionCookie.slice("sigecom_session=".length);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  return createHash("sha256").update(claims.jti).digest("hex");
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    JWT_TTL_SECONDS: "900",
  });
  app = createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });

  const [[adminRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'administrator'",
  );
  const [[targetRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  const [[warehouse]] = await pool.execute(
    "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1",
  );
  assert.ok(warehouse, "sigecom_test necesita una bodega activa");
  sellerRoleId = targetRole.id;
  adminRoleId = adminRole.id;
  const [[activeSharedSessions]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE u.role_id IN (?, ?) AND s.revoked_at IS NULL
       AND s.expires_at > UTC_TIMESTAMP(3)`,
    [sellerRoleId, adminRoleId],
  );
  assert.equal(
    Number(activeSharedSessions.count),
    0,
    "Refusing role-permissions setup while unrelated live role sessions exist",
  );
  const [[sellerMetadata]] = await pool.execute(
    "SELECT code, name, description, is_system, created_at, updated_at FROM roles WHERE id = ?",
    [sellerRoleId],
  );
  const [[adminMetadata]] = await pool.execute(
    "SELECT code, name, description, is_system, created_at, updated_at FROM roles WHERE id = ?",
    [adminRoleId],
  );
  originalRoleMetadata = sellerMetadata;
  originalAdminMetadata = adminMetadata;
  const [adminBaseline] = await pool.execute(
    `SELECT permission_id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM role_permissions WHERE role_id = ? ORDER BY permission_id`,
    [adminRoleId],
  );
  originalAdminAssignments = adminBaseline;
  const [baseline] = await pool.execute(
    `SELECT permission_id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
     FROM role_permissions WHERE role_id = ? ORDER BY permission_id`,
    [sellerRoleId],
  );
  originalAssignments = baseline;

  const allWarehouses = await pool.execute(
    "SELECT id FROM warehouses ORDER BY id",
  );
  adminPassword = randomBytes(32).toString("base64url");
  sellerPassword = randomBytes(32).toString("base64url");
  const [admin] = await pool.execute(
    `INSERT INTO users (role_id, email, display_name, password_hash, is_active, password_change_required)
     VALUES (?, ?, 'Administrador de permisos test', ?, 1, 0)`,
    [
      adminRole.id,
      `roles-admin-${unique}@sigecom.invalid`,
      await bcrypt.hash(adminPassword, 12),
    ],
  );
  adminId = String(admin.insertId);
  fixtures.user(adminId);
  const [seller] = await pool.execute(
    `INSERT INTO users (role_id, email, display_name, password_hash, is_active, password_change_required)
     VALUES (?, ?, 'Vendedor de permisos test', ?, 1, 0)`,
    [
      targetRole.id,
      `roles-seller-${unique}@sigecom.invalid`,
      await bcrypt.hash(sellerPassword, 12),
    ],
  );
  sellerId = String(seller.insertId);
  fixtures.user(sellerId);
  for (const row of allWarehouses[0]) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
      [adminId, row.id],
    );
    fixtures.assignment(adminId, row.id);
  }
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [sellerId, warehouse.id],
  );
  fixtures.assignment(sellerId, warehouse.id);
  adminSession = await login(
    `roles-admin-${unique}@sigecom.invalid`,
    adminPassword,
  );
  sellerSession = await login(
    `roles-seller-${unique}@sigecom.invalid`,
    sellerPassword,
  );
});

after(async () => {
  if (!pool) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [roleId, assignments] of [
      [sellerRoleId, originalAssignments],
      [adminRoleId, originalAdminAssignments],
    ]) {
      if (!roleId || !assignments) continue;
      await connection.execute(
        "DELETE FROM role_permissions WHERE role_id = ?",
        [roleId],
      );
      for (const row of assignments) {
        await connection.execute(
          "INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)",
          [roleId, row.permission_id, row.created_at],
        );
      }
    }
    if (originalRoleMetadata) {
      await connection.execute(
        `UPDATE roles SET code=?, name=?, description=?, is_system=?, created_at=?, updated_at=? WHERE id=?`,
        [...Object.values(originalRoleMetadata), sellerRoleId],
      );
    }
    if (originalAdminMetadata) {
      await connection.execute(
        `UPDATE roles SET code=?, name=?, description=?, is_system=?, created_at=?, updated_at=? WHERE id=?`,
        [...Object.values(originalAdminMetadata), adminRoleId],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  try {
    await fixtures.cleanupUserAssignments(pool);
  } finally {
    await pool.end();
  }
});

test("permission administration lists policy and atomically revokes affected role sessions", async () => {
  const roles = await api("get", "/api/v1/roles").expect(200);
  assert.deepEqual(
    roles.body.items.map((role) => role.code),
    ["administrator", "seller", "warehouse", "auditor"],
  );
  assert.equal(roles.headers["cache-control"], "no-store");

  const catalog = await api("get", "/api/v1/permissions").expect(200);
  assert.equal(catalog.body.items.length, 38);

  const current = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  assert.equal(current.body.permissions.length, 38);
  assert.equal(
    current.body.permissions.find((item) => item.code === "customers.manage")
      .category,
    "configurable",
  );
  assert.equal(
    current.body.permissions.find((item) => item.code === "dashboard.read")
      .category,
    "protected",
  );
  assert.equal(
    current.body.permissions.find((item) => item.code === "inventory.adjust")
      .category,
    "reserved",
  );
  assert.equal(current.body.canEdit, true);

  const selected = current.body.configurablePermissionCodes.filter(
    (code) => code !== "customers.manage",
  );
  const revokedTokenHash = sessionTokenHash(sellerSession);
  const unaffectedTokenHash = sessionTokenHash(adminSession);
  const [[sessionBeforeUpdate]] = await pool.execute(
    "SELECT id, user_id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [revokedTokenHash],
  );
  const [[unaffectedBeforeUpdate]] = await pool.execute(
    "SELECT id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [unaffectedTokenHash],
  );
  assert.equal(String(sessionBeforeUpdate.user_id), sellerId);
  assert.equal(sessionBeforeUpdate.revoked_at, null);
  assert.equal(unaffectedBeforeUpdate.revoked_at, null);
  const [[auditCountBefore]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM audit_events
     WHERE user_id = ? AND action = 'roles.permissions_updated'`,
    [adminId],
  );
  const authenticated = await api(
    "get",
    "/api/v1/auth/me",
    undefined,
    sellerSession,
  ).expect(200);
  assert.match(authenticated.headers["content-type"], /application\/json/);
  assert.equal(authenticated.body.user.id, sellerId);

  const changed = await api("patch", "/api/v1/roles/seller/permissions", {
    expectedRevision: current.body.revision,
    configurablePermissionCodes: selected,
    confirmChange: true,
  }).expect(200);
  assert.deepEqual(changed.body.removedPermissionCodes, ["customers.manage"]);
  assert.equal(changed.body.affectedAccountCount >= 1, true);
  assert.equal(changed.body.revokedSessionCount >= 1, true);
  assert.equal(changed.body.reauthenticationRequired, false);
  const [[auditCountAfter]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM audit_events
     WHERE user_id = ? AND action = 'roles.permissions_updated'`,
    [adminId],
  );
  assert.equal(
    Number(auditCountAfter.total),
    Number(auditCountBefore.total) + 1,
  );
  const [[auditEvent]] = await pool.execute(
    `SELECT details FROM audit_events
     WHERE user_id = ? AND action = 'roles.permissions_updated'
     ORDER BY id DESC LIMIT 1`,
    [adminId],
  );
  const auditDetails = JSON.parse(auditEvent.details);
  assert.equal(auditDetails.roleCode, "seller");
  assert.deepEqual(auditDetails.removedPermissionCodes, ["customers.manage"]);

  const [[sessionAfterUpdate]] = await pool.execute(
    "SELECT id, user_id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [revokedTokenHash],
  );
  assert.equal(String(sessionAfterUpdate.id), String(sessionBeforeUpdate.id));
  assert.equal(String(sessionAfterUpdate.user_id), sellerId);
  assert.ok(sessionAfterUpdate.revoked_at);
  const [[unaffectedAfterUpdate]] = await pool.execute(
    "SELECT id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [unaffectedTokenHash],
  );
  assert.equal(
    String(unaffectedAfterUpdate.id),
    String(unaffectedBeforeUpdate.id),
  );
  assert.equal(unaffectedAfterUpdate.revoked_at, null);
  await api("get", "/api/v1/auth/me", undefined, adminSession).expect(200);

  const revokedMe = await api(
    "get",
    "/api/v1/auth/me",
    undefined,
    sellerSession,
  ).expect(401);
  assert.match(revokedMe.headers["content-type"], /application\/json/);
  assert.equal(revokedMe.body.error.code, "SESSION_INVALID");
  const revokedProtectedRoute = await api(
    "get",
    "/api/v1/suppliers",
    undefined,
    sellerSession,
  ).expect(401);
  assert.match(
    revokedProtectedRoute.headers["content-type"],
    /application\/json/,
  );
  assert.equal(revokedProtectedRoute.body.error.code, "SESSION_INVALID");
  await api("patch", "/api/v1/roles/seller/permissions", {
    expectedRevision: current.body.revision,
    configurablePermissionCodes: selected,
    confirmChange: true,
  }).expect(409);

  const refreshed = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  const restored = await api("patch", "/api/v1/roles/seller/permissions", {
    expectedRevision: refreshed.body.revision,
    configurablePermissionCodes: current.body.configurablePermissionCodes,
    confirmChange: true,
  }).expect(200);
  assert.deepEqual(restored.body.addedPermissionCodes, ["customers.manage"]);
  assert.notEqual(restored.body.revision, current.body.revision);
});

test("audit write failure rolls back permission and session changes", async () => {
  const before = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  sellerSession = await login(
    `roles-seller-${unique}@sigecom.invalid`,
    sellerPassword,
  );
  const tokenHash = sessionTokenHash(sellerSession);
  const [[sessionBefore]] = await pool.execute(
    "SELECT id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [tokenHash],
  );
  assert.equal(sessionBefore.revoked_at, null);
  const [[auditBefore]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM audit_events
     WHERE user_id = ? AND action = 'roles.permissions_updated'`,
    [adminId],
  );

  const originalGetConnection = pool.getConnection;
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    pool,
    "getConnection",
  );
  pool.getConnection = async function getConnectionWithAuditFailure() {
    const connection = await originalGetConnection.call(pool);
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, values) => {
      if (
        typeof sql === "string" &&
        sql.includes("'roles.permissions_updated'")
      ) {
        const error = new Error("Controlled audit failure for rollback test");
        error.code = "TEST_AUDIT_FAILPOINT";
        throw error;
      }
      return execute(sql, values);
    };
    return connection;
  };

  try {
    const response = await api("patch", "/api/v1/roles/seller/permissions", {
      expectedRevision: before.body.revision,
      configurablePermissionCodes:
        before.body.configurablePermissionCodes.filter(
          (code) => code !== "customers.manage",
        ),
      confirmChange: true,
    });
    assert.equal(response.status, 500);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(pool, "getConnection", originalDescriptor);
    } else {
      delete pool.getConnection;
    }
  }

  const after = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  assert.equal(after.body.revision, before.body.revision);
  assert.deepEqual(
    after.body.configurablePermissionCodes,
    before.body.configurablePermissionCodes,
  );
  const [[sessionAfter]] = await pool.execute(
    "SELECT id, revoked_at FROM user_sessions WHERE token_hash = ?",
    [tokenHash],
  );
  assert.equal(String(sessionAfter.id), String(sessionBefore.id));
  assert.equal(sessionAfter.revoked_at, null);
  const [[auditAfter]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM audit_events
     WHERE user_id = ? AND action = 'roles.permissions_updated'`,
    [adminId],
  );
  assert.equal(Number(auditAfter.total), Number(auditBefore.total));
  await api("get", "/api/v1/auth/me", undefined, sellerSession).expect(200);
});

test("concurrent role edits reject the stale revision and restore permissions", async () => {
  const before = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  const [firstCode, secondCode] = ["categories.read", "customers.manage"];
  assert.ok(
    before.body.configurablePermissionCodes.includes(firstCode) &&
      before.body.configurablePermissionCodes.includes(secondCode),
    "The concurrent edit fixtures must start from the captured seller baseline",
  );
  const firstInput = {
    expectedRevision: before.body.revision,
    configurablePermissionCodes: before.body.configurablePermissionCodes.filter(
      (code) => code !== firstCode,
    ),
    confirmChange: true,
  };
  const secondInput = {
    ...firstInput,
    configurablePermissionCodes: before.body.configurablePermissionCodes.filter(
      (code) => code !== secondCode,
    ),
  };

  let responses;
  try {
    responses = await Promise.all([
      api("patch", "/api/v1/roles/seller/permissions", firstInput),
      api("patch", "/api/v1/roles/seller/permissions", secondInput),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
      JSON.stringify(
        responses.map((response) => ({
          status: response.status,
          body: response.body,
        })),
      ),
    );
    const conflict = responses.find((response) => response.status === 409);
    assert.equal(conflict.body.error.code, "ROLE_PERMISSION_REVISION_CONFLICT");
  } finally {
    const current = await api("get", "/api/v1/roles/seller/permissions").expect(
      200,
    );
    if (
      JSON.stringify(current.body.configurablePermissionCodes) !==
      JSON.stringify(before.body.configurablePermissionCodes)
    ) {
      await api("patch", "/api/v1/roles/seller/permissions", {
        expectedRevision: current.body.revision,
        configurablePermissionCodes: before.body.configurablePermissionCodes,
        confirmChange: true,
      }).expect(200);
    }
  }
});

test("permission update rejects protected, reserved, incompatible, duplicate and unknown codes", async () => {
  const current = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  const cases = [
    ["users.read", "ROLE_PERMISSION_INCOMPATIBLE"],
    ["inventory.adjust", "ROLE_PERMISSION_RESERVED"],
    ["purchases.receive", "ROLE_PERMISSION_INCOMPATIBLE"],
    ["not.registered", "ROLE_PERMISSION_UNKNOWN"],
  ];
  for (const [code, expectedCode] of cases) {
    const response = await api("patch", "/api/v1/roles/seller/permissions", {
      expectedRevision: current.body.revision,
      configurablePermissionCodes: [
        ...current.body.configurablePermissionCodes,
        code,
      ],
      confirmChange: true,
    }).expect(400);
    assert.equal(response.body.error.code, expectedCode);
  }
  const duplicate = await api("patch", "/api/v1/roles/seller/permissions", {
    expectedRevision: current.body.revision,
    configurablePermissionCodes: [
      ...current.body.configurablePermissionCodes,
      "customers.read",
      "customers.read",
    ],
    confirmChange: true,
  }).expect(400);
  assert.equal(duplicate.body.error.code, "INVALID_REQUEST");
});

test("editing the administrator role revokes the requester and requires a fresh login", async () => {
  const before = await api(
    "get",
    "/api/v1/roles/administrator/permissions",
  ).expect(200);
  const changedCodes = before.body.configurablePermissionCodes.filter(
    (code) => code !== "profile.update",
  );
  const changed = await api(
    "patch",
    "/api/v1/roles/administrator/permissions",
    {
      expectedRevision: before.body.revision,
      configurablePermissionCodes: changedCodes,
      confirmChange: true,
    },
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.reauthenticationRequired, true);
  assert.ok(changed.body.revokedSessionCount >= 1);
  await api("get", "/api/v1/auth/me").expect(401);

  adminSession = await login(
    `roles-admin-${unique}@sigecom.invalid`,
    adminPassword,
  );
  const current = await api(
    "get",
    "/api/v1/roles/administrator/permissions",
  ).expect(200);
  const restored = await api(
    "patch",
    "/api/v1/roles/administrator/permissions",
    {
      expectedRevision: current.body.revision,
      configurablePermissionCodes: before.body.configurablePermissionCodes,
      confirmChange: true,
    },
  ).expect(200);
  assert.equal(restored.body.reauthenticationRequired, true);
  assert.notEqual(restored.body.revision, before.body.revision);
  await api("get", "/api/v1/auth/me").expect(401);
  adminSession = await login(
    `roles-admin-${unique}@sigecom.invalid`,
    adminPassword,
  );
});

test("administrator essentials cannot be removed and unchanged updates have no side effects", async () => {
  const administrator = await api(
    "get",
    "/api/v1/roles/administrator/permissions",
  ).expect(200);
  const withoutEssential = [
    ...administrator.body.configurablePermissionCodes,
    "users.read",
  ];
  const denied = await api("patch", "/api/v1/roles/administrator/permissions", {
    expectedRevision: administrator.body.revision,
    configurablePermissionCodes: withoutEssential,
    confirmChange: true,
  }).expect(400);
  assert.equal(denied.body.error.code, "ROLE_PERMISSION_INCOMPATIBLE");

  const seller = await api("get", "/api/v1/roles/seller/permissions").expect(
    200,
  );
  assert.ok(
    Array.isArray(seller.body.configurablePermissionCodes),
    JSON.stringify(seller.body),
  );
  const [[beforeAudit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'roles.permissions_updated'",
  );
  const [[beforeSessions]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.role_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3)`,
    [sellerRoleId],
  );
  const noChangeInput = {
    expectedRevision: seller.body.revision,
    configurablePermissionCodes: seller.body.configurablePermissionCodes,
    confirmChange: true,
  };
  const unchanged = await api(
    "patch",
    "/api/v1/roles/seller/permissions",
    noChangeInput,
  );
  assert.equal(
    unchanged.status,
    200,
    JSON.stringify({ body: unchanged.body, input: noChangeInput }),
  );
  assert.equal(unchanged.body.changed, false);
  assert.equal(unchanged.body.revokedSessionCount, 0);
  const [[afterAudit]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'roles.permissions_updated'",
  );
  const [[afterSessions]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.role_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3)`,
    [sellerRoleId],
  );
  assert.equal(Number(afterAudit.total), Number(beforeAudit.total));
  assert.equal(Number(afterSessions.total), Number(beforeSessions.total));
});

test("global role editing blocks when one affected warehouse is outside the actor scope", async () => {
  const [[sellerWarehouse]] = await pool.execute(
    `SELECT uw.warehouse_id FROM user_warehouses uw
     WHERE uw.user_id = ? ORDER BY uw.warehouse_id LIMIT 1`,
    [sellerId],
  );
  assert.ok(sellerWarehouse);
  const [[adminWarehouseAssignment]] = await pool.execute(
    `SELECT assigned_by, created_at FROM user_warehouses
     WHERE user_id = ? AND warehouse_id = ?`,
    [adminId, sellerWarehouse.warehouse_id],
  );
  assert.ok(adminWarehouseAssignment);
  await pool.execute(
    "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [adminId, sellerWarehouse.warehouse_id],
  );
  try {
    const detail = await api("get", "/api/v1/roles/seller/permissions").expect(
      200,
    );
    assert.equal(detail.body.canEdit, false);
    assert.match(detail.body.editBlockedReason, /todas las bodegas/i);
    const response = await api("patch", "/api/v1/roles/seller/permissions", {
      expectedRevision: detail.body.revision,
      configurablePermissionCodes:
        detail.body.configurablePermissionCodes.filter(
          (code) => code !== "customers.manage",
        ),
      confirmChange: true,
    }).expect(403);
    assert.equal(response.body.error.code, "ROLE_WAREHOUSE_SCOPE_REQUIRED");
  } finally {
    await pool.execute(
      `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by, created_at)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       assigned_by = VALUES(assigned_by), created_at = VALUES(created_at)`,
      [
        adminId,
        sellerWarehouse.warehouse_id,
        adminWarehouseAssignment.assigned_by,
        adminWarehouseAssignment.created_at,
      ],
    );
  }
});

test("non-administrator accounts cannot read the role policy endpoints", async () => {
  const password = randomBytes(32).toString("base64url");
  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  const [created] = await pool.execute(
    `INSERT INTO users (role_id, email, display_name, password_hash, is_active, password_change_required)
     VALUES (?, ?, 'Vendedor sin administración de permisos', ?, 1, 0)`,
    [
      role.id,
      `roles-denied-${unique}@sigecom.invalid`,
      await bcrypt.hash(password, 12),
    ],
  );
  const deniedUserId = String(created.insertId);
  fixtures.user(deniedUserId);
  try {
    const [[warehouse]] = await pool.execute(
      "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1",
    );
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
      [deniedUserId, warehouse.id],
    );
    const deniedSession = await login(
      `roles-denied-${unique}@sigecom.invalid`,
      password,
    );
    const response = await api(
      "get",
      "/api/v1/roles",
      undefined,
      deniedSession,
    ).expect(403);
    assert.equal(response.body.error.code, "ADMINISTRATOR_REQUIRED");
  } finally {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [deniedUserId],
    );
    await pool.execute("DELETE FROM user_warehouses WHERE user_id = ?", [
      deniedUserId,
    ]);
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
      deniedUserId,
    ]);
  }
});
