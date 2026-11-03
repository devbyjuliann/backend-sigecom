import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { IntegrationFixtures } from "../support/integration-fixtures.js";

let pool;
let app;
let fixtures;
let users;
let fixtureConnection;
let activeAuditConnection;
let event;
let excludedEvents;
let historicalReferences;
let warehouseIds;
let auditQueries;
let baselineAuditFingerprint;
let syntheticAuditIds = [];
let fixtureMarker;
let fixtureTimestamp;

const credentials = `Audit-check-${randomUUID()}-Long!`;

function localDate(value) {
  const date =
    value instanceof Date
      ? value
      : new Date(`${String(value).replace(" ", "T")}Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value: part }) => [type, part]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

async function createActor(
  roleCode,
  warehouseId,
  suffix,
  { passwordChangeRequired = false } = {},
) {
  const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [
    roleCode,
  ]);
  assert.ok(role, `Debe existir el rol ${roleCode}`);
  const email = `audit-${suffix}-${randomUUID()}@sigecom.invalid`;
  const passwordHash = await bcrypt.hash(credentials, 10);
  const [inserted] = await pool.execute(
    `INSERT INTO users
       (role_id, email, display_name, password_hash, is_active, password_change_required)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [
      role.id,
      email,
      `Fixture Auditoría ${suffix}`,
      passwordHash,
      Number(passwordChangeRequired),
    ],
  );
  const userId = String(inserted.insertId);
  fixtures.user(userId);
  await pool.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
    [userId, warehouseId],
  );
  fixtures.assignment(userId, warehouseId);
  const authConfig = getAuthConfig(process.env);
  const jti = randomUUID();
  const token = jwt.sign(
    {
      sub: userId,
      jti,
      iss: authConfig.jwtIssuer,
      aud: authConfig.jwtAudience,
    },
    authConfig.jwtSecret,
    { algorithm: "HS256", expiresIn: authConfig.ttlSeconds },
  );
  const claims = jwt.decode(token);
  await pool.execute(
    "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [
      userId,
      createHash("sha256").update(jti).digest("hex"),
      new Date(claims.exp * 1000),
    ],
  );
  return { id: userId, roleCode, token, email };
}

