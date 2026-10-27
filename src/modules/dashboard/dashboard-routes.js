import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { HttpError } from "../../shared/http-error.js";
import { createDashboardService } from "./dashboard-service.js";

const emptyQuerySchema = z.object({}).strict();

export function createDashboardRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createDashboardService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    requireSession,
    requirePermission("dashboard.read"),
    async (request, response) => {
      const parsed = emptyQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "El dashboard no admite parámetros de consulta.",
        );
      }
      const dashboard = await service.getSummary({
        userId: request.auth.user.id,
        permissions: request.auth.permissions,
      });
      response.set("Cache-Control", "no-store").json(dashboard);
    },
  );

  return router;
}
