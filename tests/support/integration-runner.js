import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { getDatabaseConfig } from "../../src/db/config.js";

export const integrationFiles = [
  "tests/integration/isolation-fixtures.test.js",
  "tests/integration/reports-sales-activity.test.js",
  "tests/integration/auth.test.js",
  "tests/integration/business-partners.test.js",
  "tests/integration/categories.test.js",
  "tests/integration/dashboard.test.js",
  "tests/integration/inventory-engine.test.js",
  "tests/integration/products.test.js",
  "tests/integration/profile.test.js",
  "tests/integration/purchases.test.js",
  "tests/integration/sales.test.js",
  "tests/integration/users.test.js",
  "tests/integration/warehouses.test.js",
  "tests/integration/role-permissions.test.js",
  "tests/integration/audit.test.js",
];

export function selectIntegrationFiles(args = []) {
  if (!args.length) return [...integrationFiles];
  if (args.length !== 2 || args[0] !== "--suite") {
    throw new Error("Uso: integration-runner.js [--suite <suite aprobada>]");
  }
  const [file] = args.slice(1);
  if (!integrationFiles.includes(file)) {
    throw new Error("La suite solicitada no está en la lista aprobada.");
  }
  return [file];
}

async function fingerprint(connection, sql, params = []) {
  const [rows] = await connection.execute(sql, params);
  return createHash("sha256")
    .update(
      rows.map((row) => JSON.stringify(Object.values(row)) + "\n").join(""),
    )
    .digest("hex");
}

export async function captureSharedState(connection) {
  const [[database]] = await connection.query("SELECT DATABASE() AS name");
  if (database.name !== "sigecom_test")
    throw new Error("Shared state fuera de sigecom_test.");
  return {
    userWarehouses: await fingerprint(
      connection,
      "SELECT user_id, warehouse_id, assigned_by, created_at FROM user_warehouses ORDER BY user_id, warehouse_id",
    ),
    rolePermissions: await fingerprint(
      connection,
      "SELECT role_id, permission_id, created_at FROM role_permissions ORDER BY role_id, permission_id",
    ),
    roles: await fingerprint(
      connection,
      "SELECT id, code, name, description, is_system, created_at, updated_at FROM roles ORDER BY id",
    ),
    activeUsers: await fingerprint(
      connection,
      "SELECT id FROM users WHERE is_active = 1 ORDER BY id",
    ),
    liveSessions: await fingerprint(
      connection,
      "SELECT id, user_id FROM user_sessions WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) ORDER BY id",
    ),
    migrations: await fingerprint(
      connection,
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    ),
    privileges: await fingerprint(
      connection,
      "SELECT scope, grantee, privilege FROM (SELECT 'SCHEMA' scope, GRANTEE grantee, PRIVILEGE_TYPE privilege FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA='sigecom_test' UNION ALL SELECT 'TABLE', GRANTEE, CONCAT(TABLE_NAME, ':', PRIVILEGE_TYPE) FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA='sigecom_test') p ORDER BY scope, grantee, privilege",
    ),
  };
}

export async function runIntegration({
  files = integrationFiles,
  run = spawn,
} = {}) {
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some((file) => !integrationFiles.includes(file)) ||
    new Set(files).size !== files.length
  ) {
    throw new Error("La lista de suites de integración no es válida.");
  }
  const lock = await mysql.createConnection(
    getDatabaseConfig("test", process.env, "MIGRATOR"),
  );
  let acquired = false;
  try {
    await lock.query("SET time_zone = '+00:00'");
    const [[identity]] = await lock.query("SELECT DATABASE() AS name");
    if (identity.name !== "sigecom_test") {
      throw new Error("Integration runner solo permite sigecom_test.");
    }
    const [[lockResult]] = await lock.execute(
      "SELECT GET_LOCK('sigecom_test_integration_runner', 0) AS acquired",
    );
    acquired = Number(lockResult.acquired) === 1;
    if (!acquired) throw new Error("Ya hay un runner de integración activo.");
    console.warn(
      "Aviso: este candado coordina solo recorridos del runner oficial; no bloquea suites individuales ni otros procesos sobre sigecom_test. No ejecutar pruebas incompatibles concurrentemente.",
    );

    for (const file of files) {
      const before = await captureSharedState(lock);
      const exitCode = await new Promise((resolve, reject) => {
        const child = run(process.execPath, ["--test", file], {
          cwd: process.cwd(),
          env: process.env,
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal) reject(new Error(`${file} terminó por señal ${signal}`));
          else resolve(code);
        });
      });
      if (exitCode !== 0) throw new Error(`${file} falló (exit ${exitCode}).`);
      const after = await captureSharedState(lock);
      for (const key of Object.keys(before)) {
        if (before[key] !== after[key]) {
          throw new Error(
            `${file} dejó estado compartido distinto en ${key}; runner detenido.`,
          );
        }
      }
      console.log(`${file}: huellas compartidas sin cambios.`);
    }
  } finally {
    if (acquired) {
      await lock.execute(
        "SELECT RELEASE_LOCK('sigecom_test_integration_runner')",
      );
    }
    await lock.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runIntegration({
      files: selectIntegrationFiles(process.argv.slice(2)),
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
