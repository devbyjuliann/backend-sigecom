import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createSaleService } from "./sale-service.js";
import { createSaleReversalPdf } from "./sale-reversal-pdf.js";

const idPattern = /^[1-9]\d{0,19}$/;
const moneyPattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/;
const idSchema = z.string().regex(idPattern);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Indica una fecha válida.");
const lineSchema = z
  .object({
    productId: idSchema,
    quantity: z.number().int().min(1).max(4_294_967_295),
    unitPrice: z
      .string()
      .regex(moneyPattern)
      .refine(
        (value) => /[1-9]/.test(value),
        "El precio debe ser mayor que cero.",
      ),
  })
  .strict();
const saleFields = {
  customerId: idSchema,
  warehouseId: idSchema,
  saleDate: dateSchema,
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
  lines: z
    .array(lineSchema)
    .min(1)
    .max(50)
    .refine(
      (lines) =>
        new Set(lines.map(({ productId }) => productId)).size === lines.length,
      "No repitas productos en una venta.",
    ),
};
const createSchema = z.object(saleFields).strict();
const updateSchema = z
  .object({
    ...saleFields,
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const cancelSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const confirmationSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const reversalSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reason: z.string().trim().min(3).max(500),
    reference: z.string().trim().min(1).max(120),
    physicalObservation: z.string().trim().min(3).max(1000),
    neverDispatched: z.literal(true),
    allQuantitiesPresent: z.literal(true),
    allProductsSaleable: z.literal(true),
  })
  .strict();
const customerReturnLineSchema = z
  .object({
    saleLineId: idSchema,
    quantityReceived: z.number().int().min(1).max(4_294_967_295),
    quantityRestocked: z.number().int().min(0).max(4_294_967_295),
    nonRestockReason: z.string().trim().max(500).optional().default(""),
  })
  .strict()
  .refine((line) => line.quantityRestocked <= line.quantityReceived, {
    message: "La cantidad reintegrada no puede superar la recibida.",
  })
  .refine(
    (line) =>
      line.quantityRestocked === line.quantityReceived ||
      line.nonRestockReason.length > 0,
    {
      message: "Indica el motivo de las unidades no reintegradas.",
    },
  );
const customerReturnSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reference: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(500),
    physicalObservation: z.string().trim().min(3).max(1000),
    receivedPhysical: z.literal(true),
    inspected: z.literal(true),
    lines: z
      .array(customerReturnLineSchema)
      .min(1)
      .max(50)
      .refine(
        (lines) =>
          new Set(lines.map((line) => line.saleLineId)).size === lines.length,
        "No repitas líneas de la venta.",
      ),
  })
  .strict();
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).default(""),
    status: z.enum(["all", "draft", "confirmed", "cancelled"]).default("all"),
    customerId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional(),
    sortBy: z
      .enum(["number", "date", "customer", "warehouse", "status", "total"])
      .default("date"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(
    (value) =>
      !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
    {
      message: "La fecha inicial no puede ser posterior a la fecha final.",
    },
  );

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      "INVALID_SALE",
      result.error.issues[0]?.message || "Revisa los datos de la venta.",
    );
  return result.data;
}

function idempotencyKey(request) {
  const value = request.get("Idempotency-Key");
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Envía una clave de idempotencia válida para guardar la venta.",
    );
  }
  return value;
}

