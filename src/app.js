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
import { createDashboardRouter } from "./modules/dashboard/dashboard-routes.js";
import { createInventoryRouter } from "./modules/inventory/inventory-routes.js";
import { createPurchaseRouter } from "./modules/purchases/purchase-routes.js";
import { createSaleRouter } from "./modules/sales/sale-routes.js";
import { createAuditRouter } from "./modules/audit/audit-routes.js";
import { createSalesActivityRouter } from "./modules/reports/sales-activity-routes.js";
import { createPurchaseReceiptsRouter } from "./modules/reports/purchase-receipts-routes.js";
import { createPurchaseOrdersRouter } from "./modules/reports/purchase-orders-routes.js";
import { createInventoryAnalyticsRouter } from "./modules/reports/inventory-analytics-routes.js";
import { createUserRouter } from "./modules/users/user-routes.js";
import {
  createPermissionRouter,
  createRoleRouter,
} from "./modules/roles/role-routes.js";
import { requireTrustedOriginAndCsrf } from "./modules/auth/csrf.js";
import { createErrorHandler, notFoundHandler } from "./shared/error-handler.js";
import { createLogger, requestLogger } from "./shared/logger.js";

export function createApp({
  dbPool,
  authConfig,
  trustProxy = false,
  logger = createLogger(),
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", trustProxy);
  app.use(helmet());
  app.use((request, response, next) => {
    request.requestId = randomUUID();
    response.set("X-Request-Id", request.requestId);
    next();
  });
  app.use(requestLogger(logger));
  app.use((request, response, next) => {
    if (
      /^\/api\/v1\/(roles|permissions)(\/|$)/.test(request.path) ||
      /^\/api\/v1\/audit-events(\/|$)/.test(request.path) ||
      /^\/api\/v1\/users\/[^/]+\/password-reset$/.test(request.path)
    ) {
      response.set("Cache-Control", "no-store");
    }
    next();
  });

  if (dbPool && authConfig) {
    app.use(
      "/api/v1",
      cors({
        origin: authConfig.allowedOrigins,
        credentials: true,
        methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
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
    apiRouter.use("/dashboard", createDashboardRouter({ dbPool, authConfig }));
    apiRouter.use("/inventory", createInventoryRouter({ dbPool, authConfig }));
    apiRouter.use(
      "/purchase-orders",
      createPurchaseRouter({ dbPool, authConfig }),
    );
    apiRouter.use("/sales", createSaleRouter({ dbPool, authConfig }));
    apiRouter.use("/users", createUserRouter({ dbPool, authConfig }));
    apiRouter.use("/roles", createRoleRouter({ dbPool, authConfig }));
    apiRouter.use(
      "/permissions",
      createPermissionRouter({ dbPool, authConfig }),
    );
    apiRouter.use("/audit-events", createAuditRouter({ dbPool, authConfig }));
    apiRouter.use(
      "/reports/sales-activity",
      createSalesActivityRouter({ dbPool, authConfig }),
    );
    apiRouter.use(
      "/reports/purchase-receipts",
      createPurchaseReceiptsRouter({ dbPool, authConfig }),
    );
    apiRouter.use(
      "/reports/purchase-orders",
      createPurchaseOrdersRouter({ dbPool, authConfig }),
    );
    apiRouter.use(
      "/reports/inventory",
      createInventoryAnalyticsRouter({ dbPool, authConfig }),
    );
    app.use("/api/v1", apiRouter);
  }

  app.use(notFoundHandler(logger));
  app.use(createErrorHandler(logger));

  return app;
}
