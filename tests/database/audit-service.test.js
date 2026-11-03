import test from "node:test";
import assert from "node:assert/strict";
import { createAuditService } from "../../src/modules/audit/audit-service.js";

const secret = "unit-test-cursor-secret-that-is-long-enough";
const permissions = new Set([
  "audit.read",
  "sales.read",
  "purchases.read",
  "inventory.movements.read",
  "warehouses.read",
  "categories.read",
  "products.read",
  "customers.read",
  "suppliers.read",
]);
const filters = {
  dateFrom: "2026-11-01 05:00:00.000",
  dateTo: "2026-11-02 05:00:00.000",
};

function auditRow(overrides = {}) {
  return {
    id: "9",
    action: "sales.confirmed",
    module: "sales",
    entity_type: "sale",
    entity_id: "7",
    user_id: "4",
    created_at: "2026-11-01 12:00:00.000",
    details: {
      sourceOperationId: "8",
      warehouseId: "3",
      lineCount: 2,
      total: 900000,
      email: "private@example.test",
      password: "not-public",
    },
    scope_warehouse_ids: '["3"]',
    ...overrides,
  };
}

function poolWith({
  warehouseIds = ["3"],
  latest = [],
  page = [],
  options = [],
} = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ sql, values });
      assert.equal(
        (sql.match(/\?/g) || []).length,
        values.length,
        "cada placeholder debe tener un parámetro",
      );
      if (
        sql.includes("FROM user_warehouses") &&
        sql.includes("CAST(warehouse_id AS CHAR)")
      ) {
        return [warehouseIds.map((id) => ({ id }))];
      }
      if (sql.includes("SELECT v.created_at, v.id")) return [latest];
      if (sql.includes("SELECT DISTINCT")) return [options];
      if (sql.includes("WHERE v.id = ?")) return [page];
      if (sql.includes("SELECT v.*")) return [page];
      throw new Error(`Consulta inesperada de Auditoría: ${sql.slice(0, 100)}`);
    },
  };
}

test("la lista aplica alcance histórico en SQL y proyecta únicamente campos permitidos", async () => {
  const row = auditRow();
  const dbPool = poolWith({
    latest: [{ id: row.id, created_at: row.created_at }],
    page: [row],
  });
  const service = createAuditService({ dbPool, cursorSecret: secret });
  const result = await service.list({
    filters,
    pageSize: 20,
    userId: "2",
    permissions,
    role: "administrator",
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].warehouses, [
    { id: "3", label: "Bodega #3" },
  ]);
  assert.deepEqual(result.items[0].details, {
    sourceOperationId: "8",
    lineCount: 2,
    warehouseId: "3",
  });
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(JSON.stringify(result).includes("not-public"), false);
  const listQuery = dbPool.calls.find(({ sql }) => sql.includes("SELECT v.*"));
  assert.match(listQuery.sql, /audit_io\.operation_type = 'sale_issue'/);
  assert.match(listQuery.sql, /user_warehouses AS audit_uw/);
  assert.match(
    listQuery.sql,
    /ORDER BY v\.created_at DESC, v\.id DESC LIMIT \?/,
  );
  assert.doesNotMatch(listQuery.sql, /OFFSET/i);
});

test("el cursor opaco mantiene el orden keyset y rechaza reutilización con otro contexto", async () => {
  const first = auditRow({ id: "18", created_at: "2026-11-01 12:00:00.000" });
  const second = auditRow({ id: "17", created_at: "2026-11-01 12:00:00.000" });
  const dbPool = poolWith({
    latest: [{ id: first.id, created_at: first.created_at }],
    page: [first, second],
  });
  const service = createAuditService({ dbPool, cursorSecret: secret });
  const firstPage = await service.list({
    filters,
    pageSize: 1,
    userId: "2",
    permissions,
    role: "administrator",
  });
  assert.match(
    firstPage.pagination.nextCursor,
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  );
  assert.equal(firstPage.pagination.hasMore, true);

  const nextPool = poolWith({ page: [second] });
  const nextService = createAuditService({
    dbPool: nextPool,
    cursorSecret: secret,
  });
  const next = await nextService.list({
    filters,
    pageSize: 1,
    cursor: firstPage.pagination.nextCursor,
    userId: "2",
    permissions,
    role: "administrator",
  });
  assert.equal(next.items[0].id, "17");
  assert.match(
    nextPool.calls.find(({ sql }) => sql.includes("SELECT v.*")).sql,
    /\(v\.created_at, v\.id\) < \(\?, \?\)/,
  );

  await assert.rejects(
    nextService.list({
      filters: { ...filters, module: "auth" },
      pageSize: 1,
      cursor: firstPage.pagination.nextCursor,
      userId: "2",
      permissions,
      role: "administrator",
    }),
    { code: "INVALID_AUDIT_CURSOR" },
  );
});

