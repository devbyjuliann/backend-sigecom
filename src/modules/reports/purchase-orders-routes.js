import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { validatePurchaseOrdersPeriod } from "./purchase-orders-service.js";
import { createPurchaseOrdersApiService } from "./purchase-orders-api-service.js";

const situations = [
  "draft_without_lines",
  "draft",
  "cancelled",
  "confirmed_without_receipts",
  "partially_received",
  "fully_received",
  "closed_with_remnant",
];
const pendingSituations = new Set([
  "confirmed_without_receipts",
  "partially_received",
]);
function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
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
const querySchema = z
  .object({
    mode: z.enum(["pending", "period"]),
    warehouseId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((value) => BigInt(value) <= 18446744073709551615n)
      .optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    situation: z.enum(situations).optional(),
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !hasControlCharacters(value))
      .optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict()
  .superRefine((query, context) => {
    if (query.mode === "period") {
      if (query.dateFrom === undefined) {
        context.addIssue({ code: "custom", path: ["dateFrom"] });
      }
      if (query.dateTo === undefined) {
        context.addIssue({ code: "custom", path: ["dateTo"] });
      }
    } else {
      if (query.dateFrom !== undefined)
        context.addIssue({ code: "custom", path: ["dateFrom"] });
      if (query.dateTo !== undefined)
        context.addIssue({ code: "custom", path: ["dateTo"] });
      if (query.situation && !pendingSituations.has(query.situation))
        context.addIssue({ code: "custom", path: ["situation"] });
    }
  });

function parseQuery(query) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_REPORT_QUERY",
      "Los parámetros de consulta no son válidos.",
    );
  }
  const value = parsed.data;
  if (value.pageSize > 50) {
    throw new HttpError(
      400,
      "INVALID_PAGE_SIZE",
      "pageSize debe estar entre 1 y 50.",
    );
  }
  const offset = (value.page - 1) * value.pageSize;
  if (!Number.isSafeInteger(offset) || offset > 10000) {
    throw new HttpError(
      400,
      "PAGE_OFFSET_TOO_LARGE",
      "El desplazamiento máximo permitido es 10.000 registros.",
    );
  }
  if (value.mode === "period")
    validatePurchaseOrdersPeriod(value.dateFrom, value.dateTo);
  return value;
}

export function createPurchaseOrdersRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createPurchaseOrdersApiService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    next();
  });
  router.get("/", requireSession, async (request, response) => {
    const query = parseQuery(request.query);
    response.json(await service.list({ auth: request.auth, ...query }));
  });
  return router;
}
