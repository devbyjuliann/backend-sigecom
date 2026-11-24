import { createTextPdf } from "../../shared/text-pdf.js";

export function createSaleConfirmationPdf(sale) {
  return createTextPdf([
    "SIGECOM - Comercializadora S.A.S.",
    "Comprobante de venta confirmada",
    "Documento comercial interno; no es factura electrónica ni documento fiscal.",
    "",
    `Venta: ${sale.number}`,
    `Fecha de venta: ${sale.saleDate}`,
    `Fecha de confirmación: ${sale.confirmedAt}`,
    `Responsable: ${sale.confirmedByName || sale.confirmedBy}`,
    `Cliente: ${sale.customerName}`,
    `Identificación: ${sale.customerIdentification}`,
    `Bodega: ${sale.warehouseName}`,
    `Referencia de operación: ${sale.sourceOperationId || "—"}`,
    `Observaciones: ${sale.notes || "—"}`,
    "",
    "Productos:",
    ...sale.lines.map(
      (line) =>
        `${line.sku} · ${line.name} · ${line.quantity} ${line.unit} · Precio unitario: ${line.unitPrice} COP · Subtotal: ${line.lineTotal} COP`,
    ),
    "",
    `Total comercial: ${sale.total} COP`,
    "Documento generado con los datos persistidos de la venta.",
  ]);
}
