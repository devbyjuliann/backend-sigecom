function escapePdf(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function makePage(lines) {
  const commands = ["BT", "/F1 10 Tf", "48 752 Td", "14 TL"];
  for (const [index, line] of lines.entries()) {
    if (index) commands.push("T*");
    commands.push(`(${escapePdf(line)}) Tj`);
  }
  commands.push("ET");
  return Buffer.from(commands.join("\n"), "latin1");
}

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
  const pages = [];
  for (let index = 0; index < lines.length; index += 50)
    pages.push(lines.slice(index, index + 50));
  const objects = [null];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii");
  objects[2] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "ascii",
  );
  objects[3] = Buffer.from(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "ascii",
  );
  for (const [index, pageLines] of pages.entries()) {
    const pageId = pageIds[index];
    const streamId = pageId + 1;
    const stream = makePage(pageLines);
    objects[pageId] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      "ascii",
    );
    objects[streamId] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("\nendstream", "ascii"),
    ]);
  }
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    const header = Buffer.from(`${id} 0 obj\n`, "ascii");
    const footer = Buffer.from("\nendobj\n", "ascii");
    offsets[id] = offset;
    chunks.push(header, objects[id], footer);
    offset += header.length + objects[id].length + footer.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length}\n`,
    "0000000000 65535 f \n",
    ...offsets
      .slice(1)
      .map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      "ascii",
    ),
  );
  return Buffer.concat(chunks);
}
