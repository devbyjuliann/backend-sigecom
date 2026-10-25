import { randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createCsrfToken() {
  return randomBytes(32).toString("hex");
}

export function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;

  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;

  try {
    return decodeURIComponent(matches[0].slice(name.length + 1));
  } catch {
    return null;
  }
}

export function setCsrfCookie(response, token, config) {
  response.cookie(config.csrfCookieName, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: config.cookiePath,
    maxAge: config.ttlSeconds * 1000,
  });
}

function tokensMatch(cookieToken, headerToken) {
  if (
    typeof cookieToken !== "string" ||
    typeof headerToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(cookieToken) ||
    !/^[a-f0-9]{64}$/.test(headerToken)
  ) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(cookieToken, "hex"),
    Buffer.from(headerToken, "hex"),
  );
}

export function requireTrustedOriginAndCsrf(config) {
  return (request, _response, next) => {
    if (safeMethods.has(request.method)) return next();

    if (!config.allowedOrigins.includes(request.get("origin"))) {
      return next(
        new HttpError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "El origen de la solicitud no está autorizado.",
        ),
      );
    }

    const cookieToken = readCookie(request, config.csrfCookieName);
    const headerToken = request.get("x-csrf-token");
    if (!tokensMatch(cookieToken, headerToken)) {
      return next(
        new HttpError(
          403,
          "CSRF_VALIDATION_FAILED",
          "No se pudo validar la protección CSRF.",
        ),
      );
    }

    return next();
  };
}
