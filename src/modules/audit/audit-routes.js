import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { auditCatalog, createAuditService } from "./audit-service.js";

const idPattern = /^[1-9]\d{0,19}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const moduleSchema = z.enum(auditCatalog.modules);
const actionSchema = z.enum(auditCatalog.actions);
const filtersSchema = z
  .object({
    dateFrom: z.string().regex(datePattern).optional(),
    dateTo: z.string().regex(datePattern).optional(),
    module: moduleSchema.optional(),
    action: actionSchema.optional(),
    actorId: z.string().regex(idPattern).optional(),
    warehouseId: z.string().regex(idPattern).optional(),
  })
  .strict();
const listSchema = filtersSchema
  .extend({
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1024).optional(),
  })
  .strict();

const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsInBogota(date) {
  return Object.fromEntries(
    bogotaFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

function formatCivilDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function bogotaToday() {
  const parts = partsInBogota(new Date());
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isValidDate(value) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function utcBoundaryForBogotaDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(0);
  target.setUTCFullYear(year, month - 1, day);
  target.setUTCHours(0, 0, 0, 0);
  const targetMs = target.getTime();
  let candidate = targetMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = partsInBogota(new Date(candidate));
    const represented = new Date(0);
    represented.setUTCFullYear(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    );
    represented.setUTCHours(
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0,
    );
    const delta = targetMs - represented.getTime();
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate).toISOString().slice(0, 23).replace("T", " ");
}

function nextCivilDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(0);
  next.setUTCFullYear(year, month - 1, day + 1);
  next.setUTCHours(0, 0, 0, 0);
  return formatCivilDate(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
}

function parseFilters(query, { withPagination = false } = {}) {
  const parsed = (withPagination ? listSchema : filtersSchema).safeParse(query);
  if (!parsed.success)
    throw new HttpError(
      400,
      "INVALID_AUDIT_FILTERS",
      "Revisa los filtros de auditoría.",
    );
  const input = parsed.data;
  const today = bogotaToday();
  const dateTo = input.dateTo ?? today;
  const defaultFromDate = new Date(0);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  defaultFromDate.setUTCFullYear(todayYear, todayMonth - 1, todayDay - 29);
  defaultFromDate.setUTCHours(0, 0, 0, 0);
  const defaultFrom = formatCivilDate(
    defaultFromDate.getUTCFullYear(),
    defaultFromDate.getUTCMonth() + 1,
    defaultFromDate.getUTCDate(),
  );
  const dateFrom = input.dateFrom ?? defaultFrom;
  if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
    throw new HttpError(
      400,
      "INVALID_AUDIT_FILTERS",
      "El intervalo de fechas no es válido.",
    );
  }
  const startCivil = new Date(0);
  const [startYear, startMonth, startDay] = dateFrom.split("-").map(Number);
  startCivil.setUTCFullYear(startYear, startMonth - 1, startDay);
  const endCivil = new Date(0);
  const [endYear, endMonth, endDay] = dateTo.split("-").map(Number);
  endCivil.setUTCFullYear(endYear, endMonth - 1, endDay);
  if ((endCivil.getTime() - startCivil.getTime()) / 86400000 >= 366) {
    throw new HttpError(
      400,
      "INVALID_AUDIT_FILTERS",
      "El período máximo permitido es de 366 días.",
    );
  }
  for (const key of ["actorId", "warehouseId"]) {
    if (input[key] && BigInt(input[key]) > 18446744073709551615n) {
      throw new HttpError(
        400,
        "INVALID_AUDIT_FILTERS",
        "El identificador del filtro no es válido.",
      );
    }
  }
  return {
    filters: {
      dateFrom: utcBoundaryForBogotaDate(dateFrom),
      dateTo: utcBoundaryForBogotaDate(nextCivilDate(dateTo)),
      module: input.module,
      action: input.action,
      actorId: input.actorId,
      warehouseId: input.warehouseId,
    },
    pageSize: input.pageSize,
    cursor: input.cursor,
  };
}

function send(response, value) {
  response.status(200).json(value);
}

export function createAuditRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createAuditService({
    dbPool,
    cursorSecret: authConfig.jwtSecret,
  });
  const session = authenticate({ dbPool, authConfig });
  const permitted = requirePermission("audit.read");
  const role = (request, _response, next) => {
    if (!["administrator", "auditor"].includes(request.auth?.user?.role)) {
      return next(
        new HttpError(
          403,
          "PERMISSION_DENIED",
          "No tienes permiso para consultar auditoría.",
        ),
      );
    }
    return next();
  };

  router.use((_request, response, next) => {
    response.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private",
    );
    response.set("Pragma", "no-cache");
    next();
  });

  // Keep options ahead of the dynamic event identifier route.
  router.get(
    "/filter-options",
    session,
    permitted,
    role,
    async (request, response) => {
      const { filters } = parseFilters(request.query);
      send(
        response,
        await service.options({
          filters,
          userId: request.auth.user.id,
          permissions: request.auth.permissions,
          role: request.auth.user.role,
        }),
      );
    },
  );
  router.get("/", session, permitted, role, async (request, response) => {
    const { filters, pageSize, cursor } = parseFilters(request.query, {
      withPagination: true,
    });
    send(
      response,
      await service.list({
        filters,
        pageSize,
        cursor,
        userId: request.auth.user.id,
        permissions: request.auth.permissions,
        role: request.auth.user.role,
      }),
    );
  });
  router.get(
    "/:eventId",
    session,
    permitted,
    role,
    async (request, response) => {
      if (
        !idPattern.test(request.params.eventId) ||
        BigInt(request.params.eventId) > 18446744073709551615n
      ) {
        throw new HttpError(
          404,
          "AUDIT_EVENT_NOT_FOUND",
          "No se encontró el evento de auditoría.",
        );
      }
      send(
        response,
        await service.get({
          id: request.params.eventId,
          userId: request.auth.user.id,
          permissions: request.auth.permissions,
          role: request.auth.user.role,
        }),
      );
    },
  );
  return router;
}
