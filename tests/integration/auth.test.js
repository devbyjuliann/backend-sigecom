import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import {
  authenticate,
  requirePermission,
  requireWarehouseAccess,
} from "../../src/modules/auth/auth-middleware.js";
import { revokeUserSessions } from "../../src/modules/auth/auth-service.js";
import { createErrorHandler } from "../../src/shared/error-handler.js";
import { createLogger } from "../../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";
const testEmail = "auth-test@sigecom.invalid";
const testWarehouseCode = "AUTH-TEST";
let pool;
let fixture;
let authConfig;

function cookieValue(headers, name) {
  const cookie = (headers["set-cookie"] || []).find((value) =>
    value.startsWith(`${name}=`),
  );
  assert.ok(cookie, `Expected ${name} cookie`);
  return cookie.slice(name.length + 1, cookie.indexOf(";"));
}

function csrfCookieFrom(response) {
  const cookie = (response.headers["set-cookie"] || []).find((value) =>
    value.startsWith("sigecom_csrf="),
  );
  assert.ok(cookie, "Expected CSRF cookie");
  return cookie.split(";", 1)[0];
}

async function obtainCsrf(app) {
  const response = await request(app).get("/api/v1/auth/csrf").expect(200);
  return {
    cookie: csrfCookieFrom(response),
    token: response.body.csrfToken,
    response,
  };
}

function submitLogin(
  app,
  csrf,
  password = fixture.password,
  email = testEmail,
) {
  return request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrf.cookie)
    .set("X-CSRF-Token", csrf.token)
    .send({ email, password });
}

function makeApp(
  logger = createLogger({ level: "silent" }),
  config = authConfig,
) {
  return createApp({ dbPool: pool, authConfig: config, logger });
}

function makeAuthorizationProbe(permission) {
  const app = express();
  const auth = authenticate({ dbPool: pool, authConfig });

  app.get("/protected", auth, requirePermission(permission), (req, res) => {
    res.json({ userId: req.auth.user.id, permission });
  });
  app.get(
    "/warehouses/:warehouseId",
    auth,
    requireWarehouseAccess(),
    (req, res) => res.json({ warehouseId: Number(req.params.warehouseId) }),
  );
  app.use(createErrorHandler(createLogger({ level: "silent" })));

  return app;
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");

  const testSecret = randomBytes(48).toString("base64url");
  authConfig = getAuthConfig({
    JWT_SECRET: testSecret,
    FRONTEND_ORIGIN: origin,
    JWT_TTL_SECONDS: "900",
  });

  const password = randomBytes(32).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);
  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  const [[existingUser]] = await pool.execute(
    "SELECT id FROM users WHERE email = ?",
    [testEmail],
  );
  let userId = existingUser?.id;

  if (userId) {
    await pool.execute(
      `UPDATE users SET role_id = ?, password_hash = ?, is_active = 1,
       password_change_required = 0 WHERE id = ?`,
      [role.id, passwordHash, userId],
    );
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [userId],
    );
  } else {
    const [result] = await pool.execute(
      `INSERT INTO users (role_id, email, password_hash, is_active, password_change_required)
       VALUES (?, ?, ?, 1, 0)`,
      [role.id, testEmail, passwordHash],
    );
    userId = result.insertId;
  }

  const [[existingWarehouse]] = await pool.execute(
    "SELECT id FROM warehouses WHERE code = ?",
    [testWarehouseCode],
  );
  let warehouseId = existingWarehouse?.id;
  if (warehouseId) {
    await pool.execute("UPDATE warehouses SET is_active = 1 WHERE id = ?", [
      warehouseId,
    ]);
  } else {
    const [result] = await pool.execute(
      "INSERT INTO warehouses (code, name, is_active) VALUES (?, ?, 1)",
      [testWarehouseCode, "Bodega de pruebas de autenticación"],
    );
    warehouseId = result.insertId;
  }

  await pool.execute(
    `INSERT INTO user_warehouses (user_id, warehouse_id)
     VALUES (?, ?) ON DUPLICATE KEY UPDATE warehouse_id = VALUES(warehouse_id)`,
    [userId, warehouseId],
  );

  fixture = { userId, warehouseId, password };
});

after(async () => {
  if (pool && fixture) {
    await pool.execute(
      "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
      [fixture.userId],
    );
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
      fixture.userId,
    ]);
    await pool.execute("UPDATE warehouses SET is_active = 0 WHERE id = ?", [
      fixture.warehouseId,
    ]);
  }
  if (pool) await pool.end();
});

