import { Router } from "express";
import { z } from "zod";
import { authenticate, requirePermission } from "../auth/auth-middleware.js";
import { createProfileService } from "./profile-service.js";
import { HttpError } from "../../shared/http-error.js";

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export function createProfileRouter({ dbPool, authConfig }) {
  const router = Router();
  const service = createProfileService({ dbPool });
  const requireSession = authenticate({ dbPool, authConfig });

  router.get(
    "/",
    requireSession,
    requirePermission("profile.read"),
    async (request, response) => {
      const profile = await service.getOwnProfile(request.auth.user.id);
      response.set("Cache-Control", "no-store").json(profile);
    },
  );

  router.patch(
    "/",
    requireSession,
    requirePermission("profile.update"),
    async (request, response) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Solo puedes actualizar tu nombre y debe contener entre 1 y 120 caracteres.",
        );
      }
      const profile = await service.updateOwnProfile({
        userId: request.auth.user.id,
        displayName: parsed.data.displayName,
        request,
      });
      response.set("Cache-Control", "no-store").json(profile);
    },
  );

  return router;
}
