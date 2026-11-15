import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getDatabaseConfig,
  getTrustedProxyAddresses,
  resolveRuntimeDatabaseTarget,
} from "../../src/db/config.js";

test("selects only the approved XAMPP development and test databases", () => {
  const env = {
    SIGECOM_DEV_APP_USER: "dev_app",
    SIGECOM_DEV_APP_PASSWORD: "dev_app_password",
    SIGECOM_TEST_APP_USER: "test_app",
    SIGECOM_TEST_APP_PASSWORD: "test_app_password",
  };

  assert.equal(getDatabaseConfig("development", env).database, "sigecom_dev");
  assert.equal(getDatabaseConfig("test", env).database, "sigecom_test");
  assert.equal(getDatabaseConfig("development", env).host, "127.0.0.1");
  assert.equal(getDatabaseConfig("development", env).port, 3306);
});

test("rejects unrecognized database targets", () => {
  assert.throws(
    () => getDatabaseConfig("sigecom"),
    /destino de base de datos/i,
  );
});

const productionEnv = () => ({
  NODE_ENV: "production",
  SIGECOM_PROD_DATABASE: "sigecom_prod",
  SIGECOM_PROD_DB_HOST: "sql.example.internal",
  SIGECOM_PROD_DB_PORT: "3307",
  SIGECOM_PROD_DB_TLS_CA_BASE64: Buffer.from(
    `-----BEGIN CERTIFICATE-----\n${Buffer.from("ZERT").toString("base64")}\n-----END CERTIFICATE-----\n`,
  ).toString("base64"),
  SIGECOM_PROD_APP_USER: "sigecom_app",
  SIGECOM_PROD_APP_PASSWORD: "a".repeat(40),
  SIGECOM_PROD_MIGRATOR_USER: "sigecom_migrator",
  SIGECOM_PROD_MIGRATOR_PASSWORD: "b".repeat(40),
});

test("production requires an explicit remote-capable target, separate SQL users and verified TLS", () => {
  const config = getDatabaseConfig("production", productionEnv(), "APP");

  assert.equal(config.database, "sigecom_prod");
  assert.equal(config.host, "sql.example.internal");
  assert.equal(config.port, 3307);
  assert.equal(config.user, "sigecom_app");
  assert.equal(config.password, "a".repeat(40));
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.match(config.ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(
    resolveRuntimeDatabaseTarget({ NODE_ENV: "production" }),
    "production",
  );
  assert.equal(
    resolveRuntimeDatabaseTarget({ NODE_ENV: "development" }),
    "development",
  );
});

test("production refuses missing runtime selection, weak secrets, protected schemas and incomplete TLS", () => {
  assert.throws(() => resolveRuntimeDatabaseTarget({}), /NODE_ENV explícito/i);
  assert.throws(
    () => resolveRuntimeDatabaseTarget({ NODE_ENV: "test" }),
    /NODE_ENV explícito/i,
  );

  const cases = [
    [{ SIGECOM_PROD_DB_TLS_CA_BASE64: "" }, /TLS.*CA/i],
    [
      {
        SIGECOM_PROD_DB_TLS_CA_BASE64: Buffer.from(
          "-----BEGIN CERTIFICATE-----\nnot-base64!\n-----END CERTIFICATE-----\n",
        ).toString("base64"),
      },
      /PEM válido/i,
    ],
    [{ SIGECOM_PROD_APP_PASSWORD: "short" }, /contraseña.*APP/i],
    [
      { SIGECOM_PROD_APP_PASSWORD: `${"x".repeat(31)}\n` },
      /no incluir controles/i,
    ],
    [{ SIGECOM_PROD_MIGRATOR_USER: "sigecom_app" }, /cuentas.*distintas/i],
    [{ SIGECOM_PROD_DATABASE: "sigecom_test" }, /esquema.*protegido/i],
    [{ SIGECOM_PROD_DB_HOST: "https://db.example.internal" }, /host.*válido/i],
    [{ SIGECOM_PROD_DB_PORT: "0" }, /puerto.*válido/i],
  ];

  for (const [override, error] of cases) {
    assert.throws(
      () =>
        getDatabaseConfig("production", { ...productionEnv(), ...override }),
      error,
    );
  }
});

test("production migrator configuration requires its own strong credential", () => {
  const env = productionEnv();
  const config = getDatabaseConfig("production", env, "MIGRATOR");
  assert.equal(config.user, "sigecom_migrator");
  assert.equal(config.password, "b".repeat(40));
  assert.throws(
    () =>
      getDatabaseConfig(
        "production",
        { ...env, SIGECOM_PROD_MIGRATOR_PASSWORD: "" },
        "MIGRATOR",
      ),
    /contraseña.*MIGRATOR/i,
  );
});

test("trusted proxy configuration accepts only explicit exact IP addresses", () => {
  assert.equal(getTrustedProxyAddresses(undefined), false);
  assert.deepEqual(getTrustedProxyAddresses("127.0.0.1, 10.1.2.3"), [
    "127.0.0.1",
    "10.1.2.3",
  ]);
  assert.throws(() => getTrustedProxyAddresses("10.0.0.0/8"), /IP explícita/i);
  assert.throws(() => getTrustedProxyAddresses("*"), /IP explícita/i);
});
