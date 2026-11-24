const applicationTables = [
  "users",
  "user_sessions",
  "account_access_tokens",
  "warehouses",
  "user_warehouses",
  "categories",
  "products",
  "customers",
  "suppliers",
  "purchase_orders",
  "purchase_order_lines",
  "purchase_receipts",
  "purchase_receipt_lines",
  "supplier_returns",
  "supplier_return_lines",
  "customer_returns",
];

const allowedDatabases = new Set(["sigecom_dev", "sigecom_test"]);

export async function grantApplicationTablePrivileges(
  connection,
  { database, appUser },
) {
  if (!connection || typeof connection.query !== "function") {
    throw new TypeError("Se requiere una conexión SQL para otorgar permisos.");
  }
  if (!allowedDatabases.has(database)) {
    throw new Error("La base debe ser sigecom_dev o sigecom_test.");
  }
  if (typeof appUser !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(appUser)) {
    throw new Error("El usuario de aplicación local no es válido.");
  }

  for (const table of applicationTables) {
    await connection.query(
      `GRANT SELECT, INSERT, UPDATE ON \`${database}\`.\`${table}\` TO '${appUser}'@'127.0.0.1'`,
    );
  }
}
