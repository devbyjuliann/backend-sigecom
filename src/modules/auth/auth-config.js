function readOrigins(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "FRONTEND_ORIGIN debe declarar al menos un origen permitido.",
    );
  }

  return [
    ...new Set(
      value.split(",").map((entry) => {
        const candidate = entry.trim();
        let parsed;

        try {
          parsed = new URL(candidate);
        } catch {
          throw new Error("FRONTEND_ORIGIN contiene un origen no válido.");
        }

        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.origin === "null" ||
          parsed.pathname !== "/" ||
          parsed.search ||
          parsed.hash ||
          parsed.username ||
          parsed.password
        ) {
          throw new Error(
            "FRONTEND_ORIGIN debe usar un origen explícito HTTP o HTTPS.",
          );
        }

        return parsed.origin;
      }),
    ),
  ];
}

function readPublicAppOrigin(value, allowedOrigins, production) {
  const candidate =
    typeof value === "string" && value.trim()
      ? value.trim()
      : production
        ? null
        : allowedOrigins[0];
  if (!candidate) {
    throw new Error(
      "PUBLIC_APP_ORIGIN debe declararse explícitamente en producción.",
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("PUBLIC_APP_ORIGIN no es un origen válido.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin === "null" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "PUBLIC_APP_ORIGIN debe ser un origen HTTP o HTTPS sin ruta ni credenciales.",
    );
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_APP_ORIGIN debe usar HTTPS en producción.");
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(
      "PUBLIC_APP_ORIGIN debe estar incluido en FRONTEND_ORIGIN.",
    );
  }

  return parsed.origin;
}

export function getAuthConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET;
  if (
    typeof jwtSecret !== "string" ||
    Buffer.byteLength(jwtSecret, "utf8") < 32
  ) {
    throw new Error("JWT_SECRET debe contener al menos 32 bytes aleatorios.");
  }

  const production = env.NODE_ENV === "production";
  if (production && (!env.JWT_ISSUER?.trim() || !env.JWT_AUDIENCE?.trim())) {
    throw new Error(
      "JWT_ISSUER y JWT_AUDIENCE explícitos son obligatorios en producción.",
    );
  }
  if (
    env.COOKIE_SECURE !== undefined &&
    !["true", "false"].includes(env.COOKIE_SECURE)
  ) {
    throw new Error("COOKIE_SECURE solo acepta true o false.");
  }
  if (production && env.COOKIE_SECURE !== "true") {
    throw new Error("COOKIE_SECURE=true es obligatorio en producción.");
  }

  const ttlSeconds = Number(env.JWT_TTL_SECONDS || 900);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 28800) {
    throw new Error("JWT_TTL_SECONDS debe estar entre 60 y 28800.");
  }

  const loginAttemptLimit = Number(env.AUTH_RATE_LIMIT_MAX || 5);
  if (
    !Number.isInteger(loginAttemptLimit) ||
    loginAttemptLimit < 1 ||
    loginAttemptLimit > 20
  ) {
    throw new Error("AUTH_RATE_LIMIT_MAX debe estar entre 1 y 20.");
  }

  const loginAccountAttemptLimit = Number(
    env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX || 5,
  );
  if (
    !Number.isInteger(loginAccountAttemptLimit) ||
    loginAccountAttemptLimit < 1 ||
    loginAccountAttemptLimit > 20
  ) {
    throw new Error(
      "AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX debe estar entre 1 y 20.",
    );
  }

  const allowedOrigins = readOrigins(env.FRONTEND_ORIGIN);
  if (
    production &&
    allowedOrigins.some((origin) => new URL(origin).protocol !== "https:")
  ) {
    throw new Error(
      "FRONTEND_ORIGIN debe usar HTTPS para cookies y sesiones production.",
    );
  }
  const publicAppOrigin = readPublicAppOrigin(
    env.PUBLIC_APP_ORIGIN,
    allowedOrigins,
    production,
  );

  return {
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER || "sigecom",
    jwtAudience: env.JWT_AUDIENCE || "sigecom-api",
    ttlSeconds,
    cookieName: "sigecom_session",
    csrfCookieName: "sigecom_csrf",
    cookieSecure: env.COOKIE_SECURE === "true",
    cookieSameSite: "strict",
    cookiePath: "/api/v1",
    allowedOrigins,
    publicAppOrigin,
    loginAttemptLimit,
    loginAccountAttemptLimit,
    loginWindowMs: 15 * 60 * 1000,
  };
}
