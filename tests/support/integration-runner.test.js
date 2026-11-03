import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationFiles } from "./integration-runner.js";
import { connectTestDatabase } from "./test-database.js";
import { runIntegration } from "./integration-runner.js";

test("safe integration runner excludes migrations and serializes shared-role suite before audit", () => {
  assert.equal(
    integrationFiles.some((file) => file.endsWith("schema.test.js")),
    false,
  );
  assert.equal(integrationFiles.at(-1), "tests/integration/audit.test.js");
  assert.equal(
    integrationFiles.at(-2),
    "tests/integration/role-permissions.test.js",
  );
  assert.equal(integrationFiles.length, 14);
});

test("second integration runner is rejected without releasing another run's lock", async () => {
  const owner = await connectTestDatabase("MIGRATOR");
  try {
    const [[result]] = await owner.execute(
      "SELECT GET_LOCK('sigecom_test_integration_runner', 0) AS acquired",
    );
    assert.equal(Number(result.acquired), 1);
    await assert.rejects(runIntegration(), /runner de integración activo/);
    const [[stillHeld]] = await owner.execute(
      "SELECT IS_USED_LOCK('sigecom_test_integration_runner') = CONNECTION_ID() AS held",
    );
    assert.equal(Number(stillHeld.held), 1);
  } finally {
    await owner.execute(
      "SELECT RELEASE_LOCK('sigecom_test_integration_runner')",
    );
    await owner.end();
  }
});
