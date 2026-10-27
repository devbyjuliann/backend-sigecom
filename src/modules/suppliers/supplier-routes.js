import { createPartnerRouter } from "../business-partners/partner-routes.js";

export function createSupplierRouter({ dbPool, authConfig }) {
  return createPartnerRouter({ dbPool, authConfig, resource: "suppliers" });
}
