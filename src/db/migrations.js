import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";
import { getDatabaseConfig } from "./config.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../database/migrations/", import.meta.url),
);

export async function getMigrations(directory = migrationsDirectory) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = [];
  const seenVersions = new Set();

  for (const file of files) {
    const match = /^(\d{4})-([a-z0-9-]+)\.sql$/.exec(file);
    if (!match) throw new Error(`Nombre de migración no válido: ${file}`);
    if (seenVersions.has(match[1]))
      throw new Error(`Versión de migración duplicada: ${match[1]}`);
    seenVersions.add(match[1]);

    const sql = await readFile(path.join(directory, file), "utf8");
    if (!sql.trim()) throw new Error(`La migración ${file} está vacía.`);

    migrations.push({
      version: match[1],
      name: match[2],
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return migrations;
}

export async function applyMigrations(target) {
  const config = getDatabaseConfig(target, process.env, "MIGRATOR");
  const connection = await mysql.createConnection({
    ...config,
    multipleStatements: true,
  });
  const lockName = `sigecom:migrations:${config.database}`;
  let lockAcquired = false;

  try {
    await connection.query("SET time_zone = '+00:00'");
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName],
    );
    if (lock.acquired !== 1)
      throw new Error(
        `No se pudo bloquear ${config.database} para migraciones.`,
      );
    lockAcquired = true;

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version CHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        name VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const migrations = await getMigrations();
    const applied = [];

    for (const migration of migrations) {
      const [rows] = await connection.execute(
        "SELECT name, checksum FROM schema_migrations WHERE version = ?",
        [migration.version],
      );
      const existing = rows[0];

      if (existing) {
        if (
          existing.name !== migration.name ||
          existing.checksum !== migration.checksum
        ) {
          throw new Error(
            `La migración ${migration.version} fue modificada después de aplicarse.`,
          );
        }
        continue;
      }

      await connection.query(migration.sql);
      await connection.execute(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
        [migration.version, migration.name, migration.checksum],
      );
      applied.push(migration.version);
    }

    return { database: config.database, applied };
  } finally {
    if (lockAcquired)
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    await connection.end();
  }
}
