import { Router } from "express";
import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { createAuthService } from "./auth-service.js";
import { createCsrfToken, readCookie, setCsrfCookie } from "./csrf.js";
import { authenticate } from "./auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { changePassword } from "./password-service.js";
import {
  passwordChangeSchema,
  passwordRecoveryCompletionSchema,
  passwordValidationMessage,
} from "./password-policy.js";
import { createPasswordRecoveryService } from "./password-recovery-service.js";

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

const recoveryEmailSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

const recoveryAcceptedResponse = {
  accepted: true,
  message:
    "Si la cuenta está activa, enviaremos instrucciones al correo registrado.",
};

const recoveryRateLimitResponse = (_request, response) => {
  response.status(429).json({
    error: {
      code: "PASSWORD_RECOVERY_RATE_LIMITED",
      message: "Se alcanzó el límite de solicitudes. Inténtalo más tarde.",
    },
  });
};

function cookieOptions(config) {
  return {
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: config.cookiePath,
  };
}

export function createAuthRouter({
  dbPool,
  authConfig,
  mailTransport,
  logger,
}) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  const service = createAuthService({ dbPool, config: authConfig });
  const passwordRecovery = createPasswordRecoveryService({
    dbPool,
    mailTransport,
    logger,
    publicAppOrigin: authConfig.publicAppOrigin,
  });
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
  // Each process owns an aggregate ceiling; no request-supplied IP is trusted.
  const loginGlobalLimiter = rateLimit({
    windowMs: authConfig.loginWindowMs,
    limit: authConfig.loginGlobalAttemptLimit,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_request, response) =>
      response.statusCode < 400 || response.statusCode === 429,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "sigecom-login-global",
    handler: loginRateLimitResponse,
  });
  const loginAccountLimiter = rateLimit({
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
      return accountHash;
    },
    handler: loginRateLimitResponse,
  });
  const recoveryGlobalLimiter = rateLimit({
    windowMs: authConfig.passwordRecoveryWindowMs,
    limit: authConfig.passwordRecoveryGlobalAttemptLimit,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_request, response) => response.statusCode === 429,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "sigecom-password-recovery-global",
    handler: recoveryRateLimitResponse,
  });
  const recoveryAccountLimiter = rateLimit({
    windowMs: authConfig.passwordRecoveryAccountWindowMs,
    limit: authConfig.passwordRecoveryAccountAttemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request) => {
      const email =
        typeof request.body?.email === "string"
          ? request.body.email.trim().toLowerCase().slice(0, 254)
          : "<invalid-email>";
      return createHash("sha256").update(email).digest("hex");
    },
    handler: recoveryRateLimitResponse,
  });
  const recoveryCompletionGlobalLimiter = rateLimit({
    windowMs: authConfig.passwordRecoveryCompletionWindowMs,
    limit: authConfig.passwordRecoveryCompletionGlobalAttemptLimit,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_request, response) => response.statusCode === 429,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "sigecom-password-recovery-completion-global",
    handler: recoveryRateLimitResponse,
  });
  const recoveryCompletionTokenLimiter = rateLimit({
    windowMs: authConfig.passwordRecoveryCompletionWindowMs,
    limit: authConfig.passwordRecoveryCompletionTokenAttemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request) => {
      const token =
        typeof request.body?.token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(request.body.token)
          ? request.body.token
          : "<invalid-token>";
      return createHash("sha256").update(token).digest("hex");
    },
    handler: recoveryRateLimitResponse,
  });

  router.get("/csrf", (_request, response) => {
    const csrfToken = createCsrfToken();
    response.set("Cache-Control", "no-store");
    setCsrfCookie(response, csrfToken, authConfig);
    response.json({ csrfToken });
  });

  router.post(
    "/login",
    loginGlobalLimiter,
    loginAccountLimiter,
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

  router.post(
    "/password-recovery",
    recoveryGlobalLimiter,
    recoveryAccountLimiter,
    (request, response) => {
      const parsed = recoveryEmailSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Indica un correo electrónico válido.",
        );
      }

      response.set("Cache-Control", "no-store");
      response.status(202).json(recoveryAcceptedResponse);
      setImmediate(() => {
        void passwordRecovery
          .requestRecovery({ email: parsed.data.email, request })
          .catch(() => {
            logger?.warn(
              {
                requestId: request.requestId,
                event: "auth.password_recovery_processing_failed",
              },
              "password recovery request processing failed",
            );
          });
      });
    },
  );

  router.post(
    "/password-recovery/complete",
    recoveryCompletionGlobalLimiter,
    recoveryCompletionTokenLimiter,
    async (request, response) => {
      const parsed = passwordRecoveryCompletionSchema.safeParse(request.body);
      if (!parsed.success) {
        const tokenIssue = parsed.error.issues.some(
          (issue) => issue.path[0] === "token",
        );
        throw new HttpError(
          400,
          tokenIssue
            ? "PASSWORD_RECOVERY_LINK_INVALID"
            : "INVALID_PASSWORD_CHANGE",
          tokenIssue
            ? "El enlace no es válido, venció o ya fue utilizado. Solicita uno nuevo."
            : passwordValidationMessage(parsed.error),
        );
      }

      await passwordRecovery.completeRecovery({
        ...parsed.data,
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
      response.json({ changed: true });
    },
  );

  router.post(
    "/invitations/complete",
    recoveryCompletionGlobalLimiter,
    recoveryCompletionTokenLimiter,
    async (request, response) => {
      const parsed = passwordRecoveryCompletionSchema.safeParse(request.body);
      if (!parsed.success) {
        const tokenIssue = parsed.error.issues.some(
          (issue) => issue.path[0] === "token",
        );
        throw new HttpError(
          400,
          tokenIssue
            ? "PASSWORD_RECOVERY_LINK_INVALID"
            : "INVALID_PASSWORD_CHANGE",
          tokenIssue
            ? "El enlace no es válido, venció o ya fue utilizado. Solicita uno nuevo."
            : passwordValidationMessage(parsed.error),
        );
      }

      await passwordRecovery.completeInvitation({
        ...parsed.data,
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
      response.json({ changed: true });
    },
  );

  router.post(
    "/admin-password-reset/complete",
    recoveryCompletionGlobalLimiter,
    recoveryCompletionTokenLimiter,
    async (request, response) => {
      const parsed = passwordRecoveryCompletionSchema.safeParse(request.body);
      if (!parsed.success) {
        const tokenIssue = parsed.error.issues.some(
          (issue) => issue.path[0] === "token",
        );
        throw new HttpError(
          400,
          tokenIssue
            ? "PASSWORD_RECOVERY_LINK_INVALID"
            : "INVALID_PASSWORD_CHANGE",
          tokenIssue
            ? "El enlace no es válido, venció o ya fue utilizado. Solicita uno nuevo."
            : passwordValidationMessage(parsed.error),
        );
      }

      await passwordRecovery.completeAdminPasswordReset({
        ...parsed.data,
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
      response.json({ changed: true });
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
          passwordValidationMessage(parsed.error),
        );
      }

      const result = await changePassword({
        dbPool,
        userId: request.auth.user.id,
        sessionId: request.auth.sessionId,
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
