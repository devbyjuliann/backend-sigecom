import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODES = new Set([
  "PRE-FLIGHT",
  "PROVISION",
  "RECOVER",
  "DDL-CHECK",
  "RUN",
]);
const RUN_ID_PATTERN = /^\d{14}_[a-f0-9]{8}$/;
const PREFLIGHT_SENTINEL_RUN_ID = "00000000000000_00000000";
const PREFLIGHT_SENTINEL_SCHEMA = `sigecom_e2e_tmp_${PREFLIGHT_SENTINEL_RUN_ID}`;
const PROTECTED_SCHEMAS = new Set([
  "sigecom_dev",
  "sigecom_test",
  "sigecom_h2_concurrency",
]);
const RESERVED_PRE_FLIGHT_IDENTIFIERS = new Set([
  PREFLIGHT_SENTINEL_RUN_ID,
  PREFLIGHT_SENTINEL_SCHEMA,
]);
const RUN_AUTHORIZATION_KEYS = [
  "SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID",
  "SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID",
  "SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA",
];
const DDL_AUTHORIZATION_KEYS = [
  "SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID",
  "SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID",
  "SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA",
];
const PROVISION_APPROVAL_KEY =
  "SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID";
const RECOVERY_APPROVAL_KEY = "SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID";
const validatedConfigs = new WeakSet();
const SAFE_PROCESS_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "OS",
  "PROCESSOR_ARCHITECTURE",
];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(scriptDirectory, "..");
const integrationTest = path.join(
  backendDirectory,
  "tests",
  "integration",
  "account-access-email-mariadb-isolated.test.js",
);

export function resolveAccountAccessFrontendDirectory(
  backendDirectory,
  pathExists = existsSync,
) {
  if (
    typeof backendDirectory !== "string" ||
    typeof pathExists !== "function"
  ) {
    throw new TypeError(
      "La ruta del backend y el verificador son obligatorios.",
    );
  }
  const candidates = [
    "../frontend-release-candidate",
    "../frontend-sigecom",
    "../frontend-account-access-email",
  ].map((relativePath) => path.resolve(backendDirectory, relativePath));
  return (
    candidates.find((candidate) =>
      pathExists(path.join(candidate, "vite.config.js")),
    ) || candidates[0]
  );
}
const bootstrapIntegrationTest = path.join(
  backendDirectory,
  "tests",
  "integration",
  "account-access-bootstrap-isolated.test.js",
);
const usersIntegrationTest = path.join(
  backendDirectory,
  "tests",
  "integration",
  "users.test.js",
);
const rolePermissionsIntegrationTest = path.join(
  backendDirectory,
  "tests",
  "integration",
  "role-permissions.test.js",
);

function requireEnvironment(environment) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new Error("Se requiere un objeto de entorno válido.");
  }
  return environment;
}

function requireIdentifier(value, name) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`${name} explícito y válido es obligatorio.`);
  }
  if (RESERVED_PRE_FLIGHT_IDENTIFIERS.has(value)) {
    throw new Error(`${name} está reservado para PRE-FLIGHT.`);
  }
  if (`sigecom_e2e_tmp_${value}` === PREFLIGHT_SENTINEL_SCHEMA) {
    throw new Error(`${name} está reservado para PRE-FLIGHT.`);
  }
  return value;
}

function makeValidatedConfig(config) {
  if (config.credentials) Object.freeze(config.credentials);
  const validatedConfig = Object.freeze(config);
  validatedConfigs.add(validatedConfig);
  return validatedConfig;
}

function requireDistinctSecrets(credentials, description) {
  if (
    Object.values(credentials).some(
      (value) =>
        typeof value !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value),
    ) ||
    new Set(Object.values(credentials).filter(Boolean)).size !==
      Object.values(credentials).filter(Boolean).length
  ) {
    throw new Error(
      `Se requieren credenciales aisladas distintas de al menos 32 caracteres para ${description}.`,
    );
  }
  return Object.freeze(credentials);
}

function requireSecrets(env, mode) {
  if (mode === "DDL-CHECK") {
    return requireDistinctSecrets(
      {
        migratorPassword: env.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD,
      },
      "el chequeo DDL",
    );
  }

  const credentials = {
    appPassword: env.SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD,
    fixturePassword: env.SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD,
  };
  if (mode === "PROVISION" || mode === "RECOVER") {
    credentials.migratorPassword = env.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD;
  }
  requireDistinctSecrets(
    credentials,
    mode === "PROVISION" || mode === "RECOVER"
      ? "aplicación, recuperación de migraciones y fixtures"
      : "aplicación y fixtures",
  );
  return Object.freeze(credentials);
}

