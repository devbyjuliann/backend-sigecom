import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function loadLedgerModule() {
  try {
    return await import("./account-access-email-resource-ledger.js");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

async function createTestLedger(t, directory) {
  const module = await loadLedgerModule();
  assert.ok(module, "debe existir el registro durable de propiedad");
  return module.createResourceOwnershipLedger({
    directory,
    runId: "20261119040000_aaaaaaaa",
    attemptId: "20261119040001_bbbbbbbb",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
    appUser: "sgapp_20261119040000_aaaaaaaa",
    migratorUser: "sgmig_20261119040000_aaaaaaaa",
  });
}

async function completeProvisioningLedger(ledger) {
  for (const step of [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
    "grant.app",
    "grant.app.tables",
    "grant.migrator",
    "migrations.table",
    ...Array.from(
      { length: 19 },
      (_, index) => `migration.${String(index + 1).padStart(4, "0")}`,
    ),
    "fixtures.legacy",
    "fixtures.account-access",
  ]) {
    await ledger.recordStep(step, async () => {});
  }
}

test("resource ownership ledger persists exact ownership and successful stages without secrets", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  await completeProvisioningLedger(ledger);
  const snapshot = await ledger.markReady();
  const persisted = JSON.parse(await readFile(ledger.path, "utf8"));

  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.owner.runId, "20261119040000_aaaaaaaa");
  assert.equal(snapshot.owner.attemptId, "20261119040001_bbbbbbbb");
  assert.equal(
    snapshot.resources.schema.name,
    "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
  );
  assert.equal(snapshot.steps["schema.create"].status, "succeeded");
  assert.equal(persisted.state, "ready");
  assert.equal(JSON.stringify(persisted).includes("password"), false);

  const module = await loadLedgerModule();
  const readBack = await module.readResourceOwnershipLedger({
    directory,
    runId: "20261119040000_aaaaaaaa",
    attemptId: "20261119040001_bbbbbbbb",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
    expectedState: "ready",
  });
  assert.deepEqual(readBack, persisted);
});

test("resource ownership ledger creation is exclusive for a RUN_ID", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-exclusive-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  await createTestLedger(t, directory);
  await assert.rejects(
    createTestLedger(t, directory),
    (error) => error.code === "EEXIST",
  );
});

test("a partially applied stage remains unknown and cannot be marked ready", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-partial-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  await assert.rejects(
    ledger.recordStep("grant.app", async () => {
      throw new Error("simulated failure containing a private-secret");
    }),
    /simulated failure/,
  );
  const persisted = JSON.parse(await readFile(ledger.path, "utf8"));

  assert.equal(persisted.state, "provisioning");
  assert.equal(persisted.steps["grant.app"].status, "unknown");
  assert.equal(JSON.stringify(persisted).includes("private-secret"), false);
  await assert.rejects(ledger.markReady(), /incomplet|unknown|succeeded/i);
});

test("resource ownership resumes only the exact partial grant stage", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-resume-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  for (const step of [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
  ]) {
    await ledger.recordStep(step, async () => {});
  }
  await assert.rejects(
    ledger.recordStep("grant.app", async () => {
      throw new Error("grant denied");
    }),
    /grant denied/,
  );

  const module = await loadLedgerModule();
  assert.equal(typeof module.resumeResourceOwnershipLedger, "function");
  const resumed = await module.resumeResourceOwnershipLedger({
    directory,
    runId: "20261119040000_aaaaaaaa",
    ownerAttemptId: "20261119040001_bbbbbbbb",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
    appUser: "sgapp_20261119040000_aaaaaaaa",
    migratorUser: "sgmig_20261119040000_aaaaaaaa",
  });
  await resumed.retryStep("grant.app", async () => {});
  await resumed.recordStep("grant.migrator", async () => {});

  assert.equal(resumed.snapshot().steps["grant.app"].status, "succeeded");
  assert.equal(resumed.snapshot().steps["grant.migrator"].status, "succeeded");
  assert.equal(resumed.snapshot().owner.attemptId, "20261119040001_bbbbbbbb");
  assert.equal(resumed.snapshot().state, "provisioning");
  await assert.rejects(resumed.markReady(), /incomplet|succeeded/i);
});

