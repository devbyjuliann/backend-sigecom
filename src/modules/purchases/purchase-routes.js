import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createPurchaseService, maxQuantity } from "./purchase-service.js";
import { generateDocumentBestEffort } from "../../shared/document-generation.js";
import { createPurchaseOrderPdf } from "./purchase-order-pdf.js";
import { createPurchaseReceiptPdf } from "./purchase-receipt-pdf.js";

const idPattern = /^[1-9]\d{0,19}$/;
const moneyPattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const idSchema = z.string().regex(idPattern);
const dateSchema = z
  .string()
  .regex(datePattern)
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
    quantity: z.number().int().min(1).max(maxQuantity),
    unitCost: z.string().regex(moneyPattern),
  })
  .strict();
const orderFields = {
  supplierId: idSchema,
  warehouseId: idSchema,
  orderDate: dateSchema,
  reference: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .transform((value) => value || null),
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
      "No repitas productos en una orden.",
    ),
};
const createSchema = z.object(orderFields).strict();
const updateSchema = z
  .object({
    ...orderFields,
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const confirmSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    confirmZeroCost: z.boolean().default(false),
  })
  .strict();
const cancelSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const commercialCodeSchema = z
  .object({
    commercialCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9._/-]{0,39}$/i)
      .transform((value) => value.toUpperCase()),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
const receiptSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reference: z.string().trim().min(1).max(120),
    notes: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .transform((value) => value || null),
    lines: z
      .array(
        z
          .object({
            purchaseOrderLineId: idSchema,
            quantity: z.number().int().min(1).max(maxQuantity),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine(
        (lines) =>
          new Set(lines.map(({ purchaseOrderLineId }) => purchaseOrderLineId))
            .size === lines.length,
        "No repitas líneas dentro de una recepción.",
      ),
  })
  .strict();
const closureSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const supplierReturnSchema = z
  .object({
    reference: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(3).max(500),
    lines: z
      .array(
        z
          .object({
            purchaseReceiptLineId: idSchema,
            quantity: z.number().int().min(1).max(maxQuantity),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine(
        (lines) =>
          new Set(
            lines.map(({ purchaseReceiptLineId }) => purchaseReceiptLineId),
          ).size === lines.length,
        "No repitas líneas dentro de una devolución.",
      ),
  })
  .strict();
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).default(""),
    status: z.enum(["all", "draft", "confirmed", "cancelled"]).default("all"),
    supplierId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional(),
    sortBy: z
      .enum(["number", "date", "supplier", "warehouse", "status", "createdAt"])
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
      "INVALID_PURCHASE_ORDER",
      "Revisa los datos de la orden de compra.",
    );
  return result.data;
}

function requireAdministrator(request, _response, next) {
  if (request.auth?.user.role !== "administrator") {
    return next(
      new HttpError(
        403,
        "PERMISSION_DENIED",
        "Solo el Administrador puede gestionar órdenes de compra.",
      ),
    );
  }
  return next();
}

export function createPurchaseRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createPurchaseService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });
  const requireReceiptKey = (request, _response, next) => {
    const key = request.get("Idempotency-Key");
    if (!key || !key.trim() || key.length > 128) {
      return next(
        new HttpError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Envía una clave Idempotency-Key válida para confirmar la recepción.",
        ),
      );
    }
    request.idempotencyKey = key.trim();
    return next();
  };
  const requireClosureKey = (request, _response, next) => {
    const key = request.get("Idempotency-Key")?.trim();
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      return next(
        new HttpError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Envía una clave Idempotency-Key imprimible de hasta 128 caracteres.",
        ),
      );
    }
    request.idempotencyKey = key;
    return next();
  };
  const requireSupplierReturnKey = (request, _response, next) => {
    const key = request.get("Idempotency-Key")?.trim();
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      return next(
        new HttpError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Envía una clave Idempotency-Key imprimible de hasta 128 caracteres.",
        ),
      );
    }
    request.idempotencyKey = key;
    return next();
  };

  router.post(
    "/:id/receipts/:receiptId/returns",
    requireSession,
    requirePermission("purchases.return"),
    requireAdministrator,
    requireSupplierReturnKey,
    async (request, response) => {
      const result = await service.createSupplierReturn({
        orderId: parse(idSchema, request.params.id),
        receiptId: parse(idSchema, request.params.receiptId),
        input: parse(supplierReturnSchema, request.body),
        userId: request.auth.user.id,
        idempotencyKey: request.idempotencyKey,
        request,
      });
      response
        .status(result.replayed ? 200 : 201)
        .set("Cache-Control", "no-store")
        .json(result);
    },
  );

  router.get(
    "/:id/returns",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const result = await service.listSupplierReturns({
        orderId: parse(idSchema, request.params.id),
        userId: request.auth.user.id,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.get(
    "/:id/returns/:returnId",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const result = await service.getSupplierReturn({
        orderId: parse(idSchema, request.params.id),
        returnId: parse(idSchema, request.params.returnId),
        userId: request.auth.user.id,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.get(
    "/:id/receipts",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const orderId = parse(idSchema, request.params.id);
      const result = await service.listReceipts({
        orderId,
        userId: request.auth.user.id,
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.post(
    "/:id/receipts",
    requireSession,
    requirePermission("purchases.receive"),
    requireAdministrator,
    requireReceiptKey,
    async (request, response) => {
      const orderId = parse(idSchema, request.params.id);
      const receipt = await service.receive({
        orderId,
        input: parse(receiptSchema, request.body),
        userId: request.auth.user.id,
        idempotencyKey: request.idempotencyKey,
        request,
      });
      await generateDocumentBestEffort({
        generate: async () => {
          const document = await service.getReceiptPdfDocument({
            orderId,
            receiptId: receipt.id,
            userId: request.auth.user.id,
          });
          return createPurchaseReceiptPdf(document);
        },
        logger: request.log,
        entityType: "purchase_receipt",
        entityId: receipt.id,
      });
      response
        .status(receipt.replayed ? 200 : 201)
        .set("Cache-Control", "no-store")
        .json(receipt);
    },
  );

  router.get(
    "/:id/receipts/:receiptId",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const orderId = parse(idSchema, request.params.id);
      const receiptId = parse(idSchema, request.params.receiptId);
      const receipt = await service.getReceiptById({
        orderId,
        receiptId,
        userId: request.auth.user.id,
      });
      response.set("Cache-Control", "no-store").json(receipt);
    },
  );

  router.get(
    "/:id/receipts/:receiptId/pdf",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const orderId = parse(idSchema, request.params.id);
      const receiptId = parse(idSchema, request.params.receiptId);
      const document = await service.getReceiptPdfDocument({
        orderId,
        receiptId,
        userId: request.auth.user.id,
      });
      const pdf = createPurchaseReceiptPdf(document);
      response
        .set("Cache-Control", "no-store")
        .type("application/pdf")
        .attachment(`recepcion-compra-${receiptId}.pdf`)
        .send(pdf);
    },
  );

  router.get(
    "/",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const query = parse(listSchema, request.query);
      const result = await service.list({
        ...query,
        query: query.q,
        warehouseIds: [...request.auth.historicalWarehouseIds],
      });
      response.set("Cache-Control", "no-store").json(result);
    },
  );

  router.post(
    "/",
    requireSession,
    requirePermission("purchases.create"),
    requireAdministrator,
    async (request, response) => {
      const order = await service.create({
        input: parse(createSchema, request.body),
        userId: request.auth.user.id,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(order);
    },
  );

  router.get(
    "/:id/pdf",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.getById(id, request.auth.user.id);
      if (!order.confirmedAt)
        throw new HttpError(
          409,
          "PURCHASE_ORDER_NOT_CONFIRMED",
          "El documento PDF está disponible después de confirmar la orden.",
        );
      const pdf = createPurchaseOrderPdf(order);
      response
        .set("Cache-Control", "no-store")
        .type("application/pdf")
        .attachment(`orden-compra-${id}.pdf`)
        .send(pdf);
    },
  );

  router.get(
    "/:id",
    requireSession,
    requirePermission("purchases.read"),
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.getById(id, request.auth.user.id);
      response.set("Cache-Control", "no-store").json(order);
    },
  );

  router.patch(
    "/:id/commercial-code",
    requireSession,
    requirePermission("purchases.create"),
    requireAdministrator,
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.updateCommercialCode({
        id,
        input: parse(commercialCodeSchema, request.body),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(order);
    },
  );

  router.patch(
    "/:id",
    requireSession,
    requirePermission("purchases.create"),
    requireAdministrator,
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.update({
        id,
        input: parse(updateSchema, request.body),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(order);
    },
  );

  router.post(
    "/:id/confirmation",
    requireSession,
    requirePermission("purchases.confirm"),
    requireAdministrator,
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.confirm({
        id,
        input: parse(confirmSchema, request.body),
        userId: request.auth.user.id,
        request,
      });
      await generateDocumentBestEffort({
        generate: () => createPurchaseOrderPdf(order),
        logger: request.log,
        entityType: "purchase_order",
        entityId: order.id,
      });
      response.set("Cache-Control", "no-store").json(order);
    },
  );

  router.post(
    "/:id/closure",
    requireSession,
    requirePermission("purchases.close"),
    requireAdministrator,
    requireClosureKey,
    async (request, response) => {
      const orderId = parse(idSchema, request.params.id);
      const order = await service.close({
        orderId,
        input: parse(closureSchema, request.body),
        userId: request.auth.user.id,
        idempotencyKey: request.idempotencyKey,
        request,
      });
      response.status(200).set("Cache-Control", "no-store").json(order);
    },
  );

  router.post(
    "/:id/cancellation",
    requireSession,
    requirePermission("purchases.cancel"),
    requireAdministrator,
    async (request, response) => {
      const id = parse(idSchema, request.params.id);
      const order = await service.cancel({
        id,
        input: parse(cancelSchema, request.body),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(order);
    },
  );

  return router;
}
