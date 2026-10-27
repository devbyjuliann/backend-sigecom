import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createProductService } from "./product-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const integerMaximum = 4_294_967_295;
const unitValues = [
  "unidad",
  "caja",
  "paquete",
  "docena",
  "display",
  "bulto",
  "par",
];

const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: z.string().trim().max(120).default(""),
    categoryId: z.string().regex(idPattern).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    sortBy: z
      .enum(["sku", "name", "category", "salePrice", "status", "updatedAt"])
      .default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

const moneySchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/,
    "Usa un valor monetario válido con máximo dos decimales.",
  )
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });

const productSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .transform((value) => value.toUpperCase())
      .refine((value) => /^[A-Z0-9][A-Z0-9._-]*$/.test(value)),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).nullable().optional(),
    categoryId: z.string().regex(idPattern),
    unit: z.enum(unitValues),
    purchasePrice: moneySchema,
    salePrice: moneySchema,
    minimumSaleQuantity: z
      .number()
      .int()
      .min(1)
      .max(integerMaximum)
      .nullable()
      .optional(),
    minimumSaleEnabled: z.boolean().default(false),
    minimumStock: z.number().int().min(0).max(integerMaximum).default(0),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    const minimumSaleQuantity = value.minimumSaleQuantity ?? null;
    if (value.minimumSaleEnabled && minimumSaleQuantity === null) {
      context.addIssue({
        code: "custom",
        path: ["minimumSaleQuantity"],
        message: "Indica una cantidad mínima entera mayor que cero.",
      });
    }
    if (!value.minimumSaleEnabled && minimumSaleQuantity !== null) {
      context.addIssue({
        code: "custom",
        path: ["minimumSaleQuantity"],
        message: "Desactiva la cantidad mínima o deja el campo vacío.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    description: value.description || null,
    minimumSaleQuantity: value.minimumSaleEnabled
      ? value.minimumSaleQuantity
      : null,
  }));

const balanceQuerySchema = z
  .object({ warehouseId: z.string().regex(idPattern).optional() })
  .strict();

function parseRequest(schema, input, message) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST", message);
  return parsed.data;
}

function parseId(value) {
  if (!idPattern.test(value)) {
    throw new HttpError(
      400,
      "INVALID_PRODUCT_ID",
      "Indica un producto válido.",
    );
  }
  return value;
}

export function createProductRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createProductService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    requireSession,
    requirePermission("products.read"),
    async (request, response) => {
      const query = parseRequest(
        listSchema,
        request.query,
        "Revisa los filtros, el orden y la paginación de productos.",
      );
      response
        .set("Cache-Control", "no-store")
        .json(await service.list({ ...query, query: query.q }));
    },
  );

  router.get(
    "/:productId/balances",
    requireSession,
    requirePermission("products.read"),
    requirePermission("inventory.read"),
    async (request, response) => {
      const { warehouseId } = parseRequest(
        balanceQuerySchema,
        request.query,
        "Indica una bodega autorizada.",
      );
      response.set("Cache-Control", "no-store").json(
        await service.balances({
          productId: parseId(request.params.productId),
          warehouseId: warehouseId || null,
          userId: request.auth.user.id,
        }),
      );
    },
  );

  router.get(
    "/:productId",
    requireSession,
    requirePermission("products.read"),
    async (request, response) => {
      response
        .set("Cache-Control", "no-store")
        .json(await service.getById(parseId(request.params.productId)));
    },
  );

  router.post(
    "/",
    requireSession,
    requirePermission("products.manage"),
    async (request, response) => {
      const input = parseRequest(
        productSchema,
        request.body,
        "Revisa los datos del producto; las cantidades deben ser enteras y los precios tener hasta dos decimales.",
      );
      const product = await service.create({
        input,
        userId: request.auth.user.id,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(product);
    },
  );

  router.patch(
    "/:productId",
    requireSession,
    requirePermission("products.manage"),
    async (request, response) => {
      const product = await service.update({
        id: parseId(request.params.productId),
        input: parseRequest(
          productSchema,
          request.body,
          "Revisa los datos del producto; las cantidades deben ser enteras y los precios tener hasta dos decimales.",
        ),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(product);
    },
  );

  return router;
}
