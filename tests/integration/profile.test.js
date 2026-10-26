import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createApp } from "../../src/app.js";
import {
  authenticate,
  requirePermission,
} from "../../src/modules/auth/auth-middleware.js";
import { createErrorHandler } from "../../src/shared/error-handler.js";
import { createLogger } from "../../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";
const ownerEmail = "phase15-owner@sigecom.invalid";
const otherEmail = "phase15-other@sigecom.invalid";
const initialPassword = "Temporal-segura-2026!";
const changedPassword = "Nueva-Clave-segura-2026!";
let pool;
let authConfig;
let app;
let ownerId;
let otherId;

function cookieFrom(response, name) {
  const value = (response.headers["set-cookie"] || []).find((cookie) =>
    cookie.startsWith(`${name}=`),
  );
  assert.ok(value, `Expected ${name} cookie`);
  return value.slice(name.length + 1, value.indexOf(";"));
}

async function csrf() {
  const response = await request(app).get("/api/v1/auth/csrf").expect(200);
  return {
    cookie: `sigecom_csrf=${cookieFrom(response, "sigecom_csrf")}`,
    token: response.body.csrfToken,
  };
}

async function login(email = ownerEmail, password = initialPassword) {
  const antiCsrf = await csrf();
  const response = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", antiCsrf.cookie)
    .set("X-CSRF-Token", antiCsrf.token)
    .send({ email, password })
    .expect(200);

  return {
    sessionCookie: `sigecom_session=${cookieFrom(response, "sigecom_session")}`,
    csrfCookie: `sigecom_csrf=${cookieFrom(response, "sigecom_csrf")}`,
    csrfToken: response.body.csrfToken,
    user: response.body.user,
  };
}

function mutate(session, path, body) {
  return request(app)
    .post(path)
    .set("Origin", origin)
    .set("Cookie", [session.sessionCookie, session.csrfCookie])
    .set("X-CSRF-Token", session.csrfToken)
    .send(body);
}

function protectedOperationProbe() {
  const probe = express();
  probe.get(
    "/",
    authenticate({ dbPool: pool, authConfig }),
    requirePermission("sales.create"),
    (_request, response) => response.json({ ok: true }),
  );
  probe.use(createErrorHandler(createLogger({ level: "silent" })));
  return probe;
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");

  authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    JWT_TTL_SECONDS: "900",
    AUTH_RATE_LIMIT_MAX: "20",
  });
  app = createApp({
    dbPool: pool,
    authConfig,
    logger: createLogger({ level: "silent" }),
  });

  const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
    "seller",
  ]);
  for (const [email, displayName, idTarget] of [
    [ownerEmail, "Usuario titular", "ownerId"],
    [otherEmail, "Otra cuenta", "otherId"],
  ]) {
    const passwordHash = await bcrypt.hash(initialPassword, 12);
    const [[existing]] = await pool.execute(
      "SELECT id FROM users WHERE email = ?",
      [email],
    );
    let id = existing?.id;
    if (id) {
      await pool.execute(
        `UPDATE users SET role_id = ?, display_name = ?, password_hash = ?,
         is_active = 1, password_change_required = 1 WHERE id = ?`,
        [role.id, displayName, passwordHash, id],
      );
    } else {
      const [created] = await pool.execute(
        `INSERT INTO users
         (role_id,email,display_name,password_hash,is_active,password_change_required)
         VALUES (?,?,?,?,1,1)`,
        [role.id, email, displayName, passwordHash],
      );
      id = created.insertId;
    }
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [id],
    );
    if (idTarget === "ownerId") ownerId = id;
    else otherId = id;
  }
});

beforeEach(async () => {
  const hash = await bcrypt.hash(initialPassword, 12);
  await pool.execute(
    "UPDATE users SET password_hash = ?, password_change_required = 1, display_name = ? WHERE id = ?",
    [hash, "Usuario titular", ownerId],
  );
  await pool.execute(
    "UPDATE users SET password_hash = ?, password_change_required = 1, display_name = ? WHERE id = ?",
    [hash, "Otra cuenta", otherId],
  );
  await pool.execute(
    "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id IN (?, ?) AND revoked_at IS NULL",
    [ownerId, otherId],
  );
});

after(async () => {
  if (pool) {
    for (const id of [ownerId, otherId]) {
      await pool.execute(
        "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
        [id],
      );
      await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [id]);
    }
    await pool.end();
  }
});

test("required-password accounts cannot access profile endpoints or permission-protected operations", async () => {
  const session = await login();
  const profile = await request(app)
    .get("/api/v1/profile")
    .set("Cookie", session.sessionCookie)
    .expect(403);
  assert.equal(profile.body.error.code, "PASSWORD_CHANGE_REQUIRED");

  const operation = await request(protectedOperationProbe())
    .get("/")
    .set("Cookie", session.sessionCookie)
    .expect(403);
  assert.equal(operation.body.error.code, "PASSWORD_CHANGE_REQUIRED");
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", session.sessionCookie)
    .expect(200);
});

