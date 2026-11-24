import { createTextPdf } from "../../shared/text-pdf.js";

export function createSaleReversalPdf(reversal) {
  const lines = [
    "SIGECOM · Comercializadora S.A.S.",
    "Comprobante de anulación de venta",
    "",
    `Anulación: AN-${String(reversal.id).padStart(6, "0")}`,
    `Venta original: ${reversal.saleNumber}`,
    `Fecha de venta: ${reversal.saleDate}`,
    `Cliente: ${reversal.customerName}`,
    `Bodega original: ${reversal.warehouseName}`,
    `Responsable: ${reversal.cancelledByName}`,
    `Fecha de anulación: ${reversal.cancelledAt}`,
    `Motivo: ${reversal.reason}`,
    `Referencia de verificación: ${reversal.verificationReference}`,
    `Observaciones: ${reversal.physicalObservation}`,
    "Declaraciones del responsable:",
    "- La mercancía nunca salió físicamente de la bodega.",
    "- Todas las cantidades originales permanecían completas.",
    "- Todos los productos permanecían aptos para la venta.",
    "",
    "Cantidades compensadas:",
    ...reversal.lines.map(
      (line) =>
        `${line.sku} · ${line.name} · ${line.quantity} ${line.unit} · ${line.unitPrice} COP · ${line.lineTotal} COP`,
    ),
    "",
    `Movimiento compensatorio: sale_reversal #${reversal.sourceOperationId}`,
    "Las declaraciones son evidencia operativa atribuible al responsable;",
    "SIGECOM no verifica automáticamente la situación física de la mercancía.",
  ];

  return createTextPdf(lines);
}
