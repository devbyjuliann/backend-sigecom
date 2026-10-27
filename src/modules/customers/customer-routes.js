import { createPartnerRouter } from "../business-partners/partner-routes.js";

export function createCustomerRouter({ dbPool, authConfig }) {
  return createPartnerRouter({ dbPool, authConfig, resource: "customers" });
}
