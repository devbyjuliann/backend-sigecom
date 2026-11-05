import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { validatePurchaseReceiptsPeriod } from "./purchase-receipts-service.js";
import { createPurchaseReceiptsApiService } from "./purchase-receipts-api-service.js";

const pageSchema = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .optional()
  .transform((value) => (value === undefined ? 1 : Number(value)));
const pageSizeSchema = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .optional()
  .transform((value) => (value === undefined ? 20 : Number(value)));
const reportSchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    warehouseId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict();
const warehouseSchema = z
  .object({
    q: z.string().trim().max(100).default(""),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict();

function parse(schema, query) {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new HttpError(
      400,
      "INVALID_REPORT_QUERY",
      "Los parámetros de consulta no son válidos.",
    );
  }
  return result.data;
}

function validatePagination({ page, pageSize }) {
  if (pageSize > 100) {
    throw new HttpError(
      400,
      "INVALID_PAGE_SIZE",
      "pageSize debe estar entre 1 y 100.",
    );
  }
  if (
    !Number.isSafeInteger((page - 1) * pageSize) ||
    (page - 1) * pageSize > 10000
  ) {
    throw new HttpError(
      400,
      "PAGE_OFFSET_TOO_LARGE",
      "El desplazamiento máximo permitido es 10.000 registros.",
    );
  }
}

export function createPurchaseReceiptsRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createPurchaseReceiptsApiService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/warehouses", requireSession, async (request, response) => {
    const query = parse(warehouseSchema, request.query);
    validatePagination(query);
    response.json(
      await service.listWarehouses({ auth: request.auth, ...query }),
    );
  });
  router.get("/", requireSession, async (request, response) => {
    const query = parse(reportSchema, request.query);
    validatePagination(query);
    try {
      validatePurchaseReceiptsPeriod(query.dateFrom, query.dateTo);
    } catch (error) {
      throw new HttpError(
        400,
        error.code || "INVALID_REPORT_PERIOD",
        error.message,
      );
    }
    response.json(await service.list({ auth: request.auth, ...query }));
  });
  return router;
}
