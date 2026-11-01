import assert from "node:assert/strict";
import { test } from "node:test";
import { createCustomerReturnPdf } from "../../src/modules/sales/customer-return-pdf.js";

test("customer return PDF contains only persisted operational evidence", () => {
  const pdf = createCustomerReturnPdf({
    id: "42",
    number: "DEV-000042",
    saleNumber: "VE-000009",
    customerName: "Comercial de prueba",
    warehouseName: "Bodega norte",
    reference: "ACTA-42",
    reason: "Mercancía devuelta",
    physicalObservation: "Recibida y revisada.",
    returnedByName: "Administradora",
    returnedAt: "2026-10-31 12:00:00",
    receivedPhysical: true,
    inspected: true,
    sourceOperationId: null,
    lines: [
      {
        sku: "SKU-1",
        name: "Producto (caja)",
        unit: "unidad",
        quantityReceived: 2,
        quantityRestocked: 0,
        quantityNotRestocked: 2,
        nonRestockReason: "Empaque abierto",
      },
    ],
  });
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.includes("DEV-000042"));
  assert.ok(text.includes("Empaque abierto"));
  assert.ok(text.includes("Sin movimiento de inventario"));
  assert.ok(text.includes("startxref"));
});
