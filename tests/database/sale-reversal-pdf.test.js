import assert from "node:assert/strict";
import { test } from "node:test";
import { createSaleReversalPdf } from "../../src/modules/sales/sale-reversal-pdf.js";

test("builds a downloadable PDF from a persisted sale reversal", () => {
  const pdf = createSaleReversalPdf({
    id: "42",
    saleNumber: "VE-000042",
    saleDate: "2026-10-31",
    customerName: "Comercialización del Caribe",
    warehouseName: "Bodega Bogotá",
    reason: "El despacho no salió",
    verificationReference: "ACTA-042",
    physicalObservation: "Se verificaron las cajas y están completas.",
    neverDispatched: true,
    allQuantitiesPresent: true,
    allProductsSaleable: true,
    cancelledByName: "Administradora SIGECOM",
    cancelledAt: "2026-10-31 20:00:00",
    sourceOperationId: "901",
    lines: [
      {
        sku: "SKU-42",
        name: "Producto de prueba",
        quantity: 3,
        unit: "caja",
        unitPrice: "12.50",
        lineTotal: "37.50",
      },
    ],
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  assert.ok(
    pdf.toString("latin1").includes("Comprobante de anulación de venta"),
  );
  assert.ok(pdf.toString("latin1").includes("VE-000042"));
  assert.ok(pdf.toString("latin1").includes("ACTA-042"));
  assert.ok(pdf.toString("latin1").includes("Producto de prueba"));
  assert.ok(pdf.toString("latin1").includes("sale_reversal #901"));
  assert.ok(pdf.toString("latin1").includes("%%EOF"));
});
