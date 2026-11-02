import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createDatabasePool } from "../../src/db/pool.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";

let pool;

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
});

after(async () => {
  await pool?.end();
});

async function createOwnedFixture(fixtures, suffix) {
  const [[role]] = await pool.execute(
    "SELECT id FROM roles WHERE code = 'seller'",
  );
  const [[warehouse]] = await pool.execute(
    "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1",
  );
  assert.ok(role && warehouse, "The test database needs its seeded fixtures");
  const [created] = await pool.execute(
    "INSERT INTO users (role_id, email, password_hash, is_active) VALUES (?, ?, ?, 1)",
    [
      role.id,
      `isolation-${suffix}@sigecom.invalid`,
      "test-only-not-a-login-hash",
    ],
  );
  const userId = String(created.insertId);
  fixtures.user(userId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [userId, warehouse.id],
  );
  fixtures.assignment(userId, warehouse.id);
  return { userId, warehouseId: String(warehouse.id) };
}

test("fixture cleanup is idempotent and runs after a controlled setup failure", async () => {
  const normal = new IntegrationFixtures({ suite: "isolation-normal-cleanup" });
  const normalFixture = await createOwnedFixture(normal, randomUUID());
  await normal.cleanupUserAssignments(pool);
  await normal.cleanupUserAssignments(pool);
  const [[normalState]] = await pool.execute(
    `SELECT u.is_active,
       (SELECT COUNT(*) FROM user_warehouses WHERE user_id = u.id) assignments,
       (SELECT COUNT(*) FROM user_sessions WHERE user_id = u.id
        AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)) live_sessions
     FROM users u WHERE u.id = ?`,
    [normalFixture.userId],
  );
  assert.deepEqual(
    [
      Number(normalState.is_active),
      Number(normalState.assignments),
      Number(normalState.live_sessions),
    ],
    [0, 0, 0],
  );

  const failedSetup = new IntegrationFixtures({
    suite: "isolation-failed-setup",
  });
  let failedFixture;
  try {
    failedFixture = await createOwnedFixture(failedSetup, randomUUID());
    throw new Error("controlled setup failure");
  } catch (error) {
    assert.match(error.message, /controlled setup failure/);
  } finally {
    await failedSetup.cleanupUserAssignments(pool);
  }
  await failedSetup.cleanupUserAssignments(pool);
  const [[failedState]] = await pool.execute(
    `SELECT u.is_active,
       (SELECT COUNT(*) FROM user_warehouses WHERE user_id = u.id) assignments
     FROM users u WHERE u.id = ?`,
    [failedFixture.userId],
  );
  assert.deepEqual(
    [Number(failedState.is_active), Number(failedState.assignments)],
    [0, 0],
  );
});
