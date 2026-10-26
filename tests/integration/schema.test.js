import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createConnection } from "mysql2/promise";
import { createDatabasePool } from "../../src/db/pool.js";
import { getDatabaseConfig } from "../../src/db/config.js";
import { applyMigrations } from "../../src/db/migrations.js";

const expectedTables = [
  "audit_events",
  "categories",
  "permissions",
  "roles",
  "role_permissions",
  "schema_migrations",
  "users",
  "user_sessions",
  "user_warehouses",
  "warehouses",
];

let pool;
let migratorPool;

before(() => {
  pool = createDatabasePool("test");
  migratorPool = createDatabasePool("test", "MIGRATOR");
});

after(async () => {
  if (pool) await pool.end();
  if (migratorPool) await migratorPool.end();
});

test("test migrations and role seeds can be applied repeatedly without duplicates", async () => {
  assert.deepEqual((await applyMigrations("test")).applied, []);
  assert.deepEqual((await applyMigrations("test")).applied, []);

  const [tables] = await migratorPool.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = 'sigecom_test' AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
  );
  assert.deepEqual(
    tables.map(({ TABLE_NAME }) => TABLE_NAME),
    expectedTables,
  );

  const [[roles]] = await pool.query("SELECT COUNT(*) AS count FROM roles");
  const [[permissions]] = await pool.query(
    "SELECT COUNT(*) AS count FROM permissions",
  );
  const [[rolePermissions]] = await pool.query(
    "SELECT COUNT(*) AS count FROM role_permissions",
  );
  const [[versions]] = await migratorPool.query(
    "SELECT COUNT(*) AS count FROM schema_migrations",
  );
  assert.equal(Number(roles.count), 4);
  assert.ok(Number(permissions.count) >= 35);
  assert.ok(Number(rolePermissions.count) >= Number(permissions.count));
  assert.equal(Number(versions.count), 3);

  const [categoryAssignments] = await pool.execute(
    `SELECT r.code AS role_code, p.code AS permission_code
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE p.code LIKE 'categories.%'
     ORDER BY r.code, p.code`,
  );
  assert.deepEqual(
    categoryAssignments.map(
      ({ role_code, permission_code }) => `${role_code}:${permission_code}`,
    ),
    [
      "administrator:categories.manage",
      "administrator:categories.read",
      "auditor:categories.read",
      "seller:categories.read",
      "warehouse:categories.read",
    ],
  );
});

test("all phase 1 tables use InnoDB and declared foreign keys", async () => {
  const [tables] = await migratorPool.execute(
    `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = 'sigecom_test' AND TABLE_TYPE = 'BASE TABLE'`,
  );
  assert.equal(tables.length, expectedTables.length);
  assert.ok(tables.every(({ ENGINE }) => ENGINE === "InnoDB"));

  const [[constraints]] = await migratorPool.execute(
    `SELECT COUNT(*) AS count FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = 'sigecom_test' AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  assert.equal(Number(constraints.count), 9);
});

test("database connections use UTC sessions without changing MariaDB global settings", async () => {
  const [[session]] = await pool.query(
    "SELECT @@session.time_zone AS session_time_zone",
  );
  const [[server]] = await pool.query(
    "SELECT @@global.time_zone AS global_time_zone",
  );

  assert.equal(session.session_time_zone, "+00:00");
  assert.equal(server.global_time_zone, "SYSTEM");
});

test("unique and foreign-key constraints reject invalid users without persisting probes", async () => {
  const connection = await pool.getConnection();
  const probeEmail = `migration-probe-${Date.now()}@invalid.local`;

  try {
    const [[role]] = await connection.query(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO users (role_id, email, password_hash) VALUES (?, ?, ?)",
      [role.id, probeEmail, "not-a-real-password-hash"],
    );
    await assert.rejects(
      connection.execute(
        "INSERT INTO users (role_id, email, password_hash) VALUES (?, ?, ?)",
        [role.id, probeEmail, "not-a-real-password-hash"],
      ),
      (error) => error.code === "ER_DUP_ENTRY",
    );
    await connection.rollback();

    await assert.rejects(
      connection.execute(
        "INSERT INTO users (role_id, email, password_hash) VALUES (?, ?, ?)",
        [
          0,
          `invalid-role-${Date.now()}@invalid.local`,
          "not-a-real-password-hash",
        ],
      ),
      (error) => error.code === "ER_NO_REFERENCED_ROW_2",
    );

    const [[remaining]] = await connection.execute(
      "SELECT COUNT(*) AS count FROM users WHERE email = ?",
      [probeEmail],
    );
    assert.equal(Number(remaining.count), 0);
  } finally {
    connection.release();
  }
});

test("application account cannot alter audit history or access migration metadata", async () => {
  await assert.rejects(
    pool.query("UPDATE audit_events SET action = 'tampered' WHERE id = 0"),
    (error) => error.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await assert.rejects(
    pool.query("SELECT COUNT(*) FROM schema_migrations"),
    (error) => error.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await assert.rejects(
    pool.query("CREATE TABLE sigecom_test.permission_probe (id INT NOT NULL)"),
    (error) =>
      ["ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR"].includes(
        error.code,
      ),
  );
  await assert.rejects(
    pool.query("DELETE FROM users WHERE id = 0"),
    (error) => error.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
});

test("audit details reject invalid JSON", async () => {
  await assert.rejects(
    pool.execute(
      `INSERT INTO audit_events (action, module, details)
       VALUES ('constraint.probe', 'test', 'not-json')`,
    ),
  );
});

test("migration account can read schema but cannot drop existing tables", async () => {
  const migrator = await createConnection(
    getDatabaseConfig("test", process.env, "MIGRATOR"),
  );

  try {
    const [[row]] = await migrator.query(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    );
    assert.equal(Number(row.count), 3);
    await assert.rejects(
      migrator.query("DROP TABLE sigecom_test.schema_migrations"),
      (error) =>
        ["ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR"].includes(
          error.code,
        ),
    );
  } finally {
    await migrator.end();
  }
});
