import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";
import { getAccountAccessE2EConfig } from "../../scripts/account-access-email-e2e-runner.js";

const origin = "http://127.0.0.1:5173";
const isolatedRun =
  process.env.SIGECOM_ACCOUNT_ACCESS_MODE === "RUN"
    ? getAccountAccessE2EConfig("RUN")
    : null;
const databaseName = isolatedRun?.schema ?? "sigecom_test";
const unique = isolatedRun?.attemptId ?? randomBytes(8).toString("hex");
const adminEmail = `users-admin-${unique}@sigecom.invalid`;
const targetEmail = `users-target-${unique}@sigecom.invalid`;
let pool;
let authConfig;
let adminId;
const fixtures = new IntegrationFixtures({
  suite: "users",
  databaseName,
});
let warehouseId;
let adminPassword;
let app;
let adminCookies;
let secondWarehouseId;
const extraWarehouseIds = [];
let createdUserId;
const extraCreatedUserIds = [];
const capturedAccessMessages = [];
const mailTransport = {
  type: "simulated",
  async send(message, options) {
    capturedAccessMessages.push({ message, options });
    return { accepted: true, simulated: true };
  },
};
const changedTargetPassword = "Changed-Temporary-Password-2026!";

async function csrf(appInstance = app) {
  const response = await request(appInstance)
    .get("/api/v1/auth/csrf")
    .expect(200);
  return {
    cookie: response.headers["set-cookie"]
      .find((value) => value.startsWith("sigecom_csrf="))
      .split(";", 1)[0],
    token: response.body.csrfToken,
  };
}

async function login(email, password, appInstance = app) {
  const token = await csrf(appInstance);
  const response = await request(appInstance)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", token.cookie)
    .set("X-CSRF-Token", token.token)
    .send({ email, password })
    .expect(200);
  return {
    cookies: response.headers["set-cookie"].map(
      (value) => value.split(";", 1)[0],
    ),
    csrfToken: response.body.csrfToken,
  };
}

function api(method, path, body, session = adminCookies) {
  return apiWith(app, method, path, body, session);
}

function apiWith(appInstance, method, path, body, session = adminCookies) {
  const client = request(appInstance);
  const call =
    method === "get"
      ? client.get(path)
      : method === "post"
        ? client.post(path)
        : client.patch(path);
  call.set("Origin", origin).set("Cookie", session.cookies.join("; "));
  if (body !== undefined) {
    call.set("X-CSRF-Token", session.csrfToken).send(body);
  }
  return call;
}

function createFreshApp() {
  return createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
    mailTransport,
  });
}

function latestEmailToken(path) {
  const captured = [...capturedAccessMessages]
    .reverse()
    .find(({ message }) => message.text.includes(path));
  assert.ok(captured, `Expected an email containing ${path}`);
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(captured.message.text);
  assert.ok(match, "Expected an opaque token in the captured test email");
  return match[1];
}

async function completeAccessLink({
  appInstance = app,
  email,
  path,
  endpoint,
  password,
}) {
  const captured = [...capturedAccessMessages]
    .reverse()
    .find(({ message }) => message.text.includes(path));
  assert.ok(captured, `Expected an email containing ${path}`);
  assert.equal(captured.message.to, email);
  const token = latestEmailToken(path);
  const tokenCsrf = await csrf(appInstance);
  return request(appInstance)
    .post(endpoint)
    .set("Origin", origin)
    .set("Cookie", tokenCsrf.cookie)
    .set("X-CSRF-Token", tokenCsrf.token)
    .send({
      token,
      newPassword: password,
      confirmPassword: password,
    })
    .expect(200);
}

function acceptLatestInvitation(email, password, appInstance = app) {
  return completeAccessLink({
    appInstance,
    email,
    path: "/aceptar-invitacion#token=",
    endpoint: "/api/v1/auth/invitations/complete",
    password,
  });
}

function completeLatestAdminReset(email, password, appInstance = app) {
  return completeAccessLink({
    appInstance,
    email,
    path: "/restablecer-contrasena?modo=administrativo#token=",
    endpoint: "/api/v1/auth/admin-password-reset/complete",
    password,
  });
}

