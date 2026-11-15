import assert from "node:assert/strict";
import { test } from "node:test";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";

const validEnvironment = {
  JWT_SECRET: "a".repeat(64),
  FRONTEND_ORIGIN: "http://127.0.0.1:5173",
};

test("builds local auth configuration with a non-secure loopback cookie", () => {
  const config = getAuthConfig(validEnvironment);

  assert.equal(config.cookieSecure, false);
  assert.equal(config.cookieSameSite, "strict");
  assert.equal(config.cookiePath, "/api/v1");
  assert.equal(config.allowedOrigins[0], "http://127.0.0.1:5173");
  assert.equal(config.loginAccountAttemptLimit, 5);
});

test("validates the failed-login budget per account and origin", () => {
  assert.equal(
    getAuthConfig({
      ...validEnvironment,
      AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "3",
    }).loginAccountAttemptLimit,
    3,
  );
  assert.throws(
    () =>
      getAuthConfig({
        ...validEnvironment,
        AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "0",
      }),
    /AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX/,
  );
});

test("rejects missing or weak JWT secrets", () => {
  assert.throws(
    () => getAuthConfig({ ...validEnvironment, JWT_SECRET: "short" }),
    /JWT_SECRET/,
  );
  assert.throws(
    () => getAuthConfig({ FRONTEND_ORIGIN: validEnvironment.FRONTEND_ORIGIN }),
    /JWT_SECRET/,
  );
});

test("requires secure session cookies in production", () => {
  assert.throws(
    () =>
      getAuthConfig({
        ...validEnvironment,
        NODE_ENV: "production",
        COOKIE_SECURE: "false",
        JWT_ISSUER: "sigecom-production",
        JWT_AUDIENCE: "sigecom-api-production",
      }),
    /COOKIE_SECURE/,
  );
  assert.equal(
    getAuthConfig({
      ...validEnvironment,
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      FRONTEND_ORIGIN: "https://app.example.com",
      JWT_ISSUER: "sigecom-production",
      JWT_AUDIENCE: "sigecom-api-production",
    }).cookieSecure,
    true,
  );
});

test("production authentication requires HTTPS origins for credentialed cookies", () => {
  assert.throws(
    () =>
      getAuthConfig({
        ...validEnvironment,
        NODE_ENV: "production",
        COOKIE_SECURE: "true",
        JWT_ISSUER: "sigecom-production",
        JWT_AUDIENCE: "sigecom-api-production",
      }),
    /FRONTEND_ORIGIN.*HTTPS/i,
  );
  assert.equal(
    getAuthConfig({
      ...validEnvironment,
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      FRONTEND_ORIGIN: "https://app.example.com",
      JWT_ISSUER: "sigecom-production",
      JWT_AUDIENCE: "sigecom-api-production",
    }).allowedOrigins[0],
    "https://app.example.com",
  );
});

test("production JWT issuer and audience cannot use development defaults", () => {
  assert.throws(
    () =>
      getAuthConfig({
        ...validEnvironment,
        NODE_ENV: "production",
        COOKIE_SECURE: "true",
        FRONTEND_ORIGIN: "https://app.example.com",
      }),
    /JWT_ISSUER.*JWT_AUDIENCE.*explícitos/i,
  );
  const config = getAuthConfig({
    ...validEnvironment,
    NODE_ENV: "production",
    COOKIE_SECURE: "true",
    FRONTEND_ORIGIN: "https://app.example.com",
    JWT_ISSUER: "sigecom-production",
    JWT_AUDIENCE: "sigecom-api-production",
  });
  assert.equal(config.jwtIssuer, "sigecom-production");
  assert.equal(config.jwtAudience, "sigecom-api-production");
});

test("accepts only explicit HTTP or HTTPS origins without wildcard entries", () => {
  assert.throws(
    () => getAuthConfig({ ...validEnvironment, FRONTEND_ORIGIN: "*" }),
    /origen/,
  );
  assert.throws(
    () =>
      getAuthConfig({ ...validEnvironment, FRONTEND_ORIGIN: "file://local" }),
    /origen/,
  );
});
