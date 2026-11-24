import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = fileURLToPath(
  new URL("../../scripts/create-initial-admin.js", import.meta.url),
);

test("production admin bootstrap refuses a non-production runtime before prompting", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--production"], {
    env: { ...process.env, NODE_ENV: "development" },
    input: "",
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--production requiere NODE_ENV=production/i);
  assert.doesNotMatch(result.stdout, /Correo del administrador/);
});

test("production runtime requires the explicit production bootstrap flag", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, NODE_ENV: "production" },
    input: "",
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production requiere.*--production/i);
  assert.doesNotMatch(result.stdout, /Correo del administrador/);
});
