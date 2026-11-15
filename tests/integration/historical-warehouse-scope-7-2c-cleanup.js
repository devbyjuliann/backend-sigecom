const ownedColumns = Object.freeze({
  audit_events: new Set(["user_id"]),
  categories: new Set(["id"]),
  customers: new Set(["id"]),
  products: new Set(["id"]),
  purchase_order_lines: new Set(["purchase_order_id"]),
  purchase_orders: new Set(["id"]),
  role_permissions: new Set(["role_id"]),
  roles: new Set(["id"]),
  sale_cancellations: new Set(["sale_id"]),
  sale_lines: new Set(["sale_id"]),
  sale_requests: new Set(["actor_id"]),
  sales: new Set(["id"]),
  suppliers: new Set(["id"]),
  user_sessions: new Set(["user_id"]),
  user_warehouses: new Set(["user_id"]),
  users: new Set(["id"]),
  warehouses: new Set(["id"]),
});

function assertOwnedColumn(table, column) {
  if (!ownedColumns[table]?.has(column)) {
    throw new TypeError(`No se permite limpiar ${table}.${column}.`);
  }
}

export async function deleteOwnedRows(dbPool, table, column, ids) {
  assertOwnedColumn(table, column);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const [result] = await dbPool.execute(
    `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`,
    ids,
  );
  return result.affectedRows;
}

export async function countOwnedRows(dbPool, table, column, ids) {
  assertOwnedColumn(table, column);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const [[row]] = await dbPool.execute(
    `SELECT COUNT(*) AS total FROM ${table} WHERE ${column} IN (${placeholders})`,
    ids,
  );
  return Number(row.total);
}
