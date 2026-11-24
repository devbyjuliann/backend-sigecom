import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getAuthConfig } from "../src/modules/auth/auth-config.js";
import { createLogger } from "../src/shared/logger.js";

const origin = "http://127.0.0.1:5173";

function makeApp(authConfig, { trustProxy = false } = {}) {
  const dbPool = {
    async execute(sql) {
      if (sql.includes("FROM users AS u")) return [[], []];
      if (sql.includes("FROM account_access_tokens")) return [[], []];
      if (sql.includes("INSERT INTO audit_events")) {
        return [{ insertId: 1 }, []];
      }
      throw new Error("Unexpected database query in rate-limit test.");
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql) {
          if (sql.includes("FROM users WHERE email =")) return [[], []];
          if (sql.includes("INSERT INTO audit_events")) {
            return [{ insertId: 1 }, []];
          }
          throw new Error("Unexpected transaction query in rate-limit test.");
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };

  return createApp({
    dbPool,
    authConfig,
    logger: createLogger({ level: "silent" }),
    mailTransport: {
      type: "simulated",
      async send() {
        return { accepted: true, simulated: true };
      },
    },
    trustProxy,
  });
}

async function obtainCsrf(app) {
  const response = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = response.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];

  return { cookie, token: response.body.csrfToken };
}

function submitFailedLogin(app, csrf, email, spoofedAddress) {
  const login = request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .set("Cookie", csrf.cookie)
    .set("X-CSRF-Token", csrf.token)
    .send({ email, password: "incorrecta-para-pruebas" });

  if (spoofedAddress) {
    login
      .set("X-Forwarded-For", spoofedAddress)
      .set("X-Real-IP", spoofedAddress);
  }

  return login;
}

function submitRecovery(app, csrf, email, spoofedAddress) {
  const recovery = request(app)
    .post("/api/v1/auth/password-recovery")
    .set("Origin", origin)
    .set("Cookie", csrf.cookie)
    .set("X-CSRF-Token", csrf.token)
    .send({ email });

  if (spoofedAddress) {
    recovery
      .set("X-Forwarded-For", spoofedAddress)
      .set("X-Real-IP", spoofedAddress);
  }

  return recovery;
}

function submitCompletion(app, csrf, token, endpoint, spoofedAddress) {
  const completion = request(app)
    .post(endpoint)
    .set("Origin", origin)
    .set("Cookie", csrf.cookie)
    .set("X-CSRF-Token", csrf.token)
    .send({
      token,
      newPassword: "SIGECOM-Prueba-2026",
      confirmPassword: "SIGECOM-Prueba-2026",
    });

  if (spoofedAddress) {
    completion
      .set("X-Forwarded-For", spoofedAddress)
      .set("X-Real-IP", spoofedAddress);
  }

  return completion;
}

test("failed logins for one account do not rate-limit every other account", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_RATE_LIMIT_MAX: "2",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20",
  });
  const app = makeApp(authConfig);
  const csrf = await obtainCsrf(app);

  await submitFailedLogin(app, csrf, "uno@sigecom.invalid").expect(401);
  await submitFailedLogin(app, csrf, "uno@sigecom.invalid").expect(401);
  const otherAccount = await submitFailedLogin(
    app,
    csrf,
    "dos@sigecom.invalid",
  );

  assert.equal(otherAccount.status, 401);
});

test("spoofed forwarding headers cannot reset an account's failed-login budget", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_RATE_LIMIT_MAX: "20",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitFailedLogin(
    app,
    csrf,
    "uno@sigecom.invalid",
    "198.51.100.10",
  ).expect(401);
  await submitFailedLogin(
    app,
    csrf,
    "uno@sigecom.invalid",
    "198.51.100.11",
  ).expect(401);
  await submitFailedLogin(
    app,
    csrf,
    "uno@sigecom.invalid",
    "198.51.100.12",
  ).expect(429);
});

test("a global failed-login budget stops account spraying despite spoofed IP headers", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20",
    AUTH_LOGIN_GLOBAL_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitFailedLogin(
    app,
    csrf,
    "uno@sigecom.invalid",
    "198.51.100.10",
  ).expect(401);
  await submitFailedLogin(
    app,
    csrf,
    "dos@sigecom.invalid",
    "198.51.100.11",
  ).expect(401);
  await submitFailedLogin(
    app,
    csrf,
    "tres@sigecom.invalid",
    "198.51.100.12",
  ).expect(429);
});

