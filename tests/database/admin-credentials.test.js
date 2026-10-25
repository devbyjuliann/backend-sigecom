import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAdminEmail,
  validateTemporaryPassword,
} from "../../src/modules/users/admin-credentials.js";

test("normalizes and validates the initial administrator email", () => {
  assert.equal(
    normalizeAdminEmail("  Julian.Example@GMAIL.COM "),
    "julian.example@gmail.com",
  );
  assert.throws(() => normalizeAdminEmail("not-an-email"), /correo/);
});

test("requires a confirmed temporary password with safe bcrypt length", () => {
  assert.equal(validateTemporaryPassword("a".repeat(24), "a".repeat(24)), true);
  assert.throws(
    () => validateTemporaryPassword("short", "short"),
    /24 caracteres/,
  );
  assert.throws(
    () => validateTemporaryPassword("a".repeat(24), "b".repeat(24)),
    /no coinciden/,
  );
  assert.throws(
    () => validateTemporaryPassword("á".repeat(37), "á".repeat(37)),
    /72 bytes/,
  );
});
