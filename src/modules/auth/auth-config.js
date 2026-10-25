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

export function getAuthConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET;
  if (
    typeof jwtSecret !== "string" ||
    Buffer.byteLength(jwtSecret, "utf8") < 32
  ) {
    throw new Error("JWT_SECRET debe contener al menos 32 bytes aleatorios.");
  }

  const production = env.NODE_ENV === "production";
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
    allowedOrigins: readOrigins(env.FRONTEND_ORIGIN),
    loginAttemptLimit,
    loginWindowMs: 15 * 60 * 1000,
  };
}