before(async () => {
  if (isolatedRun) {
    pool = mysql.createPool({
      host: "127.0.0.1",
      port: 3306,
      database: isolatedRun.schema,
      user: `sgapp_${isolatedRun.runId}`,
      password: isolatedRun.credentials.appPassword,
      charset: "utf8mb4",
      timezone: "Z",
      connectionLimit: 5,
      connectTimeout: 5000,
      multipleStatements: false,
    });
  } else {
    pool = createDatabasePool("test");
  }
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, databaseName);
  authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: `${origin},http://localhost:5173`,
    JWT_TTL_SECONDS: "900",
  });
  app = createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
    mailTransport,
  });

  const [[administrator]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'administrator'",
  );
  const [[warehouseRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'warehouse'",
  );
  const [[warehouse]] = await pool.execute(
    "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1",
  );
  assert.ok(warehouse, "The test database must contain an active warehouse");
  warehouseId = String(warehouse.id);
  const [secondWarehouse] = await pool.execute(
    `INSERT INTO warehouses (code, name, is_active)
     VALUES (?, 'Segunda bodega de prueba de usuarios', 1)`,
    [`USR-${unique.toUpperCase()}`],
  );
  secondWarehouseId = String(secondWarehouse.insertId);
  extraWarehouseIds.push(secondWarehouseId);
  fixtures.warehouse(secondWarehouseId);
  adminPassword = randomBytes(32).toString("base64url");
  const hash = await bcrypt.hash(adminPassword, 12);
  const [created] = await pool.execute(
    `INSERT INTO users (role_id, email, display_name, password_hash, is_active,
                        password_change_required)
     VALUES (?, ?, 'Administrador de prueba 6.1A', ?, 1, 0)`,
    [administrator.id, adminEmail, hash],
  );
  adminId = String(created.insertId);
  fixtures.user(adminId);
  await pool.execute(
    `INSERT INTO user_warehouses (user_id, warehouse_id)
     VALUES (?, ?), (?, ?)`,
    [adminId, warehouseId, adminId, secondWarehouseId],
  );
  // Keep the second role lookup in setup to verify all fixture roles exist.
  assert.ok(warehouseRole);
  adminCookies = await login(adminEmail, adminPassword);
});

after(async () => {
  if (!pool) return;
  try {
    await fixtures.cleanupUserAssignments(pool);
  } finally {
    await pool.end();
  }
});

test("administrator creates an invitation-only account without returning a password", async () => {
  const response = await api("post", "/api/v1/users", {
    email: targetEmail.toUpperCase(),
    displayName: "Cuenta de prueba",
    roleCode: "seller",
    warehouseIds: [warehouseId],
  }).expect(201);

  const { user } = response.body;
  createdUserId = user.id;
  fixtures.user(createdUserId);
  assert.equal(user.email, targetEmail);
  assert.equal(user.roleCode, "seller");
  assert.equal(user.isActive, true);
  assert.equal(user.passwordChangeRequired, true);
  assert.equal(user.credentialState, "pending_invitation");
  assert.equal(response.body.invitation.deliveryStatus, "simulated");
  assert.equal("temporaryPassword" in response.body, false);
  assert.equal("passwordHash" in user, false);
  assert.equal("password_hash" in user, false);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /passwordHash|password_hash/,
  );

  const [[stored]] = await pool.execute(
    "SELECT password_hash, password_change_required, credential_state FROM users WHERE email = ?",
    [targetEmail],
  );
  assert.equal(stored.password_change_required, 1);
  assert.equal(stored.credential_state, "pending_invitation");
  assert.match(stored.password_hash, /^\$2[aby]\$12\$/);
  const invitationToken = latestEmailToken("/aceptar-invitacion#token=");
  assert.equal(
    await bcrypt.compare(invitationToken, stored.password_hash),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(response.body),
    new RegExp(invitationToken),
  );

  const pendingCsrf = await csrf();
  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", pendingCsrf.cookie)
    .set("X-CSRF-Token", pendingCsrf.token)
    .send({ email: targetEmail, password: changedTargetPassword })
    .expect(401);
  await acceptLatestInvitation(targetEmail, changedTargetPassword);
  const signIn = await login(targetEmail, changedTargetPassword);
  await api("get", "/api/v1/users", undefined, signIn).expect(403);
  await request(app)
    .post("/api/v1/auth/logout")
    .set("Origin", origin)
    .set("Cookie", signIn.cookies.join("; "))
    .set("X-CSRF-Token", signIn.csrfToken)
    .expect(204);
});

