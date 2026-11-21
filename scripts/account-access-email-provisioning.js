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
    typeof ledger?.recordStep !== "function"
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
  if (existingSchemas.length > 0 || existingUsers.length > 0) {
    throw new Error(
      "El destino o una cuenta derivada ya existe; PROVISION se detiene sin modificarlo.",
    );
  }

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
  await ledger.recordStep("grant.app", async () => {
    await connection.query(
      `GRANT SELECT, INSERT, UPDATE ON \`${schema}\`.* TO '${appUser}'@'localhost'`,
    );
    await connection.query(
      `GRANT DELETE ON \`${schema}\`.\`user_warehouses\` TO '${appUser}'@'localhost'`,
    );
    await connection.query(
      `GRANT DELETE ON \`${schema}\`.\`role_permissions\` TO '${appUser}'@'localhost'`,
    );
  });
  await ledger.recordStep("grant.migrator", () =>
    connection.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, TRIGGER ON \`${schema}\`.* TO '${migratorUser}'@'localhost'`,
    ),
  );
}