function requireProvisioner(env, credentials) {
  const user = env.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER;
  const password = env.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD;
  if (
    typeof user !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(user) ||
    user.toLowerCase() === "root" ||
    typeof password !== "string" ||
    !/^[A-Za-z0-9_-]{32,}$/.test(password) ||
    new Set([
      credentials.appPassword,
      credentials.migratorPassword,
      credentials.fixturePassword,
      password,
    ]).size !== 4
  ) {
    throw new Error(
      "PROVISION requiere una identidad explícita de aprovisionamiento distinta de root y una credencial aislada segura.",
    );
  }
  return Object.freeze({ user, password });
}

export function getAccountAccessE2EConfig(mode, env = process.env) {
  env = requireEnvironment(env);
  const environmentMode = env.SIGECOM_ACCOUNT_ACCESS_MODE;
  if (mode !== undefined && mode !== null && environmentMode !== undefined) {
    if (mode !== environmentMode) {
      throw new Error(
        "El modo explícito y SIGECOM_ACCOUNT_ACCESS_MODE están en conflicto.",
      );
    }
  }
  const selectedMode = mode ?? environmentMode;
  if (!MODES.has(selectedMode)) {
    throw new Error(
      "Modo E2E no permitido. Selecciona exactamente PRE-FLIGHT, PROVISION, RECOVER, DDL-CHECK o RUN.",
    );
  }

  if (selectedMode === "PRE-FLIGHT") {
    return makeValidatedConfig({
      mode: selectedMode,
      runId: null,
      attemptId: null,
      schema: null,
      credentials: null,
    });
  }

  if (env.NODE_ENV === "production") {
    throw new Error("El runner aislado rechaza NODE_ENV=production.");
  }

  if (
    (selectedMode === "PROVISION" || selectedMode === "RECOVER") &&
    [...RUN_AUTHORIZATION_KEYS, ...DDL_AUTHORIZATION_KEYS].some(
      (key) => env[key] !== undefined,
    )
  ) {
    throw new Error(
      "Las autorizaciones de RUN/DDL-CHECK no pueden mezclarse con PROVISION ni RECOVER.",
    );
  }
  if (
    selectedMode !== "PROVISION" &&
    env[PROVISION_APPROVAL_KEY] !== undefined
  ) {
    throw new Error(
      "La aprobación de PROVISION no puede mezclarse con RUN ni DDL-CHECK.",
    );
  }
  if (selectedMode !== "RECOVER" && env[RECOVERY_APPROVAL_KEY] !== undefined) {
    throw new Error(
      "La aprobación de RECOVER no puede mezclarse con otros modos E2E.",
    );
  }
  if (
    selectedMode === "RUN" &&
    DDL_AUTHORIZATION_KEYS.some((key) => env[key] !== undefined)
  ) {
    throw new Error(
      "La autorización DDL-CHECK no puede mezclarse con el modo RUN.",
    );
  }
  if (
    selectedMode === "DDL-CHECK" &&
    RUN_AUTHORIZATION_KEYS.some((key) => env[key] !== undefined)
  ) {
    throw new Error("La autorización de RUN no puede mezclarse con DDL-CHECK.");
  }

  const runId = requireIdentifier(env.SIGECOM_ACCOUNT_ACCESS_RUN_ID, "RUN_ID");
  const attemptId = requireIdentifier(
    env.SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID,
    "ATTEMPT_ID",
  );
  if (runId === attemptId) {
    throw new Error("RUN_ID y ATTEMPT_ID deben ser distintos.");
  }

  const schema = `sigecom_e2e_tmp_${runId}`;
  if (PROTECTED_SCHEMAS.has(schema.toLowerCase())) {
    throw new Error("El esquema protegido no es un destino E2E permitido.");
  }
  const credentials = requireSecrets(env, selectedMode);

  if (selectedMode === "PROVISION") {
    if (env[PROVISION_APPROVAL_KEY] !== runId) {
      throw new Error(
        "Falta la aprobación exacta de PROVISION para este RUN_ID.",
      );
    }
  } else if (selectedMode === "RECOVER") {
    if (env[RECOVERY_APPROVAL_KEY] !== runId) {
      throw new Error(
        "Falta la aprobación exacta de RECOVER para este RUN_ID.",
      );
    }
  } else if (
    selectedMode === "RUN" &&
    (env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID !== runId ||
      env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID !== attemptId ||
      env.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA !== schema)
  ) {
    throw new Error(
      "RUN requiere autorización exacta del RUN_ID, ATTEMPT_ID y esquema existente autorizado.",
    );
  } else if (
    selectedMode === "DDL-CHECK" &&
    (env.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID !== runId ||
      env.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID !== attemptId ||
      env.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA !== schema)
  ) {
    throw new Error(
      "DDL-CHECK requiere aprobación exacta del RUN_ID, ATTEMPT_ID y esquema existente autorizado.",
    );
  }

  if (selectedMode === "PROVISION" || selectedMode === "RECOVER") {
    const provisioner = requireProvisioner(env, credentials);
    const config = {
      mode: selectedMode,
      runId,
      attemptId,
      schema,
      credentials,
      provisioner,
    };
    if (selectedMode === "PROVISION") {
      config.provisionApprovedRunId = runId;
    } else {
      config.recoveryApprovedRunId = runId;
    }
    return makeValidatedConfig(config);
  }

  if (selectedMode === "DDL-CHECK") {
    return makeValidatedConfig({
      mode: selectedMode,
      runId,
      attemptId,
      schema,
      credentials,
      ddlApprovedRunId: runId,
      ddlApprovedAttemptId: attemptId,
      ddlApprovedSchema: schema,
    });
  }

  return makeValidatedConfig({
    mode: selectedMode,
    runId,
    attemptId,
    schema,
    credentials,
    authorizedRunId: runId,
    authorizedAttemptId: attemptId,
    authorizedSchema: schema,
  });
}

