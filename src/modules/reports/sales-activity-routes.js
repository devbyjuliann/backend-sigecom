import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { validateSalesActivityPeriod } from "./sales-activity-service.js";
import { createSalesActivityApiService } from "./sales-activity-api-service.js";

const querySchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    warehouseId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    page: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .optional()
      .transform((value) => (value === undefined ? 1 : Number(value))),
    pageSize: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .optional()
      .transform((value) => (value === undefined ? 20 : Number(value))),
  })
  .strict();
const warehouseQuerySchema = z
  .object({
    q: z.string().trim().max(100).default(""),
    page: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .optional()
      .transform((value) => (value === undefined ? 1 : Number(value))),
    pageSize: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .optional()
      .transform((value) => (value === undefined ? 20 : Number(value))),
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

function pagination({ page, pageSize }) {
  if (pageSize > 100)
    throw new HttpError(
      400,
      "INVALID_PAGE_SIZE",
      "pageSize debe estar entre 1 y 100.",
    );
  if ((page - 1) * pageSize > 10000)
    throw new HttpError(
      400,
      "PAGE_OFFSET_TOO_LARGE",
      "El desplazamiento máximo permitido es 10.000 registros.",
    );
}

export function createSalesActivityRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createSalesActivityApiService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  router.use((request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/warehouses", requireSession, async (request, response) => {
    const query = parse(warehouseQuerySchema, request.query);
    pagination(query);
    response.json(
      await service.listWarehouses({ auth: request.auth, ...query }),
    );
  });
  router.get("/", requireSession, async (request, response) => {
    const query = parse(querySchema, request.query);
    pagination(query);
    try {
      validateSalesActivityPeriod(query.dateFrom, query.dateTo);
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
