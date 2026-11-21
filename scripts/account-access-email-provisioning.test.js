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

function createConnectionDouble({ failOn } = {}) {
  const statements = [];
  const connection = {
    async execute(sql, parameters) {
      statements.push({ kind: "execute", sql, parameters });
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
  assert.equal(ddl.length, 7);
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
    /^GRANT SELECT, INSERT, UPDATE ON `sigecom_e2e_tmp_20261119040000_aaaaaaaa`\.\*/,
  );
  assert.match(
    ddl[4],
    /^GRANT DELETE ON `sigecom_e2e_tmp_20261119040000_aaaaaaaa`\.`user_warehouses`/,
  );
  assert.match(
    ddl[5],
    /^GRANT DELETE ON `sigecom_e2e_tmp_20261119040000_aaaaaaaa`\.`role_permissions`/,
  );
  assert.match(
    ddl[6],
    /^GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER ON `sigecom_e2e_tmp_20261119040000_aaaaaaaa`\.\*/,
  );
  assert.doesNotMatch(ddl.join("\n"), /\bON\s+\*\.\*|\bWITH GRANT OPTION\b/i);
  assert.match(
    JSON.stringify(ledger.snapshot().steps["grant.migrator"]),
    /"status":"succeeded"/,
  );
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
