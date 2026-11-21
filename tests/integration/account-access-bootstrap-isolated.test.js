import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import { createInitialAdmin } from "../../src/modules/users/initial-admin-bootstrap.js";
import { getAccountAccessE2EConfig } from "../../scripts/account-access-email-e2e-runner.js";

const config = getAccountAccessE2EConfig("RUN");
const { runId, attemptId, schema, credentials } = config;
let pool;

function rejectedInitialAdmin(result) {
  return (
    result.status === "rejected" &&
    /Ya existe una cuenta administradora/.test(result.reason?.message || "")
  );
}

after(async () => {
  await pool?.end();
});

test(
  "bootstrap aislado serializa dos inicializaciones reales y rechaza la siguiente",
  { concurrency: false },
  async () => {
    assert.notEqual(process.env.NODE_ENV, "production");
    assert.equal(schema, `sigecom_e2e_tmp_${runId}`);
    assert.equal(process.env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID, runId);
    assert.equal(
      process.env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID,
      attemptId,
    );
    assert.equal(process.env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA, schema);

    pool = mysql.createPool({
      host: "127.0.0.1",
      port: 3306,
      database: schema,
      user: `sgapp_${runId}`,
      password: credentials.appPassword,
      charset: "utf8mb4",
      timezone: "Z",
      connectionLimit: 4,
      connectTimeout: 5000,
      multipleStatements: false,
    });

    const [[identity]] = await pool.query(`
      SELECT VERSION() AS version,
             @@hostname AS hostname,
             @@port AS port,
             @@datadir AS datadir,
             DATABASE() AS selected_database,
             CURRENT_USER() AS current_identity
    `);
    assert.match(identity.version, /^10\.4\.32-MariaDB/);
    assert.equal(identity.hostname, "DESKTOP-8MEFFV0");
    assert.equal(Number(identity.port), 3306);
    assert.equal(identity.datadir.toLowerCase(), "c:\\xampp\\mysql\\data\\");
    assert.equal(identity.selected_database, schema);
    assert.equal(identity.current_identity, `sgapp_${runId}@localhost`);

    const [[before]] = await pool.execute(
      `SELECT COUNT(*) AS total
         FROM users AS u
         JOIN roles AS r ON r.id = u.role_id
        WHERE r.code = 'administrator'`,
    );
    const [[warehouseCount]] = await pool.execute(
      "SELECT COUNT(*) AS total FROM warehouses WHERE is_active = 1",
    );
    assert.ok(Number(warehouseCount.total) > 0);

    const emails = [
      `bootstrap-${attemptId}-a@example.invalid`,
      `bootstrap-${attemptId}-b@example.invalid`,
    ];
    const [existingBootstrapFixtures] = await pool.execute(
      "SELECT email FROM users WHERE email IN (?, ?)",
      emails,
    );
    assert.deepEqual(
      existingBootstrapFixtures,
      [],
      "ATTEMPT_ID nuevo requiere correos de bootstrap aislados",
    );
    const requests = await Promise.all(
      emails.map(async (email, index) => {
        try {
          const passwordHash = await bcrypt.hash(
            randomBytes(32).toString("base64url"),
            12,
          );
          return {
            status: "fulfilled",
            email,
            value: await createInitialAdmin({
              dbPool: pool,
              email,
              displayName: `Administrador inicial ${index + 1}`,
              passwordHash,
              lockName: `sigecom:initial-admin:${runId}`,
            }),
          };
        } catch (reason) {
          return { status: "rejected", email, reason };
        }
      }),
    );

    const created = requests.filter(({ status }) => status === "fulfilled");
    const rejected = requests.filter(({ status }) => status === "rejected");
    if (Number(before.total) === 0) {
      assert.equal(created.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(
        rejected[0].reason?.message || "",
        /Ya existe una cuenta administradora/,
      );
      const newAdmin = created[0].value;
      const [assignments] = await pool.execute(
        `SELECT warehouse_id FROM user_warehouses
          WHERE user_id = ? ORDER BY warehouse_id`,
        [newAdmin.id],
      );
      const [activeWarehouses] = await pool.execute(
        "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id",
      );
      assert.deepEqual(
        assignments.map(({ warehouse_id }) => String(warehouse_id)),
        activeWarehouses.map(({ id }) => String(id)),
      );
      const [[audit]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM audit_events
          WHERE user_id = ? AND action = 'initial_admin.created'`,
        [newAdmin.id],
      );
      assert.equal(Number(audit.total), 1);
    } else {
      assert.equal(created.length, 0);
      assert.equal(rejected.length, 2);
      assert.ok(rejected.every(rejectedInitialAdmin));
      const [unexpectedUsers] = await pool.execute(
        "SELECT email FROM users WHERE email IN (?, ?)",
        emails,
      );
      assert.deepEqual(unexpectedUsers, []);
    }

    const [[afterCount]] = await pool.execute(
      `SELECT COUNT(*) AS total
         FROM users AS u
         JOIN roles AS r ON r.id = u.role_id
        WHERE r.code = 'administrator'`,
    );
    assert.equal(
      Number(afterCount.total),
      Number(before.total) + created.length,
    );

    const repeated = await Promise.all(
      emails.map(async (_email, index) => {
        try {
          return {
            status: "fulfilled",
            value: await createInitialAdmin({
              dbPool: pool,
              email: `bootstrap-retry-${attemptId}-${index}@example.invalid`,
              displayName: "No debe crearse",
              passwordHash: await bcrypt.hash(
                randomBytes(32).toString("base64url"),
                12,
              ),
              lockName: `sigecom:initial-admin:${runId}`,
            }),
          };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      }),
    );
    assert.ok(repeated.every(rejectedInitialAdmin));
  },
);
