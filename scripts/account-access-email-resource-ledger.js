import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_ID_PATTERN = /^\d{14}_[a-f0-9]{8}$/;
const STEP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const RESOURCE_BY_STEP = new Map([
  ["schema.create", ["resources", "schema"]],
  ["user.app.create", ["resources", "appUser"]],
  ["user.migrator.create", ["resources", "migratorUser"]],
  ["grant.app", ["grants", "app"]],
  ["grant.app.tables", ["grants", "app"]],
  ["grant.migrator", ["grants", "migrator"]],
]);
const REQUIRED_PROVISIONING_STEPS = [
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
];

function requireRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`${label} del registro de propiedad no es válido.`);
  }
  return value;
}

function resourceLedgerPath(directory, runId) {
  return path.join(path.resolve(directory), `${runId}.json`);
}

export function defaultResourceOwnershipDirectory(environment = process.env) {
  const localAppData =
    environment.LOCALAPPDATA ||
    path.join(environment.USERPROFILE || os.homedir(), "AppData", "Local");
  return path.join(
    localAppData,
    "SIGECOM",
    "account-access-email",
    "resource-ownership",
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertKeys(value, keys, requiredKeys = keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(
      "El registro durable de propiedad contiene campos inválidos.",
    );
  }
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateTarget({ runId, attemptId, schema, appUser, migratorUser }) {
  runId = requireRunId(runId, "RUN_ID");
  attemptId = requireRunId(attemptId, "ATTEMPT_ID");
  if (runId === attemptId) {
    throw new Error("RUN_ID y ATTEMPT_ID deben ser distintos.");
  }
  if (
    schema !== `sigecom_e2e_tmp_${runId}` ||
    appUser !== `sgapp_${runId}` ||
    migratorUser !== `sgmig_${runId}`
  ) {
    throw new Error(
      "El objetivo del registro de propiedad no coincide con el RUN_ID.",
    );
  }
  return { runId, attemptId, schema, appUser, migratorUser };
}

function assertRecord(record) {
  assertKeys(
    record,
    [
      "formatVersion",
      "state",
      "owner",
      "resources",
      "grants",
      "createdAt",
      "updatedAt",
      "readyAt",
      "steps",
      "acceptanceAttempts",
    ],
    [
      "formatVersion",
      "state",
      "owner",
      "resources",
      "grants",
      "createdAt",
      "updatedAt",
      "steps",
    ],
  );
  assertKeys(record.owner, ["runId", "attemptId"]);
  assertKeys(record.resources, ["schema", "appUser", "migratorUser"]);
  assertKeys(record.resources.schema, ["name", "status"]);
  assertKeys(record.resources.appUser, ["name", "host", "status"]);
  assertKeys(record.resources.migratorUser, ["name", "host", "status"]);
  assertKeys(record.grants, ["app", "migrator"]);
  assertKeys(record.grants.app, ["status"]);
  assertKeys(record.grants.migrator, ["status"]);
  assertKeys(record.steps, Object.keys(record.steps));

  if (
    record?.formatVersion !== 1 ||
    !["provisioning", "ready"].includes(record.state) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    (record.state === "ready" && !isTimestamp(record.readyAt)) ||
    (record.state === "provisioning" && Object.hasOwn(record, "readyAt")) ||
    record.resources.appUser.host !== "localhost" ||
    record.resources.migratorUser.host !== "localhost" ||
    !["planned", "pending", "succeeded", "unknown"].includes(
      record.resources.schema.status,
    ) ||
    !["planned", "pending", "succeeded", "unknown"].includes(
      record.resources.appUser.status,
    ) ||
    !["planned", "pending", "succeeded", "unknown"].includes(
      record.resources.migratorUser.status,
    ) ||
    !["planned", "pending", "succeeded", "unknown"].includes(
      record.grants.app.status,
    ) ||
    !["planned", "pending", "succeeded", "unknown"].includes(
      record.grants.migrator.status,
    )
  ) {
    throw new Error(
      "El registro durable de propiedad está incompleto o inválido.",
    );
  }
  for (const [name, step] of Object.entries(record.steps)) {
    if (
      !STEP_PATTERN.test(name) ||
      (record.state === "ready" && step.status !== "succeeded")
    ) {
      throw new Error(
        "El registro durable de propiedad contiene pasos inválidos.",
      );
    }
    assertKeys(
      step,
      ["status", "startedAt", "completedAt", "errorCode"],
      ["status", "startedAt"],
    );
    if (
      !["pending", "succeeded", "unknown"].includes(step.status) ||
      !isTimestamp(step.startedAt) ||
      (step.completedAt !== undefined && !isTimestamp(step.completedAt)) ||
      (step.errorCode !== undefined &&
        (typeof step.errorCode !== "string" ||
          !/^(?:[A-Z0-9_]{1,40}|\d{1,8})$/.test(step.errorCode)))
    ) {
      throw new Error(
        "El registro durable de propiedad contiene pasos inválidos.",
      );
    }
  }
  if (Object.hasOwn(record, "acceptanceAttempts")) {
    if (!Array.isArray(record.acceptanceAttempts)) {
      throw new Error(
        "El registro durable contiene intentos de aceptación inválidos.",
      );
    }
    const seenAttempts = new Set();
    for (const attempt of record.acceptanceAttempts) {
      assertKeys(attempt, ["attemptId", "startedAt"]);
      validateTarget({
        runId: record.owner.runId,
        attemptId: attempt.attemptId,
        schema: record.resources.schema.name,
        appUser: record.resources.appUser.name,
        migratorUser: record.resources.migratorUser.name,
      });
      if (
        attempt.attemptId === record.owner.attemptId ||
        seenAttempts.has(attempt.attemptId) ||
        !isTimestamp(attempt.startedAt)
      ) {
        throw new Error(
          "El registro durable contiene intentos de aceptación duplicados o inválidos.",
        );
      }
      seenAttempts.add(attempt.attemptId);
    }
  }
  if (
    record.state === "ready" &&
    (Object.keys(record.steps).length === 0 ||
      REQUIRED_PROVISIONING_STEPS.some(
        (step) => record.steps[step]?.status !== "succeeded",
      ) ||
      Object.values(record.resources).some(
        ({ status }) => status !== "succeeded",
      ) ||
      Object.values(record.grants).some(({ status }) => status !== "succeeded"))
  ) {
    throw new Error(
      "El registro durable de propiedad listo tiene etapas incompletas.",
    );
  }
  validateTarget({
    runId: record.owner.runId,
    attemptId: record.owner.attemptId,
    schema: record.resources.schema.name,
    appUser: record.resources.appUser.name,
    migratorUser: record.resources.migratorUser.name,
  });
  return record;
}

async function writeInitialRecord(filePath, record) {
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function replaceRecord(filePath, record) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function createResourceOwnershipLedger({
  directory = defaultResourceOwnershipDirectory(),
  runId,
  attemptId,
  schema,
  appUser,
  migratorUser,
}) {
  const target = validateTarget({
    runId,
    attemptId,
    schema,
    appUser,
    migratorUser,
  });
  const resolvedDirectory = path.resolve(directory);
  const filePath = resourceLedgerPath(resolvedDirectory, target.runId);
  await mkdir(resolvedDirectory, { recursive: true });

  const now = new Date().toISOString();
  const record = {
    formatVersion: 1,
    state: "provisioning",
    owner: {
      runId: target.runId,
      attemptId: target.attemptId,
    },
    resources: {
      schema: { name: target.schema, status: "planned" },
      appUser: {
        name: target.appUser,
        host: "localhost",
        status: "planned",
      },
      migratorUser: {
        name: target.migratorUser,
        host: "localhost",
        status: "planned",
      },
    },
    grants: {
      app: { status: "planned" },
      migrator: { status: "planned" },
    },
    createdAt: now,
    updatedAt: now,
    steps: {},
    acceptanceAttempts: [],
  };
  await writeInitialRecord(filePath, record);

  async function persist() {
    record.updatedAt = new Date().toISOString();
    await replaceRecord(filePath, record);
    return clone(record);
  }

  async function recordStep(name, operation) {
    if (
      typeof name !== "string" ||
      !STEP_PATTERN.test(name) ||
      typeof operation !== "function"
    ) {
      throw new Error("El paso durable de aprovisionamiento no es válido.");
    }
    if (Object.hasOwn(record.steps, name)) {
      throw new Error(`El paso durable ${name} ya está registrado.`);
    }

    const step = { status: "pending", startedAt: new Date().toISOString() };
    record.steps[name] = step;
    const resourcePath = RESOURCE_BY_STEP.get(name);
    if (resourcePath) {
      record[resourcePath[0]][resourcePath[1]].status = "pending";
    }
    await persist();

    try {
      const result = await operation();
      step.status = "succeeded";
      step.completedAt = new Date().toISOString();
      if (resourcePath) {
        record[resourcePath[0]][resourcePath[1]].status = "succeeded";
      }
      await persist();
      return result;
    } catch (error) {
      step.status = "unknown";
      const code = error?.code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) {
        step.errorCode = code;
      } else if (Number.isInteger(error?.errno)) {
        step.errorCode = String(error.errno);
      }
      if (resourcePath) {
        record[resourcePath[0]][resourcePath[1]].status = "unknown";
      }
      await persist();
      throw error;
    }
  }

  async function markReady() {
    const steps = Object.values(record.steps);
    if (
      steps.length === 0 ||
      REQUIRED_PROVISIONING_STEPS.some(
        (step) => record.steps[step]?.status !== "succeeded",
      ) ||
      steps.some(({ status }) => status !== "succeeded") ||
      Object.values(record.resources).some(
        ({ status }) => status !== "succeeded",
      ) ||
      Object.values(record.grants).some(({ status }) => status !== "succeeded")
    ) {
      throw new Error(
        "El registro de propiedad no puede marcarse listo con migraciones, fixtures o recursos incompletos/desconocidos.",
      );
    }
    record.state = "ready";
    record.readyAt = new Date().toISOString();
    return persist();
  }

  return Object.freeze({
    path: filePath,
    recordStep,
    markReady,
    snapshot: () => clone(record),
  });
}

export async function resumeResourceOwnershipLedger({
  directory = defaultResourceOwnershipDirectory(),
  runId,
  ownerAttemptId,
  schema,
  appUser,
  migratorUser,
}) {
  const target = validateTarget({
    runId,
    attemptId: ownerAttemptId,
    schema,
    appUser,
    migratorUser,
  });
  const filePath = resourceLedgerPath(path.resolve(directory), target.runId);
  let record;
  try {
    record = assertRecord(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    throw new Error("El registro parcial de propiedad no es válido.");
  }

  const expectedSteps = [
    "schema.create",
    "user.app.create",
    "user.migrator.create",
    "grant.app",
  ];
  if (
    record.state !== "provisioning" ||
    record.owner.runId !== target.runId ||
    record.owner.attemptId !== target.attemptId ||
    record.resources.schema.name !== target.schema ||
    record.resources.appUser.name !== target.appUser ||
    record.resources.migratorUser.name !== target.migratorUser ||
    Object.keys(record.steps).length !== expectedSteps.length ||
    expectedSteps.some((step) => !Object.hasOwn(record.steps, step)) ||
    ["schema.create", "user.app.create", "user.migrator.create"].some(
      (step) => record.steps[step].status !== "succeeded",
    ) ||
    record.steps["grant.app"].status !== "unknown" ||
    record.resources.schema.status !== "succeeded" ||
    record.resources.appUser.status !== "succeeded" ||
    record.resources.migratorUser.status !== "succeeded" ||
    record.grants.app.status !== "unknown" ||
    record.grants.migrator.status !== "planned"
  ) {
    throw new Error(
      "El registro no coincide con el único estado parcial autorizado para recuperación.",
    );
  }

  async function persist() {
    record.updatedAt = new Date().toISOString();
    await replaceRecord(filePath, record);
    return clone(record);
  }

  async function runStep(name, operation, { retryUnknown = false } = {}) {
    if (
      typeof name !== "string" ||
      !STEP_PATTERN.test(name) ||
      typeof operation !== "function"
    ) {
      throw new Error("El paso durable de recuperación no es válido.");
    }
    let step = record.steps[name];
    if (step) {
      if (!retryUnknown || name !== "grant.app" || step.status !== "unknown") {
        throw new Error(`El paso durable ${name} ya está registrado.`);
      }
      step = { status: "pending", startedAt: new Date().toISOString() };
      record.steps[name] = step;
      record.grants.app.status = "pending";
    } else {
      step = { status: "pending", startedAt: new Date().toISOString() };
      record.steps[name] = step;
      const resourcePath = RESOURCE_BY_STEP.get(name);
      if (resourcePath) {
        record[resourcePath[0]][resourcePath[1]].status = "pending";
      }
    }
    await persist();

    try {
      const result = await operation();
      step.status = "succeeded";
      step.completedAt = new Date().toISOString();
      const resourcePath = RESOURCE_BY_STEP.get(name);
      if (resourcePath) {
        record[resourcePath[0]][resourcePath[1]].status = "succeeded";
      }
      await persist();
      return result;
    } catch (error) {
      step.status = "unknown";
      const code = error?.code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) {
        step.errorCode = code;
      } else if (Number.isInteger(error?.errno)) {
        step.errorCode = String(error.errno);
      }
      const resourcePath = RESOURCE_BY_STEP.get(name);
      if (resourcePath) {
        record[resourcePath[0]][resourcePath[1]].status = "unknown";
      }
      await persist();
      throw error;
    }
  }

  async function markReady() {
    const steps = Object.values(record.steps);
    if (
      steps.length === 0 ||
      REQUIRED_PROVISIONING_STEPS.some(
        (step) => record.steps[step]?.status !== "succeeded",
      ) ||
      steps.some(({ status }) => status !== "succeeded") ||
      Object.values(record.resources).some(
        ({ status }) => status !== "succeeded",
      ) ||
      Object.values(record.grants).some(({ status }) => status !== "succeeded")
    ) {
      throw new Error(
        "El registro de propiedad no puede marcarse listo con migraciones, fixtures o recursos incompletos/desconocidos.",
      );
    }
    record.state = "ready";
    record.readyAt = new Date().toISOString();
    return persist();
  }

  return Object.freeze({
    path: filePath,
    recordStep: (name, operation) => runStep(name, operation),
    retryStep: (name, operation) =>
      runStep(name, operation, { retryUnknown: true }),
    markReady,
    snapshot: () => clone(record),
  });
}

export async function readResourceOwnershipLedger({
  directory = defaultResourceOwnershipDirectory(),
  runId,
  attemptId,
  schema,
  expectedState = "ready",
}) {
  const target = validateTarget({
    runId,
    attemptId,
    schema,
    appUser: `sgapp_${runId}`,
    migratorUser: `sgmig_${runId}`,
  });
  const contents = await readFile(
    resourceLedgerPath(directory, target.runId),
    "utf8",
  );
  let record;
  try {
    record = assertRecord(JSON.parse(contents));
  } catch {
    throw new Error("El registro durable de propiedad está inválido.");
  }

  if (
    record.state !== expectedState ||
    record.owner.runId !== target.runId ||
    record.resources.schema.name !== target.schema
  ) {
    throw new Error(
      "El registro durable de propiedad no coincide con la autorización u objetivo.",
    );
  }
  return clone(record);
}

export async function claimResourceOwnershipAttempt({
  directory = defaultResourceOwnershipDirectory(),
  runId,
  attemptId,
  schema,
}) {
  const target = validateTarget({
    runId,
    attemptId,
    schema,
    appUser: `sgapp_${runId}`,
    migratorUser: `sgmig_${runId}`,
  });
  const filePath = resourceLedgerPath(directory, target.runId);
  const lockPath = `${filePath}.attempt.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    let record;
    try {
      record = assertRecord(JSON.parse(await readFile(filePath, "utf8")));
    } catch {
      throw new Error("El registro durable de propiedad está inválido.");
    }
    if (
      record.state !== "ready" ||
      record.owner.runId !== target.runId ||
      record.resources.schema.name !== target.schema
    ) {
      throw new Error(
        "El intento RUN requiere propiedad durable lista para el mismo RUN_ID y esquema.",
      );
    }
    if (record.owner.attemptId === target.attemptId) {
      throw new Error(
        "ATTEMPT_ID debe ser nuevo y distinto del intento de PROVISION.",
      );
    }
    record.acceptanceAttempts ??= [];
    if (
      record.acceptanceAttempts.some(
        (attempt) => attempt.attemptId === target.attemptId,
      )
    ) {
      throw new Error(
        "ATTEMPT_ID ya fue utilizado; cada ejecución RUN requiere uno nuevo.",
      );
    }
    record.acceptanceAttempts.push({
      attemptId: target.attemptId,
      startedAt: new Date().toISOString(),
    });
    record.updatedAt = new Date().toISOString();
    await replaceRecord(filePath, record);
    return clone(record);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
