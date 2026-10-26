import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createWarehouseService } from "./warehouse-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: z.string().trim().max(120).default(""),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    sortBy: z
      .enum([
        "code",
        "name",
        "location",
        "status",
        "responsible",
        "createdAt",
        "updatedAt",
      ])
      .default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

const responsibleQuerySchema = z
  .object({ q: z.string().trim().max(120).default("") })
  .strict();

const warehouseSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .transform((value) => value.toUpperCase())
      .refine((value) => /^[A-Z0-9][A-Z0-9_-]*$/.test(value)),
    name: z.string().trim().min(1).max(120),
    location: z.string().trim().max(255).nullable().optional(),
    responsibleUserId: z
      .union([z.string().regex(/^[1-9]\d{0,19}$/), z.null()])
      .optional(),
  })
  .strict()
  .transform(({ code, name, location, responsibleUserId }) => ({
    code,
    name,
    location: location || null,
    responsibleUserId: responsibleUserId || null,
  }));

const statusSchema = z.object({ isActive: z.boolean() }).strict();

function parseRequest(schema, input, message) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", message);
  }
  return parsed.data;
}

function parseId(value) {
  if (!idPattern.test(value)) {
    throw new HttpError(
      400,
      "INVALID_WAREHOUSE_ID",
      "Indica una bodega válida.",
    );
  }
  return value;
}

function requireAdministrator(request, _response, next) {
  if (request.auth?.user?.role !== "administrator") {
    return next(
      new HttpError(
        403,
        "WAREHOUSE_ADMIN_REQUIRED",
        "Solo un administrador puede modificar bodegas.",
      ),
    );
  }
  return next();
}

export function createWarehouseRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createWarehouseService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    requireSession,
    requirePermission("warehouses.read"),
    async (request, response) => {
      const query = parseRequest(
        listSchema,
        request.query,
        "Revisa los filtros, el orden y la paginación de bodegas.",
      );
      const result = await service.list({
        ...query,
        userId: request.auth.user.id,
        query: query.q,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.get(
    "/responsibles",
    requireSession,
    requirePermission("warehouses.manage"),
    requireAdministrator,
    async (request, response) => {
      const { q } = parseRequest(
        responsibleQuerySchema,
        request.query,
        "Revisa el texto de búsqueda del responsable.",
      );
      response
        .set("Cache-Control", "no-store")
        .json({ items: await service.listForResponsibles(q) });
    },
  );

  router.get(
    "/:warehouseId",
    requireSession,
    requirePermission("warehouses.read"),
    async (request, response) => {
      const warehouse = await service.getById(
        parseId(request.params.warehouseId),
        request.auth.user.id,
      );
      response.set("Cache-Control", "no-store").json(warehouse);
    },
  );

  router.post(
    "/",
    requireSession,
    requirePermission("warehouses.manage"),
    requireAdministrator,
    async (request, response) => {
      const input = parseRequest(
        warehouseSchema,
        request.body,
        "Revisa el código, nombre, ubicación y responsable de la bodega.",
      );
      const warehouse = await service.create({
        input,
        userId: request.auth.user.id,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(warehouse);
    },
  );

  router.patch(
    "/:warehouseId",
    requireSession,
    requirePermission("warehouses.manage"),
    requireAdministrator,
    async (request, response) => {
      const warehouse = await service.update({
        id: parseId(request.params.warehouseId),
        input: parseRequest(
          warehouseSchema,
          request.body,
          "Revisa el código, nombre, ubicación y responsable de la bodega.",
        ),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(warehouse);
    },
  );

  router.patch(
    "/:warehouseId/status",
    requireSession,
    requirePermission("warehouses.manage"),
    requireAdministrator,
    async (request, response) => {
      const { isActive } = parseRequest(
        statusSchema,
        request.body,
        "Indica si la bodega debe estar activa.",
      );
      const warehouse = await service.setStatus({
        id: parseId(request.params.warehouseId),
        isActive,
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(warehouse);
    },
  );

  return router;
}