test("password changes require valid CSRF and current password", async () => {
  const session = await login();
  const missingCsrf = await request(app)
    .post("/api/v1/auth/change-password")
    .set("Origin", origin)
    .set("Cookie", [session.sessionCookie, session.csrfCookie])
    .send({
      currentPassword: initialPassword,
      newPassword: changedPassword,
      confirmPassword: changedPassword,
    })
    .expect(403);
  assert.equal(missingCsrf.body.error.code, "CSRF_VALIDATION_FAILED");

  const wrongCurrent = await mutate(session, "/api/v1/auth/change-password", {
    currentPassword: "Incorrecta-actual-123!",
    newPassword: changedPassword,
    confirmPassword: changedPassword,
  }).expect(401);
  assert.equal(wrongCurrent.body.error.code, "CURRENT_PASSWORD_INCORRECT");
  const [[flag]] = await pool.execute(
    "SELECT password_change_required FROM users WHERE id = ?",
    [ownerId],
  );
  assert.equal(Number(flag.password_change_required), 1);
});

test("change-password rejects weak, mismatched, and unchanged passwords", async () => {
  const session = await login();
  for (const body of [
    {
      currentPassword: initialPassword,
      newPassword: "short",
      confirmPassword: "short",
    },
    {
      currentPassword: initialPassword,
      newPassword: changedPassword,
      confirmPassword: "Other-Password-123!",
    },
    {
      currentPassword: initialPassword,
      newPassword: initialPassword,
      confirmPassword: initialPassword,
    },
  ]) {
    const response = await mutate(
      session,
      "/api/v1/auth/change-password",
      body,
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error.code, /PASSWORD|REQUEST/);
  }
  const [[flag]] = await pool.execute(
    "SELECT password_change_required FROM users WHERE id = ?",
    [ownerId],
  );
  assert.equal(Number(flag.password_change_required), 1);
});

test("successful password change clears the required flag and revokes every session", async () => {
  const first = await login();
  const second = await login();
  const firstToken = first.sessionCookie.slice("sigecom_session=".length);
  const secondToken = second.sessionCookie.slice("sigecom_session=".length);

  const response = await mutate(first, "/api/v1/auth/change-password", {
    currentPassword: initialPassword,
    newPassword: changedPassword,
    confirmPassword: changedPassword,
  }).expect(200);
  assert.equal(response.body.changed, true);
  assert.equal("passwordHash" in response.body, false);
  assert.ok(
    (response.headers["set-cookie"] || []).some((cookie) =>
      cookie.startsWith("sigecom_session=;"),
    ),
  );

  const [[updated]] = await pool.execute(
    "SELECT password_hash, password_change_required FROM users WHERE id = ?",
    [ownerId],
  );
  assert.equal(Number(updated.password_change_required), 0);
  assert.equal(
    await bcrypt.compare(changedPassword, updated.password_hash),
    true,
  );
  assert.equal(
    await bcrypt.compare(initialPassword, updated.password_hash),
    false,
  );

  for (const token of [firstToken, secondToken]) {
    await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", `sigecom_session=${token}`)
      .expect(401);
  }

  const antiCsrf = await csrf();
  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", antiCsrf.cookie)
    .set("X-CSRF-Token", antiCsrf.token)
    .send({ email: ownerEmail, password: initialPassword })
    .expect(401);

  const newLogin = await login(ownerEmail, changedPassword);
  assert.equal(newLogin.user.passwordChangeRequired, false);
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", newLogin.sessionCookie)
    .expect(200);
});

test("profile reads and updates only the authenticated user's display name", async () => {
  await pool.execute(
    "UPDATE users SET password_change_required = 0 WHERE id IN (?, ?)",
    [ownerId, otherId],
  );
  const session = await login();
  const profile = await request(app)
    .get("/api/v1/profile")
    .set("Cookie", session.sessionCookie)
    .expect(200);
  assert.equal(profile.body.email, ownerEmail);
  assert.equal(profile.body.displayName, "Usuario titular");
  assert.equal("passwordHash" in profile.body, false);

  const updated = await request(app)
    .patch("/api/v1/profile")
    .set("Origin", origin)
    .set("Cookie", [session.sessionCookie, session.csrfCookie])
    .set("X-CSRF-Token", session.csrfToken)
    .send({ displayName: "Nombre actualizado" })
    .expect(200);
  assert.equal(updated.body.displayName, "Nombre actualizado");

  const forbiddenFields = await request(app)
    .patch("/api/v1/profile")
    .set("Origin", origin)
    .set("Cookie", [session.sessionCookie, session.csrfCookie])
    .set("X-CSRF-Token", session.csrfToken)
    .send({
      displayName: "Otro",
      userId: String(otherId),
      role: "administrator",
      password: "x",
    })
    .expect(400);
  assert.equal(forbiddenFields.body.error.code, "INVALID_REQUEST");

  const [[owner], [other]] = await Promise.all([
    pool.execute("SELECT display_name FROM users WHERE id = ?", [ownerId]),
    pool.execute("SELECT display_name FROM users WHERE id = ?", [otherId]),
  ]);
  assert.equal(owner[0].display_name, "Nombre actualizado");
  assert.equal(other[0].display_name, "Otra cuenta");
});

test("anonymous users cannot query or update a profile", async () => {
  await request(app).get("/api/v1/profile").expect(401);
  await request(app)
    .patch("/api/v1/profile")
    .set("Origin", origin)
    .send({ displayName: "Invitado" })
    .expect(403);
});