export function createSaleRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createSaleService({ dbPool });
  const auth = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      const query = parse(listSchema, request.query);
      response.json(
        await service.list({
          warehouseIds: [...request.auth.historicalWarehouseIds],
          query,
        }),
      );
    },
  );

  router.get(
    "/:id",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      response.json(
        await service.getById(request.params.id, {
          warehouseIds: [...request.auth.historicalWarehouseIds],
        }),
      );
    },
  );

  router.post(
    "/",
    auth,
    requirePermission("sales.create"),
    async (request, response) => {
      const input = parse(createSchema, request.body);
      const sale = await service.write({
        operation: "create",
        input,
        actor: request.auth,
        request,
        key: idempotencyKey(request),
      });
      response.status(201).json(sale);
    },
  );

  router.patch(
    "/:id",
    auth,
    requirePermission("sales.create"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const input = parse(updateSchema, request.body);
      const sale = await service.write({
        operation: "update",
        id: request.params.id,
        input,
        actor: request.auth,
        request,
        key: idempotencyKey(request),
      });
      response.json(sale);
    },
  );

  router.post(
    "/:id/cancellation",
    auth,
    requirePermission("sales.cancel"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const input = parse(cancelSchema, request.body);
      const sale = await service.write({
        operation: "cancel",
        id: request.params.id,
        input,
        actor: request.auth,
        request,
        key: idempotencyKey(request),
      });
      response.json(sale);
    },
  );

  router.post(
    "/:id/confirmation",
    auth,
    requirePermission("sales.confirm"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const { expectedVersion } = parse(confirmationSchema, request.body);
      const sale = await service.confirm({
        id: request.params.id,
        expectedVersion,
        actor: request.auth,
        request,
        key: idempotencyKey(request),
      });
      response.json(sale);
    },
  );

  router.get(
    "/:id/reversal",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      response.set("Cache-Control", "no-store").json(
        await service.getReversal({
          saleId: request.params.id,
          warehouseIds: [...request.auth.historicalWarehouseIds],
        }),
      );
    },
  );

  router.get(
    "/:id/reversal/pdf",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const reversal = await service.getReversal({
        saleId: request.params.id,
        warehouseIds: [...request.auth.historicalWarehouseIds],
      });
      const pdf = createSaleReversalPdf(reversal);
      response
        .set("Cache-Control", "no-store")
        .type("application/pdf")
        .attachment(`anulacion-venta-${request.params.id}.pdf`)
        .send(pdf);
    },
  );

  router.post(
    "/:id/reversal",
    auth,
    requirePermission("sales.cancel"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const input = parse(reversalSchema, request.body);
      response.status(200).json(
        await service.reverse({
          id: request.params.id,
          input,
          actor: request.auth,
          request,
          key: idempotencyKey(request),
        }),
      );
    },
  );

  router.post(
    "/:id/returns",
    auth,
    requirePermission("sales.return"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      const result = await service.createCustomerReturn({
        id: request.params.id,
        input: parse(customerReturnSchema, request.body),
        actor: request.auth,
        request,
        key: idempotencyKey(request),
      });
      response.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.get(
    "/:id/returns",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (!idPattern.test(request.params.id))
        throw new HttpError(400, "INVALID_SALE_ID", "Indica una venta válida.");
      response.set("Cache-Control", "no-store").json(
        await service.listCustomerReturns({
          saleId: request.params.id,
          warehouseIds: [...request.auth.historicalWarehouseIds],
        }),
      );
    },
  );

  router.get(
    "/:id/returns/:returnId",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (
        !idPattern.test(request.params.id) ||
        !idPattern.test(request.params.returnId)
      )
        throw new HttpError(
          400,
          "INVALID_CUSTOMER_RETURN_ID",
          "Indica una devolución válida.",
        );
      response.set("Cache-Control", "no-store").json(
        await service.getCustomerReturn({
          saleId: request.params.id,
          returnId: request.params.returnId,
          warehouseIds: [...request.auth.historicalWarehouseIds],
        }),
      );
    },
  );

  router.get(
    "/:id/returns/:returnId/pdf",
    auth,
    requirePermission("sales.read"),
    async (request, response) => {
      if (
        !idPattern.test(request.params.id) ||
        !idPattern.test(request.params.returnId)
      )
        throw new HttpError(
          400,
          "INVALID_CUSTOMER_RETURN_ID",
          "Indica una devolución válida.",
        );
      const pdf = await service.getCustomerReturnPdf({
        saleId: request.params.id,
        returnId: request.params.returnId,
        warehouseIds: [...request.auth.historicalWarehouseIds],
      });
      response
        .set("Cache-Control", "no-store")
        .type("application/pdf")
        .attachment(
          `devolucion-cliente-${request.params.id}-${request.params.returnId}.pdf`,
        )
        .send(pdf);
    },
  );

  return router;
}