test("login accepts valid credentials and returns an HttpOnly local session cookie", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const response = await submitLogin(app, csrf).expect(200);
  const sessionCookie = (response.headers["set-cookie"] || []).find((value) =>
    value.startsWith("sigecom_session="),
  );

  assert.ok(sessionCookie);
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Strict/i);
  assert.match(sessionCookie, /Path=\/api\/v1/i);
  assert.doesNotMatch(sessionCookie, /; Secure(?:;|$)/i);
  assert.equal(response.body.user.email, testEmail);
  assert.equal(response.body.user.role, "seller");
  assert.equal("passwordHash" in response.body.user, false);
  assert.equal("token" in response.body, false);
  assert.equal(JSON.stringify(response.body).includes(fixture.password), false);
  assert.match(
    response.headers["set-cookie"].find((value) =>
      value.startsWith("sigecom_csrf="),
    ),
    /SameSite=Strict/i,
  );
  assert.doesNotMatch(
    response.headers["set-cookie"].find((value) =>
      value.startsWith("sigecom_csrf="),
    ),
    /HttpOnly/i,
  );
});

test("login rejects incorrect credentials without revealing account existence", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const wrongPassword = await submitLogin(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
  );

  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(wrongPassword.body.error.code, "INVALID_CREDENTIALS");
  assert.equal(wrongPassword.headers["set-cookie"], undefined);

  const unknownEmail = await submitLogin(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "not-present@sigecom.invalid",
  );
  assert.equal(unknownEmail.status, 401);
  assert.equal(unknownEmail.body.error.code, wrongPassword.body.error.code);
  assert.equal(
    unknownEmail.body.error.message,
    wrongPassword.body.error.message,
  );
});

test("login rejects inactive users and records no credential material in audit", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
    fixture.userId,
  ]);

  try {
    const response = await submitLogin(app, csrf).expect(401);
    assert.equal(response.body.error.code, "INVALID_CREDENTIALS");
    const [[event]] = await pool.execute(
      `SELECT action, details, entity_id FROM audit_events
       WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(event.action, "auth.login_failed");
    assert.equal(event.details, null);
    assert.equal(event.entity_id, null);
  } finally {
    await pool.execute("UPDATE users SET is_active = 1 WHERE id = ?", [
      fixture.userId,
    ]);
  }
});

test("session JWT is persisted by jti hash and never returned in JSON", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const response = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(response.headers, "sigecom_session");
  const claims = jwt.verify(token, authConfig.jwtSecret, {
    algorithms: ["HS256"],
    issuer: authConfig.jwtIssuer,
    audience: authConfig.jwtAudience,
  });
  const tokenHash = createHash("sha256").update(claims.jti).digest("hex");
  const [[session]] = await pool.execute(
    "SELECT user_id, expires_at, revoked_at FROM user_sessions WHERE token_hash = ?",
    [tokenHash],
  );

  assert.equal(Number(session.user_id), Number(fixture.userId));
  assert.ok(new Date(session.expires_at).getTime() > Date.now());
  assert.equal(session.revoked_at, null);
  assert.equal(JSON.stringify(response.body).includes(token), false);
  assert.equal(JSON.stringify(response.body).includes(tokenHash), false);
});

test("me rejects missing, malformed, tampered, and expired JWTs", async () => {
  const app = makeApp();
  await request(app).get("/api/v1/auth/me").expect(401);
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", "sigecom_session=not-a-jwt")
    .expect(401);

  const csrf = await obtainCsrf(app);
  const login = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(login.headers, "sigecom_session");
  const [header, payload, signature] = token.split(".");
  const alteredSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${header}.${payload}.${alteredSignature}`)
    .expect(401);

  const expiredToken = jwt.sign({ jti: randomUUID() }, authConfig.jwtSecret, {
    algorithm: "HS256",
    subject: String(fixture.userId),
    issuer: authConfig.jwtIssuer,
    audience: authConfig.jwtAudience,
    expiresIn: -1,
  });
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${expiredToken}`)
    .expect(401);
});

test("an expired persistent session invalidates a still-valid signed JWT", async () => {
  const jti = randomUUID();
  const token = jwt.sign({}, authConfig.jwtSecret, {
    algorithm: "HS256",
    subject: String(fixture.userId),
    jwtid: jti,
    issuer: authConfig.jwtIssuer,
    audience: authConfig.jwtAudience,
    expiresIn: 300,
  });
  const tokenHash = createHash("sha256").update(jti).digest("hex");
  await pool.execute(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES (?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE))`,
    [fixture.userId, tokenHash],
  );

  await request(makeApp())
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${token}`)
    .expect(401);
});

test("logout revokes the persisted session and clears both cookies", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const login = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(login.headers, "sigecom_session");
  const rotatedCsrf = csrfCookieFrom(login);
  const nextCsrf = login.body.csrfToken;
  const claims = jwt.verify(token, authConfig.jwtSecret, {
    algorithms: ["HS256"],
  });
  const tokenHash = createHash("sha256").update(claims.jti).digest("hex");

  const logout = await request(app)
    .post("/api/v1/auth/logout")
    .set("Origin", origin)
    .set("Cookie", [`sigecom_session=${token}`, rotatedCsrf])
    .set("X-CSRF-Token", nextCsrf)
    .expect(204);

  const [[session]] = await pool.execute(
    "SELECT revoked_at FROM user_sessions WHERE token_hash = ?",
    [tokenHash],
  );
  assert.ok(session.revoked_at);

  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${token}`)
    .expect(401);
  assert.equal(me.body.error.code, "SESSION_INVALID");

  const logoutCookies = logout.headers["set-cookie"] || [];
  assert.ok(
    logoutCookies.some((value) => value.startsWith("sigecom_session=;")),
  );
  assert.ok(logoutCookies.some((value) => value.startsWith("sigecom_csrf=;")));
});

