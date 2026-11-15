import { createServer } from "node:net";
import mysql from "mysql2/promise";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getMigrations } from "../../src/db/migrations.js";

export const H2_E2E_DATABASE = "sigecom_h2_concurrency";
export const H2_E2E_USER = "sigecom_h2_runner";
const H2_E2E_ACCOUNT = `${H2_E2E_USER}@127.0.0.1`;

function required(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Falta configuración H2 E2E: ${key}.`);
  }
  return value;
}

function parsePort(value, key) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} debe ser un puerto TCP válido.`);
  }
  return port;
}

export function getH2E2EConfig(env = process.env) {
  if (
    env.SIGECOM_H2_E2E_TARGET !== H2_E2E_DATABASE ||
    env.SIGECOM_H2_DATABASE !== H2_E2E_DATABASE ||
    env.SIGECOM_H2_USER !== H2_E2E_USER ||
    !env.SIGECOM_H2_PASSWORD
  ) {
    throw new Error(
      "Debe establecerse explícitamente el destino H2 E2E autorizado, su esquema y su cuenta restringida.",
    );
  }
  const runId = required(env, "SIGECOM_H2_E2E_RUN_ID");
  if (!/^[a-f0-9]{12}$/.test(runId)) {
    throw new Error(
      "SIGECOM_H2_E2E_RUN_ID debe tener 12 caracteres hexadecimales minúsculos.",
    );
  }
  const sqlHost = required(env, "SIGECOM_H2_E2E_SQL_HOST");
  const sqlPort = parsePort(
    required(env, "SIGECOM_H2_E2E_SQL_PORT"),
    "SQL_PORT",
  );
  if (sqlHost !== "127.0.0.1" || sqlPort !== 3306) {
    throw new Error("H2 E2E solo permite MariaDB en 127.0.0.1:3306.");
  }
  const apiPort = parsePort(
    required(env, "SIGECOM_H2_E2E_API_PORT"),
    "API_PORT",
  );
  const frontendPort = parsePort(
    required(env, "SIGECOM_H2_E2E_FRONTEND_PORT"),
    "FRONTEND_PORT",
  );
  if (new Set([sqlPort, apiPort, frontendPort]).size !== 3) {
    throw new Error("SQL, API y frontend deben utilizar puertos distintos.");
  }
  const jwtSecret = required(env, "SIGECOM_H2_E2E_JWT_SECRET");
  const fixturePassword = required(env, "SIGECOM_H2_E2E_FIXTURE_PASSWORD");
  if (
    Buffer.byteLength(jwtSecret, "utf8") < 32 ||
    fixturePassword.length < 20
  ) {
    throw new Error(
      "Los secretos efímeros H2 E2E no cumplen la longitud mínima.",
    );
  }
  return {
    database: H2_E2E_DATABASE,
    user: H2_E2E_USER,
    password: env.SIGECOM_H2_PASSWORD,
    runId,
    sqlHost,
    sqlPort,
    apiPort,
    frontendPort,
    frontendOrigin: `http://127.0.0.1:${frontendPort}`,
    jwtSecret,
    fixturePassword,
    resultsDir: required(env, "SIGECOM_H2_E2E_RESULTS_DIR"),
  };
}

export function assertH2E2EGrants(grants, globalPrivilegeCount) {
  const normalized = grants.map((grant) =>
    String(grant)
      .replace(/ IDENTIFIED BY PASSWORD '[^']*'/i, "")
      .toLowerCase(),
  );
  const expectedUsage =
    `grant usage on *.* to \`${H2_E2E_USER}\`@\`127.0.0.1\``.toLowerCase();
  const expectedSchemaDml =
    "grant select, insert, update, delete on `sigecom\\_h2\\_concurrency`.* to `sigecom_h2_runner`@`127.0.0.1`";
  if (
    Number(globalPrivilegeCount) !== 0 ||
    grants.length !== 2 ||
    normalized.filter((grant) => grant === expectedUsage).length !== 1 ||
    normalized.filter((grant) => grant === expectedSchemaDml).length !== 1
  ) {
    throw new Error(
      "Los grants efectivos no coinciden con la allowlist H2 E2E.",
    );
  }
}

export function assertH2E2EMigrations(local, applied) {
  const normalize = (rows) =>
    rows.map(({ version, name, checksum }) => ({
      version: String(version).padStart(4, "0"),
      name: String(name),
      checksum: String(checksum),
    }));
  if (JSON.stringify(normalize(local)) !== JSON.stringify(normalize(applied))) {
    throw new Error(
      "Los checksums de migraciones H2 E2E no coinciden con el código local.",
    );
  }
}

