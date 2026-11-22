const RUN_ID_PATTERN = /^\d{14}_[a-f0-9]{8}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function validateProvisioningTarget({
  runId,
  schema,
  appUser,
  migratorUser,
  appPassword,
  migratorPassword,
}) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("RUN_ID del aprovisionamiento no es válido.");
  }
  if (
    schema !== `sigecom_e2e_tmp_${runId}` ||
    appUser !== `sgapp_${runId}` ||
    migratorUser !== `sgmig_${runId}`
  ) {
    throw new Error("El destino de aprovisionamiento no coincide con RUN_ID.");
  }
  if (
    typeof appPassword !== "string" ||
    !SECRET_PATTERN.test(appPassword) ||
    typeof migratorPassword !== "string" ||
    !SECRET_PATTERN.test(migratorPassword) ||
    appPassword === migratorPassword
  ) {
    throw new Error(
      "Las credenciales de las cuentas aisladas deben ser seguras y distintas.",
    );
  }
}

export function assertProvisionerIdentity(currentIdentity, expectedUser) {
  const identityParts =
    typeof currentIdentity === "string" ? currentIdentity.split("@") : [];
  const [user, host] = identityParts;
  if (
    typeof expectedUser !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(expectedUser) ||
    expectedUser.toLowerCase() === "root" ||
    identityParts.length !== 2 ||
    user.toLowerCase() !== expectedUser.toLowerCase() ||
    !["localhost", "127.0.0.1"].includes(host.toLowerCase())
  ) {
    throw new Error(
      "La identidad efectiva de PROVISION no coincide con el provisioner local autorizado.",
    );
  }
  return true;
}

export async function provisionIsolatedDatabaseResources({
  connection,
  ledger,
  runId,
  schema,
  appUser,
  migratorUser,
  appPassword,
  migratorPassword,
  resumeExisting = false,
}) {
  validateProvisioningTarget({
    runId,
    schema,
    appUser,
    migratorUser,
    appPassword,
    migratorPassword,
  });
  if (
    !connection ||
    typeof connection.execute !== "function" ||
    typeof connection.query !== "function" ||
    typeof ledger?.recordStep !== "function" ||
    (resumeExisting && typeof ledger?.retryStep !== "function")
  ) {
    throw new Error(
      "La conexión y el registro durable son obligatorios para aprovisionar.",
    );
  }

  const [existingSchemas] = await connection.execute(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [schema],
  );
  const [existingUsers] = await connection.execute(
    "SELECT User FROM mysql.user WHERE User IN (?, ?)",
    [appUser, migratorUser],
  );
  if (
    !resumeExisting &&
    (existingSchemas.length > 0 || existingUsers.length > 0)
  ) {
    throw new Error(
      "El destino o una cuenta derivada ya existe; PROVISION se detiene sin modificarlo.",
    );
  }
  if (resumeExisting) {
    const [existingTables] = await connection.execute(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [schema],
    );
    const ledgerState = ledger.snapshot?.();
    if (
      existingSchemas.length !== 1 ||
      existingUsers.length !== 2 ||
      existingTables.length !== 0 ||
      ledgerState?.state !== "provisioning" ||
      ledgerState?.resources.schema.status !== "succeeded" ||
      ledgerState?.resources.appUser.status !== "succeeded" ||
      ledgerState?.resources.migratorUser.status !== "succeeded" ||
      ledgerState?.steps["grant.app"]?.status !== "unknown" ||
      ledgerState?.grants.app.status !== "unknown" ||
      ledgerState?.grants.migrator.status !== "planned"
    ) {
      throw new Error(
        "La recuperación solo admite esquema vacío, dos cuentas existentes y el grant.app desconocido.",
      );
    }
  }

  const grantSchema = schema.replace(/[\\%_]/g, "\\$&");

  if (!resumeExisting) {
    await ledger.recordStep("schema.create", () =>
      connection.query(
        `CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      ),
    );
    await ledger.recordStep("user.app.create", () =>
      connection.query(
        `CREATE USER '${appUser}'@'localhost' IDENTIFIED BY '${appPassword}'`,
      ),
    );
    await ledger.recordStep("user.migrator.create", () =>
      connection.query(
        `CREATE USER '${migratorUser}'@'localhost' IDENTIFIED BY '${migratorPassword}'`,
      ),
    );
  }
  const grantApp = async () => {
    await connection.query(
      `GRANT SELECT, INSERT, UPDATE ON \`${grantSchema}\`.* TO '${appUser}'@'localhost'`,
    );
  };
  if (resumeExisting) {
    await ledger.retryStep("grant.app", grantApp);
  } else {
    await ledger.recordStep("grant.app", grantApp);
  }
  await ledger.recordStep("grant.migrator", () =>
    connection.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER ON \`${grantSchema}\`.* TO '${migratorUser}'@'localhost'`,
    ),
  );
}

export async function grantIsolatedApplicationTablePrivileges({
  connection,
  ledger,
  runId,
  schema,
  appUser,
}) {
  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    schema !== `sigecom_e2e_tmp_${runId}` ||
    appUser !== `sgapp_${runId}`
  ) {
    throw new Error("El destino de permisos de tablas no coincide con RUN_ID.");
  }
  if (
    !connection ||
    typeof connection.execute !== "function" ||
    typeof connection.query !== "function" ||
    typeof ledger?.recordStep !== "function" ||
    typeof ledger?.snapshot !== "function"
  ) {
    throw new Error(
      "La conexión y el registro durable son obligatorios para conceder permisos de tablas.",
    );
  }

  const ledgerState = ledger.snapshot();
  if (
    ledgerState?.state !== "provisioning" ||
    ledgerState.grants.app.status !== "succeeded" ||
    ledgerState.grants.migrator.status !== "succeeded" ||
    Object.hasOwn(ledgerState.steps, "grant.app.tables")
  ) {
    throw new Error(
      "Los permisos de tablas requieren los grants base registrados y pendientes de finalización.",
    );
  }

  const [schemas] = await connection.execute(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [schema],
  );
  const [users] = await connection.execute(
    "SELECT User FROM mysql.user WHERE User = ?",
    [appUser],
  );
  const [tables] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (?, ?)`,
    [schema, "user_warehouses", "role_permissions"],
  );
  const existingTables = new Set(tables.map(({ TABLE_NAME }) => TABLE_NAME));
  if (
    schemas.length !== 1 ||
    users.length < 1 ||
    existingTables.size !== 2 ||
    !existingTables.has("user_warehouses") ||
    !existingTables.has("role_permissions")
  ) {
    throw new Error(
      "Los permisos DELETE sólo se conceden cuando existen ambas tablas y la cuenta APP en el esquema autorizado.",
    );
  }

  const grantSchema = schema.replace(/[\\%_]/g, "\\$&");
  await ledger.recordStep("grant.app.tables", async () => {
    await connection.query(
      `GRANT DELETE ON \`${grantSchema}\`.\`user_warehouses\` TO '${appUser}'@'localhost'`,
    );
    await connection.query(
      `GRANT DELETE ON \`${grantSchema}\`.\`role_permissions\` TO '${appUser}'@'localhost'`,
    );
  });
}
