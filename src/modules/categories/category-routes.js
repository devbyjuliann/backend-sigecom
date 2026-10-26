import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createCategoryService } from "./category-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: z.string().trim().max(120).default(""),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    sortBy: z
      .enum(["name", "status", "createdAt", "updatedAt"])
      .default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(255).nullable().optional(),
  })
  .strict()
  .transform(({ name, description }) => ({
    name,
    description: description || null,
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
      "INVALID_CATEGORY_ID",
      "Indica una categoría válida.",
    );
  }
  return value;
}

export function createCategoryRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createCategoryService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    requireSession,
    requirePermission("categories.read"),
    async (request, response) => {
      const query = parseRequest(
        listSchema,
        request.query,
        "Revisa los filtros, el orden y la paginación de categorías.",
      );
      const result = await service.list({
        page: query.page,
        pageSize: query.pageSize,
        query: query.q,
        status: query.status,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.get(
    "/:categoryId",
    requireSession,
    requirePermission("categories.read"),
    async (request, response) => {
      response
        .set("Cache-Control", "no-store")
        .json(await service.getById(parseId(request.params.categoryId)));
    },
  );

  router.post(
    "/",
    requireSession,
    requirePermission("categories.manage"),
    async (request, response) => {
      const input = parseRequest(
        categorySchema,
        request.body,
        "Escribe un nombre de hasta 120 caracteres y una descripción de hasta 255 caracteres.",
      );
      const category = await service.create({
        ...input,
        userId: request.auth.user.id,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(category);
    },
  );

  router.patch(
    "/:categoryId",
    requireSession,
    requirePermission("categories.manage"),
    async (request, response) => {
      const category = await service.update({
        id: parseId(request.params.categoryId),
        ...parseRequest(
          categorySchema,
          request.body,
          "Escribe un nombre de hasta 120 caracteres y una descripción de hasta 255 caracteres.",
        ),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(category);
    },
  );

  router.patch(
    "/:categoryId/status",
    requireSession,
    requirePermission("categories.manage"),
    async (request, response) => {
      const { isActive } = parseRequest(
        statusSchema,
        request.body,
        "Indica si la categoría debe estar activa.",
      );
      const category = await service.setStatus({
        id: parseId(request.params.categoryId),
        isActive,
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(category);
    },
  );

  return router;
}
