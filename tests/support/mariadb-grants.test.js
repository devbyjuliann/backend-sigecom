import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMariaDbGrantScope } from "./mariadb-grants.js";

test("MariaDB schema and table grants normalize escaped database wildcards", () => {
  const schemaGrant = normalizeMariaDbGrantScope(
    "GRANT SELECT ON `sigecom\\_e2e\\_tmp\\_20261120161644\\_1610b0c9`.* TO `sgapp`@`localhost`",
  );
  const tableGrant = normalizeMariaDbGrantScope(
    "GRANT DELETE ON `sigecom_e2e_tmp_20261120161644_1610b0c9`.`role_permissions` TO `sgapp`@`localhost`",
  );

  assert.match(schemaGrant, /ON `sigecom_e2e_tmp_20261120161644_1610b0c9`\.\*/);
  assert.match(
    tableGrant,
    /ON `sigecom_e2e_tmp_20261120161644_1610b0c9`\.`role_permissions`/,
  );
});
