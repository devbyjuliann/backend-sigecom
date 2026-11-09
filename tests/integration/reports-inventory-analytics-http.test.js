import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";

const suffix = randomBytes(8).toString("hex");
const origin = "http://127.0.0.1:5173";
let pool;
let connection;
let app;
let cookie;
let warehouseId;
let activityDay;
let fixtureUserId;
let sqlMetrics = [];

function transactionalPool() {
  const measure = async (operation, sql, values) => {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      sqlMetrics.push({
        durationMs: performance.now() - started,
        sql: String(sql),
        values,
      });
    }
  };
  return {
    execute: (sql, values) =>
      measure(() => connection.execute(sql, values), sql, values),
    query: (sql, values) =>
      measure(() => connection.query(sql, values), sql, values),
    getConnection: async () => ({
      execute: (sql, values) =>
        measure(() => connection.execute(sql, values), sql, values),
      query: async (sql, values) => {
        if (
          /^SET TRANSACTION (ISOLATION LEVEL REPEATABLE READ|READ ONLY)/i.test(
            sql,
          )
        )
          return [[], []];
        return measure(() => connection.query(sql, values), sql, values);
      },
      beginTransaction: () => connection.query("SAVEPOINT http_inventory_read"),
      commit: () => connection.query("RELEASE SAVEPOINT http_inventory_read"),
      rollback: async () => {
        await connection.query("ROLLBACK TO SAVEPOINT http_inventory_read");
        await connection.query("RELEASE SAVEPOINT http_inventory_read");
      },
      release: () => {},
    }),
  };
}

before(async () => {
  pool = createDatabasePool("test");
  const [[database]] = await pool.query("SELECT DATABASE() AS name");
  assert.equal(database.name, "sigecom_test");
  connection = await pool.getConnection();
  await connection.beginTransaction();
  const [[role]] = await connection.execute(
    "SELECT id FROM roles WHERE code='administrator'",
  );
  const [[warehouse]] = await connection.execute(
    `SELECT w.id,MAX(io.created_at) AS latest
       FROM warehouses w JOIN inventory_balances ib ON ib.warehouse_id=w.id
       LEFT JOIN inventory_movements im ON im.warehouse_id=w.id
       LEFT JOIN inventory_operations io ON io.id=im.operation_id
      GROUP BY w.id HAVING COUNT(DISTINCT im.id)>0
      ORDER BY COUNT(DISTINCT ib.product_id) DESC,w.id LIMIT 1`,
  );
  assert.ok(warehouse, "HTTP integration requires existing balance data");
  warehouseId = String(warehouse.id);
  activityDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(warehouse.latest));
  const [user] = await connection.execute(
    `INSERT INTO users (role_id,email,password_hash,password_change_required)
     VALUES (?,?,'http-inventory-fixture-hash',0)`,
    [role.id, `inventory-http-${suffix}@sigecom.invalid`],
  );
  const userId = String(user.insertId);
  fixtureUserId = userId;
  await connection.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [userId, warehouseId],
  );
  const jti = randomUUID();
  const config = getAuthConfig({
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: origin,
  });
  const token = jwt.sign(
    { sub: userId, jti, iss: config.jwtIssuer, aud: config.jwtAudience },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.ttlSeconds },
  );
  const decoded = jwt.decode(token);
  await connection.execute(
    `INSERT INTO user_sessions (user_id,token_hash,expires_at)
     VALUES (?,?,FROM_UNIXTIME(?))`,
    [userId, createHash("sha256").update(jti).digest("hex"), decoded.exp],
  );
  cookie = `${config.cookieName}=${token}`;
  app = createApp({
    dbPool: transactionalPool(),
    authConfig: config,
    logger: createLogger({ level: "silent" }),
  });
});

after(async () => {
  if (connection) {
    await connection.rollback();
    connection.release();
  }
  if (pool) {
    const [[counts]] = await pool.execute(
      `SELECT (SELECT COUNT(*) FROM users WHERE email=?) AS users,
              (SELECT COUNT(*) FROM user_sessions WHERE user_id=?) AS sessions,
              (SELECT COUNT(*) FROM user_warehouses WHERE user_id=?) AS assignments`,
      [
        `inventory-http-${suffix}@sigecom.invalid`,
        fixtureUserId,
        fixtureUserId,
      ],
    );
    assert.equal(Number(counts.users), 0);
    assert.equal(Number(counts.sessions), 0);
    assert.equal(Number(counts.assignments), 0);
    await pool.end();
  }
});

