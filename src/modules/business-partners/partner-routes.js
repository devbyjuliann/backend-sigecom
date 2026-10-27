import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createPartnerService } from "./partner-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    q: z.string().trim().max(120).default(""),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    sortBy: z
      .enum(["identification", "name", "status", "createdAt", "updatedAt"])
      .default("name"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

function identificationKey(value) {
  return value.toUpperCase().replace(/[ .-]/g, "");
}

const identificationTypeSchema = z
  .string()
  .trim()
  .max(30)
  .nullable()
  .optional()
  .transform((value) => value || null);

const identificationNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => /[\p{L}\p{N}]/u.test(identificationKey(value)),
    "El número debe incluir al menos una letra o un número.",
  );

const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^[\p{L}\p{N}+()\s./#-]*$/u, "Revisa el formato del teléfono.")
  .refine(
    (value) => !value || /\p{N}/u.test(value),
    "El teléfono debe incluir al menos un número.",
  )
  .nullable()
  .optional()
  .transform((value) => value || null);

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email("Escribe un correo electrónico válido.")
  .nullable()
  .optional()
  .transform((value) => value || null);

const addressSchema = z
  .string()
  .trim()
  .max(255)
  .nullable()
  .optional()
  .transform((value) => value || null);

function createPartnerSchema(resource) {
  const fields = {
    identificationType: identificationTypeSchema,
    identificationNumber: identificationNumberSchema,
    phone: phoneSchema,
    email: emailSchema,
    address: addressSchema,
    isActive: z.boolean().default(true),
  };
  if (resource === "customers") {
    fields.name = z.string().trim().min(1).max(180);
  } else {
    fields.businessName = z.string().trim().min(1).max(180);
    fields.contactName = z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((value) => value || null);
  }
  return z.object(fields).strict();
}

const statusSchema = z.object({ isActive: z.boolean() }).strict();

function parseRequest(schema, input, message) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST", message);
  return parsed.data;
}

function parseId(value, resource) {
  if (!idPattern.test(value)) {
    throw new HttpError(
      400,
      `INVALID_${resource === "customers" ? "CUSTOMER" : "SUPPLIER"}_ID`,
      `Indica un ${resource === "customers" ? "cliente" : "proveedor"} válido.`,
    );
  }
  return value;
}

export function createPartnerRouter({ dbPool, authConfig, resource }) {
  if (!["customers", "suppliers"].includes(resource)) {
    throw new Error("El recurso de terceros no es válido.");
  }
  const router = Router();
  const service = createPartnerService({ dbPool, resource });
  const requireSession = authenticate({ dbPool, authConfig });
  const readPermission = requirePermission(`${resource}.read`);
  const managePermission = requirePermission(`${resource}.manage`);
  const schema = createPartnerSchema(resource);

  router.get("/", requireSession, readPermission, async (request, response) => {
    const query = parseRequest(
      listSchema,
      request.query,
      `Revisa los filtros, el orden y la paginación de ${resource === "customers" ? "clientes" : "proveedores"}.`,
    );
    response
      .set("Cache-Control", "no-store")
      .json(await service.list({ ...query, query: query.q }));
  });

  router.get(
    "/:partnerId",
    requireSession,
    readPermission,
    async (request, response) => {
      response
        .set("Cache-Control", "no-store")
        .json(
          await service.getById(parseId(request.params.partnerId, resource)),
        );
    },
  );

  router.post(
    "/",
    requireSession,
    managePermission,
    async (request, response) => {
      const input = parseRequest(
        schema,
        request.body,
        `Revisa los datos obligatorios y de contacto del ${resource === "customers" ? "cliente" : "proveedor"}.`,
      );
      const partner = await service.create({
        input,
        userId: request.auth.user.id,
        request,
      });
      response.status(201).set("Cache-Control", "no-store").json(partner);
    },
  );

  router.patch(
    "/:partnerId",
    requireSession,
    managePermission,
    async (request, response) => {
      const partner = await service.update({
        id: parseId(request.params.partnerId, resource),
        input: parseRequest(
          schema,
          request.body,
          `Revisa los datos obligatorios y de contacto del ${resource === "customers" ? "cliente" : "proveedor"}.`,
        ),
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(partner);
    },
  );

  router.patch(
    "/:partnerId/status",
    requireSession,
    managePermission,
    async (request, response) => {
      const { isActive } = parseRequest(
        statusSchema,
        request.body,
        "Indica si el registro debe estar activo.",
      );
      const partner = await service.setStatus({
        id: parseId(request.params.partnerId, resource),
        isActive,
        userId: request.auth.user.id,
        request,
      });
      response.set("Cache-Control", "no-store").json(partner);
    },
  );

  return router;
}
