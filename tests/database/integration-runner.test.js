import assert from "node:assert/strict";
import { test } from "node:test";
import {
  integrationFiles,
  selectIntegrationFiles,
} from "../support/integration-runner.js";

test("integration runner defaults to the complete approved sequential suite list", () => {
  assert.deepEqual(selectIntegrationFiles([]), integrationFiles);
});

test("integration runner selects only a known suite when explicitly requested", () => {
  assert.deepEqual(
    selectIntegrationFiles([
      "--suite",
      "tests/integration/reports-sales-activity.test.js",
    ]),
    ["tests/integration/reports-sales-activity.test.js"],
  );
});

test("integration runner rejects malformed or unapproved suite selectors", () => {
  assert.throws(() => selectIntegrationFiles(["--suite"]));
  assert.throws(() => selectIntegrationFiles(["--suite", "../schema.test.js"]));
  assert.throws(() => selectIntegrationFiles(["--unknown"]));
  assert.throws(() =>
    selectIntegrationFiles([
      "--suite",
      "tests/integration/reports-sales-activity.test.js",
      "--suite",
      "tests/integration/auth.test.js",
    ]),
  );
});
