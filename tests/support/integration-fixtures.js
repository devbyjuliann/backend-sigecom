import { randomUUID } from "node:crypto";

export class IntegrationFixtures {
  constructor({ suite }) {
    if (!suite) throw new Error("Each integration fixture needs a suite name.");
    this.suite = suite;
    this.runId = randomUUID();
    this.users = new Set();
    this.warehouses = new Set();
    this.roles = new Set();
    this.assignments = new Map();
  }

  user(id) {
    this.users.add(String(id));
    return this;
  }

  warehouse(id) {
    this.warehouses.add(String(id));
    return this;
  }

  role(id) {
    this.roles.add(String(id));
    return this;
  }

  assignment(userId, warehouseId) {
    const key = `${userId}:${warehouseId}`;
    this.assignments.set(key, {
      userId: String(userId),
      warehouseId: String(warehouseId),
    });
    return this;
  }

  ownsUser(id) {
    return this.users.has(String(id));
  }

  ownsWarehouse(id) {
    return this.warehouses.has(String(id));
  }

  get ownedUsers() {
    return [...this.users];
  }

  get ownedWarehouses() {
    return [...this.warehouses];
  }

  get ownedRoles() {
    return [...this.roles];
  }

  get ownedAssignments() {
    return [...this.assignments.values()];
  }

  async cleanupUserAssignments(pool) {
    if (!pool) return;
    const [[identity]] = await pool.query("SELECT DATABASE() AS name");
    if (identity.name !== "sigecom_test") {
      throw new Error(`Refusing ${this.suite} cleanup outside sigecom_test.`);
    }
    for (const userId of this.users) {
      await pool.execute(
        "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
        [userId],
      );
      await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [
        userId,
      ]);
      await pool.execute("DELETE FROM user_warehouses WHERE user_id = ?", [
        userId,
      ]);
    }
    for (const warehouseId of this.warehouses) {
      await pool.execute("DELETE FROM user_warehouses WHERE warehouse_id = ?", [
        warehouseId,
      ]);
    }
    for (const { userId, warehouseId } of this.assignments.values()) {
      if (this.users.has(userId) || this.warehouses.has(warehouseId)) continue;
      await pool.execute(
        "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
        [userId, warehouseId],
      );
    }
  }
}