test("Inventory reports HTTP exposes scoped data and rejects malformed queries without writes", async () => {
  const [[businessBefore]] = await connection.execute(
    `SELECT (SELECT COUNT(*) FROM inventory_operations) AS operations,
            (SELECT COUNT(*) FROM inventory_movements) AS movements,
            (SELECT COUNT(*) FROM inventory_balances) AS balances`,
  );
  const measurements = [];
  const timedGet = async (path) => {
    sqlMetrics = [];
    const started = performance.now();
    const response = await request(app).get(path).set("Cookie", cookie);
    measurements.push({
      path,
      httpMs: Number((performance.now() - started).toFixed(2)),
      sqlCalls: sqlMetrics.length,
      sqlTotalMs: Number(
        sqlMetrics
          .reduce((sum, metric) => sum + metric.durationMs, 0)
          .toFixed(2),
      ),
      sqlMaxMs: Number(
        Math.max(0, ...sqlMetrics.map((metric) => metric.durationMs)).toFixed(
          2,
        ),
      ),
      responseBytes: Buffer.byteLength(JSON.stringify(response.body)),
    });
    return response;
  };
  const balances = await timedGet(
    "/api/v1/reports/inventory/balances?page=1&pageSize=20",
  );
  assert.equal(balances.status, 200, JSON.stringify(balances.body));
  assert.equal(balances.headers["cache-control"], "private, no-store");
  assert.equal(balances.body.view, "balances");
  assert.ok(BigInt(balances.body.summary.candidatePairs) > 0n);
  assert.equal(
    balances.body.criteria.observationUnit,
    "product_warehouse_pairs",
  );
  const stockPlanQuery = sqlMetrics.find(({ sql }) => /^\s*WITH\s/i.test(sql));
  assert.ok(stockPlanQuery, "Stock HTTP should execute its analytic SQL CTE");
  const [stockPlan] = await connection.execute(
    `EXPLAIN ${stockPlanQuery.sql}`,
    stockPlanQuery.values,
  );
  const explain = {
    rowsEstimatedSum: stockPlan.reduce(
      (sum, row) => sum + Number(row.rows || 0),
      0,
    ),
    indexes: [...new Set(stockPlan.map((row) => row.key).filter(Boolean))],
    temporary: stockPlan.some((row) => /temporary/i.test(row.Extra || "")),
    filesort: stockPlan.some((row) => /filesort/i.test(row.Extra || "")),
    dependentSubqueries: stockPlan.filter((row) =>
      String(row.select_type).includes("DEPENDENT"),
    ).length,
  };
  const filteredBalances = await timedGet(
    `/api/v1/reports/inventory/balances?unit=${encodeURIComponent(balances.body.summary.units[0].unit)}&status=positive&productStatus=active&page=1&pageSize=1`,
  );
  assert.equal(filteredBalances.status, 200);
  assert.equal(filteredBalances.body.criteria.status, "positive");
  assert.equal(filteredBalances.body.pagination.pageSize, 1);
  assert.ok(
    BigInt(filteredBalances.body.summary.positivePairs) <=
      BigInt(filteredBalances.body.summary.candidatePairs),
  );
  const laterBalancePage = await timedGet(
    "/api/v1/reports/inventory/balances?page=2&pageSize=1",
  );
  assert.equal(laterBalancePage.status, 200);
  assert.equal(laterBalancePage.body.pagination.page, 2);

  const movements = await timedGet(
    `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
  );
  assert.equal(movements.status, 200);
  assert.equal(movements.headers["cache-control"], "private, no-store");
  assert.equal(movements.body.view, "movements");
  assert.ok(BigInt(movements.body.summary.candidateMovements) > 0n);
  assert.equal(movements.body.criteria.timeZone, "America/Bogota");
  assert.ok(movements.body.groups.length > 0);
  const activityPlanQuery = sqlMetrics.find(({ sql }) =>
    /^\s*WITH\s/i.test(sql),
  );
  assert.ok(
    activityPlanQuery,
    "Activity HTTP should execute its analytic SQL CTE",
  );
  const [activityPlan] = await connection.execute(
    `EXPLAIN ${activityPlanQuery.sql}`,
    activityPlanQuery.values,
  );
  const activityExplain = {
    rowsEstimatedSum: activityPlan.reduce(
      (sum, row) => sum + Number(row.rows || 0),
      0,
    ),
    indexes: [...new Set(activityPlan.map((row) => row.key).filter(Boolean))],
    temporary: activityPlan.some((row) => /temporary/i.test(row.Extra || "")),
    filesort: activityPlan.some((row) => /filesort/i.test(row.Extra || "")),
    dependentSubqueries: activityPlan.filter((row) =>
      String(row.select_type).includes("DEPENDENT"),
    ).length,
  };
  const filteredMovements = await timedGet(
    `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}&unit=${encodeURIComponent(movements.body.groups[0].unit)}&operationType=${movements.body.groups[0].operationType}&direction=IN&page=1&pageSize=1`,
  );
  assert.equal(filteredMovements.status, 200);
  assert.equal(filteredMovements.body.criteria.direction, "IN");
  assert.equal(filteredMovements.body.pagination.pageSize, 1);
  const dayBefore = new Date(`${activityDay}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 91);
  const dateFrom92 = dayBefore.toISOString().slice(0, 10);
  const movements92 = await timedGet(
    `/api/v1/reports/inventory/movements?dateFrom=${dateFrom92}&dateTo=${activityDay}&warehouseId=${warehouseId}&page=2&pageSize=1`,
  );
  assert.equal(movements92.status, 200);
  assert.equal(movements92.body.pagination.page, 2);
  assert.equal(movements92.body.criteria.dateFrom, dateFrom92);

  const warehouses = await timedGet(
    "/api/v1/reports/inventory/warehouses?view=balances",
  );
  assert.equal(warehouses.status, 200);
  assert.ok(warehouses.body.items.some((item) => item.id === warehouseId));
  assert.equal(warehouses.headers["cache-control"], "private, no-store");
  const warehouseSearch = await timedGet(
    "/api/v1/reports/inventory/warehouses?view=movements&q=__no_matching_warehouse__&page=1&pageSize=5",
  );
  assert.equal(warehouseSearch.status, 200);
  assert.deepEqual(warehouseSearch.body.items, []);
  assert.equal(warehouseSearch.body.view, "movements");

  const invalid = await request(app)
    .get(
      "/api/v1/reports/inventory/movements?dateFrom=2026-02-30&dateTo=2026-03-01",
    )
    .set("Cookie", cookie)
    .expect(400);
  assert.equal(invalid.headers["cache-control"], "private, no-store");
  const date92Start = new Date(`${activityDay}T00:00:00Z`);
  date92Start.setUTCDate(date92Start.getUTCDate() - 92);
  const invalidLongPeriod = await request(app)
    .get(
      `/api/v1/reports/inventory/movements?dateFrom=${date92Start.toISOString().slice(0, 10)}&dateTo=${activityDay}`,
    )
    .set("Cookie", cookie)
    .expect(400);
  assert.equal(invalidLongPeriod.headers["cache-control"], "private, no-store");
  const unknownFilter = await request(app)
    .get("/api/v1/reports/inventory/balances?unexpected=1")
    .set("Cookie", cookie)
    .expect(400);
  assert.equal(unknownFilter.headers["cache-control"], "private, no-store");
  const repeatedFilter = await request(app)
    .get(
      `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateFrom=${activityDay}&dateTo=${activityDay}`,
    )
    .set("Cookie", cookie)
    .expect(400);
  assert.equal(repeatedFilter.headers["cache-control"], "private, no-store");
  const overSizedPage = await request(app)
    .get("/api/v1/reports/inventory/balances?pageSize=51")
    .set("Cookie", cookie)
    .expect(400);
  assert.equal(overSizedPage.headers["cache-control"], "private, no-store");

  const foreign = await request(app)
    .get("/api/v1/reports/inventory/balances?warehouseId=18446744073709551615")
    .set("Cookie", cookie)
    .expect(404);
  assert.equal(foreign.headers["cache-control"], "private, no-store");
  assert.equal(foreign.body.error.code, "WAREHOUSE_NOT_FOUND");

  const [[stockPermission]] = await connection.execute(
    "SELECT id FROM permissions WHERE code='inventory.read'",
  );
  const [[adminRole]] = await connection.execute(
    "SELECT role_id FROM users WHERE email=?",
    [`inventory-http-${suffix}@sigecom.invalid`],
  );
  await connection.execute(
    "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
    [adminRole.role_id, stockPermission.id],
  );
  const stockDenied = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(403);
  assert.equal(stockDenied.headers["cache-control"], "private, no-store");
  const movementStillAllowed = await request(app)
    .get(
      `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(movementStillAllowed.body.view, "movements");

  await connection.execute(
    "INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)",
    [adminRole.role_id, stockPermission.id],
  );
  const [[movementPermission]] = await connection.execute(
    "SELECT id FROM permissions WHERE code='inventory.movements.read'",
  );
  await connection.execute(
    "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
    [adminRole.role_id, movementPermission.id],
  );
  const movementDenied = await request(app)
    .get(
      `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
    )
    .set("Cookie", cookie)
    .expect(403);
  assert.equal(movementDenied.headers["cache-control"], "private, no-store");
  const stockStillAllowed = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(stockStillAllowed.body.view, "balances");
  await connection.execute(
    "INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)",
    [adminRole.role_id, movementPermission.id],
  );

  const [[roleIds]] = await connection.execute(
    `SELECT
       MAX(CASE WHEN code='administrator' THEN id END) AS administrator,
       MAX(CASE WHEN code='auditor' THEN id END) AS auditor,
       MAX(CASE WHEN code='seller' THEN id END) AS seller,
       MAX(CASE WHEN code='warehouse' THEN id END) AS warehouse
     FROM roles`,
  );
  const [[fixtureUser]] = await connection.execute(
    "SELECT id,role_id FROM users WHERE email=?",
    [`inventory-http-${suffix}@sigecom.invalid`],
  );
  for (const roleCode of ["seller", "warehouse"]) {
    await connection.execute("UPDATE users SET role_id=? WHERE id=?", [
      roleIds[roleCode],
      fixtureUser.id,
    ]);
    const denied = await request(app)
      .get("/api/v1/reports/inventory/balances")
      .set("Cookie", cookie)
      .expect(403);
    assert.equal(denied.headers["cache-control"], "private, no-store");
    const movementDeniedByRole = await request(app)
      .get(
        `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
      )
      .set("Cookie", cookie)
      .expect(403);
    assert.equal(
      movementDeniedByRole.headers["cache-control"],
      "private, no-store",
    );
  }
  await connection.execute("UPDATE users SET role_id=? WHERE id=?", [
    roleIds.auditor,
    fixtureUser.id,
  ]);
  const auditorBalances = await request(app)
    .get("/api/v1/reports/inventory/balances?pageSize=1")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(auditorBalances.body.view, "balances");
  const auditorMovements = await request(app)
    .get(
      `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
    )
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(auditorMovements.body.view, "movements");
  await connection.execute("UPDATE users SET role_id=? WHERE id=?", [
    roleIds.administrator,
    fixtureUser.id,
  ]);

  for (const permissionCode of ["reports.read", "warehouses.read"]) {
    const [[permission]] = await connection.execute(
      "SELECT id FROM permissions WHERE code=?",
      [permissionCode],
    );
    await connection.execute(
      "DELETE FROM role_permissions WHERE role_id=? AND permission_id=?",
      [adminRole.role_id, permission.id],
    );
    for (const path of [
      "/api/v1/reports/inventory/balances",
      `/api/v1/reports/inventory/movements?dateFrom=${activityDay}&dateTo=${activityDay}`,
    ]) {
      const denied = await request(app)
        .get(path)
        .set("Cookie", cookie)
        .expect(403);
      assert.equal(denied.headers["cache-control"], "private, no-store");
    }
    await connection.execute(
      "INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)",
      [adminRole.role_id, permission.id],
    );
  }

  await connection.execute("UPDATE users SET is_active=0 WHERE id=?", [
    fixtureUser.id,
  ]);
  const inactive = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(401);
  assert.equal(inactive.headers["cache-control"], "private, no-store");
  await connection.execute(
    "UPDATE users SET is_active=1,password_change_required=1 WHERE id=?",
    [fixtureUser.id],
  );
  const passwordPending = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(403);
  assert.equal(passwordPending.headers["cache-control"], "private, no-store");
  await connection.execute(
    "UPDATE users SET password_change_required=0 WHERE id=?",
    [fixtureUser.id],
  );
  await connection.execute(
    "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE user_id=?",
    [fixtureUser.id],
  );
  const expired = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(401);
  assert.equal(expired.headers["cache-control"], "private, no-store");
  await connection.execute(
    "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP(3)+INTERVAL 1 HOUR WHERE user_id=?",
    [fixtureUser.id],
  );

  await connection.execute("DELETE FROM user_warehouses WHERE user_id=?", [
    fixtureUser.id,
  ]);
  const unassigned = await request(app)
    .get("/api/v1/reports/inventory/balances")
    .set("Cookie", cookie)
    .expect(200);
  assert.equal(unassigned.body.summary.candidatePairs, "0");
  await connection.execute(
    "INSERT INTO user_warehouses (user_id,warehouse_id) VALUES (?,?)",
    [fixtureUser.id, warehouseId],
  );

  const [[remaining]] = await connection.execute(
    "SELECT COUNT(*) AS count FROM users WHERE email=?",
    [`inventory-http-${suffix}@sigecom.invalid`],
  );
  assert.equal(Number(remaining.count), 1);
  const [[businessAfter]] = await connection.execute(
    `SELECT (SELECT COUNT(*) FROM inventory_operations) AS operations,
            (SELECT COUNT(*) FROM inventory_movements) AS movements,
            (SELECT COUNT(*) FROM inventory_balances) AS balances`,
  );
  assert.deepEqual(
    businessAfter,
    businessBefore,
    "GET reports must not write inventory business data",
  );
  console.log(
    `inventory HTTP local metrics ${JSON.stringify({ measurements, stockPlan: explain, activityPlan: activityExplain })}`,
  );
});
