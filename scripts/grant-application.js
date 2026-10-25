import { createConnection } from "mysql2/promise";

const targets = {
  development: { database: "sigecom_dev", slug: "dev" },
  test: { database: "sigecom_test", slug: "test" },
};
const target = targets[process.argv[2]];

if (!target)
  throw new Error("Indica el destino permitido: test o development.");
if (
  (process.env.DB_HOST || "127.0.0.1") !== "127.0.0.1" ||
  Number(process.env.DB_PORT || 3306) !== 3306
) {
  throw new Error("SIGECOM solo permite MariaDB XAMPP en 127.0.0.1:3306.");
}

const appUser = process.env[`SIGECOM_${target.slug.toUpperCase()}_APP_USER`];
if (!appUser) throw new Error("Falta el usuario local de aplicación en .env.");

const connection = await createConnection({
  host: "127.0.0.1",
  port: 3306,
  user: process.env.XAMPP_ADMIN_USER || "root",
  password: process.env.XAMPP_ADMIN_PASSWORD || "",
  connectTimeout: 5000,
});

try {
  const [[database]] = await connection.execute(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [target.database],
  );
  if (!database)
    throw new Error(`La base ${target.database} todavía no existe.`);

  const applicationTables = [
    "roles",
    "permissions",
    "role_permissions",
    "users",
    "user_sessions",
    "warehouses",
    "user_warehouses",
  ];

  for (const table of applicationTables) {
    await connection.query(
      `GRANT SELECT, INSERT, UPDATE ON \`${target.database}\`.\`${table}\` TO '${appUser}'@'127.0.0.1'`,
    );
  }

  await connection.query(
    `GRANT SELECT, INSERT ON \`${target.database}\`.\`audit_events\` TO '${appUser}'@'127.0.0.1'`,
  );

  console.log(
    `Permisos mínimos de aplicación otorgados sobre las tablas de ${target.database}.`,
  );
} finally {
  await connection.end();
}
