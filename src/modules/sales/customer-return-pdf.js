import { createTextPdf } from "../../shared/text-pdf.js";

export function createCustomerReturnPdf(document) {
  const lines = [
    "SIGECOM - Comercializadora S.A.S.",
    "Comprobante de devolucion de cliente",
    "",
    `Devolucion: ${document.number}`,
    `Venta original: ${document.saleNumber}`,
    `Cliente: ${document.customerName}`,
    `Bodega original: ${document.warehouseName}`,
    `Referencia: ${document.reference}`,
    `Motivo: ${document.reason}`,
    `Observacion fisica: ${document.physicalObservation}`,
    `Responsable: ${document.returnedByName}`,
    `Fecha: ${document.returnedAt}`,
    `Recepcion fisica declarada: ${document.receivedPhysical ? "Si" : "No"}`,
    `Inspeccion declarada: ${document.inspected ? "Si" : "No"}`,
    "",
    "Detalle de cantidades:",
    ...document.lines.map(
      (line) =>
        `${line.sku} ${line.name}: recibidas ${line.quantityReceived} ${line.unit}; reintegradas ${line.quantityRestocked}; no aptas ${line.quantityNotRestocked}${line.nonRestockReason ? ` (${line.nonRestockReason})` : ""}`,
    ),
    "",
    document.sourceOperationId
      ? `Movimiento customer_return #${document.sourceOperationId}`
      : "Sin movimiento de inventario: no hubo unidades aptas para reintegro.",
    "Documento operativo basado en datos persistidos; no representa reembolso ni nota credito financiera.",
  ];
  return createTextPdf(lines);
}
