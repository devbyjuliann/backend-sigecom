import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POLICY_VERSION,
  classifyPermission,
  validatePermissionSet,
} from "../../src/modules/roles/role-permissions-policy.js";

test("policy classifies role-specific configurable, protected and reserved permissions", () => {
  assert.equal(POLICY_VERSION, 1);
  assert.equal(
    classifyPermission("administrator", "users.read").category,
    "protected",
  );
  assert.equal(
    classifyPermission("administrator", "customers.read").category,
    "configurable",
  );
  assert.equal(
    classifyPermission("warehouse", "purchases.receive").category,
    "incompatible",
  );
  assert.equal(
    classifyPermission("auditor", "audit.read").category,
    "reserved",
  );
  assert.equal(
    classifyPermission("seller", "unknown.permission").category,
    "incompatible",
  );
});

test("policy rejects permissions outside role ceiling and missing dependencies", () => {
  assert.throws(
    () => validatePermissionSet("seller", ["sales.read", "purchases.create"]),
    (error) => error.code === "ROLE_PERMISSION_INCOMPATIBLE",
  );
  assert.throws(
    () => validatePermissionSet("seller", ["sales.confirm"]),
    (error) => error.code === "ROLE_PERMISSION_DEPENDENCY_MISSING",
  );
  assert.deepEqual(
    validatePermissionSet("seller", [
      "customers.read",
      "sales.read",
      "sales.create",
      "sales.confirm",
      "products.read",
      "warehouses.read",
      "inventory.read",
    ]),
    [],
  );
});
