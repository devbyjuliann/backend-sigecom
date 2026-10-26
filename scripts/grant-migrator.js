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

const migratorUser =
  process.env[`SIGECOM_${target.slug.toUpperCase()}_MIGRATOR_USER`];
if (!migratorUser) throw new Error("Falta el usuario migrador local en .env.");
if (!/^[a-zA-Z0-9_]+$/.test(migratorUser)) {
  throw new Error("El usuario migrador configurado no es válido.");
}

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
  if (!database) throw new Error(`La base ${target.database} no existe.`);

  await connection.query(
    `GRANT DELETE ON \`${target.database}\`.role_permissions TO '${migratorUser}'@'127.0.0.1'`,
  );
  console.log(
    `Permiso DELETE limitado a ${target.database}.role_permissions otorgado al migrador.`,
  );
} finally {
  await connection.end();
}