async function fingerprintTables(connection = pool) {
  const hash = createHash("sha256");
  const writeSensitiveTables = [
    "audit_events",
    "customer_return_lines",
    "customer_returns",
    "inventory_balances",
    "inventory_movements",
    "inventory_operations",
    "purchase_order_lines",
    "purchase_orders",
    "purchase_receipt_lines",
    "purchase_receipts",
    "role_permissions",
    "sale_cancellations",
    "sale_lines",
    "sale_requests",
    "sales",
    "supplier_return_lines",
    "supplier_returns",
    "user_sessions",
    "user_warehouses",
  ];
  for (const table of writeSensitiveTables.sort()) {
    const [rows] = await connection.query(
      `SELECT * FROM \`${table}\` ORDER BY 1, 2`,
    );
    hash.update(`${table}\n`);
    for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

async function fingerprintAuditEvents(connection) {
  const hash = createHash("sha256");
  const [rows] = await connection.query(
    "SELECT * FROM audit_events ORDER BY id",
  );
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

async function insertSyntheticEvent({
  actorId,
  action,
  module = "sales",
  entityType = "sale",
  entityId = String(
    9000000000000000000n + BigInt(syntheticAuditIds.length + 1),
  ),
  details,
  createdAt = fixtureTimestamp,
}) {
  const [result] = await (activeAuditConnection || pool).execute(
    `INSERT INTO audit_events
       (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorId,
      action,
      module,
      entityType,
      entityId,
      details === null ? null : JSON.stringify(details),
      "203.0.113.42",
      fixtureMarker,
      createdAt,
    ],
  );
  const id = String(result.insertId);
  syntheticAuditIds.push(id);
  return id;
}

async function getAs(actor, path) {
  return request(app)
    .get(path)
    .set("Cookie", `sigecom_session=${encodeURIComponent(actor.token)}`)
    .set("Accept", "application/json");
}

before(async () => {
  pool = createDatabasePool("test");
  const [[identity]] = await pool.query(
    "SELECT DATABASE() AS name, VERSION() AS version",
  );
  assert.equal(identity.name, "sigecom_test");
  assert.match(identity.version, /^10\.4\.32-MariaDB/i);
  fixtures = new IntegrationFixtures({ suite: "audit-read-only" });
  fixtureMarker = `SIGECOM-AUDIT-TEST:${fixtures.runId}`;
  baselineAuditFingerprint = await fingerprintAuditEvents(pool);

  const [warehouseRows] = await pool.query(
    "SELECT id FROM warehouses ORDER BY id LIMIT 3",
  );
  assert.ok(
    warehouseRows.length === 3,
    "La prueba requiere tres bodegas persistidas",
  );
  warehouseIds = warehouseRows.map(({ id }) => String(id));
  const [[clock]] = await pool.query(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(3) - INTERVAL 1 SECOND, '%Y-%m-%d %H:%i:%s.000') AS value",
  );
  fixtureTimestamp = clock.value;

  const [eventRows] = await pool.execute(
    `SELECT ae.id, ae.entity_id, ae.created_at, w.is_active
       FROM audit_events ae JOIN warehouses w ON w.id = CAST(ae.entity_id AS UNSIGNED)
      WHERE ae.module = 'warehouses' AND ae.action = 'warehouses.created'
        AND ae.entity_type = 'warehouse'
        AND ae.entity_id REGEXP '^[1-9][0-9]{0,19}$'
      ORDER BY w.is_active, ae.created_at DESC, ae.id DESC LIMIT 1`,
  );
  assert.ok(
    eventRows[0],
    "La base de test requiere un evento histórico de creación de bodega",
  );
  event = { ...eventRows[0], warehouseId: String(eventRows[0].entity_id) };
  assert.equal(
    Number(event.is_active),
    0,
    "se prioriza una bodega inactiva con asignación histórica persistida",
  );
  const [[foreignEvent]] = await pool.execute(
    `SELECT id FROM audit_events
      WHERE module = 'warehouses' AND action = 'warehouses.created'
        AND entity_type = 'warehouse' AND entity_id REGEXP '^[1-9][0-9]{0,19}$'
        AND entity_id <> ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [event.warehouseId],
  );
  assert.ok(
    foreignEvent,
    "La prueba requiere un evento histórico de otra bodega",
  );
  event.foreignEventId = String(foreignEvent.id);
  warehouseIds = [
    event.warehouseId,
    ...warehouseIds.filter((id) => id !== event.warehouseId).slice(0, 2),
  ];

  const [[purchaseOrderEvent]] = await pool.execute(
    `SELECT id FROM audit_events WHERE module = 'purchases'
       AND action = 'purchases.order_created' AND entity_type = 'purchase_order'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const [[cancelledDraftEvent]] = await pool.execute(
    `SELECT id FROM audit_events WHERE module = 'sales'
       AND action = 'sales.draft_cancelled' AND entity_type = 'sale'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.ok(
    purchaseOrderEvent && cancelledDraftEvent,
    "La base requiere variantes históricas que la política excluye",
  );
  excludedEvents = {
    purchaseOrder: String(purchaseOrderEvent.id),
    cancelledDraft: String(cancelledDraftEvent.id),
  };

  const [[legacyReceipt]] = await pool.execute(
    `SELECT ae.id, CAST(io.source_warehouse_id AS CHAR) AS warehouse_id
       FROM audit_events ae
       JOIN purchase_receipts pr ON pr.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.receiptId')) AS UNSIGNED)
       JOIN purchase_orders po ON po.id = pr.purchase_order_id
       JOIN inventory_operations io ON io.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceOperationId')) AS UNSIGNED)
      WHERE ae.module = 'purchases' AND ae.action = 'purchases.receipt_confirmed'
        AND ae.entity_type = 'purchase_order' AND BINARY io.source_id = BINARY CAST(pr.id AS CHAR)
        AND io.source_warehouse_id = po.warehouse_id LIMIT 1`,
  );
  const [[returnWithoutRestock]] = await pool.execute(
    `SELECT ae.id, CAST(issue.source_warehouse_id AS CHAR) AS warehouse_id
       FROM audit_events ae
       JOIN customer_returns cr ON cr.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.returnId')) AS UNSIGNED)
       JOIN inventory_operations issue ON issue.operation_type = 'sale_issue'
        AND issue.source_type = 'sale' AND BINARY issue.source_id = BINARY ae.entity_id
      WHERE ae.module = 'sales' AND ae.action = 'sales.return_confirmed'
        AND cr.source_operation_id IS NULL LIMIT 1`,
  );
  assert.ok(
    legacyReceipt && returnWithoutRestock,
    "La base requiere una recepción heredada y una devolución sin reintegro",
  );
  historicalReferences = { legacyReceipt, returnWithoutRestock };

  users = {
    administrator: await createActor(
      "administrator",
      event.warehouseId,
      "administrator",
    ),
    auditor: await createActor("auditor", event.warehouseId, "auditor"),
    policyAuditor: await createActor("auditor", event.warehouseId, "policy"),
    seller: await createActor("seller", event.warehouseId, "seller"),
    warehouse: await createActor("warehouse", event.warehouseId, "warehouse"),
    passwordPending: await createActor(
      "auditor",
      event.warehouseId,
      "password-pending",
      { passwordChangeRequired: true },
    ),
    receiptAuditor: await createActor(
      "auditor",
      legacyReceipt.warehouse_id,
      "legacy-receipt",
    ),
    returnAuditor: await createActor(
      "auditor",
      returnWithoutRestock.warehouse_id,
      "return-without-restock",
    ),
    uncoveredAuditor: await createActor(
      "auditor",
      warehouseIds[2],
      "uncovered",
    ),
  };
  for (const warehouseId of warehouseIds.slice(1)) {
    await pool.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
      [users.administrator.id, warehouseId],
    );
    fixtures.assignment(users.administrator.id, warehouseId);
  }

  const authConfig = getAuthConfig(process.env);
  auditQueries = [];
  const tracedPool = {
    async execute(sql, values) {
      if (
        sql.startsWith("SELECT v.created_at") ||
        sql.startsWith("SELECT DISTINCT v.module")
      )
        auditQueries.push({ sql, values });
      return (activeAuditConnection || pool).execute(sql, values);
    },
  };
  app = createApp({ dbPool: tracedPool, authConfig });
});

after(async () => {
  try {
    if (fixtureConnection) await fixtureConnection.rollback();
    activeAuditConnection = null;
    await fixtures?.cleanupUserAssignments(pool);
    if (baselineAuditFingerprint) {
      assert.equal(
        await fingerprintAuditEvents(pool),
        baselineAuditFingerprint,
        "el setup/cleanup debe restaurar exactamente la huella previa de audit_events",
      );
    }
  } finally {
    fixtureConnection?.release();
    await pool?.end();
  }
});

test("lectura autenticada permite Administrador y Auditor y rechaza Vendedor, Bodega y cambio de contraseña pendiente", async () => {
  const date = localDate(event.created_at);
  const path = `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&module=warehouses&action=warehouses.created&warehouseId=${event.warehouseId}`;
  const administrator = await getAs(users.administrator, path);
  const auditor = await getAs(users.auditor, path);
  const seller = await getAs(users.seller, path);
  const warehouse = await getAs(users.warehouse, path);
  const pending = await getAs(users.passwordPending, path);

  assert.equal(administrator.status, 200, JSON.stringify(administrator.body));
  assert.equal(auditor.status, 200, JSON.stringify(auditor.body));
  assert.ok(
    administrator.body.items.some(({ id }) => String(id) === String(event.id)),
  );
  assert.ok(
    auditor.body.items.some(({ id }) => String(id) === String(event.id)),
  );
  assert.equal(seller.status, 403);
  assert.equal(warehouse.status, 403);
  assert.equal(pending.status, 403);
  for (const response of [administrator, auditor, seller, warehouse, pending])
    assert.match(response.headers["cache-control"], /no-store/);
});

test("listado, opciones y detalle comparten el alcance y no revelan la bodega ajena", async () => {
  const before = await fingerprintTables();
  const date = localDate(event.created_at);
  const base = `dateFrom=${date}&dateTo=${date}&module=warehouses&action=warehouses.created`;
  const listed = await getAs(
    users.auditor,
    `/api/v1/audit-events?${base}&warehouseId=${event.warehouseId}`,
  );
  const detail = await getAs(users.auditor, `/api/v1/audit-events/${event.id}`);
  const options = await getAs(
    users.auditor,
    `/api/v1/audit-events/filter-options?${base}`,
  );
  const unauthorizedList = await getAs(
    users.auditor,
    `/api/v1/audit-events?${base}&warehouseId=${warehouseIds.find((id) => id !== event.warehouseId)}`,
  );
  const unauthorizedOptions = await getAs(
    users.auditor,
    `/api/v1/audit-events/filter-options?${base}&warehouseId=${warehouseIds.find((id) => id !== event.warehouseId)}`,
  );
  const unauthorizedDetail = await getAs(
    users.auditor,
    `/api/v1/audit-events/${event.foreignEventId}`,
  );
  const missingDetail = await getAs(
    users.auditor,
    "/api/v1/audit-events/18446744073709551615",
  );

  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.ok(
    listed.body.items.some(({ id }) => String(id) === String(event.id)),
  );
  assert.equal(detail.body.id, String(event.id));
  assert.deepEqual(options.body.warehouses, [
    { id: event.warehouseId, label: `Bodega #${event.warehouseId}` },
  ]);
  assert.equal(unauthorizedList.status, 200);
  assert.deepEqual(unauthorizedList.body.items, []);
  assert.equal(unauthorizedOptions.status, 200);
  assert.equal(
    unauthorizedOptions.body.warehouses.some(
      ({ id }) => id !== event.warehouseId,
    ),
    false,
  );
  assert.equal(unauthorizedDetail.status, missingDetail.status);
  assert.equal(unauthorizedDetail.body.error.code, "AUDIT_EVENT_NOT_FOUND");
  assert.equal(missingDetail.body.error.code, "AUDIT_EVENT_NOT_FOUND");
  assert.equal(
    await fingerprintTables(),
    before,
    "GETs de Auditoría no deben cambiar eventos, sesiones ni asignaciones/permisos",
  );
});

test("la paginación devuelve un cursor opaco y conserva el filtro y el orden descendente", async () => {
  const date = localDate(event.created_at);
  const path = `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&module=warehouses&action=warehouses.created&pageSize=1`;
  const first = await getAs(users.auditor, path);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.items.length <= 1);
  if (first.body.pagination.hasMore) {
    const cursor = first.body.pagination.nextCursor;
    assert.match(cursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const second = await getAs(
      users.auditor,
      `${path}&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.items[0]?.id, first.body.items[0]?.id);
    const mismatched = await getAs(
      users.auditor,
      `${path.replace("module=warehouses", "module=auth")}&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.body.error.code, "INVALID_AUDIT_CURSOR");
  }
});

test("las referencias históricas de recepción y devolución se verifican sin reconstruir alcance desde la orden actual", async () => {
  const receipt = await getAs(
    users.receiptAuditor,
    `/api/v1/audit-events/${historicalReferences.legacyReceipt.id}`,
  );
  const customerReturn = await getAs(
    users.returnAuditor,
    `/api/v1/audit-events/${historicalReferences.returnWithoutRestock.id}`,
  );
  const excludedOrder = await getAs(
    users.administrator,
    `/api/v1/audit-events/${excludedEvents.purchaseOrder}`,
  );
  const excludedDraftCancellation = await getAs(
    users.administrator,
    `/api/v1/audit-events/${excludedEvents.cancelledDraft}`,
  );
  const options = await getAs(
    users.administrator,
    "/api/v1/audit-events/filter-options?module=purchases",
  );

  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.action, "purchases.receipt_confirmed");
  assert.equal(receipt.body.entity.type, "purchase_order");
  assert.deepEqual(receipt.body.warehouses, [
    {
      id: historicalReferences.legacyReceipt.warehouse_id,
      label: `Bodega #${historicalReferences.legacyReceipt.warehouse_id}`,
    },
  ]);
  assert.equal(customerReturn.status, 200, JSON.stringify(customerReturn.body));
  assert.equal(customerReturn.body.action, "sales.return_confirmed");
  assert.equal(excludedOrder.status, 404);
  assert.equal(excludedOrder.body.error.code, "AUDIT_EVENT_NOT_FOUND");
  assert.equal(excludedDraftCancellation.status, 404);
  assert.equal(
    excludedDraftCancellation.body.error.code,
    "AUDIT_EVENT_NOT_FOUND",
  );
  assert.equal(options.body.actions.includes("purchases.order_created"), false);
});

test("la revocación de una sesión surte efecto en la siguiente consulta", async () => {
  await pool.execute(
    "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ?",
    [users.auditor.id],
  );
  const before = await fingerprintTables();
  const response = await getAs(
    users.auditor,
    "/api/v1/audit-events/filter-options",
  );
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "SESSION_INVALID");
  assert.equal(await fingerprintTables(), before);
});

