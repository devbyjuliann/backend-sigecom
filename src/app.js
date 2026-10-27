import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createAuthRouter } from "./modules/auth/auth-routes.js";
import { createProfileRouter } from "./modules/profile/profile-routes.js";
import { createCategoryRouter } from "./modules/categories/category-routes.js";
import { createWarehouseRouter } from "./modules/warehouses/warehouse-routes.js";
import { createProductRouter } from "./modules/products/product-routes.js";
import { createCustomerRouter } from "./modules/customers/customer-routes.js";
import { createSupplierRouter } from "./modules/suppliers/supplier-routes.js";
import { requireTrustedOriginAndCsrf } from "./modules/auth/csrf.js";
import { createErrorHandler, notFoundHandler } from "./shared/error-handler.js";
import { createLogger, requestLogger } from "./shared/logger.js";

export function createApp({
  dbPool,
  authConfig,
  logger = createLogger(),
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", false);
  app.use(helmet());
  app.use((request, response, next) => {
    request.requestId = randomUUID();
    response.set("X-Request-Id", request.requestId);
    next();
  });
  app.use(requestLogger(logger));

  if (dbPool && authConfig) {
    app.use(
      "/api/v1",
      cors({
        origin: authConfig.allowedOrigins,
        credentials: true,
        methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "X-CSRF-Token"],
        maxAge: 600,
      }),
      requireTrustedOriginAndCsrf(authConfig),
      express.json({ limit: "10kb", strict: true }),
    );
  } else {
    app.use(express.json({ limit: "10kb", strict: true }));
  }

  app.get("/api/v1/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "sigecom-backend",
    });
  });

  if (dbPool && authConfig) {
    const apiRouter = express.Router();
    apiRouter.use("/auth", createAuthRouter({ dbPool, authConfig }));
    apiRouter.use("/profile", createProfileRouter({ dbPool, authConfig }));
    apiRouter.use("/categories", createCategoryRouter({ dbPool, authConfig }));
    apiRouter.use("/warehouses", createWarehouseRouter({ dbPool, authConfig }));
    apiRouter.use("/products", createProductRouter({ dbPool, authConfig }));
    apiRouter.use("/customers", createCustomerRouter({ dbPool, authConfig }));
    apiRouter.use("/suppliers", createSupplierRouter({ dbPool, authConfig }));
    app.use("/api/v1", apiRouter);
  }

  app.use(notFoundHandler(logger));
  app.use(createErrorHandler(logger));

  return app;
}
