import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createInventoryService } from "./inventory-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const pageSchema = {
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).default(""),
};
const balanceSchema = z
  .object({
    ...pageSchema,
    warehouseId: z.string().regex(idPattern).optional(),
    categoryId: z.string().regex(idPattern).optional(),
    productStatus: z.enum(["all", "active", "inactive"]).default("active"),
    warehouseStatus: z.enum(["all", "active", "inactive"]).default("active"),
    stockStatus: z.enum(["all", "low", "zero", "unregistered"]).default("all"),
    sortBy: z
      .enum([
        "sku",
        "product",
        "warehouse",
        "quantity",
        "minimumStock",
        "status",
      ])
      .default("product"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
const movementSchema = z
  .object({
    ...pageSchema,
    warehouseId: z.string().regex(idPattern).optional(),
    productId: z.string().regex(idPattern).optional(),
    operationType: z
      .enum([
        "initial_stock",
        "adjustment_in",
        "adjustment_out",
        "transfer",
        "purchase_receipt",
        "sale_issue",
        "sale_reversal",
        "customer_return",
        "supplier_return",
      ])
      .optional(),
    direction: z.enum(["IN", "OUT"]).optional(),
    dateFrom: z.string().regex(datePattern).optional(),
    dateTo: z.string().regex(datePattern).optional(),
    sortBy: z
      .enum(["createdAt", "product", "warehouse", "quantity", "type"])
      .default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
const operationSchema = z
  .object({
    ...pageSchema,
    warehouseId: z.string().regex(idPattern).optional(),
    operationType: movementSchema.shape.operationType,
    dateFrom: z.string().regex(datePattern).optional(),
    dateTo: z.string().regex(datePattern).optional(),
  })
  .strict();
const warehouseSchema = z
  .object({ warehouseId: z.string().regex(idPattern).optional() })
  .strict();

function parse(schema, input, message) {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "INVALID_REQUEST", message);
  if (
    result.data.dateFrom &&
    result.data.dateTo &&
    result.data.dateFrom > result.data.dateTo
  ) {
    throw new HttpError(
      400,
      "INVALID_DATE_RANGE",
      "La fecha inicial no puede ser posterior a la fecha final.",
    );
  }
  return { ...result.data, query: result.data.q };
}

function parseId(value, code) {
  if (!idPattern.test(value))
    throw new HttpError(400, code, "Indica un identificador válido.");
  return value;
}

export function createInventoryRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createInventoryService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/balances",
    requireSession,
    requirePermission("inventory.read"),
    async (request, response) => {
      const filters = parse(
        balanceSchema,
        request.query,
        "Revisa los filtros de existencias y la paginación.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.listBalances({
          ...filters,
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/totals",
    requireSession,
    requirePermission("inventory.read"),
    async (request, response) => {
      const filters = parse(
        balanceSchema,
        request.query,
        "Revisa los filtros de existencias y la paginación.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.listTotals({
          ...filters,
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/movements",
    requireSession,
    requirePermission("inventory.movements.read"),
    async (request, response) => {
      const filters = parse(
        movementSchema,
        request.query,
        "Revisa los filtros del historial y la paginación.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.listMovements({
          ...filters,
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/movements/:movementId",
    requireSession,
    requirePermission("inventory.movements.read"),
    async (request, response) => {
      response.set("Cache-Control", "no-store").json(
        await service.getMovement({
          id: parseId(request.params.movementId, "INVALID_MOVEMENT_ID"),
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/operations",
    requireSession,
    requirePermission("inventory.movements.read"),
    async (request, response) => {
      const filters = parse(
        operationSchema,
        request.query,
        "Revisa los filtros de operaciones y la paginación.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.listOperations({
          ...filters,
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/operations/:operationId",
    requireSession,
    requirePermission("inventory.movements.read"),
    async (request, response) => {
      response.set("Cache-Control", "no-store").json(
        await service.getOperation({
          id: parseId(request.params.operationId, "INVALID_OPERATION_ID"),
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/reconciliation",
    requireSession,
    requirePermission("inventory.read"),
    async (request, response) => {
      const { warehouseId } = parse(
        warehouseSchema,
        request.query,
        "Indica una bodega autorizada.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.reconcile({
          userId: request.auth.user.id,
          warehouseId,
        }),
      );
    },
  );

  return router;
}
