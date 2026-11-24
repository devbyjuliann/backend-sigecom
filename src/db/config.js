import { isIP } from "node:net";

const localTargets = {
  development: { database: "sigecom_dev", prefix: "SIGECOM_DEV" },
  test: { database: "sigecom_test", prefix: "SIGECOM_TEST" },
};
const protectedProductionSchemas = new Set([
  "sigecom_dev",
  "sigecom_test",
  "sigecom_h2_concurrency",
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
]);

export function resolveRuntimeDatabaseTarget(env = process.env) {
  if (env.NODE_ENV === "development") return "development";
  if (env.NODE_ENV === "production") return "production";
  throw new Error(
    "NODE_ENV explícito debe ser development o production para iniciar la API.",
  );
}

export function getTrustedProxyAddresses(value) {
  if (value === undefined || value.trim() === "") return false;
  const addresses = [...new Set(value.split(",").map((item) => item.trim()))];
  if (!addresses.length || addresses.some((address) => !isIP(address))) {
    throw new Error(
      "TRUSTED_PROXY_IPS solo acepta direcciones IP explícitas; no admite CIDR ni comodines.",
    );
  }
  return addresses;
}

function productionHost(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[/:?#@\\\s]/.test(value)
  ) {
    throw new Error(
      "SIGECOM_PROD_DB_HOST debe ser un host SQL válido explícito.",
    );
  }
  if (isIP(value)) return value;
  const labels = value.split(".");
  if (
    value.length > 253 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    throw new Error(
      "SIGECOM_PROD_DB_HOST debe ser un host SQL válido explícito.",
    );
  }
  return value;
}

function productionDatabaseConfig(env, role) {
  if (env.NODE_ENV !== "production") {
    throw new Error(
      "La configuración SQL production requiere NODE_ENV=production.",
    );
  }
  if (!["APP", "MIGRATOR"].includes(role)) {
    throw new Error("Rol SQL no permitido.");
  }

  const database = env.SIGECOM_PROD_DATABASE;
  if (
    typeof database !== "string" ||
    !/^[a-zA-Z0-9_]{1,64}$/.test(database) ||
    protectedProductionSchemas.has(database.toLowerCase()) ||
    database.toLowerCase().startsWith("sigecom_e2e_tmp_")
  ) {
    throw new Error(
      "SIGECOM_PROD_DATABASE debe ser un identificador válido distinto de esquemas protegidos.",
    );
  }

  const host = productionHost(env.SIGECOM_PROD_DB_HOST);
  const port = Number(env.SIGECOM_PROD_DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SIGECOM_PROD_DB_PORT debe ser un puerto SQL válido.");
  }

  const caBase64 = env.SIGECOM_PROD_DB_TLS_CA_BASE64;
  if (
    typeof caBase64 !== "string" ||
    !caBase64 ||
    caBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      caBase64,
    )
  ) {
    throw new Error(
      "SIGECOM_PROD_DB_TLS_CA_BASE64 debe contener el certificado CA en Base64.",
    );
  }
  const ca = Buffer.from(caBase64, "base64").toString("utf8");
  if (
    !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(
      ca,
    )
  ) {
    throw new Error(
      "El certificado CA SQL production no tiene formato PEM válido.",
    );
  }

  const appUser = env.SIGECOM_PROD_APP_USER;
  const migratorUser = env.SIGECOM_PROD_MIGRATOR_USER;
  const validUser = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,32}$/.test(value);
  if (
    !validUser(appUser) ||
    (role === "MIGRATOR" &&
      (!validUser(migratorUser) || appUser === migratorUser))
  ) {
    throw new Error(
      "Las cuentas SQL production APP y MIGRATOR deben ser válidas y distintas.",
    );
  }

  const username = role === "APP" ? appUser : migratorUser;
  const password =
    role === "APP"
      ? env.SIGECOM_PROD_APP_PASSWORD
      : env.SIGECOM_PROD_MIGRATOR_PASSWORD;
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password, "utf8") < 32 ||
    [...password].some(
      (character) =>
        character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(
      `La contraseña SQL production ${role} debe tener al menos 32 bytes y no incluir controles.`,
    );
  }
  if (
    role === "APP" &&
    env.SIGECOM_PROD_MIGRATOR_PASSWORD &&
    password === env.SIGECOM_PROD_MIGRATOR_PASSWORD
  ) {
    throw new Error(
      "Las contraseñas SQL production APP y MIGRATOR deben diferir.",
    );
  }

  return {
    host,
    port,
    database,
    user: username,
    password,
    charset: "utf8mb4",
    timezone: "Z",
    connectTimeout: 5000,
    ssl: { ca, rejectUnauthorized: true },
  };
}

export function getDatabaseConfig(target, env = process.env, role = "APP") {
  if (target === "production") return productionDatabaseConfig(env, role);
  const selected = localTargets[target];

  if (!selected) {
    throw new Error(
      "Destino de base de datos no permitido; use development, test o production.",
    );
  }

  const host = env.DB_HOST || "127.0.0.1";
  const port = Number(env.DB_PORT || 3306);

  if (host !== "127.0.0.1" || port !== 3306) {
    throw new Error("SIGECOM solo permite MariaDB local en 127.0.0.1:3306.");
  }

  if (!["APP", "MIGRATOR"].includes(role)) {
    throw new Error("Rol SQL no permitido.");
  }

  const usernameKey = `${selected.prefix}_${role}_USER`;
  const passwordKey = `${selected.prefix}_${role}_PASSWORD`;
  const user = env[usernameKey];
  const password = env[passwordKey];

  if (!user || !password) {
    throw new Error(
      `Falta configurar ${usernameKey} y ${passwordKey} en el entorno local.`,
    );
  }

  return {
    host,
    port,
    database: selected.database,
    user,
    password,
    charset: "utf8mb4",
    timezone: "Z",
    connectTimeout: 5000,
  };
}