test("account-limited login attempts do not consume the global failure budget", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "2",
    AUTH_LOGIN_GLOBAL_RATE_LIMIT_MAX: "3",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitFailedLogin(app, csrf, "uno@sigecom.invalid").expect(401);
  await submitFailedLogin(app, csrf, "uno@sigecom.invalid").expect(401);
  await submitFailedLogin(app, csrf, "uno@sigecom.invalid").expect(429);
  await submitFailedLogin(app, csrf, "dos@sigecom.invalid").expect(401);
});

test("password recovery limits each account independently without an IP collision", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await submitRecovery(
      app,
      csrf,
      "  ANA@SIGECOM.INVALID ",
      `198.51.100.${attempt}`,
    ).expect(202);
  }
  const limitedAccount = await submitRecovery(
    app,
    csrf,
    "ana@sigecom.invalid",
    "198.51.100.44",
  );
  const otherAccount = await submitRecovery(
    app,
    csrf,
    "otro@sigecom.invalid",
    "198.51.100.44",
  );

  assert.equal(limitedAccount.status, 429);
  assert.equal(otherAccount.status, 202);
  assert.deepEqual(otherAccount.body, {
    accepted: true,
    message:
      "Si la cuenta está activa, enviaremos instrucciones al correo registrado.",
  });
});

test("a global recovery budget caps requests across accounts and spoofed IP headers", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_PASSWORD_RECOVERY_GLOBAL_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitRecovery(
    app,
    csrf,
    "uno@sigecom.invalid",
    "198.51.100.10",
  ).expect(202);
  await submitRecovery(
    app,
    csrf,
    "dos@sigecom.invalid",
    "198.51.100.11",
  ).expect(202);
  const limited = await submitRecovery(
    app,
    csrf,
    "tres@sigecom.invalid",
    "198.51.100.12",
  );

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "PASSWORD_RECOVERY_RATE_LIMITED");
});

test("account-limited recovery requests do not consume the global request budget", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_PASSWORD_RECOVERY_GLOBAL_RATE_LIMIT_MAX: "4",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitRecovery(app, csrf, "uno@sigecom.invalid").expect(202);
  await submitRecovery(app, csrf, "uno@sigecom.invalid").expect(202);
  await submitRecovery(app, csrf, "uno@sigecom.invalid").expect(202);
  await submitRecovery(app, csrf, "uno@sigecom.invalid").expect(429);
  await submitRecovery(app, csrf, "dos@sigecom.invalid").expect(202);
});

test("completion budgets are per token across completion routes, not per spoofable IP", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_PASSWORD_RECOVERY_COMPLETION_TOKEN_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);
  const token = randomBytes(32).toString("base64url");

  await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/password-recovery/complete",
    "198.51.100.10",
  ).expect(400);
  await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/invitations/complete",
    "198.51.100.11",
  ).expect(400);
  const sameToken = await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/admin-password-reset/complete",
    "198.51.100.12",
  );
  const otherToken = await submitCompletion(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "/api/v1/auth/password-recovery/complete",
    "198.51.100.13",
  );

  assert.equal(sameToken.status, 429);
  assert.equal(otherToken.status, 400);
});

test("token-limited completion attempts do not consume the global completion budget", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_PASSWORD_RECOVERY_COMPLETION_GLOBAL_RATE_LIMIT_MAX: "3",
    AUTH_PASSWORD_RECOVERY_COMPLETION_TOKEN_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);
  const token = randomBytes(32).toString("base64url");

  await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/password-recovery/complete",
  ).expect(400);
  await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/password-recovery/complete",
  ).expect(400);
  await submitCompletion(
    app,
    csrf,
    token,
    "/api/v1/auth/password-recovery/complete",
  ).expect(429);
  await submitCompletion(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "/api/v1/auth/password-recovery/complete",
  ).expect(400);
});

test("a global completion budget caps token spraying across accounts and IP headers", async () => {
  const authConfig = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
    AUTH_PASSWORD_RECOVERY_COMPLETION_GLOBAL_RATE_LIMIT_MAX: "2",
  });
  const app = makeApp(authConfig, { trustProxy: true });
  const csrf = await obtainCsrf(app);

  await submitCompletion(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "/api/v1/auth/password-recovery/complete",
    "198.51.100.10",
  ).expect(400);
  await submitCompletion(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "/api/v1/auth/invitations/complete",
    "198.51.100.11",
  ).expect(400);
  const limited = await submitCompletion(
    app,
    csrf,
    randomBytes(32).toString("base64url"),
    "/api/v1/auth/admin-password-reset/complete",
    "198.51.100.12",
  );

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "PASSWORD_RECOVERY_RATE_LIMITED");
});
