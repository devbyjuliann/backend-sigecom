import assert from "node:assert/strict";
import { test } from "node:test";
import { getDatabaseConfig } from "../../src/db/config.js";

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

test("rejects all database targets outside the two approved local databases", () => {
  assert.throws(
    () => getDatabaseConfig("production"),
    /destino de base de datos/i,
  );
  assert.throws(
    () => getDatabaseConfig("sigecom"),
    /destino de base de datos/i,
  );
});