test("los días de Bogotá usan inicio UTC inclusivo y el siguiente día exclusivo; valida el rango", async () => {
  const initialQueryCount = auditQueries.length;
  const boundary = await getAs(
    users.administrator,
    "/api/v1/audit-events?dateFrom=2026-11-02&dateTo=2026-11-02&pageSize=20",
  );
  assert.equal(boundary.status, 200, JSON.stringify(boundary.body));
  const query = auditQueries
    .slice(initialQueryCount)
    .find(({ sql }) => sql.includes("ORDER BY v.created_at DESC"));
  assert.ok(query, "el listado debe ejecutar su consulta de límite superior");
  assert.deepEqual(query.values.slice(-2), [
    "2026-11-02 05:00:00.000",
    "2026-11-03 05:00:00.000",
  ]);

  const invalidCalendarDate = await getAs(
    users.administrator,
    "/api/v1/audit-events?dateFrom=2026-02-30&dateTo=2026-02-30",
  );
  const tooWide = await getAs(
    users.administrator,
    "/api/v1/audit-events?dateFrom=2025-11-01&dateTo=2026-11-02",
  );
  const excessivePageSize = await getAs(
    users.administrator,
    "/api/v1/audit-events?pageSize=101",
  );
  assert.equal(invalidCalendarDate.status, 400);
  assert.equal(invalidCalendarDate.body.error.code, "INVALID_AUDIT_FILTERS");
  assert.equal(tooWide.status, 400);
  assert.equal(tooWide.body.error.code, "INVALID_AUDIT_FILTERS");
  assert.equal(excessivePageSize.status, 400);
  assert.equal(excessivePageSize.body.error.code, "INVALID_AUDIT_FILTERS");
});

