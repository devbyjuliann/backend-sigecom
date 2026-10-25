const targets = {
  development: { database: "sigecom_dev", prefix: "SIGECOM_DEV" },
  test: { database: "sigecom_test", prefix: "SIGECOM_TEST" },
};

export function getDatabaseConfig(target, env = process.env, role = "APP") {
  const selected = targets[target];

  if (!selected) {
    throw new Error(
      "Destino de base de datos no permitido; use development o test.",
    );
  }

  const host = env.DB_HOST || "127.0.0.1";
  const port = Number(env.DB_PORT || 3306);

  if (host !== "127.0.0.1" || port !== 3306) {
    throw new Error("SIGECOM solo permite MariaDB de XAMPP en 127.0.0.1:3306.");
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
