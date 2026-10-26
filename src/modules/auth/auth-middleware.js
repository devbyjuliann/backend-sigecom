import { readCookie } from "./csrf.js";
import { createAuthService } from "./auth-service.js";
import { HttpError } from "../../shared/http-error.js";

export function authenticate({
  dbPool,
  authConfig,
  allowPasswordChangePending = false,
}) {
  const service = createAuthService({ dbPool, config: authConfig });

  return async (request, _response, next) => {
    const token = readCookie(request, authConfig.cookieName);
    if (!token) {
      return next(
        new HttpError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Inicia sesión para continuar.",
        ),
      );
    }

    try {
      request.auth = await service.authenticateToken(token);
      if (
        request.auth.user.passwordChangeRequired &&
        !allowPasswordChangePending
      ) {
        throw new HttpError(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "Debes cambiar tu contraseña antes de continuar.",
        );
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requirePermission(permission) {
  return (request, _response, next) => {
    if (!request.auth) {
      return next(
        new HttpError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Inicia sesión para continuar.",
        ),
      );
    }
    if (request.auth.user.passwordChangeRequired) {
      return next(
        new HttpError(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "Debes cambiar tu contraseña antes de continuar.",
        ),
      );
    }
    if (!request.auth.permissions.has(permission)) {
      return next(
        new HttpError(
          403,
          "PERMISSION_DENIED",
          "No tienes permiso para esta operación.",
        ),
      );
    }
    return next();
  };
}

export function requireWarehouseAccess({ param = "warehouseId" } = {}) {
  return (request, _response, next) => {
    if (!request.auth) {
      return next(
        new HttpError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Inicia sesión para continuar.",
        ),
      );
    }
    if (request.auth.user.passwordChangeRequired) {
      return next(
        new HttpError(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "Debes cambiar tu contraseña antes de continuar.",
        ),
      );
    }

    const warehouseId = request.params[param];
    if (!/^[1-9]\d{0,19}$/.test(String(warehouseId || ""))) {
      return next(
        new HttpError(400, "WAREHOUSE_REQUIRED", "Indica una bodega válida."),
      );
    }
    if (!request.auth.warehouseIds.has(String(warehouseId))) {
      return next(
        new HttpError(
          403,
          "WAREHOUSE_ACCESS_DENIED",
          "No tienes acceso a esta bodega.",
        ),
      );
    }

    return next();
  };
}
