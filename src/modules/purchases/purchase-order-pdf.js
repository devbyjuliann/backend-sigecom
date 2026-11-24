import { createTextPdf } from "../../shared/text-pdf.js";

export function createPurchaseOrderPdf(order) {
  return createTextPdf([
    "SIGECOM - Comercializadora S.A.S.",
    "Orden de compra confirmada",
    "Documento comercial interno; no es factura electrónica ni documento fiscal.",
    "",
    `Orden: ${order.number}`,
    `Fecha de la orden: ${order.orderDate}`,
    `Fecha de confirmación: ${order.confirmedAt}`,
    `Responsable: ${order.confirmedByName || order.confirmedBy}`,
    `Proveedor: ${order.supplierName}`,
    `Identificación del proveedor: ${order.supplierIdentification || "—"}`,
    `Bodega: ${order.warehouseName}`,
    `Referencia: ${order.reference || "—"}`,
    `Notas: ${order.notes || "—"}`,
    "",
    "Productos solicitados:",
    ...order.lines.map(
      (line) =>
        `${line.sku} · ${line.name} · ${line.quantity} ${line.unit} · Costo unitario: ${line.unitCost} COP · Subtotal: ${line.lineTotal} COP`,
    ),
    "",
    `Total documentado: ${order.total} COP`,
    "La confirmación de la orden no registra recepción ni incrementa existencias.",
  ]);
}
