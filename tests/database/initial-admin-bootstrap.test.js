import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialAdmin } from "../../src/modules/users/initial-admin-bootstrap.js";

function createHarness({ warehouses = [{ id: "3" }] } = {}) {
  const state = {
    users: [],
    assignments: [],
    audits: [],
    warehouses: structuredClone(warehouses),
    lock: false,
    lockOwner: null,
    nextId: 1,
    nextWarehouseId: 50,
  };
  let nextConnectionId = 0;
  function createConnection() {
    const connectionId = ++nextConnectionId;
    return {
      async query(sql) {
        if (sql.startsWith("SELECT GET_LOCK")) {
          if (state.lockOwner !== null && state.lockOwner !== connectionId) {
            return [[{ acquired: 0 }]];
          }
          state.lockOwner = connectionId;
          state.lock = true;
          return [[{ acquired: 1 }]];
        }
        if (sql.startsWith("SELECT RELEASE_LOCK")) {
          if (state.lockOwner === connectionId) {
            state.lockOwner = null;
            state.lock = false;
          }
          return [[{ released: 1 }]];
        }
        throw new Error(`Unexpected bootstrap query: ${sql}`);
      },
      async execute(sql, params = []) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (
          normalized.includes("JOIN roles AS r") &&
          normalized.includes("r.code = 'administrator'")
        ) {
          return [
            state.users
              .filter((user) => user.role_id === 1)
              .map((user) => ({ id: user.id })),
          ];
        }
        if (normalized.startsWith("SELECT id FROM users WHERE email = ?")) {
          return [
            state.users
              .filter((user) => user.email === params[0])
              .map((user) => ({ id: user.id })),
          ];
        }
        if (
          normalized.startsWith(
            "SELECT id FROM roles WHERE code = 'administrator'",
          )
        ) {
          return [[{ id: 1 }]];
        }
        if (
          normalized.startsWith(
            "SELECT id, is_active FROM warehouses ORDER BY id",
          )
        ) {
          return [
            state.warehouses.map(({ id, is_active = 1 }) => ({
              id,
              is_active,
            })),
          ];
        }
        if (normalized.startsWith("INSERT INTO warehouses")) {
          const [code, name, location] = params;
          const id = String(state.nextWarehouseId++);
          state.warehouses.push({
            id,
            code,
            name,
            location,
            is_active: 1,
          });
          return [{ insertId: id, affectedRows: 1 }];
        }
        if (normalized.startsWith("INSERT INTO users")) {
          const [roleId, email, displayName, passwordHash] = params;
          const id = String(state.nextId++);
          state.users.push({
            id,
            role_id: roleId,
            email,
            display_name: displayName,
            password_hash: passwordHash,
            credential_state: "active",
            password_change_required: 1,
          });
          return [{ insertId: id, affectedRows: 1 }];
        }
        if (normalized.startsWith("INSERT INTO user_warehouses")) {
          const [userId, warehouseId, assignedBy] = params;
          state.assignments.push({
            user_id: String(userId),
            warehouse_id: String(warehouseId),
            assigned_by: assignedBy ?? null,
          });
          return [{ affectedRows: 1 }];
        }
        if (normalized.startsWith("INSERT INTO audit_events")) {
          state.audits.push({ sql: normalized, params });
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected bootstrap SQL: ${normalized}`);
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
    };
  }
  return {
    state,
    dbPool: {
      async getConnection() {
        return createConnection();
      },
    },
  };
}

test("initial administrator bootstrap assigns active warehouses and blocks every later run", async () => {
  const { state, dbPool } = createHarness({
    warehouses: [{ id: "3" }, { id: "9" }],
  });
  const input = {
    email: "admin@sigecom.co",
    displayName: "Administradora inicial",
    passwordHash: "$2b$12$hash",
  };

  const first = await createInitialAdmin({ dbPool, ...input });
  assert.equal(first.id, "1");
  assert.equal(state.users[0].credential_state, "active");
  assert.equal(state.users[0].password_change_required, 1);
  assert.deepEqual(
    state.assignments.map(({ warehouse_id }) => warehouse_id),
    ["3", "9"],
  );

  await assert.rejects(
    createInitialAdmin({ dbPool, ...input }),
    /Ya existe una cuenta administradora/,
  );
  assert.equal(state.users.length, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.lock, false);
});

test("bootstrap refuses to create an administrator without an active warehouse", async () => {
  const { state, dbPool } = createHarness({ warehouses: [] });

  await assert.rejects(
    createInitialAdmin({
      dbPool,
      email: "admin@sigecom.co",
      displayName: "Administradora inicial",
      passwordHash: "$2b$12$hash",
    }),
    /Debe existir al menos una bodega activa/,
  );

  assert.equal(state.users.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.lock, false);
});

test("initial bootstrap atomically creates the first warehouse and administrator", async () => {
  const { state, dbPool } = createHarness({ warehouses: [] });

  const created = await createInitialAdmin({
    dbPool,
    email: "admin@sigecom.co",
    displayName: "Administradora inicial",
    passwordHash: "$2b$12$hash",
    initialWarehouse: {
      code: "CENTRAL",
      name: "Bodega Principal",
      location: "Bogotá",
    },
  });

  assert.equal(state.warehouses.length, 1);
  assert.equal(state.warehouses[0].code, "CENTRAL");
  assert.equal(state.warehouses[0].name, "Bodega Principal");
  assert.deepEqual(created.warehouseIds, [state.warehouses[0].id]);
  assert.deepEqual(state.assignments, [
    {
      user_id: created.id,
      warehouse_id: state.warehouses[0].id,
      assigned_by: null,
    },
  ]);
  assert.equal(state.users.length, 1);
  assert.equal(state.audits.length, 2);
});

test("initial bootstrap refuses to create a second warehouse", async () => {
  const { state, dbPool } = createHarness();

  await assert.rejects(
    createInitialAdmin({
      dbPool,
      email: "admin@sigecom.co",
      displayName: "Administradora inicial",
      passwordHash: "$2b$12$hash",
      initialWarehouse: { code: "CENTRAL", name: "Bodega Principal" },
    }),
    /Ya existen bodegas/,
  );

  assert.equal(state.warehouses.length, 1);
  assert.equal(state.users.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.lock, false);
});

test("initial bootstrap validates first-warehouse fields before connecting", async () => {
  await assert.rejects(
    createInitialAdmin({
      dbPool: {
        async getConnection() {
          throw new Error("database connection should not be attempted");
        },
      },
      email: "admin@sigecom.co",
      displayName: "Administradora inicial",
      passwordHash: "$2b$12$hash",
      initialWarehouse: { code: "../unsafe", name: "" },
    }),
    /primera bodega.*válidos/i,
  );
});

test("concurrent initial-admin bootstraps can create only one administrator", async () => {
  const { state, dbPool } = createHarness();
  const input = {
    dbPool,
    email: "admin@sigecom.co",
    displayName: "Administradora inicial",
    passwordHash: "$2b$12$hash",
  };

  const attempts = await Promise.allSettled([
    createInitialAdmin(input),
    createInitialAdmin(input),
  ]);

  assert.equal(
    attempts.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = attempts.find(({ status }) => status === "rejected");
  assert.match(
    rejected.reason.message,
    /No se pudo reservar|Ya existe una cuenta administradora/,
  );
  assert.equal(state.users.length, 1);
  assert.equal(state.assignments.length, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.lock, false);
});
