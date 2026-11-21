import assert from "node:assert/strict";
import { test } from "node:test";

const migrationPlanModule =
  await import("../support/account-access-migration-plan.js").catch(() => null);

test("applies migrations 0018 and 0019 around legacy account setup", async () => {
  const { applyLegacyCompatibleMigrations } = migrationPlanModule ?? {};
  assert.equal(
    typeof applyLegacyCompatibleMigrations,
    "function",
    "the account-access migration plan must be available",
  );

  const events = [];
  const migrations = Array.from({ length: 19 }, (_, index) => ({
    version: String(index + 1).padStart(4, "0"),
  }));

  await applyLegacyCompatibleMigrations({
    migrations,
    applyMigration: async ({ version }) => events.push(version),
    seedLegacyFixtures: async () => events.push("legacy-fixtures"),
    verifyLegacyState: async () => events.push("legacy-state"),
  });

  assert.deepEqual(events, [
    "0001",
    "0002",
    "0003",
    "0004",
    "0005",
    "0006",
    "0007",
    "0008",
    "0009",
    "0010",
    "0011",
    "0012",
    "0013",
    "0014",
    "0015",
    "0016",
    "0017",
    "legacy-fixtures",
    "0018",
    "legacy-state",
    "0019",
  ]);
});