test("administrator resets an active account by email and revokes previous access", async () => {
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const previousSession = await login(targetEmail, changedTargetPassword);
  const response = await api(
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    { expectedRevision: detail.body.revision, confirmReset: true },
  ).expect(200);

  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.user.passwordChangeRequired, true);
  assert.equal(response.body.user.credentialState, "pending_admin_reset");
  assert.equal(response.body.user.email, targetEmail);
  assert.equal(response.body.deliveryStatus, "simulated");
  assert.equal("temporaryPassword" in response.body, false);
  assert.equal(response.body.revokedSessions, 1);
  const auditSecretCheck = JSON.stringify(response.body);
  assert.doesNotMatch(auditSecretCheck, /password_hash|passwordHash/);
  assert.equal("passwordHash" in response.body.user, false);
  const [[stored]] = await pool.execute(
    "SELECT password_hash, password_change_required, credential_state FROM users WHERE id = ?",
    [createdUserId],
  );
  assert.equal(stored.password_change_required, 1);
  assert.equal(stored.credential_state, "pending_admin_reset");
  assert.match(stored.password_hash, /^\$2[aby]\$12\$/);
  assert.equal(
    await bcrypt.compare(changedTargetPassword, stored.password_hash),
    false,
  );
  const [[resetAudit]] = await pool.execute(
    `SELECT action, details FROM audit_events
     WHERE action = 'users.password_reset_requested' AND entity_id = ?
     ORDER BY id DESC LIMIT 1`,
    [createdUserId],
  );
  assert.equal(resetAudit.action, "users.password_reset_requested");
  assert.deepEqual(JSON.parse(resetAudit.details), {
    revokedSessions: 1,
    passwordChangeRequired: true,
    credentialState: "pending_admin_reset",
  });
  const resetToken = latestEmailToken(
    "/restablecer-contrasena?modo=administrativo#token=",
  );
  assert.equal(resetAudit.details.includes(resetToken), false);

  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", previousSession.cookies.join("; "))
    .expect(401);
  const oldPasswordCsrf = await csrf();
  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", oldPasswordCsrf.cookie)
    .set("X-CSRF-Token", oldPasswordCsrf.token)
    .send({ email: targetEmail, password: changedTargetPassword })
    .expect(401);

  await completeLatestAdminReset(targetEmail, changedTargetPassword);
  await login(targetEmail, changedTargetPassword);
});

