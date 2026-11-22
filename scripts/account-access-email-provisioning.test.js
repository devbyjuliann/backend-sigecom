import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const target = {
  runId: "20261119040000_aaaaaaaa",
  attemptId: "20261119040001_bbbbbbbb",
  schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
  appUser: "sgapp_20261119040000_aaaaaaaa",
  migratorUser: "sgmig_20261119040000_aaaaaaaa",
  appPassword: "app-secret-".padEnd(40, "a"),
  migratorPassword: "migrator-secret-".padEnd(40, "b"),
};

async function loadProvisioningModule() {
  try {
    return await import("./account-access-email-provisioning.js");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

async function makeLedger(t, directory) {
  const { createResourceOwnershipLedger } =
    await import("./account-access-email-resource-ledger.js");
  const ledger = await createResourceOwnershipLedger({
    directory,
    ...target,
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return ledger;
}

function createConnectionDouble({
  failOn,
  existingTarget = false,
  existingTables = [],
} = {}) {
  const statements = [];
  const connection = {
    async execute(sql, parameters) {
      statements.push({ kind: "execute", sql, parameters });
      if (existingTarget && sql.includes("information_schema.SCHEMATA")) {
        return [[{ SCHEMA_NAME: target.schema }], []];
      }
      if (existingTarget && sql.includes("FROM mysql.user")) {
        return [[{ User: target.appUser }, { User: target.migratorUser }], []];
      }
      if (existingTarget && sql.includes("information_schema.TABLES")) {
        return [existingTables.map((TABLE_NAME) => ({ TABLE_NAME })), []];
      }
      return [[], []];
    },
    async query(sql) {
      statements.push({ kind: "query", sql });
      if (failOn && sql.includes(failOn)) {
        const error = new Error("simulated privilege denial private-secret");
        error.code = "ER_DBACCESS_DENIED_ERROR";
        throw error;
      }
      return [[], []];
    },
  };
  return { connection, statements };
}

test("isolated provisioning scopes every grant to the derived schema", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-scope-"),
  );
  const ledger = await makeLedger(t, directory);
  const { connection, statements } = createConnectionDouble();

  await module.provisionIsolatedDatabaseResources({
    connection,
    ledger,
    ...target,
  });

  const ddl = statements
    .filter(({ kind }) => kind === "query")
    .map(({ sql }) => sql);
  assert.equal(ddl.length, 5);
  assert.match(
    ddl[0],
    /^CREATE DATABASE `sigecom_e2e_tmp_20261119040000_aaaaaaaa`/,
  );
  assert.match(
    ddl[1],
    /^CREATE USER 'sgapp_20261119040000_aaaaaaaa'@'localhost'/,
  );
  assert.match(
    ddl[2],
    /^CREATE USER 'sgmig_20261119040000_aaaaaaaa'@'localhost'/,
  );
  assert.match(
    ddl[3],
    /^GRANT SELECT, INSERT, UPDATE ON `sigecom\\_e2e\\_tmp\\_20261119040000\\_aaaaaaaa`\.\*/,
  );
  assert.match(
    ddl[4],
    /^GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER ON `sigecom\\_e2e\\_tmp\\_20261119040000\\_aaaaaaaa`\.\*/,
  );
  assert.doesNotMatch(ddl.join("\n"), /\bON\s+\*\.\*|\bWITH GRANT OPTION\b/i);
  assert.match(
    JSON.stringify(ledger.snapshot().steps["grant.migrator"]),
    /"status":"succeeded"/,
  );
});

test("isolated grants escape wildcard characters in the database scope", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-escaped-scope-"),
  );
  const ledger = await makeLedger(t, directory);
  const { connection, statements } = createConnectionDouble();

  await module.provisionIsolatedDatabaseResources({
    connection,
    ledger,
    ...target,
  });

  const grants = statements
    .filter(({ kind, sql }) => kind === "query" && sql.startsWith("GRANT "))
    .map(({ sql }) => sql);
  assert.equal(grants.length, 2);
  for (const grant of grants) {
    assert.match(
      grant,
      /ON `sigecom\\_e2e\\_tmp\\_20261119040000\\_aaaaaaaa`\./,
    );
  }
});

