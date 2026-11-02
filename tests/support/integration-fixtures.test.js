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
