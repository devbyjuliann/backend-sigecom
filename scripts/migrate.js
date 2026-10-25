import { applyMigrations } from "../src/db/migrations.js";

const target = process.argv[2];

try {
  const result = await applyMigrations(target);
  const message = result.applied.length
    ? `Migraciones aplicadas: ${result.applied.join(", ")}`
    : "La base ya está al día; no se aplicaron migraciones nuevas.";
  console.log(`${result.database}: ${message}`);
} catch (error) {
  console.error(
    `Falló la migración (${error.code || "ERROR"}): ${error.message}`,
  );
  process.exitCode = 1;
}