test("password reset rolls back credential and session changes when revocation or audit fails", async () => {
  for (const failedStatement of [
    "UPDATE user_sessions SET revoked_at",
    "INSERT INTO audit_events",
  ]) {
    const targetSession = await login(targetEmail, changedTargetPassword);
    const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(
      200,
    );
    const [[before]] = await pool.execute(
      `SELECT password_hash, password_change_required, credential_state,
              (SELECT COUNT(*) FROM user_sessions
               WHERE user_id = users.id AND revoked_at IS NULL) AS active_sessions
       FROM users WHERE id = ?`,
      [createdUserId],
    );
    const faultPool = new Proxy(pool, {
      get(target, property) {
        if (property === "getConnection") {
          return async () => {
            const connection = await target.getConnection();
            return new Proxy(connection, {
              get(inner, method) {
                if (method === "execute") {
                  return async (sql, parameters) => {
                    if (String(sql).includes(failedStatement)) {
                      throw new Error("Injected transactional failure");
                    }
                    return inner.execute.call(inner, sql, parameters);
                  };
                }
                const value = Reflect.get(inner, method, inner);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const faultApp = createApp({
      dbPool: faultPool,
      authConfig,
      logger: createLogger({ level: "silent" }),
      mailTransport,
    });
    const failed = await request(faultApp)
      .post(`/api/v1/users/${createdUserId}/password-reset`)
      .set("Origin", origin)
      .set("Cookie", adminCookies.cookies.join("; "))
      .set("X-CSRF-Token", adminCookies.csrfToken)
      .send({ expectedRevision: detail.body.revision, confirmReset: true })
      .expect(500);
    assert.equal(failed.headers["cache-control"], "no-store");
    const [[afterFailure]] = await pool.execute(
      `SELECT password_hash, password_change_required, credential_state,
              (SELECT COUNT(*) FROM user_sessions
               WHERE user_id = users.id AND revoked_at IS NULL) AS active_sessions
       FROM users WHERE id = ?`,
      [createdUserId],
    );
    assert.equal(afterFailure.password_hash, before.password_hash);
    assert.equal(afterFailure.credential_state, before.credential_state);
    assert.equal(
      Number(afterFailure.password_change_required),
      Number(before.password_change_required),
    );
    assert.equal(
      Number(afterFailure.active_sessions),
      Number(before.active_sessions),
    );
    await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", targetSession.cookies.join("; "))
      .expect(200);
  }
});

test("a concurrent login with the old password cannot create a session surviving a reset", async () => {
  const raceApp = createFreshApp();
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const csrfResponse = await request(raceApp)
    .get("/api/v1/auth/csrf")
    .expect(200);
  const csrfCookie = csrfResponse.headers["set-cookie"]
    .find((cookie) => cookie.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const loginAttempt = request(raceApp)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrfCookie)
    .set("X-CSRF-Token", csrfResponse.body.csrfToken)
    .send({ email: targetEmail, password: changedTargetPassword });
  const resetAttempt = apiWith(
    raceApp,
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    { expectedRevision: detail.body.revision, confirmReset: true },
  );
  const [oldLogin, reset] = await Promise.all([loginAttempt, resetAttempt]);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  if (oldLogin.status === 200) {
    const sessionCookie = oldLogin.headers["set-cookie"]
      .find((cookie) => cookie.startsWith("sigecom_session="))
      .split(";", 1)[0];
    await request(raceApp)
      .get("/api/v1/auth/me")
      .set("Cookie", sessionCookie)
      .expect(401);
  } else {
    assert.equal(oldLogin.status, 401);
    assert.equal(oldLogin.body.error.code, "INVALID_CREDENTIALS");
  }

  await completeLatestAdminReset(targetEmail, changedTargetPassword, raceApp);
  await login(targetEmail, changedTargetPassword, raceApp);
});

test("password reset rejects self-targets and stale credential revisions", async () => {
  const resetApp = createFreshApp();
  const self = await api("get", `/api/v1/users/${adminId}`).expect(200);
  const selfReset = await apiWith(
    resetApp,
    "post",
    `/api/v1/users/${adminId}/password-reset`,
    {
      expectedRevision: self.body.revision,
      confirmReset: true,
    },
  ).expect(409);
  assert.equal(selfReset.body.error.code, "OWN_PASSWORD_RESET_DENIED");

  const current = await api("get", `/api/v1/users/${createdUserId}`).expect(
    200,
  );
  const [[original]] = await pool.execute(
    "SELECT password_hash FROM users WHERE id = ?",
    [createdUserId],
  );
  const oldHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 12);
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
    oldHash,
    createdUserId,
  ]);
  const afterCredentialChange = await api(
    "get",
    `/api/v1/users/${createdUserId}`,
  ).expect(200);
  assert.notEqual(afterCredentialChange.body.revision, current.body.revision);
  const stale = await apiWith(
    resetApp,
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    {
      expectedRevision: current.body.revision,
      confirmReset: true,
    },
  ).expect(409);
  assert.equal(stale.body.error.code, "USER_REVISION_CONFLICT");
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
    original.password_hash,
    createdUserId,
  ]);
});

test("an invitation-pending account can receive a replacement invitation", async () => {
  const resetApp = createFreshApp();
  const created = await api("post", "/api/v1/users", {
    email: `users-pending-reset-${unique}@sigecom.invalid`,
    displayName: "Cuenta con invitación pendiente",
    roleCode: "seller",
    warehouseIds: [warehouseId],
  }).expect(201);
  extraCreatedUserIds.push(created.body.user.id);
  fixtures.user(created.body.user.id);
  const detail = await api(
    "get",
    `/api/v1/users/${created.body.user.id}`,
  ).expect(200);
  assert.equal(detail.body.credentialState, "pending_invitation");
  const invitation = await apiWith(
    resetApp,
    "post",
    `/api/v1/users/${created.body.user.id}/invitation/resend`,
    { expectedRevision: detail.body.revision, confirmResend: true },
  ).expect(200);
  assert.equal(invitation.body.user.credentialState, "pending_invitation");
  assert.equal(invitation.body.invitation.deliveryStatus, "simulated");
  assert.equal("temporaryPassword" in created.body, false);

  const oldCsrf = await csrf();
  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", oldCsrf.cookie)
    .set("X-CSRF-Token", oldCsrf.token)
    .send({
      email: created.body.user.email,
      password: "Not-A-Valid-Password-2026!",
    })
    .expect(401);
  await acceptLatestInvitation(created.body.user.email, "Invited-User-2026!");
  const current = await login(created.body.user.email, "Invited-User-2026!");
  await api("get", "/api/v1/users", undefined, current).expect(403);
});

test("password reset strictly validates confirmation and rejects inactive accounts", async () => {
  const resetApp = createFreshApp();
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const csrfDenied = await request(app)
    .post(`/api/v1/users/${createdUserId}/password-reset`)
    .set("Origin", origin)
    .set("Cookie", adminCookies.cookies.join("; "))
    .send({ expectedRevision: detail.body.revision, confirmReset: true })
    .expect(403);
  assert.equal(csrfDenied.headers["cache-control"], "no-store");
  const unsafe = await apiWith(
    resetApp,
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    {
      expectedRevision: detail.body.revision,
      confirmReset: true,
      password: "not-allowed",
    },
  ).expect(400);
  assert.equal(unsafe.body.error.code, "INVALID_REQUEST");
  await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
    createdUserId,
  ]);
  try {
    const inactiveDetail = await api(
      "get",
      `/api/v1/users/${createdUserId}`,
    ).expect(200);
    const response = await apiWith(
      resetApp,
      "post",
      `/api/v1/users/${createdUserId}/password-reset`,
      {
        expectedRevision: inactiveDetail.body.revision,
        confirmReset: true,
      },
    ).expect(409);
    assert.equal(
      response.body.error.code,
      "INACTIVE_USER_PASSWORD_RESET_DENIED",
    );
  } finally {
    await pool.execute("UPDATE users SET is_active = 1 WHERE id = ?", [
      createdUserId,
    ]);
  }
});

test("password reset rate limit applies ten attempts per administrator in fifteen minutes", async () => {
  const limitedApp = createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
    mailTransport,
  });
  const responses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    responses.push(
      await request(limitedApp)
        .post("/api/v1/users/18446744073709551615/password-reset")
        .set("Origin", origin)
        .set("Cookie", adminCookies.cookies.join("; "))
        .set("X-CSRF-Token", adminCookies.csrfToken)
        .send({
          expectedRevision: "revision-01234567890123456789",
          confirmReset: true,
        }),
    );
  }
  assert.deepEqual(
    responses.map((response) => response.status),
    [...Array(10).fill(404), 429],
  );
  assert.equal(responses.at(-1).body.error.code, "PASSWORD_RESET_RATE_LIMITED");
  assert.ok(responses.at(-1).body.error.requestId);
});

