import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const databases = [
  { name: "sigecom_dev", prefix: "SIGECOM_DEV", slug: "dev" },
  { name: "sigecom_test", prefix: "SIGECOM_TEST", slug: "test" },
];

function generatePassword() {
  return randomBytes(32).toString("base64url");
}

function quoteIdentifier(value) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function updateLocalEnvironment(current, credentials) {
  let updated = current;

  for (const [key, value] of Object.entries(credentials)) {
    const expression = new RegExp(`^${key}=.*$`, "m");
    const existing = updated.match(expression);
    if (!existing || !existing[0].endsWith("=")) {
      throw new Error(
        `La variable ${key} falta o ya tiene valor; no se sobrescribirá.`,
      );
    }
    updated = updated.replace(expression, `${key}=${value}`);
  }

  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

const host = process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.DB_PORT || 3306);
const adminUser = process.env.XAMPP_ADMIN_USER || "root";

if (host !== "127.0.0.1" || port !== 3306) {
  throw new Error(
    "Se rechazó la configuración: solo se admite MariaDB XAMPP en 127.0.0.1:3306.",
  );
}

let envContents;
try {
  envContents = await readFile(envPath, "utf8");
} catch {
  throw new Error(
    "No existe backend-sigecom/.env. Cópialo desde .env.example antes de provisionar.",
  );
}

const accounts = databases.flatMap(({ slug }) => [
  { role: "APP", user: `sigecom_${slug}_app`, password: generatePassword() },
  {
    role: "MIGRATOR",
    user: `sigecom_${slug}_migrator`,
    password: generatePassword(),
  },
]);

const connection = await mysql.createConnection({
  host,
  port,
  user: adminUser,
  password: process.env.XAMPP_ADMIN_PASSWORD || "",
  connectTimeout: 5000,
});

try {
  const [[server]] = await connection.query(
    "SELECT VERSION() AS version, @@port AS port, @@datadir AS data_directory",
  );
  if (
    !String(server.version).includes("MariaDB") ||
    Number(server.port) !== 3306
  ) {
    throw new Error(
      "El servidor conectado no es MariaDB de XAMPP en el puerto 3306.",
    );
  }

  const [existingDatabases] = await connection.execute(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)",
    databases.map(({ name }) => name),
  );
  if (existingDatabases.length) {
    throw new Error(
      `Se abortó sin cambios: ya existe ${existingDatabases.map(({ SCHEMA_NAME }) => SCHEMA_NAME).join(", ")}.`,
    );
  }

  const usernames = accounts.map(({ user }) => user);
  const [existingUsers] = await connection.execute(
    `SELECT User, Host FROM mysql.user WHERE User IN (${usernames.map(() => "?").join(", ")})`,
    usernames,
  );
  if (existingUsers.length) {
    throw new Error(
      "Se abortó sin cambios: ya existe una cuenta SQL reservada para SIGECOM.",
    );
  }

  const envCredentials = Object.fromEntries(
    accounts.flatMap(({ role, user, password }, index) => {
      const { prefix } = databases[Math.floor(index / 2)];
      return [
        [`${prefix}_${role}_USER`, user],
        [`${prefix}_${role}_PASSWORD`, password],
      ];
    }),
  );
  const updatedEnvironment = updateLocalEnvironment(
    envContents,
    envCredentials,
  );
  await writeFile(envPath, updatedEnvironment, {
    encoding: "utf8",
    mode: 0o600,
  });

  for (const { name } of databases) {
    await connection.query(
      `CREATE DATABASE ${quoteIdentifier(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  }

  for (const account of accounts) {
    const { user, password, role } = account;
    await connection.query(
      `CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY ${connection.escape(password)}`,
    );

    if (role === "MIGRATOR") {
      const database = account.user.includes("_dev_")
        ? "sigecom_dev"
        : "sigecom_test";
      await connection.query(
        `GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES ON ${quoteIdentifier(database)}.* TO '${user}'@'127.0.0.1'`,
      );
    }
  }

  console.log(
    "Se crearon sigecom_dev y sigecom_test vacías en MariaDB XAMPP 127.0.0.1:3306.",
  );
  console.log(
    "Se crearon usuarios independientes de aplicación y migración; las credenciales están solo en el .env ignorado.",
  );
  console.log(`Directorio de datos confirmado: ${server.data_directory}`);
} catch (error) {
  console.error(
    `No se completó la provisión (${error.code || "ERROR"}): ${error.message}`,
  );
  process.exitCode = 1;
} finally {
  await connection.end();
}
