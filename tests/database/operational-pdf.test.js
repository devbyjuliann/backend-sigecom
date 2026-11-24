import assert from "node:assert/strict";
import { test } from "node:test";
import { createPurchaseOrderPdf } from "../../src/modules/purchases/purchase-order-pdf.js";
import { createPurchaseReceiptPdf } from "../../src/modules/purchases/purchase-receipt-pdf.js";
import { createSaleConfirmationPdf } from "../../src/modules/sales/sale-confirmation-pdf.js";
import { generateDocumentBestEffort } from "../../src/shared/document-generation.js";

function pdfText(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.toString("latin1").startsWith("%PDF-1.4"));
  assert.ok(buffer.toString("latin1").endsWith("%%EOF\n"));
  return buffer.toString("latin1");
}

test("sale confirmation PDF uses immutable commercial details and is explicitly non-fiscal", () => {
  const content = pdfText(
    createSaleConfirmationPdf({
      number: "VE-000123",
      saleDate: "2026-11-23",
      confirmedAt: "2026-11-23 15:30:00",
      confirmedByName: "Ana Vendedora",
      customerName: "Cliente Mayorista",
      customerIdentification: "900123",
      warehouseName: "Bodega Norte",
      total: "3703.50",
      lines: [
        {
          sku: "SKU-ARROZ",
          name: "Arroz mayorista",
          unit: "bulto",
          quantity: 3,
          unitPrice: "1234.50",
          lineTotal: "3703.50",
        },
      ],
    }),
  );

  assert.match(content, /Comprobante de venta confirmada/);
  assert.match(content, /VE-000123/);
  assert.match(content, /Cliente Mayorista/);
  assert.match(content, /900123/);
  assert.match(content, /2026-11-23/);
  assert.match(content, /SKU-ARROZ/);
  assert.match(content, /3 bulto/);
  assert.match(content, /1234\.50 COP/);
  assert.match(content, /3703\.50 COP/);
  assert.match(content, /no es factura electrónica ni documento fiscal/);
});

test("confirmed purchase order PDF includes supplier, warehouse, line values, and non-fiscal notice", () => {
  const content = pdfText(
    createPurchaseOrderPdf({
      number: "OC-000042",
      status: "confirmed",
      orderDate: "2026-11-20",
      confirmedAt: "2026-11-21 10:15:00",
      confirmedBy: "17",
      supplierName: "Proveedor de prueba",
      supplierIdentification: "800456",
      warehouseName: "Bodega Centro",
      reference: "PO-REF-42",
      total: "200.50",
      lines: [
        {
          sku: "SKU-CAJA",
          name: "Caja de producto",
          unit: "caja",
          quantity: 2,
          unitCost: "100.25",
          lineTotal: "200.50",
        },
      ],
    }),
  );

  assert.match(content, /Orden de compra confirmada/);
  assert.match(content, /OC-000042/);
  assert.match(content, /Proveedor de prueba/);
  assert.match(content, /800456/);
  assert.match(content, /Bodega Centro/);
  assert.match(content, /PO-REF-42/);
  assert.match(content, /SKU-CAJA/);
  assert.match(content, /2 caja/);
  assert.match(content, /100\.25 COP/);
  assert.match(content, /200\.50 COP/);
  assert.match(content, /no es factura electrónica ni documento fiscal/);
});

test("purchase receipt PDF shows its own date, reference, quantities, and receipt values", () => {
  const content = pdfText(
    createPurchaseReceiptPdf({
      number: "REC-000043",
      reference: "ENTREGA-43",
      purchaseOrderNumber: "OC-000042",
      orderDate: "2026-11-20",
      receivedAt: "2026-11-22 09:30:00",
      receivedByName: "Carlos Bodega",
      supplierName: "Proveedor de prueba",
      supplierIdentification: "800456",
      warehouseName: "Bodega Centro",
      notes: "Entrega parcial",
      lines: [
        {
          sku: "SKU-CAJA",
          name: "Caja de producto",
          unit: "caja",
          quantity: 1,
          unitCost: "100.25",
          lineTotal: "100.25",
        },
      ],
    }),
  );

  assert.match(content, /Comprobante de recepción de compra/);
  assert.match(content, /REC-000043/);
  assert.match(content, /ENTREGA-43/);
  assert.match(content, /OC-000042/);
  assert.match(content, /2026-11-22/);
  assert.match(content, /Carlos Bodega/);
  assert.match(content, /Entrega parcial/);
  assert.match(content, /100\.25 COP/);
  assert.match(content, /no es factura electrónica ni documento fiscal/);
});

test("document generation failure is logged and does not escape the committed operation flow", async () => {
  const warning = { warn: 0 };
  const logger = {
    warn() {
      warning.warn += 1;
    },
  };

  await assert.doesNotReject(() =>
    generateDocumentBestEffort({
      generate: () => {
        throw new Error("PDF writer unavailable");
      },
      logger,
      entityType: "sale",
      entityId: "12",
    }),
  );
  assert.equal(warning.warn, 1);
});