export function createIntegrationTestEnvironment(
  config,
  sourceEnvironment = process.env,
) {
  sourceEnvironment = requireEnvironment(sourceEnvironment);
  if (!validatedConfigs.has(config)) {
    throw new Error("La configuración del runner no está validada.");
  }

  const childEnvironment = Object.fromEntries(
    SAFE_PROCESS_ENV_KEYS.filter(
      (key) => sourceEnvironment[key] !== undefined,
    ).map((key) => [key, sourceEnvironment[key]]),
  );
  if (sourceEnvironment.NODE_ENV !== undefined) {
    childEnvironment.NODE_ENV = sourceEnvironment.NODE_ENV;
  }
  childEnvironment.SIGECOM_ACCOUNT_ACCESS_MODE = config.mode;

  if (config.mode === "PRE-FLIGHT") return childEnvironment;

  childEnvironment.SIGECOM_ACCOUNT_ACCESS_RUN_ID = config.runId;
  childEnvironment.SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID = config.attemptId;

  if (config.mode === "PROVISION" || config.mode === "RECOVER") {
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD =
      config.credentials.appPassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD =
      config.credentials.migratorPassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD =
      config.credentials.fixturePassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER =
      config.provisioner.user;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD =
      config.provisioner.password;
    if (config.mode === "PROVISION") {
      childEnvironment[PROVISION_APPROVAL_KEY] = config.provisionApprovedRunId;
    } else {
      childEnvironment[RECOVERY_APPROVAL_KEY] = config.recoveryApprovedRunId;
    }
  } else if (config.mode === "RUN") {
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD =
      config.credentials.appPassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD =
      config.credentials.fixturePassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID =
      config.authorizedRunId;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID =
      config.authorizedAttemptId;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA =
      config.authorizedSchema;
  } else {
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD =
      config.credentials.migratorPassword;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID =
      config.ddlApprovedRunId;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID =
      config.ddlApprovedAttemptId;
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA =
      config.ddlApprovedSchema;
  }

  return childEnvironment;
}

export async function executeAccountAccessMode(config, actions) {
  if (!MODES.has(config?.mode)) {
    throw new Error("Modo E2E no permitido.");
  }
  if (!validatedConfigs.has(config)) {
    throw new Error("La configuración del runner no está validada.");
  }
  const action = actions?.[config.mode];
  if (typeof action !== "function") {
    throw new Error(`No hay acción implementada para ${config.mode}.`);
  }
  return action(config);
}

function executeIntegrationTest(config) {
  const tests =
    config.mode === "RUN"
      ? [
          bootstrapIntegrationTest,
          integrationTest,
          usersIntegrationTest,
          rolePermissionsIntegrationTest,
        ]
      : [integrationTest];
  const environment = createIntegrationTestEnvironment(config);
  for (const testFile of tests) {
    const result = spawnSync(process.execPath, ["--test", testFile], {
      cwd: backendDirectory,
      env: environment,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

export function dispatchAccountAccessMode(config, action) {
  if (typeof action !== "function") {
    throw new Error("La acción del runner de integración es obligatoria.");
  }
  return executeAccountAccessMode(
    config,
    Object.fromEntries([...MODES].map((mode) => [mode, action])),
  );
}

function isCliEntryPoint() {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isCliEntryPoint()) {
  try {
    const config = getAccountAccessE2EConfig(process.argv[2]);
    const status = await dispatchAccountAccessMode(
      config,
      executeIntegrationTest,
    );
    process.exitCode = status;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
