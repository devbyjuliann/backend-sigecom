import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSqlGrantSecrets } from "../../scripts/redact-sql-grants.js";

test("redacts MariaDB password hashes from SHOW GRANTS output", () => {
  const output = redactSqlGrantSecrets(
    "GRANT USAGE ON *.* TO 'runner'@'127.0.0.1' IDENTIFIED BY PASSWORD '*private-hash'",
  );
  assert.equal(
    output,
    "GRANT USAGE ON *.* TO 'runner'@'127.0.0.1' IDENTIFIED BY PASSWORD '[REDACTED]'",
  );
  assert.doesNotMatch(output, /private-hash/);
});
