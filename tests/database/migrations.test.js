import assert from "node:assert/strict";
import { test } from "node:test";
import { getMigrations } from "../../src/db/migrations.js";

test("loads versioned migrations in order with stable checksums", async () => {
  const migrations = await getMigrations();

  assert.deepEqual(
    migrations.map(({ version }) => version),
    ["0001", "0002", "0003", "0004"],
  );
  for (const migration of migrations) {
    assert.match(migration.name, /^[a-z0-9-]+$/);
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(migration.sql.trim().length > 0);
    assert.doesNotMatch(migration.sql, /\b(?:DROP|TRUNCATE)\b/i);
  }
});