test("mutual administrator password resets serialize and cannot invalidate the surviving operator", async () => {
  const resetApp = createFreshApp();
  const admins = [];
  const sessions = [];
  const initialPasswords = [];
  for (const suffix of ["left", "right"]) {
    const created = await api("post", "/api/v1/users", {
      email: `users-reset-${suffix}-${unique}@sigecom.invalid`,
      displayName: `Administrador ${suffix}`,
      roleCode: "administrator",
      warehouseIds: [warehouseId],
    }).expect(201);
    admins.push(created.body.user.id);
    extraCreatedUserIds.push(created.body.user.id);
    fixtures.user(created.body.user.id);
    const initialPassword = `Initial-Admin-${suffix}-2026!`;
    await acceptLatestInvitation(
      `users-reset-${suffix}-${unique}@sigecom.invalid`,
      initialPassword,
    );
    initialPasswords.push(initialPassword);
  }
  for (let index = 0; index < admins.length; index += 1) {
    const email = `users-reset-${index === 0 ? "left" : "right"}-${unique}@sigecom.invalid`;
    sessions.push(await login(email, initialPasswords[index]));
  }
  const details = await Promise.all(
    admins.map((id) => api("get", `/api/v1/users/${id}`)),
  );
  assert.ok(details.every((response) => response.status === 200));
  const reset = (targetIndex, actorSession) => {
    const call = request(resetApp)
      .post(`/api/v1/users/${admins[targetIndex]}/password-reset`)
      .set("Origin", origin)
      .set("Cookie", actorSession.cookies.join("; "))
      .set("X-CSRF-Token", actorSession.csrfToken)
      .send({
        expectedRevision: details[targetIndex].body.revision,
        confirmReset: true,
      });
    return call;
  };
  const outcomes = await Promise.all([
    reset(1, sessions[0]),
    reset(0, sessions[1]),
  ]);
  assert.equal(
    outcomes.filter((response) => response.status === 200).length,
    1,
  );
  assert.ok(
    outcomes.every((response) =>
      [200, 401, 403, 409].includes(response.status),
    ),
  );
  const [[operators]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM users
     WHERE role_id = (SELECT id FROM roles WHERE code = 'administrator')
       AND is_active = 1 AND password_change_required = 0`,
  );
  assert.ok(Number(operators.total) >= 1);
});

test("a concurrent password reset and normal password change cannot restore a revoked credential", async () => {
  const raceApp = createFreshApp();
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const targetSession = await login(targetEmail, changedTargetPassword);
  const resetRequest = apiWith(
    raceApp,
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    { expectedRevision: detail.body.revision, confirmReset: true },
  );
  const passwordChangeRequest = request(raceApp)
    .post("/api/v1/auth/change-password")
    .set("Origin", origin)
    .set("Cookie", targetSession.cookies.join("; "))
    .set("X-CSRF-Token", targetSession.csrfToken)
    .send({
      currentPassword: changedTargetPassword,
      newPassword: "Concurrent-Definitive-2026!",
      confirmPassword: "Concurrent-Definitive-2026!",
    });
  const [reset, changed] = await Promise.all([
    resetRequest,
    passwordChangeRequest,
  ]);

  if (reset.status === 200) {
    assert.equal(changed.status, 401);
    assert.equal(changed.body.error.code, "SESSION_INVALID");
    await completeLatestAdminReset(targetEmail, changedTargetPassword, raceApp);
    await login(targetEmail, changedTargetPassword, raceApp);
  } else {
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(reset.status, 409, JSON.stringify(reset.body));
    assert.equal(reset.body.error.code, "USER_REVISION_CONFLICT");
    const recoveryDetail = await api(
      "get",
      `/api/v1/users/${createdUserId}`,
    ).expect(200);
    await apiWith(
      raceApp,
      "post",
      `/api/v1/users/${createdUserId}/password-reset`,
      {
        expectedRevision: recoveryDetail.body.revision,
        confirmReset: true,
      },
    ).expect(200);
    await completeLatestAdminReset(targetEmail, changedTargetPassword, raceApp);
    await login(targetEmail, changedTargetPassword, raceApp);
  }
});

test("edits role and warehouse scope incrementally, rejects stale revisions and revokes sessions", async () => {
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  assert.deepEqual(
    detail.body.assignedWarehouses.map((item) => item.id),
    [warehouseId],
  );
  assert.equal(detail.body.canManage, true);
  assert.equal(detail.headers["cache-control"], "no-store");
  const previousSession = await login(targetEmail, changedTargetPassword);

  const updated = await api("patch", `/api/v1/users/${createdUserId}`, {
    expectedRevision: detail.body.revision,
    email: `updated-${targetEmail}`,
    roleCode: "warehouse",
    warehouseChanges: { addIds: [secondWarehouseId], removeIds: [warehouseId] },
  }).expect(200);
  assert.equal(updated.body.roleCode, "warehouse");
  assert.equal(updated.body.email, `updated-${targetEmail}`);
  assert.deepEqual(
    updated.body.assignedWarehouses.map((item) => item.id),
    [secondWarehouseId],
  );
  assert.notEqual(updated.body.revision, detail.body.revision);

  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", previousSession.cookies.join("; "))
    .expect(401);
  const stale = await api("patch", `/api/v1/users/${createdUserId}`, {
    expectedRevision: detail.body.revision,
    displayName: "Edición obsoleta",
  }).expect(409);
  assert.equal(stale.body.error.code, "USER_REVISION_CONFLICT");

  const [[audit]] = await pool.execute(
    `SELECT details FROM audit_events
     WHERE module = 'users' AND entity_type = 'user' AND entity_id = ?
     ORDER BY id DESC LIMIT 1`,
    [createdUserId],
  );
  assert.deepEqual(JSON.parse(audit.details).addedWarehouseIds, [
    secondWarehouseId,
  ]);
  assert.equal(
    JSON.stringify(audit.details).includes(changedTargetPassword),
    false,
  );
});

test("status changes require a current revision and account activation requires an active warehouse", async () => {
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const inactive = await api("patch", `/api/v1/users/${createdUserId}/status`, {
    expectedRevision: detail.body.revision,
    isActive: false,
  }).expect(200);
  assert.equal(inactive.body.isActive, false);
  const changed = await api("patch", `/api/v1/users/${createdUserId}/status`, {
    expectedRevision: inactive.body.revision,
    isActive: true,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.isActive, true);
});

test("does not allow removing the last active warehouse from an active account", async () => {
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  const response = await api("patch", `/api/v1/users/${createdUserId}`, {
    expectedRevision: detail.body.revision,
    warehouseChanges: { addIds: [], removeIds: [secondWarehouseId] },
  }).expect(409);
  assert.equal(response.body.error.code, "ACTIVE_USER_REQUIRES_WAREHOUSE");
});

test("hides out-of-scope warehouse details and blocks all edits to that account", async () => {
  const [createdWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name, is_active) VALUES (?, 'Bodega fuera de alcance', 1)",
    [`OUT-${unique.toUpperCase()}`],
  );
  const outOfScopeWarehouseId = String(createdWarehouse.insertId);
  extraWarehouseIds.push(outOfScopeWarehouseId);
  fixtures.warehouse(outOfScopeWarehouseId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [createdUserId, outOfScopeWarehouseId],
  );
  const detail = await api("get", `/api/v1/users/${createdUserId}`).expect(200);
  assert.equal(detail.body.hasOutOfScopeWarehouses, true);
  assert.equal(detail.body.canManage, false);
  assert.equal(detail.body.warehouseCount, 2);
  assert.deepEqual(
    detail.body.assignedWarehouses.map((warehouse) => warehouse.id),
    [secondWarehouseId],
  );
  assert.equal(
    JSON.stringify(detail.body).includes("Bodega fuera de alcance"),
    false,
  );
  const denied = await api("patch", `/api/v1/users/${createdUserId}`, {
    expectedRevision: detail.body.revision,
    displayName: "Cambio fuera de alcance",
  }).expect(403);
  assert.equal(denied.body.error.code, "USER_WAREHOUSE_SCOPE_REQUIRED");
  const resetDenied = await apiWith(
    createFreshApp(),
    "post",
    `/api/v1/users/${createdUserId}/password-reset`,
    {
      expectedRevision: detail.body.revision,
      confirmReset: true,
    },
  ).expect(403);
  assert.equal(resetDenied.body.error.code, "USER_WAREHOUSE_SCOPE_REQUIRED");
});

test("role directory is limited to the four existing roles and filters paginate users", async () => {
  const roles = await api("get", "/api/v1/users/roles").expect(200);
  assert.deepEqual(
    roles.body.items.map((role) => role.code),
    ["administrator", "seller", "warehouse", "auditor"],
  );
  const listing = await api("get", "/api/v1/users")
    .query({
      q: `updated-${targetEmail}`,
      roleCode: "warehouse",
      status: "active",
      page: 1,
      pageSize: 10,
    })
    .expect(200);
  assert.equal(listing.body.pagination.total, 1);
  assert.equal(listing.body.items[0].id, createdUserId);
  assert.equal("passwordHash" in listing.body.items[0], false);
  assert.equal(listing.headers["cache-control"], "no-store");
});

test("creates accounts only with each of the four existing roles and rejects unsafe fields", async () => {
  for (const roleCode of ["administrator", "seller", "warehouse", "auditor"]) {
    const response = await api("post", "/api/v1/users", {
      email: `users-${roleCode}-${unique}@sigecom.invalid`,
      displayName: `Cuenta ${roleCode}`,
      roleCode,
      warehouseIds: [warehouseId],
    }).expect(201);
    extraCreatedUserIds.push(response.body.user.id);
    fixtures.user(response.body.user.id);
    assert.equal(response.body.user.roleCode, roleCode);
    assert.equal(response.body.user.passwordChangeRequired, true);
    const email = `users-${roleCode}-${unique}@sigecom.invalid`;
    const password = `Users-${roleCode}-Password-2026!`;
    await acceptLatestInvitation(email, password);
    const session = await login(email, password);
    const access = await api("get", "/api/v1/users", undefined, session);
    assert.equal(access.status, roleCode === "administrator" ? 200 : 403);
  }

  const invalid = await api("post", "/api/v1/users", {
    email: `unsafe-${unique}@sigecom.invalid`,
    displayName: "No debe crearse",
    roleCode: "seller",
    warehouseIds: [warehouseId],
    passwordHash: "attacker-controlled",
  }).expect(400);
  assert.equal(invalid.body.error.code, "INVALID_REQUEST");

  const duplicate = await api("post", "/api/v1/users", {
    email: `updated-${targetEmail}`,
    displayName: "Duplicada",
    roleCode: "seller",
    warehouseIds: [warehouseId],
  }).expect(409);
  assert.equal(duplicate.body.error.code, "USER_EMAIL_TAKEN");
});

test("rejects warehouse assignments outside the actor scope or to inactive warehouses", async () => {
  const [createdWarehouse] = await pool.execute(
    "INSERT INTO warehouses (code, name, is_active) VALUES (?, 'Bodega no asignada', 1)",
    [`DENY-${unique.toUpperCase()}`],
  );
  const outOfScope = String(createdWarehouse.insertId);
  extraWarehouseIds.push(outOfScope);
  fixtures.warehouse(outOfScope);
  const denied = await api("post", "/api/v1/users", {
    email: `users-denied-scope-${unique}@sigecom.invalid`,
    displayName: "No autorizada",
    roleCode: "seller",
    warehouseIds: [outOfScope],
  }).expect(403);
  assert.equal(denied.body.error.code, "WAREHOUSE_ASSIGNMENT_DENIED");

  await pool.execute("UPDATE warehouses SET is_active = 0 WHERE id = ?", [
    secondWarehouseId,
  ]);
  try {
    const inactive = await api("post", "/api/v1/users", {
      email: `users-inactive-warehouse-${unique}@sigecom.invalid`,
      displayName: "Bodega inactiva",
      roleCode: "seller",
      warehouseIds: [secondWarehouseId],
    }).expect(403);
    assert.equal(inactive.body.error.code, "WAREHOUSE_ASSIGNMENT_DENIED");
  } finally {
    await pool.execute("UPDATE warehouses SET is_active = 1 WHERE id = ?", [
      secondWarehouseId,
    ]);
  }
});

test("prevents self-deactivation and self-role changes", async () => {
  const detail = await api("get", `/api/v1/users/${adminId}`).expect(200);
  const deactivate = await api("patch", `/api/v1/users/${adminId}/status`, {
    expectedRevision: detail.body.revision,
    isActive: false,
  }).expect(409);
  assert.equal(deactivate.body.error.code, "OWN_ACCOUNT_DEACTIVATION_DENIED");
  const changeRole = await api("patch", `/api/v1/users/${adminId}`, {
    expectedRevision: detail.body.revision,
    roleCode: "seller",
  }).expect(409);
  assert.equal(changeRole.body.error.code, "OWN_ROLE_CHANGE_DENIED");
});

test("serializes simultaneous administrator offboarding and prevents mutual deactivation", async () => {
  const response = await api("post", "/api/v1/users", {
    email: `users-concurrent-admin-${unique}@sigecom.invalid`,
    displayName: "Administrador concurrente de prueba",
    roleCode: "administrator",
    warehouseIds: [warehouseId],
  }).expect(201);
  const secondAdminId = response.body.user.id;
  extraCreatedUserIds.push(secondAdminId);
  fixtures.user(secondAdminId);
  const initialPassword = "Concurrent-Admin-Changed-2026!";
  const concurrentAdminEmail = `users-concurrent-admin-${unique}@sigecom.invalid`;
  await acceptLatestInvitation(concurrentAdminEmail, initialPassword);
  const secondAdminSession = await login(concurrentAdminEmail, initialPassword);
  const [firstDetails, secondDetails] = await Promise.all([
    api("get", `/api/v1/users/${adminId}`),
    api("get", `/api/v1/users/${secondAdminId}`),
  ]);
  assert.equal(firstDetails.status, 200);
  assert.equal(secondDetails.status, 200);
  const outcomes = await Promise.all([
    api("patch", `/api/v1/users/${secondAdminId}/status`, {
      expectedRevision: secondDetails.body.revision,
      isActive: false,
    }),
    api(
      "patch",
      `/api/v1/users/${adminId}/status`,
      {
        expectedRevision: firstDetails.body.revision,
        isActive: false,
      },
      secondAdminSession,
    ),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === 200).length,
    1,
    JSON.stringify(
      outcomes.map((result) => ({ status: result.status, body: result.body })),
    ),
  );
  assert.ok(
    outcomes.every((result) => [200, 401, 403, 409].includes(result.status)),
    JSON.stringify(
      outcomes.map((result) => ({ status: result.status, body: result.body })),
    ),
  );
  const [[remaining]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM users WHERE id IN (?, ?) AND is_active = 1",
    [adminId, secondAdminId],
  );
  assert.equal(Number(remaining.count), 1);
});

test("user administration requires the administrator role and effective permission", async () => {
  const [[sellerRole]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  const password = randomBytes(32).toString("base64url");
  const hash = await bcrypt.hash(password, 12);
  const [created] = await pool.execute(
    `INSERT INTO users (role_id, email, password_hash, is_active,
                        password_change_required)
     VALUES (?, ?, ?, 1, 0)`,
    [sellerRole.id, `users-authz-seller-${unique}@sigecom.invalid`, hash],
  );
  const sellerId = String(created.insertId);
  fixtures.user(sellerId);
  try {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
      [sellerId, warehouseId],
    );
    const sellerSession = await login(
      `users-authz-seller-${unique}@sigecom.invalid`,
      password,
    );
    await api("get", "/api/v1/users", undefined, sellerSession).expect(403);
    await api(
      "post",
      `/api/v1/users/${adminId}/password-reset`,
      {
        expectedRevision: "valid-but-not-authorized-revision",
        confirmReset: true,
      },
      sellerSession,
    ).expect(403);
  } finally {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [sellerId],
    );
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
      sellerId,
    ]);
    await pool.execute("DELETE FROM user_warehouses WHERE user_id = ?", [
      sellerId,
    ]);
  }
});
