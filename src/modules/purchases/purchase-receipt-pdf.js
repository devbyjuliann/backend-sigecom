import { createTextPdf } from "../../shared/text-pdf.js";

export function createPurchaseReceiptPdf(receipt) {
  return createTextPdf([
    "SIGECOM - Comercializadora S.A.S.",
    "Comprobante de recepción de compra",
    "Documento operativo interno; no es factura electrónica ni documento fiscal.",
    "",
    `Recepción: ${receipt.number}`,
    `Referencia de entrega: ${receipt.reference}`,
    `Orden relacionada: ${receipt.purchaseOrderNumber}`,
    `Fecha de la orden: ${receipt.orderDate}`,
    `Referencia de la orden: ${receipt.purchaseOrderReference || "—"}`,
    `Fecha y hora de recepción: ${receipt.receivedAt}`,
    `Responsable: ${receipt.receivedByName}`,
    `Proveedor: ${receipt.supplierName}`,
    `Identificación del proveedor: ${receipt.supplierIdentification || "—"}`,
    `Bodega: ${receipt.warehouseName}`,
    `Notas: ${receipt.notes || "—"}`,
    "",
    "Productos recibidos:",
    ...receipt.lines.map(
      (line) =>
        `${line.sku} · ${line.name} · Recibidas: ${line.quantity} ${line.unit} · Costo unitario: ${line.unitCost} COP · Valor recibido: ${line.lineTotal} COP`,
    ),
    "",
    `Unidades registradas: ${receipt.lines.reduce((total, line) => total + line.quantity, 0)}`,
    "Las existencias aumentaron únicamente por las cantidades de esta recepción confirmada.",
  ]);
}
