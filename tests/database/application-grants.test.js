import assert from "node:assert/strict";
import test from "node:test";
import { grantApplicationTablePrivileges } from "../../src/db/application-grants.js";

test("application grants include least-privilege access to account tokens", async () => {
  const statements = [];
  const connection = {
    async query(sql) {
      statements.push(sql);
    },
  };

  await grantApplicationTablePrivileges(connection, {
    database: "sigecom_test",
    appUser: "sigecom_test_app",
  });

  assert.deepEqual(
    statements.filter((sql) => sql.includes("account_access_tokens")),
    [
      "GRANT SELECT, INSERT, UPDATE ON `sigecom_test`.`account_access_tokens` TO 'sigecom_test_app'@'127.0.0.1'",
    ],
  );
});
