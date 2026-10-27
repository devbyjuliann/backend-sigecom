import { Router } from "express";
import { createHash } from "node:crypto";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { createAuthService } from "./auth-service.js";
import { createCsrfToken, readCookie, setCsrfCookie } from "./csrf.js";
import { authenticate } from "./auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { changePassword } from "./password-service.js";

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

const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
    newPassword: z
      .string()
      .min(12, "La nueva contraseña debe tener al menos 12 caracteres.")
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72)
      .refine((value) => /[a-z]/.test(value), "Incluye al menos una minúscula.")
      .refine((value) => /[A-Z]/.test(value), "Incluye al menos una mayúscula.")
      .refine((value) => /\d/.test(value), "Incluye al menos un número."),
    confirmPassword: z.string().min(1).max(72),
  })
  .strict()
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "La confirmación no coincide con la nueva contraseña.",
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "La nueva contraseña debe ser diferente de la actual.",
  });

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
  const requireSessionWithPendingPassword = authenticate({
    dbPool,
    authConfig,
    allowPasswordChangePending: true,
  });
  const loginRateLimitResponse = (_request, response) => {
    response.status(429).json({
      error: {
        code: "LOGIN_RATE_LIMITED",
        message: "Se alcanzó el límite de intentos. Inténtalo más tarde.",
      },
    });
  };
  const loginOriginLimiter = rateLimit({
    windowMs: authConfig.loginWindowMs,
    limit: authConfig.loginAttemptLimit,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: loginRateLimitResponse,
  });
  const loginAccountOriginLimiter = rateLimit({
    windowMs: authConfig.loginWindowMs,
    limit: authConfig.loginAccountAttemptLimit,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request) => {
      const account =
        typeof request.body?.email === "string"
          ? request.body.email.trim().toLowerCase().slice(0, 254)
          : "<missing-account>";
      const accountHash = createHash("sha256").update(account).digest("hex");
      return `${ipKeyGenerator(request.ip)}:${accountHash}`;
    },
    handler: loginRateLimitResponse,
  });

  router.get("/csrf", (_request, response) => {
    const csrfToken = createCsrfToken();
    response.set("Cache-Control", "no-store");
    setCsrfCookie(response, csrfToken, authConfig);
    response.json({ csrfToken });
  });

  router.post(
    "/login",
    loginOriginLimiter,
    loginAccountOriginLimiter,
    async (request, response) => {
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
    },
  );

  router.get("/me", requireSessionWithPendingPassword, (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({
      user: request.auth.user,
      permissions: [...request.auth.permissions],
      warehouseIds: [...request.auth.warehouseIds],
    });
  });

  router.post(
    "/change-password",
    requireSessionWithPendingPassword,
    async (request, response) => {
      const parsed = passwordChangeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_PASSWORD_CHANGE",
          parsed.error.issues[0]?.message ||
            "La contraseña nueva no cumple la política de seguridad.",
        );
      }

      const result = await changePassword({
        dbPool,
        userId: request.auth.user.id,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        request,
      });
      response.clearCookie(authConfig.cookieName, {
        ...cookieOptions(authConfig),
        httpOnly: true,
      });
      response.clearCookie(authConfig.csrfCookieName, {
        ...cookieOptions(authConfig),
        httpOnly: false,
      });
      response.set("Cache-Control", "no-store");
      response.json(result);
    },
  );

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
