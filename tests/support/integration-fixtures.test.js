import assert from "node:assert/strict";
import { test } from "node:test";
import { IntegrationFixtures } from "./integration-fixtures.js";

test("integration fixtures record exact owned IDs and only explicit assignments", () => {
  const fixtures = new IntegrationFixtures({ suite: "fixture-registry-test" });
  fixtures.user("41").warehouse("72").role("8");
  fixtures.assignment("41", "72");
  assert.equal(fixtures.suite, "fixture-registry-test");
  assert.deepEqual(fixtures.ownedUsers, ["41"]);
  assert.deepEqual(fixtures.ownedWarehouses, ["72"]);
  assert.deepEqual(fixtures.ownedRoles, ["8"]);
  assert.deepEqual(fixtures.ownedAssignments, [
    { userId: "41", warehouseId: "72" },
  ]);
  assert.equal(fixtures.ownsUser("42"), false);
});

test("integration fixture cleanup refuses a database other than its exact target", async () => {
  const fixtures = new IntegrationFixtures({
    suite: "isolated-run",
    databaseName: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
  });
  fixtures.user("41");
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return [[{ name: "sigecom_test" }]];
    },
    async execute(sql) {
      statements.push(sql);
      return [[], []];
    },
  };

  await assert.rejects(
    fixtures.cleanupUserAssignments(pool),
    /outside its explicit database target/,
  );
  assert.deepEqual(statements, ["SELECT DATABASE() AS name"]);
});

test("integration fixture cleanup uses only recorded IDs in its exact target", async () => {
  const fixtures = new IntegrationFixtures({
    suite: "isolated-run",
    databaseName: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
  });
  fixtures.user("41").warehouse("72").assignment("99", "88");
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push({ sql });
      return [[{ name: "sigecom_e2e_tmp_20261119040000_aaaaaaaa" }]];
    },
    async execute(sql, values) {
      statements.push({ sql, values });
      return [[], []];
    },
  };

  await fixtures.cleanupUserAssignments(pool);

  assert.equal(statements[0].sql, "SELECT DATABASE() AS name");
  assert.deepEqual(
    statements.slice(1).map(({ values }) => values),
    [["41"], ["41"], ["41"], ["72"], ["99", "88"]],
  );
  assert.equal(statements.length, 6);
});