test("opciones y detalle consultan la política autorizada y el evento no visible devuelve 404 uniforme", async () => {
  const dbPool = poolWith({
    options: [
      {
        module: "auth",
        action: "auth.login_succeeded",
        user_id: "5",
        scope_warehouse_ids: "[]",
      },
      {
        module: "sales",
        action: "sales.confirmed",
        user_id: "6",
        scope_warehouse_ids: '["3"]',
      },
    ],
  });
  const service = createAuditService({ dbPool, cursorSecret: secret });
  const options = await service.options({
    filters: { ...filters, module: "sales", actorId: "6" },
    userId: "2",
    permissions,
    role: "auditor",
  });
  const optionQueries = dbPool.calls.filter(({ sql }) =>
    sql.includes("SELECT DISTINCT"),
  );
  assert.equal(optionQueries.length, 1);
  assert.deepEqual(options.modules, ["sales"]);
  assert.deepEqual(options.actions, ["sales.confirmed"]);
  assert.deepEqual(options.actors, [{ id: "6", label: "Usuario #6" }]);
  assert.deepEqual(options.warehouses, [{ id: "3", label: "Bodega #3" }]);
  assert.match(optionQueries[0].sql, /audit_io\.operation_type = 'sale_issue'/);
  assert.match(
    optionQueries[0].sql,
    /SELECT COUNT\(\*\) FROM user_warehouses AS audit_array_uw/,
  );

  await assert.rejects(
    service.get({ id: "99", userId: "2", permissions, role: "auditor" }),
    { status: 404, code: "AUDIT_EVENT_NOT_FOUND" },
  );
  const detailQuery = dbPool.calls.find(({ sql }) =>
    sql.includes("WHERE v.id = ?"),
  );
  assert.match(detailQuery.sql, /audit_io\.operation_type = 'sale_issue'/);
  assert.equal(detailQuery.values.at(-1), "99");
});

test("al retirar permisos comerciales la política SQL excluye eventos del dominio sin depender del filtro del cliente", async () => {
  const dbPool = poolWith({ warehouseIds: [], latest: [] });
  const service = createAuditService({ dbPool, cursorSecret: secret });
  const result = await service.list({
    filters,
    pageSize: 20,
    userId: "2",
    permissions: new Set(["audit.read", "warehouses.read"]),
    role: "auditor",
  });

  assert.deepEqual(result.items, []);
  const query = dbPool.calls.find(({ sql }) =>
    sql.includes("SELECT v.created_at"),
  );
  const visibilityPredicate = query.sql.slice(
    query.sql.indexOf("FROM audit_events AS ae WHERE"),
  );
  assert.doesNotMatch(
    visibilityPredicate,
    /OR \(ae\.module = '(sales|purchases|inventory|products|categories|customers|suppliers)'/,
  );
  assert.match(visibilityPredicate, /OR \(ae\.module = 'warehouses'/);
});

test("las variantes históricas con arrays exigen cobertura completa y elementos únicos asignados", async () => {
  const dbPool = poolWith({ warehouseIds: ["3", "4"], options: [] });
  const service = createAuditService({ dbPool, cursorSecret: secret });
  await service.options({
    filters,
    userId: "2",
    permissions: new Set(["audit.read", "warehouses.read"]),
    role: "auditor",
  });
  const optionsQuery = dbPool.calls.find(({ sql }) =>
    sql.includes("SELECT DISTINCT"),
  );
  assert.match(
    optionsQuery.sql,
    /JSON_LENGTH\(JSON_EXTRACT\(ae\.details, '\$\.warehouseIds'\)\) = \(/,
  );
  assert.match(
    optionsQuery.sql,
    /JSON_LENGTH\(JSON_EXTRACT\(ae\.details, '\$\.warehouseIds'\)\) <= 64/,
  );
  assert.match(optionsQuery.sql, /FROM user_warehouses AS audit_array_uw/);
  assert.equal(
    (optionsQuery.sql.match(/\?/g) || []).length,
    optionsQuery.values.length,
  );
});
