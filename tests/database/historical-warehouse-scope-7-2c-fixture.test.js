import assert from "node:assert/strict";
import { test } from "node:test";
import { trackReaderRole } from "../integration/historical-warehouse-scope-7-2c-fixture.js";

test("7.2C conserva el ID del rol sintético en la fixture y su lista de limpieza", () => {
  const fixture = { roleIds: [] };

  assert.equal(trackReaderRole(fixture, 417), "417");
  assert.equal(fixture.readerRoleId, "417");
  assert.deepEqual(fixture.roleIds, ["417"]);
});
