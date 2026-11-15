import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertH2E2EGrants,
  assertH2E2EMigrations,
  getH2E2EConfig,
} from "../../scripts/h2-e2e/preflight.js";
import {
  buildH2E2EIdempotencyLikePattern,
  buildH2E2EFixturePermissionRevocation,
} from "../../scripts/h2-e2e/fixtures.js";

const env = () => ({
  SIGECOM_H2_E2E_TARGET: "sigecom_h2_concurrency",
  SIGECOM_H2_DATABASE: "sigecom_h2_concurrency",
  SIGECOM_H2_USER: "sigecom_h2_runner",
  SIGECOM_H2_PASSWORD: "ephemeral-test-password",
  SIGECOM_H2_E2E_SQL_HOST: "127.0.0.1",
  SIGECOM_H2_E2E_SQL_PORT: "3306",
  SIGECOM_H2_E2E_RUN_ID: "a1b2c3d4e5f6",
  SIGECOM_H2_E2E_API_PORT: "3202",
  SIGECOM_H2_E2E_FRONTEND_PORT: "5175",
  SIGECOM_H2_E2E_JWT_SECRET: "a".repeat(48),
  SIGECOM_H2_E2E_FIXTURE_PASSWORD: "fixture-passphrase-2026-secure",
  SIGECOM_H2_E2E_RESULTS_DIR: "C:/Temp/sigecom-h2-results",
});

test("H2 E2E target must be explicit and exact before a pool can be built", () => {
  assert.throws(() => getH2E2EConfig({}), /destino H2 E2E autorizado/i);
  assert.throws(
    () =>
      getH2E2EConfig({
        ...env(),
        SIGECOM_H2_E2E_TARGET: "sigecom_test",
      }),
    /destino H2 E2E autorizado/i,
  );
  assert.throws(
    () => getH2E2EConfig({ ...env(), SIGECOM_H2_DATABASE: "sigecom_dev" }),
    /destino H2 E2E autorizado/i,
  );
  const config = getH2E2EConfig(env());
  assert.equal(config.database, "sigecom_h2_concurrency");
  assert.equal(config.user, "sigecom_h2_runner");
  assert.equal(config.apiPort, 3202);
  assert.equal(config.frontendPort, 5175);
});

test("H2 E2E accepts only the authorized schema-scoped DML grant and no globals", () => {
  assert.doesNotThrow(() =>
    assertH2E2EGrants(
      [
        "GRANT USAGE ON *.* TO `sigecom_h2_runner`@`127.0.0.1` IDENTIFIED BY PASSWORD '*redacted'",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON `sigecom\\_h2\\_concurrency`.* TO `sigecom_h2_runner`@`127.0.0.1`",
      ],
      0,
    ),
  );
  assert.throws(
    () =>
      assertH2E2EGrants(
        [
          "GRANT USAGE ON *.* TO `sigecom_h2_runner`@`127.0.0.1`",
          "GRANT ALL PRIVILEGES ON *.* TO `sigecom_h2_runner`@`127.0.0.1`",
        ],
        1,
      ),
    /grants efectivos/i,
  );
  assert.throws(
    () =>
      assertH2E2EGrants(
        [
          "GRANT USAGE ON *.* TO `sigecom_h2_runner`@`127.0.0.1`",
          "GRANT SELECT ON `sigecom\\_h2\\_concurrency`.* TO `sigecom_h2_runner`@`127.0.0.1`",
        ],
        0,
      ),
    /grants efectivos/i,
  );
});

test("H2 E2E stops before writes when local migration inventory differs", () => {
  const local = [
    { version: "0001", name: "initial-schema", checksum: "a".repeat(64) },
  ];
  assert.doesNotThrow(() => assertH2E2EMigrations(local, local));
  assert.throws(
    () =>
      assertH2E2EMigrations(local, [{ ...local[0], checksum: "b".repeat(64) }]),
    /migraciones.*coinciden/i,
  );
});

test("fixture cleanup pattern includes separator-based operation keys", () => {
  assert.equal(
    buildH2E2EIdempotencyLikePattern("a1b2c3d4e5f6"),
    "H2E2E-a1b2c3d4e5f6%",
  );
});

test("fixture permission revocation is restricted to its generated role and dashboard.read", () => {
  assert.deepEqual(
    buildH2E2EFixturePermissionRevocation("a1b2c3d4e5f6", "dashboard.read"),
    {
      sql: `DELETE rp FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id
       WHERE r.code = ? AND p.code = ?`,
      values: ["h2e2e_a1b2c3d4e5f6_seller", "dashboard.read"],
    },
  );
  assert.throws(
    () =>
      buildH2E2EFixturePermissionRevocation(
        "a1b2c3d4e5f6",
        "permissions.manage",
      ),
    /not allowed/i,
  );
  assert.throws(
    () =>
      buildH2E2EFixturePermissionRevocation(
        "production_role",
        "dashboard.read",
      ),
    /RUN_ID/i,
  );
});
