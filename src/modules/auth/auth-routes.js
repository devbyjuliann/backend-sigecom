import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { createAuthService } from "./auth-service.js";
import { createCsrfToken, readCookie, setCsrfCookie } from "./csrf.js";
import { authenticate } from "./auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";

const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z
      .string()
      .min(1)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();

function cookieOptions(config) {
  return {
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: config.cookiePath,
  };
}

export function createAuthRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createAuthService({ dbPool, config: authConfig });
  const requireSession = authenticate({ dbPool, authConfig });
  const loginLimiter = rateLimit({
    windowMs: authConfig.loginWindowMs,
    limit: authConfig.loginAttemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: {
          code: "LOGIN_RATE_LIMITED",
          message: "Se alcanzó el límite de intentos. Inténtalo más tarde.",
        },
      });
    },
  });

  router.get("/csrf", (_request, response) => {
    const csrfToken = createCsrfToken();
    response.set("Cache-Control", "no-store");
    setCsrfCookie(response, csrfToken, authConfig);
    response.json({ csrfToken });
  });

  router.post("/login", loginLimiter, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Indica un correo y una contraseña válidos.",
      );
    }

    const result = await service.login({ ...parsed.data, request });
    const csrfToken = createCsrfToken();
    response.cookie(authConfig.cookieName, result.token, {
      ...cookieOptions(authConfig),
      httpOnly: true,
      maxAge: authConfig.ttlSeconds * 1000,
    });
    setCsrfCookie(response, csrfToken, authConfig);
    response.set("Cache-Control", "no-store");
    response.json({ user: result.user, csrfToken });
  });

  router.get("/me", requireSession, (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({
      user: request.auth.user,
      permissions: [...request.auth.permissions],
      warehouseIds: [...request.auth.warehouseIds],
    });
  });

  router.post("/logout", async (request, response) => {
    const token = readCookie(request, authConfig.cookieName);
    await service.logout(token, request);
    response.clearCookie(authConfig.cookieName, {
      ...cookieOptions(authConfig),
      httpOnly: true,
    });
    response.clearCookie(authConfig.csrfCookieName, {
      ...cookieOptions(authConfig),
      httpOnly: false,
    });
    response.set("Cache-Control", "no-store");
    response.status(204).end();
  });

  return router;
}