test("RBAC reloads permissions from MariaDB and restricts assigned warehouses", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const login = await submitLogin(app, csrf).expect(200);
  const session = `sigecom_session=${cookieValue(login.headers, "sigecom_session")}`;
  const permissionProbe = makeAuthorizationProbe("users.manage");

  await request(permissionProbe)
    .get("/protected")
    .set("Cookie", session)
    .expect(403);

  const salesProbe = makeAuthorizationProbe("sales.create");
  const allowed = await request(salesProbe)
    .get("/protected")
    .set("Cookie", session)
    .expect(200);
  assert.equal(allowed.body.permission, "sales.create");

  const warehouseProbe = makeAuthorizationProbe("inventory.read");
  await request(warehouseProbe)
    .get(`/warehouses/${fixture.warehouseId}`)
    .set("Cookie", session)
    .expect(200);
  await request(warehouseProbe)
    .get("/warehouses/999999999")
    .set("Cookie", session)
    .expect(403);

  const [[auditor]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'auditor'",
  );
  const [[seller]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  assert.ok(auditor && seller);
  try {
    await pool.execute("UPDATE users SET role_id = ? WHERE id = ?", [
      auditor.id,
      fixture.userId,
    ]);
    await request(salesProbe)
      .get("/protected")
      .set("Cookie", session)
      .expect(403);
  } finally {
    await pool.execute("UPDATE users SET role_id = ? WHERE id = ?", [
      seller.id,
      fixture.userId,
    ]);
  }
  await request(salesProbe)
    .get("/protected")
    .set("Cookie", session)
    .expect(200);
});

test("security-driven session revocation takes effect immediately", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const login = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(login.headers, "sigecom_session");

  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${token}`)
    .expect(200);
  assert.ok((await revokeUserSessions(pool, fixture.userId)) >= 1);
  const revoked = await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${token}`)
    .expect(401);
  assert.equal(revoked.body.error.code, "SESSION_INVALID");
});

test("CSRF and origin checks protect login and logout mutations", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);

  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: testEmail, password: fixture.password })
    .expect(403);
  await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", "https://untrusted.invalid")
    .set("Cookie", csrf.cookie)
    .set("X-CSRF-Token", csrf.token)
    .send({ email: testEmail, password: fixture.password })
    .expect(403);

  const login = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(login.headers, "sigecom_session");
  await request(app)
    .post("/api/v1/auth/logout")
    .set("Origin", origin)
    .set("Cookie", `sigecom_session=${token}`)
    .expect(403);
  await request(app)
    .get("/api/v1/auth/me")
    .set("Cookie", `sigecom_session=${token}`)
    .expect(200);
});

test("login rate limiting returns 429 after the configured failed attempts", async () => {
  const app = makeApp();
  const csrf = await obtainCsrf(app);
  const statuses = [];

  for (
    let attempt = 0;
    attempt < authConfig.loginAttemptLimit + 1;
    attempt += 1
  ) {
    const response = await submitLogin(
      app,
      csrf,
      randomBytes(32).toString("base64url"),
    );
    statuses.push(response.status);
  }

  assert.deepEqual(statuses, [
    ...Array(authConfig.loginAttemptLimit).fill(401),
    429,
  ]);
});

test("successful logins do not consume the failed-attempt rate-limit budget", async () => {
  const limitedConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_RATE_LIMIT_MAX: "2",
  });
  const limitedApp = makeApp(createLogger({ level: "silent" }), limitedConfig);
  const csrf = await obtainCsrf(limitedApp);

  await submitLogin(limitedApp, csrf).expect(200);
  await submitLogin(limitedApp, csrf, "incorrecta-primera").expect(401);
  await submitLogin(limitedApp, csrf).expect(200);
  await submitLogin(limitedApp, csrf, "incorrecta-segunda").expect(401);
  await submitLogin(limitedApp, csrf, "incorrecta-tercera").expect(429);
});

test("request logs never contain login passwords, JWTs, or cookies", async () => {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = createLogger({ level: "info", destination });
  const app = makeApp(logger);
  const csrf = await obtainCsrf(app);
  const response = await submitLogin(app, csrf).expect(200);
  const token = cookieValue(response.headers, "sigecom_session");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.includes(fixture.password), false);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes("sigecom_session="), false);
  assert.equal(output.includes("password_hash"), false);
});

test("authentication integration stays isolated in sigecom_test", async () => {
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  const [[devAdmin]] = await pool.execute(
    "SELECT COUNT(*) AS count FROM sigecom_test.users WHERE email = ?",
    ["administrator@sigecom.invalid"],
  );

  assert.equal(database.name, "sigecom_test");
  assert.equal(Number(devAdmin.count), 0);
  assert.match(testEmail, /\.invalid$/);
});