test("fixtures sintéticos verifican cobertura histórica multibodega, arrays y variantes indeterminadas", async (t) => {
  fixtureConnection = await pool.getConnection();
  await fixtureConnection.beginTransaction();
  activeAuditConnection = fixtureConnection;
  t.after(async () => {
    await fixtureConnection.rollback();
    activeAuditConnection = null;
    fixtureConnection.release();
    fixtureConnection = null;
  });
  const warehouseState = [];
  for (const warehouseId of warehouseIds) {
    const [[state]] = await pool.execute(
      "SELECT id, is_active FROM warehouses WHERE id = ?",
      [warehouseId],
    );
    if (state) warehouseState.push(state);
  }
  assert.equal(warehouseState.length, 3);
  assert.ok(
    warehouseState.some(
      (warehouse) =>
        String(warehouse.id) === event.warehouseId && !warehouse.is_active,
    ),
    "una asignación histórica inactiva debe quedar cubierta por el actor asignado",
  );

  const [actorAssignmentsBefore] = await pool.execute(
    "SELECT CAST(warehouse_id AS CHAR) id FROM user_warehouses WHERE user_id = ? ORDER BY warehouse_id",
    [users.administrator.id],
  );
  assert.deepEqual(
    actorAssignmentsBefore.map(({ id }) => id).sort(),
    [...warehouseIds].sort(),
  );
  const multiDetails = {
    expectedVersion: 1,
    version: 2,
    previous: { warehouseId: warehouseIds[0] },
    current: { warehouseId: warehouseIds[1] },
  };
  const [[mismatchedIssue]] = await pool.execute(
    `SELECT CAST(id AS CHAR) id, source_id
       FROM inventory_operations
      WHERE operation_type = 'sale_issue' AND source_type = 'sale'
        AND source_warehouse_id <> ?
      ORDER BY id DESC LIMIT 1`,
    [warehouseIds[0]],
  );
  assert.ok(
    mismatchedIssue,
    "la prueba requiere una referencia de venta real de otra bodega para fabricar una contradicción aislada",
  );
  const [[sourceWarehouse]] = await pool.execute(
    `SELECT CAST(source_warehouse_id AS CHAR) id
       FROM inventory_operations WHERE id = ?`,
    [mismatchedIssue.id],
  );
  const [[adminHasSourceWarehouse]] = await fixtureConnection.execute(
    "SELECT 1 present FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [users.administrator.id, sourceWarehouse.id],
  );
  if (!adminHasSourceWarehouse) {
    await fixtureConnection.execute(
      "INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)",
      [users.administrator.id, sourceWarehouse.id],
    );
  }
  const synthetic = {
    accessibleSingle: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      action: "sales.draft_updated",
      details: {
        expectedVersion: 1,
        version: 2,
        previous: { warehouseId: warehouseIds[0] },
        current: { warehouseId: warehouseIds[0] },
      },
    }),
    unauthorizedSingle: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      action: "sales.draft_updated",
      details: {
        expectedVersion: 1,
        version: 2,
        previous: { warehouseId: warehouseIds[1] },
        current: { warehouseId: warehouseIds[1] },
      },
    }),
    multi: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      action: "sales.draft_updated",
      details: multiDetails,
    }),
    changedWarehouse: await insertSyntheticEvent({
      actorId: users.administrator.id,
      action: "sales.draft_updated",
      details: multiDetails,
    }),
    noWarehouseCoverage: await insertSyntheticEvent({
      actorId: users.uncoveredAuditor.id,
      action: "sales.draft_updated",
      details: multiDetails,
    }),
    incompleteSnapshot: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      action: "sales.draft_updated",
      details: {
        expectedVersion: 1,
        version: 2,
        previous: { warehouseId: warehouseIds[0] },
        current: { warehouseId: "not-a-warehouse-id" },
      },
    }),
    contradictoryReference: await insertSyntheticEvent({
      actorId: users.administrator.id,
      action: "sales.confirmed",
      entityId: mismatchedIssue.source_id,
      details: {
        sourceOperationId: mismatchedIssue.id,
        warehouseId: warehouseIds[0],
      },
    }),
    unknownAction: await insertSyntheticEvent({
      actorId: users.administrator.id,
      action: "sales.unregistered_action",
      details: { warehouseId: warehouseIds[0] },
    }),
    missingCommercialReference: await insertSyntheticEvent({
      actorId: users.administrator.id,
      action: "sales.confirmed",
      details: {
        sourceOperationId: "18446744073709551613",
        warehouseId: warehouseIds[0],
      },
    }),
    sessionPrivacy: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "auth",
      action: "auth.login_succeeded",
      entityType: "user_session",
      entityId: "987654321",
      details: {
        method: "password",
        password: "synthetic-secret",
        password_hash: "$2b$10$synthetic-hash",
        token: "synthetic-jwt",
        cookie: "sigecom_session=synthetic-cookie",
      },
    }),
  };
  const arrayCases = {
    valid: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "users",
      action: "users.created",
      entityType: "user",
      entityId: "880001",
      details: { warehouseIds: [warehouseIds[0]] },
    }),
    invalid: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "users",
      action: "users.created",
      entityType: "user",
      entityId: "880002",
      details: { warehouseIds: ["invalid"] },
    }),
    duplicate: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "users",
      action: "users.created",
      entityType: "user",
      entityId: "880003",
      details: { warehouseIds: [warehouseIds[0], warehouseIds[0]] },
    }),
    excessive: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "users",
      action: "users.created",
      entityType: "user",
      entityId: "880004",
      details: { warehouseIds: Array(65).fill(warehouseIds[0]) },
    }),
    incompleteCoverage: await insertSyntheticEvent({
      actorId: users.policyAuditor.id,
      module: "users",
      action: "users.created",
      entityType: "user",
      entityId: "880005",
      details: { warehouseIds: [warehouseIds[0], warehouseIds[1]] },
    }),
  };

  const pageEvents = [];
  for (let index = 0; index < 3; index += 1) {
    pageEvents.push(
      await insertSyntheticEvent({
        actorId: users.administrator.id,
        action: "sales.draft_updated",
        details: {
          expectedVersion: index + 1,
          version: index + 2,
          previous: { warehouseId: warehouseIds[0] },
          current: { warehouseId: warehouseIds[0] },
        },
      }),
    );
  }
  const auditorPageEvents = [];
  for (let index = 0; index < 2; index += 1) {
    auditorPageEvents.push(
      await insertSyntheticEvent({
        actorId: users.policyAuditor.id,
        action: "sales.draft_updated",
        details: {
          expectedVersion: index + 1,
          version: index + 2,
          previous: { warehouseId: warehouseIds[0] },
          current: { warehouseId: warehouseIds[0] },
        },
      }),
    );
  }
  const foreignDuringPaging = await insertSyntheticEvent({
    actorId: users.policyAuditor.id,
    action: "sales.draft_updated",
    details: {
      expectedVersion: 1,
      version: 2,
      previous: { warehouseId: warehouseIds[1] },
      current: { warehouseId: warehouseIds[1] },
    },
    createdAt: new Date(
      new Date(fixtureTimestamp.replace(" ", "T") + "Z").getTime() - 5,
    )
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
  });
  const beforeGets = await fingerprintTables(fixtureConnection);

  const date = localDate(fixtureTimestamp);
  const urlFor = (actor) =>
    `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&actorId=${actor.id}&pageSize=100`;
  const visible = await getAs(
    users.policyAuditor,
    `${urlFor(users.policyAuditor)}&module=sales&action=sales.draft_updated`,
  );
  const fullAccess = await getAs(
    users.administrator,
    `${urlFor(users.policyAuditor)}&module=sales&action=sales.draft_updated`,
  );
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  assert.ok(
    visible.body.items.some(({ id }) => id === synthetic.accessibleSingle),
  );
  assert.equal(
    visible.body.items.some(({ id }) => id === synthetic.unauthorizedSingle),
    false,
  );
  assert.equal(
    visible.body.items.some(({ id }) => id === synthetic.multi),
    false,
  );
  assert.equal(
    visible.body.items.some(({ id }) => id === synthetic.incompleteSnapshot),
    false,
  );
  assert.ok(fullAccess.body.items.some(({ id }) => id === synthetic.multi));
  const administratorOwnEvents = await getAs(
    users.administrator,
    `${urlFor(users.administrator)}&module=sales&action=sales.draft_updated`,
  );
  assert.ok(
    administratorOwnEvents.body.items.some(
      ({ id }) => id === synthetic.changedWarehouse,
    ),
  );
  assert.equal(
    administratorOwnEvents.body.items.some(
      ({ id }) => id === synthetic.contradictoryReference,
    ),
    false,
  );
  assert.equal(
    administratorOwnEvents.body.items.some(
      ({ id }) => id === synthetic.unknownAction,
    ),
    false,
  );
  assert.equal(
    administratorOwnEvents.body.items.some(
      ({ id }) => id === synthetic.missingCommercialReference,
    ),
    false,
  );
  assert.equal(await fingerprintTables(fixtureConnection), beforeGets);
  const pageBase = `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&module=sales&action=sales.draft_updated&actorId=${users.administrator.id}&pageSize=1`;
  const pageOne = await getAs(users.administrator, pageBase);
  assert.equal(pageOne.status, 200, JSON.stringify(pageOne.body));
  const upperBoundPageIds = [synthetic.changedWarehouse, ...pageEvents].sort(
    (left, right) => (BigInt(left) > BigInt(right) ? -1 : 1),
  );
  assert.equal(pageOne.body.items[0].id, upperBoundPageIds[0]);
  const upperBound = pageOne.body.pagination.nextCursor;
  assert.ok(upperBound, "debe continuar la secuencia de timestamps iguales");
  const laterInsert = await insertSyntheticEvent({
    actorId: users.administrator.id,
    action: "sales.draft_updated",
    details: {
      expectedVersion: 8,
      version: 9,
      previous: { warehouseId: warehouseIds[0] },
      current: { warehouseId: warehouseIds[0] },
    },
  });
  const allPageIds = [pageOne.body.items[0].id];
  const beforePageGets = await fingerprintTables(fixtureConnection);
  let cursor = upperBound;
  while (cursor) {
    const page = await getAs(
      users.administrator,
      `${pageBase}&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(page.status, 200, JSON.stringify(page.body));
    allPageIds.push(...page.body.items.map(({ id }) => id));
    cursor = page.body.pagination.nextCursor;
  }
  assert.deepEqual(allPageIds, upperBoundPageIds);
  assert.equal(new Set(allPageIds).size, allPageIds.length);
  assert.equal(allPageIds.includes(laterInsert), false);
  assert.equal(await fingerprintTables(fixtureConnection), beforePageGets);

  const cursorParts = upperBound.split(".");
  cursorParts[0] = `${cursorParts[0][0] === "A" ? "B" : "A"}${cursorParts[0].slice(1)}`;
  const tamperedCursor = cursorParts.join(".");
  const tampered = await getAs(
    users.administrator,
    `${pageBase}&cursor=${encodeURIComponent(tamperedCursor)}`,
  );
  assert.equal(tampered.status, 400);
  assert.equal(tampered.body.error.code, "INVALID_AUDIT_CURSOR");
  const changedFilters = await getAs(
    users.administrator,
    `${pageBase.replace("module=sales", "module=auth")}&cursor=${encodeURIComponent(upperBound)}`,
  );
  assert.equal(changedFilters.status, 400);
  assert.equal(changedFilters.body.error.code, "INVALID_AUDIT_CURSOR");

  const authLostPage = await getAs(users.administrator, pageBase);
  assert.ok(authLostPage.body.pagination.nextCursor);
  const [[restoredAssignment]] = await fixtureConnection.execute(
    "SELECT assigned_by, created_at FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [users.administrator.id, warehouseIds[1]],
  );
  await fixtureConnection.execute(
    "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
    [users.administrator.id, warehouseIds[1]],
  );
  const authLost = await getAs(
    users.administrator,
    `${pageBase}&cursor=${encodeURIComponent(authLostPage.body.pagination.nextCursor)}`,
  );
  assert.equal(authLost.status, 400);
  assert.equal(authLost.body.error.code, "INVALID_AUDIT_CURSOR");
  await fixtureConnection.execute(
    "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by, created_at) VALUES (?, ?, ?, ?)",
    [
      users.administrator.id,
      warehouseIds[1],
      restoredAssignment.assigned_by,
      restoredAssignment.created_at,
    ],
  );

  const auditorPageBase = `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&module=sales&action=sales.draft_updated&actorId=${users.policyAuditor.id}&pageSize=1`;
  const beforeAuditorGets = await fingerprintTables(fixtureConnection);
  const auditorFirst = await getAs(users.policyAuditor, auditorPageBase);
  assert.equal(auditorFirst.status, 200, JSON.stringify(auditorFirst.body));
  const auditorIds = [...auditorFirst.body.items.map(({ id }) => id)];
  cursor = auditorFirst.body.pagination.nextCursor;
  while (cursor) {
    const page = await getAs(
      users.policyAuditor,
      `${auditorPageBase}&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(page.status, 200, JSON.stringify(page.body));
    auditorIds.push(...page.body.items.map(({ id }) => id));
    cursor = page.body.pagination.nextCursor;
  }
  assert.equal(auditorIds.includes(foreignDuringPaging), false);
  assert.equal(auditorIds.includes(synthetic.multi), false);
  assert.equal(auditorIds.includes(synthetic.unauthorizedSingle), false);
  assert.ok(auditorIds.includes(synthetic.accessibleSingle));
  assert.ok(auditorIds.includes(auditorPageEvents[0]));
  assert.ok(auditorIds.includes(auditorPageEvents[1]));
  assert.equal(new Set(auditorIds).size, auditorIds.length);
  const sessionDetail = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/${synthetic.sessionPrivacy}`,
  );
  assert.equal(sessionDetail.status, 200, JSON.stringify(sessionDetail.body));
  assert.equal(sessionDetail.body.entity, null);
  assert.deepEqual(sessionDetail.body.details, { method: "password" });
  assert.doesNotMatch(
    JSON.stringify(sessionDetail.body),
    /synthetic-secret|synthetic-hash|synthetic-jwt|synthetic-cookie|203\.0\.113\.42|SIGECOM-AUDIT-TEST/i,
  );

  for (const denied of [
    synthetic.unauthorizedSingle,
    synthetic.multi,
    synthetic.incompleteSnapshot,
    synthetic.noWarehouseCoverage,
    synthetic.contradictoryReference,
    synthetic.unknownAction,
    synthetic.missingCommercialReference,
    arrayCases.invalid,
    arrayCases.duplicate,
    arrayCases.excessive,
    arrayCases.incompleteCoverage,
  ]) {
    const owner = [synthetic.noWarehouseCoverage].includes(denied)
      ? users.uncoveredAuditor
      : [
            synthetic.contradictoryReference,
            synthetic.unknownAction,
            synthetic.missingCommercialReference,
          ].includes(denied)
        ? users.administrator
        : users.policyAuditor;
    const detail = await getAs(owner, `/api/v1/audit-events/${denied}`);
    assert.equal(
      detail.status,
      404,
      `fixture ${denied} debe ser indistinguible de inexistente`,
    );
    assert.equal(detail.body.error.code, "AUDIT_EVENT_NOT_FOUND");
  }

  const allowedOptions = await getAs(
    users.administrator,
    `/api/v1/audit-events/filter-options?dateFrom=${date}&dateTo=${date}&actorId=${users.administrator.id}&module=sales`,
  );
  const partialOptions = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/filter-options?dateFrom=${date}&dateTo=${date}&actorId=${users.policyAuditor.id}&module=sales&warehouseId=${warehouseIds[0]}`,
  );
  assert.equal(allowedOptions.status, 200);
  assert.equal(partialOptions.status, 200);
  assert.equal(
    partialOptions.body.warehouses.some(({ id }) => id === warehouseIds[1]),
    false,
  );
  const optionQueries = auditQueries.filter(({ sql }) =>
    sql.startsWith("SELECT DISTINCT v.module"),
  );
  assert.ok(optionQueries.length >= 2);
  assert.ok(
    optionQueries.every(({ sql }) => /user_warehouses AS audit_uw/.test(sql)),
  );

  const validArray = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/${arrayCases.valid}`,
  );
  assert.equal(validArray.status, 200, JSON.stringify(validArray.body));
  assert.deepEqual(validArray.body.warehouses, [
    { id: warehouseIds[0], label: `Bodega #${warehouseIds[0]}` },
  ]);
  for (const denied of [
    arrayCases.invalid,
    arrayCases.duplicate,
    arrayCases.excessive,
    arrayCases.incompleteCoverage,
  ]) {
    const response = await getAs(
      users.policyAuditor,
      `/api/v1/audit-events/${denied}`,
    );
    assert.equal(response.status, 404);
  }
  const noWarehouseOptions = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/filter-options?dateFrom=${date}&dateTo=${date}&module=sales&actorId=${users.policyAuditor.id}&warehouseId=${warehouseIds[1]}`,
  );
  assert.equal(noWarehouseOptions.status, 200);
  assert.deepEqual(noWarehouseOptions.body.warehouses, [
    { id: warehouseIds[0], label: `Bodega #${warehouseIds[0]}` },
  ]);
  assert.equal(
    noWarehouseOptions.body.warehouses.some(({ id }) => id === warehouseIds[1]),
    false,
    "las facetas pueden mostrar la bodega propia, nunca la segunda bodega no asignada",
  );
  const oneWarehouseFilter = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events?dateFrom=${date}&dateTo=${date}&module=sales&action=sales.draft_updated&actorId=${users.policyAuditor.id}&warehouseId=${warehouseIds[0]}&pageSize=100`,
  );
  assert.equal(oneWarehouseFilter.status, 200);
  assert.equal(
    oneWarehouseFilter.body.items.some(({ id }) => id === synthetic.multi),
    false,
    "filtrar por una bodega autorizada no puede abrir un evento multibodega parcial",
  );
  const noCoverageList = await getAs(
    users.uncoveredAuditor,
    `${urlFor(users.uncoveredAuditor)}&module=sales&action=sales.draft_updated`,
  );
  assert.equal(noCoverageList.status, 200);
  assert.equal(
    noCoverageList.body.items.some(
      ({ id }) => id === synthetic.noWarehouseCoverage,
    ),
    false,
  );
  assert.equal(
    await fingerprintTables(fixtureConnection),
    beforeAuditorGets,
    "las consultas de páginas, opciones y detalles son de solo lectura",
  );

  const [[auditorRolePermission]] = await fixtureConnection.execute(
    `SELECT rp.role_id, rp.permission_id, rp.created_at
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = 'auditor' AND p.code = 'sales.read'`,
  );
  assert.ok(
    auditorRolePermission,
    "sales.read está asignado por la política 6.1C",
  );
  await fixtureConnection.execute(
    "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?",
    [auditorRolePermission.role_id, auditorRolePermission.permission_id],
  );
  const revokedPermissionList = await getAs(
    users.policyAuditor,
    `${urlFor(users.policyAuditor)}&module=sales&action=sales.draft_updated`,
  );
  const revokedPermissionDetail = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/${synthetic.accessibleSingle}`,
  );
  const revokedPermissionOptions = await getAs(
    users.policyAuditor,
    `/api/v1/audit-events/filter-options?dateFrom=${date}&dateTo=${date}&actorId=${users.policyAuditor.id}&module=sales`,
  );
  assert.equal(revokedPermissionList.status, 200);
  assert.deepEqual(revokedPermissionList.body.items, []);
  assert.equal(revokedPermissionDetail.status, 404);
  assert.equal(
    revokedPermissionDetail.body.error.code,
    "AUDIT_EVENT_NOT_FOUND",
  );
  assert.equal(
    revokedPermissionOptions.body.actions.includes("sales.draft_updated"),
    false,
  );
  await fixtureConnection.execute(
    "INSERT INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)",
    [
      auditorRolePermission.role_id,
      auditorRolePermission.permission_id,
      auditorRolePermission.created_at,
    ],
  );
});
