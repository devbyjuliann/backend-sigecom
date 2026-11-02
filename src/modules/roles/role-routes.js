import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createRoleService } from "./role-service.js";

const roleCodePattern = /^(administrator|seller|warehouse|auditor)$/;
const updateSchema = z
  .object({
    expectedRevision: z.string().min(20).max(128),
    configurablePermissionCodes: z.array(z.string().min(1).max(100)).max(38),
    confirmChange: z.literal(true),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.configurablePermissionCodes).size ===
      input.configurablePermissionCodes.length,
    { message: "No repitas permisos en la solicitud." },
  );

function requireAdministrator(request, _response, next) {
  if (request.auth?.user?.role !== "administrator") {
    return next(
      new HttpError(
        403,
        "ADMINISTRATOR_REQUIRED",
        "Solo un Administrador puede consultar o modificar permisos por rol.",
      ),
    );
  }
  return next();
}

function requirePolicyPermissions(request, _response, next) {
  const required = [
    "users.read",
    "users.manage",
    "roles.manage",
    "permissions.manage",
    "warehouses.read",
  ];
  if (
    !required.every((permission) => request.auth?.permissions?.has(permission))
  ) {
    return next(
      new HttpError(
        403,
        "PERMISSION_DENIED",
        "No tienes permisos administrativos suficientes.",
      ),
    );
  }
  return next();
}

function parseRoleCode(value) {
  if (!roleCodePattern.test(value)) {
    throw new HttpError(
      404,
      "ROLE_NOT_FOUND",
      "No se encontró el rol solicitado.",
    );
  }
  return value;
}

export function createRoleRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createRoleService({ dbPool });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  router.use(
    authenticate({ dbPool, authConfig }),
    requireAdministrator,
    requirePolicyPermissions,
  );

  router.get("/", async (_request, response) => {
    response.json({ items: await service.roles() });
  });

  router.get("/permissions", async (_request, response) => {
    response.json({ items: await service.permissions() });
  });

  router.get("/:roleCode/permissions", async (request, response) => {
    response.json(
      await service.getPermissions(
        parseRoleCode(request.params.roleCode),
        request.auth,
      ),
    );
  });

  router.patch("/:roleCode/permissions", async (request, response) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Revisa la revisión, la selección de permisos y la confirmación.",
      );
    }
    response.json(
      await service.updatePermissions(
        parseRoleCode(request.params.roleCode),
        parsed.data,
        request.auth,
        request,
      ),
    );
  });

  return router;
}

export function createPermissionRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createRoleService({ dbPool });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  router.use(
    authenticate({ dbPool, authConfig }),
    requireAdministrator,
    requirePolicyPermissions,
  );
  router.get("/", async (_request, response) => {
    response.json({ items: await service.permissions() });
  });
  return router;
}