test("resource ownership lookup permits fresh attempts for the same ready RUN_ID", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-lookup-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  await completeProvisioningLedger(ledger);
  await ledger.markReady();
  const module = await loadLedgerModule();

  const firstAttempt = await module.readResourceOwnershipLedger({
    directory,
    runId: "20261119040000_aaaaaaaa",
    attemptId: "20261119040002_cccccccc",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
    expectedState: "ready",
  });
  const secondAttempt = await module.readResourceOwnershipLedger({
    directory,
    runId: "20261119040000_aaaaaaaa",
    attemptId: "20261119040003_dddddddd",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
    expectedState: "ready",
  });

  assert.deepEqual(secondAttempt, firstAttempt);
  assert.equal(firstAttempt.owner.runId, "20261119040000_aaaaaaaa");
  assert.equal(firstAttempt.owner.attemptId, "20261119040001_bbbbbbbb");

  for (const overrides of [
    { runId: "20261119040004_eeeeeeee" },
    {
      schema: "sigecom_e2e_tmp_other",
    },
  ]) {
    await assert.rejects(
      module.readResourceOwnershipLedger({
        directory,
        runId: "20261119040000_aaaaaaaa",
        attemptId: "20261119040002_cccccccc",
        schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
        expectedState: "ready",
        ...overrides,
      }),
      /coincide|propiedad|objetivo/i,
    );
  }
});

test("resource ownership durably claims each RUN attempt once for the same schema", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-attempts-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  await completeProvisioningLedger(ledger);
  await ledger.markReady();
  const module = await loadLedgerModule();
  const target = {
    directory,
    runId: "20261119040000_aaaaaaaa",
    schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
  };
  const first = await module.claimResourceOwnershipAttempt({
    ...target,
    attemptId: "20261119040002_cccccccc",
  });
  const second = await module.claimResourceOwnershipAttempt({
    ...target,
    attemptId: "20261119040003_dddddddd",
  });

  assert.equal(first.owner.runId, target.runId);
  assert.equal(second.owner.runId, target.runId);
  assert.deepEqual(
    second.acceptanceAttempts.map(({ attemptId }) => attemptId),
    ["20261119040002_cccccccc", "20261119040003_dddddddd"],
  );
  const concurrentClaims = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      module.claimResourceOwnershipAttempt({
        ...target,
        attemptId: "20261119040005_ffffffff",
      }),
    ),
  );
  assert.equal(
    concurrentClaims.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrentClaims.filter(({ status }) => status === "rejected").length,
    1,
  );
  const afterConcurrentClaim = JSON.parse(await readFile(ledger.path, "utf8"));
  assert.equal(
    afterConcurrentClaim.acceptanceAttempts.filter(
      ({ attemptId }) => attemptId === "20261119040005_ffffffff",
    ).length,
    1,
  );
  await assert.rejects(
    module.claimResourceOwnershipAttempt({
      ...target,
      attemptId: "20261119040002_cccccccc",
    }),
    /intento.*ya|ATTEMPT_ID.*ya/i,
  );
  await assert.rejects(
    module.claimResourceOwnershipAttempt({
      ...target,
      attemptId: "20261119040001_bbbbbbbb",
    }),
    /provisi[oó]n|propiedad/i,
  );
});

test("resource ownership lookup rejects unknown fields instead of logging injected secrets", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-unexpected-field-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  await completeProvisioningLedger(ledger);
  await ledger.markReady();
  const record = JSON.parse(await readFile(ledger.path, "utf8"));
  record.credentials = "private-secret-must-not-be-logged";
  await writeFile(ledger.path, JSON.stringify(record), "utf8");
  const module = await loadLedgerModule();

  await assert.rejects(
    module.readResourceOwnershipLedger({
      directory,
      runId: "20261119040000_aaaaaaaa",
      attemptId: "20261119040001_bbbbbbbb",
      schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
      expectedState: "ready",
    }),
    /inválido/i,
  );
  delete record.credentials;
  record.updatedAt = "private-secret-must-not-be-logged";
  await writeFile(ledger.path, JSON.stringify(record), "utf8");
  await assert.rejects(
    module.readResourceOwnershipLedger({
      directory,
      runId: "20261119040000_aaaaaaaa",
      attemptId: "20261119040001_bbbbbbbb",
      schema: "sigecom_e2e_tmp_20261119040000_aaaaaaaa",
      expectedState: "ready",
    }),
    /inválido/i,
  );
});

test("resource ownership cannot become ready before every migration and fixture stage", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sigecom-resource-ledger-incomplete-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = await createTestLedger(t, directory);
  for (const step of [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
    "grant.app",
    "grant.app.tables",
    "grant.migrator",
  ]) {
    await ledger.recordStep(step, async () => {});
  }

  await assert.rejects(ledger.markReady(), /incomplet|migration|fixture/i);
});
