import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { validateInventoryActivityPeriod } from "./inventory-analytics-service.js";
import { createInventoryAnalyticsApiService } from "./inventory-analytics-api-service.js";

const positiveInteger = (maxDigits) =>
  z.string().regex(new RegExp(`^[1-9]\\d{0,${maxDigits - 1}}$`));
const page = positiveInteger(6)
  .optional()
  .transform((value) => (value === undefined ? 1 : Number(value)));
const pageSize = positiveInteger(2)
  .optional()
  .transform((value) => (value === undefined ? 20 : Number(value)));
const id = z.string().regex(/^[1-9]\d{0,19}$/);
const balancesSchema = z
  .object({
    warehouseId: id.optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    status: z
      .enum([
        "all",
        "positive",
        "depleted",
        "below_minimum",
        "inconsistent",
        "insufficient",
      ])
      .optional(),
    productStatus: z.enum(["active", "inactive"]).optional(),
    page,
    pageSize,
  })
  .strict();
const movementsSchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    warehouseId: id.optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    operationType: z
      .enum([
        "initial_stock",
        "adjustment_in",
        "adjustment_out",
        "transfer",
        "purchase_receipt",
        "supplier_return",
        "sale_issue",
        "sale_reversal",
        "customer_return",
      ])
      .optional(),
    direction: z.enum(["IN", "OUT"]).optional(),
    page,
    pageSize,
  })
  .strict();
const warehouseSchema = z
  .object({
    view: z.enum(["balances", "movements"]),
    q: z.string().trim().max(100).default(""),
    page,
    pageSize,
  })
  .strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      "INVALID_REPORT_QUERY",
      "Los parámetros de consulta no son válidos.",
    );
  return result.data;
}

function validatePaging(query) {
  if (query.pageSize > 50 || (query.page - 1) * query.pageSize > 10_000) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PAGINATION",
      "La paginación no es válida.",
    );
  }
}

export function createInventoryAnalyticsRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createInventoryAnalyticsApiService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/warehouses", requireSession, async (request, response) => {
    const query = parse(warehouseSchema, request.query);
    validatePaging(query);
    response.json(await service.warehouses({ auth: request.auth, ...query }));
  });
  router.get("/balances", requireSession, async (request, response) => {
    const query = parse(balancesSchema, request.query);
    validatePaging(query);
    response.json(await service.balances({ auth: request.auth, ...query }));
  });
  router.get("/movements", requireSession, async (request, response) => {
    const query = parse(movementsSchema, request.query);
    validatePaging(query);
    try {
      validateInventoryActivityPeriod(query.dateFrom, query.dateTo);
    } catch (error) {
      throw new HttpError(
        400,
        error.code || "INVALID_REPORT_PERIOD",
        error.message,
      );
    }
    response.json(await service.movements({ auth: request.auth, ...query }));
  });
  return router;
}