test("application table DELETE grants are deferred until both tables exist", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-app-table-grants-"),
  );
  const ledger = await makeLedger(t, directory);
  for (const step of [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
    "grant.app",
    "grant.migrator",
  ]) {
    await ledger.recordStep(step, async () => {});
  }
  const { connection, statements } = createConnectionDouble({
    existingTarget: true,
    existingTables: ["user_warehouses", "role_permissions"],
  });

  await module.grantIsolatedApplicationTablePrivileges({
    connection,
    ledger,
    runId: target.runId,
    schema: target.schema,
    appUser: target.appUser,
  });

  const grants = statements
    .filter(({ kind, sql }) => kind === "query" && sql.startsWith("GRANT "))
    .map(({ sql }) => sql);
  assert.equal(grants.length, 2);
  assert.match(
    grants[0],
    /^GRANT DELETE ON `sigecom\\_e2e\\_tmp\\_20261119040000\\_aaaaaaaa`\.`user_warehouses` TO 'sgapp_20261119040000_aaaaaaaa'@'localhost'$/,
  );
  assert.match(
    grants[1],
    /^GRANT DELETE ON `sigecom\\_e2e\\_tmp\\_20261119040000\\_aaaaaaaa`\.`role_permissions` TO 'sgapp_20261119040000_aaaaaaaa'@'localhost'$/,
  );
  assert.equal(ledger.snapshot().steps["grant.app.tables"].status, "succeeded");
});

test("a privilege denial records the attempted stage as unknown and stops provisioning", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-partial-"),
  );
  const ledger = await makeLedger(t, directory);
  const { connection, statements } = createConnectionDouble({
    failOn: "CREATE USER 'sgmig_",
  });

  await assert.rejects(
    module.provisionIsolatedDatabaseResources({
      connection,
      ledger,
      ...target,
    }),
    /simulated privilege denial/,
  );

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.resources.schema.status, "succeeded");
  assert.equal(snapshot.resources.appUser.status, "succeeded");
  assert.equal(snapshot.resources.migratorUser.status, "unknown");
  assert.equal(
    snapshot.steps["user.migrator.create"].errorCode,
    "ER_DBACCESS_DENIED_ERROR",
  );
  assert.equal(
    Object.hasOwn(snapshot.steps["user.migrator.create"], "error"),
    false,
  );
  assert.equal(
    statements.some(({ sql }) => sql.startsWith("GRANT ")),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes("private-secret"), false);
});

test("recovery grants existing accounts without recreating their schema or users", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-resume-"),
  );
  const ledger = await makeLedger(t, directory);
  for (const step of [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
  ]) {
    await ledger.recordStep(step, async () => {});
  }
  await assert.rejects(
    ledger.recordStep("grant.app", async () => {
      throw new Error("initial grant failure");
    }),
    /initial grant failure/,
  );
  const resumedLedger = await (
    await import("./account-access-email-resource-ledger.js")
  ).resumeResourceOwnershipLedger({
    directory,
    ...target,
    ownerAttemptId: target.attemptId,
  });
  const { connection, statements } = createConnectionDouble({
    existingTarget: true,
  });

  await module.provisionIsolatedDatabaseResources({
    connection,
    ledger: resumedLedger,
    ...target,
    resumeExisting: true,
  });

  const writes = statements
    .filter(({ kind }) => kind === "query")
    .map(({ sql }) => sql);
  assert.equal(
    writes.some((sql) => /^(?:CREATE DATABASE|CREATE USER)/.test(sql)),
    false,
  );
  assert.equal(writes.filter((sql) => sql.startsWith("GRANT ")).length, 2);
  assert.equal(resumedLedger.snapshot().steps["grant.app"].status, "succeeded");
  assert.equal(
    resumedLedger.snapshot().steps["grant.migrator"].status,
    "succeeded",
  );
});

test("existing targets and malformed destinations fail before any write", async (t) => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-provision-target-"),
  );
  const ledger = await makeLedger(t, directory);
  const { connection, statements } = createConnectionDouble();

  await assert.rejects(
    module.provisionIsolatedDatabaseResources({
      connection,
      ledger,
      ...target,
      schema: "sigecom_test",
    }),
    /objetivo.*RUN_ID|destino/i,
  );
  assert.equal(
    statements.some(({ kind }) => kind === "query"),
    false,
  );
});

test("provisioner identity must match the configured local account and never root or wildcard hosts", async () => {
  const module = await loadProvisioningModule();
  assert.ok(module, "debe existir el módulo aislado de aprovisionamiento");
  assert.equal(typeof module.assertProvisionerIdentity, "function");

  assert.equal(
    module.assertProvisionerIdentity(
      "sigecom_e2e_provisioner@localhost",
      "sigecom_e2e_provisioner",
    ),
    true,
  );
  assert.equal(
    module.assertProvisionerIdentity(
      "sigecom_e2e_provisioner@127.0.0.1",
      "sigecom_e2e_provisioner",
    ),
    true,
  );
  for (const identity of [
    "root@localhost",
    "sigecom_e2e_provisioner@%",
    "other@localhost",
  ]) {
    assert.throws(
      () =>
        module.assertProvisionerIdentity(identity, "sigecom_e2e_provisioner"),
      /provisioner|identidad/i,
    );
  }
});