async function assertNoRunCollisions(connection, runId) {
  const marker = `H2E2E-${runId}`;
  const emailPattern = `h2e2e-${runId}-%@sigecom.invalid`;
  const codePattern = `${marker}-%`;
  const checks = [
    [
      "usuarios",
      "SELECT COUNT(*) AS total FROM users WHERE email LIKE ?",
      [emailPattern],
    ],
    [
      "bodegas",
      "SELECT COUNT(*) AS total FROM warehouses WHERE code LIKE ?",
      [codePattern],
    ],
    [
      "categorías",
      "SELECT COUNT(*) AS total FROM categories WHERE name LIKE ?",
      [`${marker}%`],
    ],
    [
      "productos",
      "SELECT COUNT(*) AS total FROM products WHERE sku LIKE ?",
      [codePattern],
    ],
    [
      "clientes",
      "SELECT COUNT(*) AS total FROM customers WHERE identification_number LIKE ?",
      [codePattern],
    ],
    [
      "proveedores",
      "SELECT COUNT(*) AS total FROM suppliers WHERE identification_number LIKE ?",
      [codePattern],
    ],
    [
      "órdenes de compra",
      "SELECT COUNT(*) AS total FROM purchase_orders WHERE reference LIKE ?",
      [codePattern],
    ],
    [
      "ventas",
      "SELECT COUNT(*) AS total FROM sales WHERE notes LIKE ?",
      [codePattern],
    ],
    [
      "roles",
      "SELECT COUNT(*) AS total FROM roles WHERE code LIKE ?",
      [`h2e2e_${runId}_%`],
    ],
    [
      "operaciones de inventario",
      "SELECT COUNT(*) AS total FROM inventory_operations WHERE idempotency_key LIKE ?",
      [`${marker}%`],
    ],
  ];
  for (const [label, sql, values] of checks) {
    const [[row]] = await connection.execute(sql, values);
    if (Number(row.total) !== 0) {
      throw new Error(
        `Preflight H2 E2E encontró una colisión en ${label}; se aborta sin escribir.`,
      );
    }
  }
  const [[related]] = await connection.execute(
    `SELECT
       (SELECT COUNT(*) FROM user_sessions us JOIN users u ON u.id = us.user_id WHERE u.email LIKE ?) AS sessions,
       (SELECT COUNT(*) FROM user_warehouses uw JOIN users u ON u.id = uw.user_id WHERE u.email LIKE ?) AS assignments,
       (SELECT COUNT(*) FROM purchase_receipts pr JOIN purchase_orders po ON po.id = pr.purchase_order_id WHERE po.reference LIKE ?) AS receipts,
       (SELECT COUNT(*) FROM supplier_returns sr JOIN purchase_orders po ON po.id = sr.purchase_order_id WHERE po.reference LIKE ?) AS supplier_returns,
       (SELECT COUNT(*) FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id WHERE s.notes LIKE ?) AS sale_lines,
       (SELECT COUNT(*) FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id WHERE s.notes LIKE ?) AS customer_returns,
       (SELECT COUNT(*) FROM inventory_movements im JOIN products p ON p.id = im.product_id WHERE p.sku LIKE ?) AS movements,
       (SELECT COUNT(*) FROM audit_events ae JOIN users u ON u.id = ae.user_id WHERE u.email LIKE ?) AS audit_events`,
    [
      emailPattern,
      emailPattern,
      codePattern,
      codePattern,
      codePattern,
      codePattern,
      codePattern,
      emailPattern,
    ],
  );
  if (Object.values(related).some((count) => Number(count) !== 0)) {
    throw new Error(
      "Preflight H2 E2E encontró relaciones previas para el RUN_ID; se aborta sin escribir.",
    );
  }
}

export async function verifyH2E2EConnection(
  connection,
  config,
  { checkCollisions = true } = {},
) {
  const [[identity]] = await connection.query(
    "SELECT DATABASE() AS database_name, CURRENT_USER() AS account, VERSION() AS version, @@port AS port",
  );
  if (
    identity.database_name !== H2_E2E_DATABASE ||
    identity.account !== H2_E2E_ACCOUNT ||
    !/^10\.4\.32(?:-|$)/.test(String(identity.version)) ||
    Number(identity.port) !== 3306
  ) {
    throw new Error(
      "Preflight H2 E2E rechazó identidad, esquema, versión o puerto SQL.",
    );
  }
  const [grantRows] = await connection.query("SHOW GRANTS");
  const grants = grantRows.map((row) => String(Object.values(row)[0]));
  const [[globalPrivileges]] = await connection.execute(
    `SELECT COUNT(*) AS total FROM information_schema.USER_PRIVILEGES
      WHERE GRANTEE = ? AND PRIVILEGE_TYPE <> 'USAGE'`,
    [`'${H2_E2E_USER}'@'127.0.0.1'`],
  );
  assertH2E2EGrants(grants, globalPrivileges.total);

  const [applied] = await connection.query(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  assertH2E2EMigrations(await getMigrations(), applied);
  if (checkCollisions) await assertNoRunCollisions(connection, config.runId);
  return {
    database: identity.database_name,
    account: identity.account,
    version: String(identity.version),
    migrationCount: applied.length,
  };
}

export async function runH2E2EPreflight(env = process.env) {
  const config = getH2E2EConfig(env);
  for (const port of [config.apiPort, config.frontendPort]) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        probe.close((error) => (error ? reject(error) : resolve()));
      });
    }).catch((error) => {
      throw new Error(
        `El puerto local aislado ${port} no está disponible (${error.code || "PORT"}).`,
      );
    });
  }
  const connection = await mysql.createConnection({
    host: config.sqlHost,
    port: config.sqlPort,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: 5000,
    timezone: "Z",
  });
  try {
    const verified = await verifyH2E2EConnection(connection, config);
    return { config, verified };
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runH2E2EPreflight()
    .then(({ verified }) => {
      console.log(
        `H2 E2E preflight OK: ${verified.database}, ${verified.account}, MariaDB ${verified.version}, ${verified.migrationCount} migraciones; sin colisiones del RUN_ID.`,
      );
    })
    .catch((error) => {
      console.error(
        `H2 E2E preflight rechazado (${error.code || "PREFLIGHT"}).`,
      );
      process.exitCode = 1;
    });
}
