import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createUserService } from "./user-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const roleCodes = ["administrator", "seller", "warehouse", "auditor"];
const warehouseIdsSchema = z.array(z.string().regex(idPattern)).max(100);
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: z.string().trim().max(120).default(""),
    roleCode: z.enum(["all", ...roleCodes]).default("all"),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    sortBy: z
      .enum(["name", "email", "role", "status", "updatedAt"])
      .default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const createSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(120),
    roleCode: z.enum(roleCodes),
    warehouseIds: warehouseIdsSchema.min(1),
  })
  .strict();
const updateSchema = z
  .object({
    expectedRevision: z.string().min(20).max(128),
    displayName: z.string().trim().min(1).max(120).optional(),
    email: emailSchema.optional(),
    roleCode: z.enum(roleCodes).optional(),
    warehouseChanges: z
      .object({
        addIds: warehouseIdsSchema.default([]),
        removeIds: warehouseIdsSchema.default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
    {
      message: "Indica al menos un cambio para guardar.",
    },
  );
const statusSchema = z
  .object({
    expectedRevision: z.string().min(20).max(128),
    isActive: z.boolean(),
  })
  .strict();

function parse(schema, input, message) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "INVALID_REQUEST", message);
  return result.data;
}

function parseId(value) {
  if (!idPattern.test(value))
    throw new HttpError(400, "INVALID_USER_ID", "Indica una cuenta válida.");
  return value;
}

function requireAdministrator(request, _response, next) {
  if (request.auth?.user?.role !== "administrator") {
    return next(
      new HttpError(
        403,
        "ADMINISTRATOR_REQUIRED",
        "Solo un Administrador puede gestionar cuentas.",
      ),
    );
  }
  return next();
}

export function createUserRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createUserService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  router.use(requireSession, requireAdministrator);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/",
    requirePermission("users.read"),
    async (request, response) => {
      const filters = parse(
        listSchema,
        request.query,
        "Revisa los filtros y la paginación de usuarios.",
      );
      const result = await service.list({
        ...filters,
        actorId: request.auth.user.id,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.get(
    "/roles",
    requirePermission("users.read"),
    async (_request, response) => {
      response
        .set("Cache-Control", "no-store")
        .json({ items: await service.roles() });
    },
  );

  router.get(
    "/:userId",
    requirePermission("users.read"),
    async (request, response) => {
      const user = await service.getById(
        parseId(request.params.userId),
        request.auth.user.id,
      );
      response.set("Cache-Control", "no-store").json(user);
    },
  );

  router.post(
    "/",
    requirePermission("users.read"),
    requirePermission("users.manage"),
    requirePermission("roles.manage"),
    requirePermission("warehouses.read"),
    async (request, response) => {
      const input = parse(
        createSchema,
        request.body,
        "Revisa el correo, nombre, rol y bodegas de la cuenta.",
      );
      const result = await service.create({
        input,
        actor: request.auth,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(result);
    },
  );

  router.patch(
    "/:userId",
    requirePermission("users.read"),
    requirePermission("users.manage"),
    async (request, response) => {
      const result = await service.update({
        id: parseId(request.params.userId),
        input: parse(
          updateSchema,
          request.body,
          "Revisa los datos y la revisión de la cuenta.",
        ),
        actor: request.auth,
        request,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.patch(
    "/:userId/status",
    requirePermission("users.read"),
    requirePermission("users.manage"),
    async (request, response) => {
      const result = await service.setStatus({
        id: parseId(request.params.userId),
        input: parse(
          statusSchema,
          request.body,
          "Indica el estado y la revisión actual de la cuenta.",
        ),
        actor: request.auth,
        request,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  return router;
}
