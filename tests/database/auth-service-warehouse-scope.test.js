import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import test from "node:test";
import { createAuthService } from "../../src/modules/auth/auth-service.js";

const config = {
  jwtSecret: "unit-test-secret-with-sufficient-entropy-1234567890",
  jwtIssuer: "sigecom-test",
  jwtAudience: "sigecom-frontend",
};

function authPool({
  role = "seller",
  assignments,
  permissions = ["sales.read"],
}) {
  const queries = [];
  return {
    queries,
    async execute(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("FROM user_sessions AS s")) {
        return [
          [
            {
              session_id: "31",
              id: "7",
              email: "user@sigecom.invalid",
              display_name: "Usuario de prueba",
              password_change_required: 0,
              role_id: "4",
              role_code: role,
            },
          ],
        ];
      }
      if (sql.includes("FROM role_permissions AS rp")) {
        return [permissions.map((code) => ({ code }))];
      }
      if (sql.includes("FROM user_warehouses AS uw")) {
        return [
          /w\.is_active\s*=\s*1/i.test(sql)
            ? assignments.filter((row) => Number(row.is_active) === 1)
            : assignments,
        ];
      }
      throw new Error(`Unexpected auth query: ${sql}`);
    },
  };
}

async function authenticate(dbPool) {
  const jti = randomUUID();
  const token = jwt.sign(
    {
      sub: "7",
      jti,
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
    },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: 300 },
  );
  return createAuthService({ dbPool, config }).authenticateToken(token);
}

test("auth preserves live assignments for history while operational scope requires an active warehouse", async () => {
  const dbPool = authPool({
    assignments: [
      { warehouse_id: "10", is_active: 1 },
      { warehouse_id: "20", is_active: 0 },
    ],
  });

  const auth = await authenticate(dbPool);

  assert.deepEqual([...auth.warehouseIds], ["10"]);
  assert.deepEqual([...auth.historicalWarehouseIds], ["10", "20"]);
  assert.deepEqual([...auth.permissions], ["sales.read"]);
  assert.ok(
    dbPool.queries.some(
      ({ sql }) =>
        sql.includes("FROM user_warehouses AS uw") &&
        !/WHERE[^;]*w\.is_active\s*=\s*1/i.test(sql),
    ),
    "assignment query must retain inactive warehouses for historical reads",
  );
});

test("unassigned warehouses never enter either authorization scope", async () => {
  const auth = await authenticate(
    authPool({ assignments: [{ warehouse_id: "10", is_active: 1 }] }),
  );

  assert.deepEqual([...auth.warehouseIds], ["10"]);
  assert.deepEqual([...auth.historicalWarehouseIds], ["10"]);
  assert.equal(auth.historicalWarehouseIds.has("20"), false);
});

test("administrator and auditor scopes preserve assignments without changing permissions", async (t) => {
  for (const role of ["administrator", "auditor"]) {
    await t.test(role, async () => {
      const permissions = ["sales.read", "reports.read"];
      const auth = await authenticate(
        authPool({
          role,
          permissions,
          assignments: [
            { warehouse_id: "10", is_active: 1 },
            { warehouse_id: "20", is_active: 0 },
          ],
        }),
      );

      assert.deepEqual([...auth.warehouseIds], ["10"]);
      assert.deepEqual([...auth.historicalWarehouseIds], ["10", "20"]);
      assert.deepEqual([...auth.permissions], permissions);
    });
  }
});
