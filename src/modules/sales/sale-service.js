import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";
import { createInventoryEngine } from "../inventory/inventory-engine.js";
import { createCustomerReturnPdf } from "./customer-return-pdf.js";

const maxCents = BigInt("9".repeat(22));
const sorts = {
  number: "s.commercial_code",
  date: "s.sale_date",
  customer: "s.customer_name_snapshot",
  warehouse: "s.warehouse_name_snapshot",
  status: "s.status",
  total: "total_cents",
};

function invalid(message = "Revisa los datos de la venta.") {
  return new HttpError(400, "INVALID_SALE", message);
}

function conflict(code, message) {
  return new HttpError(409, code, message);
}

function cents(value) {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function money(value) {
  const amount = BigInt(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function hashRequest(operation, saleId, input) {
  return createHash("sha256")
    .update(JSON.stringify({ operation, saleId: saleId || null, input }))
    .digest("hex");
}

function reversalConflict(code, message) {
  return new HttpError(409, code, message);
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function totalCents(lines) {
  const total = lines.reduce((sum, line) => sum + cents(line.line_total), 0n);
  if (total > maxCents)
    throw invalid("El total de la venta supera el límite permitido.");
  return total;
}

function toSale(row, lines = []) {
  const total = lines.reduce((sum, line) => sum + cents(line.line_total), 0n);
  return {
    id: String(row.id),
    number: row.commercial_code,
    customerId: String(row.customer_id),
    customerName: row.customer_name_snapshot,
    customerIdentification: row.customer_identification_snapshot,
    warehouseId: String(row.warehouse_id),
    warehouseCode: row.warehouse_code_snapshot,
    warehouseName: row.warehouse_name_snapshot,
    warehouseLocation: row.warehouse_location_snapshot,
    saleDate: row.sale_date,
    notes: row.notes,
    status: row.status,
    warehouseIsActive: Boolean(row.sale_warehouse_is_active),
    version: Number(row.version),
    total: money(total),
    lines: lines.map((line) => ({
      id: String(line.id),
      productId: String(line.product_id),
      sku: line.sku_snapshot,
      name: line.product_name_snapshot,
      unit: line.unit_snapshot,
      quantity: Number(line.quantity),
      unitPrice: String(line.unit_price),
      lineTotal: String(line.line_total),
    })),
    createdBy: String(row.created_by),
    createdByName: row.created_by_name,
    updatedBy: String(row.updated_by),
    updatedByName: row.updated_by_name,
    cancelledBy: row.cancelled_by === null ? null : String(row.cancelled_by),
    cancelledByName: row.cancelled_by_name,
    cancelledAt: row.cancelled_at,
    confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
    confirmedByName: row.confirmed_by_name,
    confirmedAt: row.confirmed_at,
    sourceOperationId:
      row.source_operation_id === null || row.source_operation_id === undefined
        ? null
        : String(row.source_operation_id),
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const saleSelect = `
  SELECT s.*, DATE_FORMAT(s.sale_date, '%Y-%m-%d') AS sale_date,
         creator.display_name AS created_by_name,
         updater.display_name AS updated_by_name,
         canceller.display_name AS cancelled_by_name,
         confirmer.display_name AS confirmed_by_name,
         sale_warehouse.is_active AS sale_warehouse_is_active,
         operation.id AS source_operation_id
  FROM sales AS s
  JOIN users AS creator ON creator.id = s.created_by
  JOIN users AS updater ON updater.id = s.updated_by
  LEFT JOIN users AS canceller ON canceller.id = s.cancelled_by
  LEFT JOIN users AS confirmer ON confirmer.id = s.confirmed_by
  LEFT JOIN warehouses AS sale_warehouse ON sale_warehouse.id = s.warehouse_id
  LEFT JOIN inventory_operations AS operation
     ON BINARY operation.source_type = BINARY 'sale'
    AND BINARY operation.source_id = BINARY CAST(s.id AS CHAR)`;

async function getLines(connection, saleId) {
  const [lines] = await connection.execute(
    `SELECT id, product_id, sku_snapshot, product_name_snapshot, unit_snapshot,
            quantity, unit_price, line_total
     FROM sale_lines WHERE sale_id = ? ORDER BY position, id`,
    [saleId],
  );
  return lines;
}

async function writeAudit(
  connection,
  { userId, action, saleId, details, request },
) {
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'sales', 'sale', ?, ?, ?, ?)`,
    [
      userId,
      action,
      String(saleId),
      JSON.stringify(details),
      request?.ip || null,
      request?.get("user-agent")?.slice(0, 512) || null,
    ],
  );
}

export function createSaleService({ dbPool }) {
  const inventoryEngine = createInventoryEngine({ dbPool });

  async function loadReversal(connection, saleId, warehouseIds) {
    if (!warehouseIds.length)
      throw new HttpError(
        404,
        "SALE_REVERSAL_NOT_FOUND",
        "No se encontró la anulación disponible.",
      );
    const [rows] = await connection.execute(
      `SELECT sc.id, sc.sale_id, sc.verification_reference,
              sc.physical_observation, sc.never_dispatched,
              sc.all_quantities_present, sc.all_products_saleable,
              sc.source_operation_id, sc.created_at AS document_created_at,
              s.commercial_code, DATE_FORMAT(s.sale_date, '%Y-%m-%d') AS sale_date,
              s.customer_name_snapshot, s.warehouse_name_snapshot,
              s.cancellation_reason, s.cancelled_at,
              actor.display_name AS cancelled_by_name
       FROM sale_cancellations sc
       JOIN sales s ON s.id = sc.sale_id
       JOIN users actor ON actor.id = s.cancelled_by
       WHERE sc.sale_id = ?
         AND s.warehouse_id IN (${placeholders(warehouseIds)})
       LIMIT 1`,
      [saleId, ...warehouseIds],
    );
    const row = rows[0];
    if (!row)
      throw new HttpError(
        404,
        "SALE_REVERSAL_NOT_FOUND",
        "No se encontró la anulación disponible.",
      );
    const lines = await getLines(connection, saleId);
    return {
      id: String(row.id),
      saleId: String(row.sale_id),
      saleNumber: row.commercial_code,
      saleDate: row.sale_date,
      customerName: row.customer_name_snapshot,
      warehouseName: row.warehouse_name_snapshot,
      reason: row.cancellation_reason,
      verificationReference: row.verification_reference,
      physicalObservation: row.physical_observation,
      neverDispatched: Boolean(row.never_dispatched),
      allQuantitiesPresent: Boolean(row.all_quantities_present),
      allProductsSaleable: Boolean(row.all_products_saleable),
      sourceOperationId:
        row.source_operation_id === null
          ? null
          : String(row.source_operation_id),
      cancelledByName: row.cancelled_by_name,
      cancelledAt: row.cancelled_at,
      createdAt: row.document_created_at,
      lines: lines.map((line) => ({
        id: String(line.id),
        productId: String(line.product_id),
        sku: line.sku_snapshot,
        name: line.product_name_snapshot,
        unit: line.unit_snapshot,
        quantity: Number(line.quantity),
        unitPrice: String(line.unit_price),
        lineTotal: String(line.line_total),
      })),
    };
  }

  async function readReversalReplay(
    connection,
    { actorId, key, requestHash, warehouseIds },
  ) {
    const [rows] = await connection.execute(
      `SELECT operation, request_hash, sale_id, reversal_id
       FROM sale_requests WHERE actor_id = ? AND idempotency_key = ?
       LIMIT 1 FOR UPDATE`,
      [actorId, key],
    );
    const prior = rows[0];
    if (!prior) return null;
    if (
      prior.operation !== "reversal" ||
      prior.request_hash !== requestHash ||
      prior.reversal_id === null
    )
      throw reversalConflict(
        "IDEMPOTENCY_KEY_REUSED",
        "La clave de idempotencia ya se utilizó con otros datos.",
      );
    const sale = await loadSale(connection, prior.sale_id, warehouseIds);
    const reversal = await loadReversal(
      connection,
      prior.sale_id,
      warehouseIds,
    );
    return { sale, reversal };
  }

  async function assertReturnActor(connection, actorId) {
    const [users] = await connection.execute(
      `SELECT u.id, u.is_active, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE`,
      [actorId],
    );
    if (!users[0] || !users[0].is_active)
      throw new HttpError(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    if (users[0].role_code !== "administrator")
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "Solo un Administrador puede registrar devoluciones de clientes.",
      );
    const [permissions] = await connection.execute(
      `SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       JOIN users u ON u.role_id = rp.role_id
       WHERE u.id = ? AND p.code = 'sales.return' LOCK IN SHARE MODE`,
      [actorId],
    );
    if (!permissions.length)
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "No tienes permiso para registrar devoluciones.",
      );
  }

  async function loadCustomerReturn(connection, returnId, warehouseIds) {
    if (!warehouseIds.length)
      throw new HttpError(
        404,
        "CUSTOMER_RETURN_NOT_FOUND",
        "No se encontró la devolución disponible.",
      );
    const [headers] = await connection.execute(
      `SELECT cr.*, s.commercial_code, DATE_FORMAT(s.sale_date, '%Y-%m-%d') AS sale_date,
              s.customer_name_snapshot, s.warehouse_name_snapshot,
              u.display_name AS returned_by_name
       FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id
       JOIN users u ON u.id = cr.returned_by
       WHERE cr.id = ? AND s.warehouse_id IN (${placeholders(warehouseIds)}) LIMIT 1`,
      [returnId, ...warehouseIds],
    );
    const row = headers[0];
    if (!row)
      throw new HttpError(
        404,
        "CUSTOMER_RETURN_NOT_FOUND",
        "No se encontró la devolución disponible.",
      );
    const [lines] = await connection.execute(
      `SELECT crl.id, crl.sale_line_id, crl.product_id, crl.sku_snapshot,
              crl.product_name_snapshot, crl.unit_snapshot, sl.quantity AS sold_quantity,
              crl.quantity_received, crl.quantity_restocked, crl.non_restock_reason,
              (crl.quantity_received - crl.quantity_restocked) AS quantity_not_restocked
       FROM customer_return_lines crl JOIN sale_lines sl
         ON sl.id = crl.sale_line_id AND sl.sale_id = crl.sale_id
       WHERE crl.customer_return_id = ? ORDER BY sl.position, sl.id`,
      [returnId],
    );
    return {
      id: String(row.id),
      number: `DEV-${String(row.id).padStart(6, "0")}`,
      saleId: String(row.sale_id),
      saleNumber: row.commercial_code,
      saleDate: row.sale_date,
      customerName: row.customer_name_snapshot,
      warehouseName: row.warehouse_name_snapshot,
      reference: row.reference,
      reason: row.reason,
      physicalObservation: row.physical_observation,
      receivedPhysical: Boolean(row.received_physical),
      inspected: Boolean(row.inspected),
      sourceOperationId:
        row.source_operation_id === null
          ? null
          : String(row.source_operation_id),
      returnedBy: String(row.returned_by),
      returnedByName: row.returned_by_name,
      returnedAt: row.returned_at,
      lines: lines.map((line) => ({
        id: String(line.id),
        saleLineId: String(line.sale_line_id),
        productId: String(line.product_id),
        sku: line.sku_snapshot,
        name: line.product_name_snapshot,
        unit: line.unit_snapshot,
        soldQuantity: Number(line.sold_quantity),
        quantityReceived: Number(line.quantity_received),
        quantityRestocked: Number(line.quantity_restocked),
        quantityNotRestocked: Number(line.quantity_not_restocked),
        nonRestockReason: line.non_restock_reason,
      })),
    };
  }

  async function getCustomerReturn({ saleId, returnId, warehouseIds }) {
    if (!warehouseIds.length)
      throw new HttpError(
        404,
        "CUSTOMER_RETURN_NOT_FOUND",
        "No se encontró la devolución disponible.",
      );
    const [rows] = await dbPool.execute(
      `SELECT cr.id FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id
       WHERE cr.id = ? AND cr.sale_id = ? AND s.warehouse_id IN (${placeholders(warehouseIds)}) LIMIT 1`,
      [returnId, saleId, ...warehouseIds],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "CUSTOMER_RETURN_NOT_FOUND",
        "No se encontró la devolución disponible.",
      );
    return loadCustomerReturn(dbPool, returnId, warehouseIds);
  }

  async function listCustomerReturns({ saleId, warehouseIds }) {
    const sale = await loadSale(dbPool, saleId, warehouseIds);
    const [rows] = await dbPool.execute(
      "SELECT id FROM customer_returns WHERE sale_id = ? ORDER BY returned_at DESC, id DESC",
      [saleId],
    );
    const items = [];
    for (const row of rows)
      items.push(
        await loadCustomerReturn(dbPool, String(row.id), warehouseIds),
      );
    return { saleId: sale.id, items };
  }

  async function readCustomerReturnReplay(
    connection,
    { actorId, key, requestHash, saleId, warehouseIds },
  ) {
    const [rows] = await connection.execute(
      `SELECT operation, request_hash, sale_id, return_id FROM sale_requests
       WHERE actor_id = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
      [actorId, key],
    );
    const prior = rows[0];
    if (!prior) return null;
    if (
      prior.operation !== "return" ||
      prior.request_hash !== requestHash ||
      String(prior.sale_id) !== String(saleId) ||
      prior.return_id === null
    )
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "La clave de idempotencia ya se utilizó con otros datos.",
      );
    return loadCustomerReturn(
      connection,
      String(prior.return_id),
      warehouseIds,
    );
  }

  async function returnAttempt({ id, input, actor, request, key }) {
    const connection = await dbPool.getConnection();
    const canonicalInput = {
      expectedVersion: input.expectedVersion,
      reference: input.reference,
      reason: input.reason,
      physicalObservation: input.physicalObservation,
      receivedPhysical: input.receivedPhysical,
      inspected: input.inspected,
      lines: [...input.lines].sort((a, b) =>
        BigInt(a.saleLineId) < BigInt(b.saleLineId) ? -1 : 1,
      ),
    };
    const requestHash = hashRequest("return", id, canonicalInput);
    try {
      await connection.beginTransaction();
      await assertReturnActor(connection, actor.user.id);
      const [sales] = await connection.execute(
        "SELECT * FROM sales WHERE id = ? FOR UPDATE",
        [id],
      );
      const sale = sales[0];
      if (!sale || !actor.warehouseIds.has(String(sale.warehouse_id)))
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      const [assignments] = await connection.execute(
        `SELECT w.is_active FROM warehouses w JOIN user_warehouses uw
          ON uw.warehouse_id = w.id AND uw.user_id = ? WHERE w.id = ? LOCK IN SHARE MODE`,
        [actor.user.id, sale.warehouse_id],
      );
      if (!assignments[0])
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      const replayed = await readCustomerReturnReplay(connection, {
        actorId: actor.user.id,
        key,
        requestHash,
        saleId: id,
        warehouseIds: [...actor.warehouseIds],
      });
      if (replayed) {
        await connection.commit();
        const replaySale = await loadSale(connection, id, [
          ...actor.warehouseIds,
        ]);
        return {
          sale: await withReturnSummary(connection, id, replaySale),
          customerReturn: replayed,
          replayed: true,
        };
      }
      const [inventoryKeyUses] = await connection.execute(
        "SELECT id FROM inventory_operations WHERE created_by = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE",
        [actor.user.id, key],
      );
      if (inventoryKeyUses.length)
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "La clave de idempotencia ya se utilizó para otra operación.",
        );
      if (sale.status !== "confirmed")
        throw conflict(
          "SALE_NOT_RETURNABLE",
          "Solo se admiten devoluciones de ventas confirmadas.",
        );
      if (!assignments[0].is_active)
        throw conflict(
          "INACTIVE_WAREHOUSE",
          "La bodega original está inactiva.",
        );
      if (Number(sale.version) !== input.expectedVersion)
        throw conflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de devolver mercancía.",
        );

      const lines = await getLines(connection, id);
      const priorTotals = new Map();
      const [totals] = await connection.execute(
        `SELECT sale_line_id, SUM(quantity_received) AS received
         FROM customer_return_lines WHERE sale_id = ? GROUP BY sale_line_id`,
        [id],
      );
      for (const row of totals)
        priorTotals.set(String(row.sale_line_id), Number(row.received));
      const originals = new Map(lines.map((line) => [String(line.id), line]));
      const selected = input.lines.map((requested) => {
        const original = originals.get(requested.saleLineId);
        if (!original)
          throw invalid("Una línea no pertenece a la venta original.");
        const returned = priorTotals.get(requested.saleLineId) || 0;
        const pending = Number(original.quantity) - returned;
        if (requested.quantityReceived > pending)
          throw conflict(
            "RETURN_QUANTITY_EXCEEDED",
            `La cantidad supera lo pendiente para ${original.product_name_snapshot} (${pending}).`,
          );
        return { requested, original, returned, pending };
      });
      const [duplicates] = await connection.execute(
        "SELECT id FROM customer_returns WHERE sale_id = ? AND reference = ? LIMIT 1 FOR UPDATE",
        [id, input.reference],
      );
      if (duplicates.length)
        throw conflict(
          "DUPLICATE_RETURN_REFERENCE",
          "Esta referencia ya se registró para la venta.",
        );

      const [inserted] = await connection.execute(
        `INSERT INTO customer_returns
          (sale_id, reference, reason, physical_observation, received_physical, inspected, returned_by)
         VALUES (?, ?, ?, ?, 1, 1, ?)`,
        [
          id,
          input.reference,
          input.reason,
          input.physicalObservation,
          actor.user.id,
        ],
      );
      const returnId = String(inserted.insertId);
      for (const { requested, original } of selected) {
        const notRestocked =
          requested.quantityReceived - requested.quantityRestocked;
        await connection.execute(
          `INSERT INTO customer_return_lines
            (customer_return_id, sale_id, sale_line_id, product_id, sku_snapshot,
             product_name_snapshot, unit_snapshot, quantity_received, quantity_restocked, non_restock_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            returnId,
            id,
            original.id,
            original.product_id,
            original.sku_snapshot,
            original.product_name_snapshot,
            original.unit_snapshot,
            requested.quantityReceived,
            requested.quantityRestocked,
            notRestocked ? requested.nonRestockReason : null,
          ],
        );
      }

      const restockLines = selected.filter(
        ({ requested }) => requested.quantityRestocked > 0,
      );
      let operationId = null;
      if (restockLines.length) {
        const inventoryLines = [];
        for (const { requested, original } of restockLines) {
          const [balances] = await connection.execute(
            `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
             WHERE product_id = ? AND warehouse_id = ? FOR UPDATE`,
            [original.product_id, sale.warehouse_id],
          );
          if (!balances[0])
            throw conflict(
              "INVENTORY_HISTORY_INCONSISTENT",
              "No se encontró el saldo de Inventario de la venta.",
            );
          inventoryLines.push({
            productId: String(original.product_id),
            quantity: requested.quantityRestocked,
            expectedVersion: String(balances[0].version),
          });
        }
        const inventory = await inventoryEngine.applyWithinTransaction({
          connection,
          userId: actor.user.id,
          idempotencyKey: key,
          payload: {
            type: "customer_return",
            sourceWarehouseId: String(sale.warehouse_id),
            destinationWarehouseId: null,
            sourceType: "customer_return",
            sourceId: returnId,
            reason: input.reason,
            reference: input.reference,
            lines: inventoryLines,
          },
          internal: true,
          allowCustomerReturn: true,
          request,
          validateProducts: async ({ products }) => {
            for (const { original } of restockLines) {
              const product = products.get(String(original.product_id));
              if (!product || product.unit !== original.unit_snapshot)
                throw conflict(
                  "RETURN_PRODUCT_INVALID",
                  `El producto ${original.product_name_snapshot} no está disponible con su unidad original para reintegrarlo.`,
                );
            }
          },
        });
        operationId = inventory.operationId;
        await connection.execute(
          "UPDATE customer_returns SET source_operation_id = ? WHERE id = ?",
          [operationId, returnId],
        );
      }

      const [updated] = await connection.execute(
        `UPDATE sales SET updated_by = ?, version = version + 1
         WHERE id = ? AND status = 'confirmed' AND version = ?`,
        [actor.user.id, id, input.expectedVersion],
      );
      if (updated.affectedRows !== 1)
        throw conflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de devolver mercancía.",
        );
      await writeAudit(connection, {
        userId: actor.user.id,
        action: "sales.return_confirmed",
        saleId: id,
        details: {
          returnId,
          expectedVersion: input.expectedVersion,
          version: input.expectedVersion + 1,
          reference: input.reference,
          sourceOperationId: operationId,
          reason: input.reason,
          physicalObservation: input.physicalObservation,
          receivedPhysical: true,
          inspected: true,
          lines: selected.map(({ requested, original }) => ({
            saleLineId: String(original.id),
            productId: String(original.product_id),
            received: requested.quantityReceived,
            restocked: requested.quantityRestocked,
            notRestocked:
              requested.quantityReceived - requested.quantityRestocked,
            nonRestockReason: requested.nonRestockReason || null,
            unit: original.unit_snapshot,
          })),
        },
        request,
      });
      await connection.execute(
        `INSERT INTO sale_requests (actor_id, idempotency_key, operation, request_hash, sale_id, return_id, response_version)
         VALUES (?, ?, 'return', ?, ?, ?, ?)`,
        [
          actor.user.id,
          key,
          requestHash,
          id,
          returnId,
          input.expectedVersion + 1,
        ],
      );
      const document = await loadCustomerReturn(connection, returnId, [
        ...actor.warehouseIds,
      ]);
      const updatedSale = await withReturnSummary(
        connection,
        id,
        await loadSale(connection, id, [...actor.warehouseIds]),
      );
      await connection.commit();
      return { sale: updatedSale, customerReturn: document, replayed: false };
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        /* Preserve original error. */
      }
      if (error.code === "ER_DUP_ENTRY") {
        if (String(error.message).includes("uq_sale_requests_actor_key")) {
          const replay = await readCustomerReturnReplay(dbPool, {
            actorId: actor.user.id,
            key,
            requestHash,
            saleId: id,
            warehouseIds: [...actor.warehouseIds],
          });
          if (replay) {
            const replaySale = await loadSale(dbPool, id, [
              ...actor.warehouseIds,
            ]);
            return {
              sale: await withReturnSummary(dbPool, id, replaySale),
              customerReturn: replay,
              replayed: true,
            };
          }
        }
        if (
          String(error.message).includes("uq_customer_returns_sale_reference")
        )
          throw conflict(
            "DUPLICATE_RETURN_REFERENCE",
            "Esta referencia ya se registró para la venta.",
          );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function createCustomerReturn(args) {
    let attempt = 0;
    while (true) {
      try {
        return await returnAttempt(args);
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, 15 * 2 ** (attempt - 1)),
        );
      }
    }
  }

  async function getCustomerReturnPdf({ saleId, returnId, warehouseIds }) {
    const customerReturn = await getCustomerReturn({
      saleId,
      returnId,
      warehouseIds,
    });
    return createCustomerReturnPdf(customerReturn);
  }

  async function assertReversalActor(connection, actorId) {
    const [users] = await connection.execute(
      `SELECT u.id, u.is_active, role.code AS role_code
       FROM users u JOIN roles role ON role.id = u.role_id
       WHERE u.id = ? FOR UPDATE`,
      [actorId],
    );
    if (!users[0] || !users[0].is_active)
      throw new HttpError(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    if (users[0].role_code !== "administrator")
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "Solo un Administrador puede anular una venta confirmada.",
      );
    const [permissions] = await connection.execute(
      `SELECT 1 FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       JOIN users u ON u.role_id = rp.role_id
       WHERE u.id = ? AND p.code = 'sales.cancel'
       LOCK IN SHARE MODE`,
      [actorId],
    );
    if (!permissions.length)
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "No tienes permiso para anular ventas.",
      );
  }

  async function assertReversalWarehouse(connection, actorId, warehouseId) {
    const [rows] = await connection.execute(
      `SELECT w.id, w.is_active FROM warehouses w
       JOIN user_warehouses uw ON uw.warehouse_id = w.id AND uw.user_id = ?
       WHERE w.id = ? FOR UPDATE`,
      [actorId, warehouseId],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "SALE_NOT_FOUND",
        "No se encontró la venta disponible.",
      );
    if (!rows[0].is_active)
      throw reversalConflict(
        "INACTIVE_WAREHOUSE",
        "No se puede anular una venta de una bodega inactiva.",
      );
  }

  async function getReversal({ saleId, warehouseIds }) {
    return loadReversal(dbPool, saleId, warehouseIds);
  }

  async function reverseAttempt({ id, input, actor, request, key }) {
    const connection = await dbPool.getConnection();
    const requestHash = hashRequest("reversal", id, input);
    try {
      await connection.beginTransaction();
      await assertReversalActor(connection, actor.user.id);
      const [sales] = await connection.execute(
        "SELECT * FROM sales WHERE id = ? FOR UPDATE",
        [id],
      );
      const sale = sales[0];
      if (!sale)
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      await assertReversalWarehouse(
        connection,
        actor.user.id,
        String(sale.warehouse_id),
      );

      const replayed = await readReversalReplay(connection, {
        actorId: actor.user.id,
        key,
        requestHash,
        warehouseIds: [...actor.warehouseIds],
      });
      if (replayed) {
        await connection.commit();
        return replayed;
      }
      if (sale.status !== "confirmed")
        throw reversalConflict(
          "SALE_NOT_REVERSIBLE",
          "Solo se pueden anular ventas confirmadas que no tengan operaciones posteriores.",
        );
      if (Number(sale.version) !== input.expectedVersion)
        throw reversalConflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de anularlo.",
        );

      const [existingReversals] = await connection.execute(
        "SELECT id FROM sale_cancellations WHERE sale_id = ? LIMIT 1 FOR UPDATE",
        [id],
      );
      if (existingReversals.length)
        throw reversalConflict(
          "SALE_ALREADY_REVERSED",
          "Esta venta ya tiene una anulación registrada.",
        );
      const [existingReturns] = await connection.execute(
        "SELECT id FROM customer_returns WHERE sale_id = ? LIMIT 1 FOR UPDATE",
        [id],
      );
      if (existingReturns.length)
        throw reversalConflict(
          "SALE_HAS_RETURNS",
          "No se puede anular una venta que ya tiene devoluciones registradas.",
        );

      const [sourceOperations] = await connection.execute(
        `SELECT id, operation_type, source_warehouse_id, created_by
         FROM inventory_operations
         WHERE source_type = 'sale' AND source_id = ? LIMIT 1 FOR UPDATE`,
        [id],
      );
      const issue = sourceOperations[0];
      if (
        !issue ||
        issue.operation_type !== "sale_issue" ||
        String(issue.source_warehouse_id) !== String(sale.warehouse_id) ||
        String(issue.created_by) !== String(sale.confirmed_by)
      )
        throw reversalConflict(
          "SALE_ISSUE_INVALID",
          "No se encontró una salida de inventario válida para esta venta.",
        );
      const lines = await getLines(connection, id);
      const [issueMovements] = await connection.execute(
        `SELECT product_id, warehouse_id, direction, quantity, unit_snapshot
         FROM inventory_movements WHERE operation_id = ? ORDER BY product_id FOR UPDATE`,
        [issue.id],
      );
      if (issueMovements.length !== lines.length)
        throw reversalConflict(
          "SALE_ISSUE_INVALID",
          "La salida de inventario no coincide con las líneas originales de la venta.",
        );
      const issuesByProduct = new Map(
        issueMovements.map((movement) => [
          String(movement.product_id),
          movement,
        ]),
      );
      for (const line of lines) {
        const movement = issuesByProduct.get(String(line.product_id));
        if (
          !movement ||
          movement.direction !== "OUT" ||
          Number(movement.quantity) !== Number(line.quantity) ||
          String(movement.warehouse_id) !== String(sale.warehouse_id) ||
          movement.unit_snapshot !== line.unit_snapshot
        )
          throw reversalConflict(
            "SALE_ISSUE_INVALID",
            "La salida de inventario no coincide con las líneas originales de la venta.",
          );
      }

      const [inserted] = await connection.execute(
        `INSERT INTO sale_cancellations
          (sale_id, verification_reference, physical_observation,
           never_dispatched, all_quantities_present, all_products_saleable)
         VALUES (?, ?, ?, 1, 1, 1)`,
        [id, input.reference, input.physicalObservation],
      );
      const reversalId = String(inserted.insertId);
      const inventoryLines = [];
      for (const line of lines) {
        const [balances] = await connection.execute(
          `SELECT CAST(version AS CHAR) AS version
           FROM inventory_balances
           WHERE product_id = ? AND warehouse_id = ? FOR UPDATE`,
          [line.product_id, sale.warehouse_id],
        );
        if (!balances[0])
          throw reversalConflict(
            "INVENTORY_HISTORY_INCONSISTENT",
            "No se encontró el saldo de inventario asociado a la venta.",
          );
        inventoryLines.push({
          productId: String(line.product_id),
          quantity: Number(line.quantity),
          expectedVersion: String(balances[0].version),
        });
      }

      const inventoryResult = await inventoryEngine.applyWithinTransaction({
        connection,
        userId: actor.user.id,
        idempotencyKey: key,
        payload: {
          type: "sale_reversal",
          sourceWarehouseId: String(sale.warehouse_id),
          destinationWarehouseId: null,
          sourceType: "sale_cancellation",
          sourceId: reversalId,
          reason: input.reason,
          reference: input.reference,
          lines: inventoryLines,
        },
        internal: true,
        allowSaleReversal: true,
        request,
        validateProducts: async ({ products }) => {
          for (const line of lines) {
            const product = products.get(String(line.product_id));
            if (!product || product.unit !== line.unit_snapshot)
              throw reversalConflict(
                "SALE_PRODUCT_CHANGED",
                `El producto ${line.product_name_snapshot} está inactivo o su unidad cambió; no se puede reintegrar la venta.`,
              );
          }
        },
      });
      await connection.execute(
        "UPDATE sale_cancellations SET source_operation_id = ? WHERE id = ? AND source_operation_id IS NULL",
        [inventoryResult.operationId, reversalId],
      );
      const [updated] = await connection.execute(
        `UPDATE sales SET status = 'cancelled', cancelled_by = ?,
           cancelled_at = UTC_TIMESTAMP(3), cancellation_reason = ?,
           updated_by = ?, version = version + 1
         WHERE id = ? AND status = 'confirmed' AND version = ?`,
        [actor.user.id, input.reason, actor.user.id, id, input.expectedVersion],
      );
      if (updated.affectedRows !== 1)
        throw reversalConflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de anularlo.",
        );
      await writeAudit(connection, {
        userId: actor.user.id,
        action: "sales.reversed",
        saleId: id,
        details: {
          reversalId,
          expectedVersion: input.expectedVersion,
          version: input.expectedVersion + 1,
          sourceIssueOperationId: String(issue.id),
          sourceOperationId: inventoryResult.operationId,
          warehouseId: String(sale.warehouse_id),
          reference: input.reference,
          physicalObservation: input.physicalObservation,
          neverDispatched: true,
          allQuantitiesPresent: true,
          allProductsSaleable: true,
          lines: lines.map((line) => ({
            productId: String(line.product_id),
            quantity: Number(line.quantity),
            unit: line.unit_snapshot,
          })),
        },
        request,
      });
      const updatedSale = await loadSale(connection, id, [
        ...actor.warehouseIds,
      ]);
      await connection.execute(
        `INSERT INTO sale_requests
          (actor_id, idempotency_key, operation, request_hash, sale_id,
           reversal_id, response_version)
         VALUES (?, ?, 'reversal', ?, ?, ?, ?)`,
        [actor.user.id, key, requestHash, id, reversalId, updatedSale.version],
      );
      const reversal = await loadReversal(connection, id, [
        ...actor.warehouseIds,
      ]);
      await connection.commit();
      return { sale: updatedSale, reversal };
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the original transaction error.
      }
      if (
        error.code === "ER_DUP_ENTRY" &&
        String(error.message).includes("uq_sale_requests_actor_key")
      ) {
        const replay = await readReversalReplay(dbPool, {
          actorId: actor.user.id,
          key,
          requestHash,
          warehouseIds: [...actor.warehouseIds],
        });
        if (replay) return replay;
      }
      if (
        error.code === "ER_DUP_ENTRY" &&
        String(error.message).includes("uq_sale_cancellations_sale")
      )
        throw reversalConflict(
          "SALE_ALREADY_REVERSED",
          "Esta venta ya tiene una anulación registrada.",
        );
      throw error;
    } finally {
      connection.release();
    }
  }

  async function reverse(args) {
    let attempt = 0;
    while (true) {
      try {
        return await reverseAttempt(args);
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }
  async function assertWriteWarehouse(connection, userId, warehouseId) {
    const [rows] = await connection.execute(
      `SELECT w.id, w.code, w.name, w.location, w.is_active
       FROM warehouses AS w
       JOIN user_warehouses AS uw ON uw.warehouse_id = w.id AND uw.user_id = ?
       WHERE w.id = ? FOR UPDATE`,
      [userId, warehouseId],
    );
    if (!rows[0])
      throw new HttpError(
        403,
        "WAREHOUSE_ACCESS_DENIED",
        "No tienes acceso a esta bodega.",
      );
    if (!rows[0].is_active)
      throw invalid("Selecciona una bodega activa y autorizada.");
    return rows[0];
  }

  async function loadSale(connection, saleId, warehouseIds) {
    const [rows] = await connection.execute(
      `${saleSelect}
       WHERE s.id = ? AND s.warehouse_id IN (${placeholders(warehouseIds)}) LIMIT 1`,
      [saleId, ...warehouseIds],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "SALE_NOT_FOUND",
        "No se encontró la venta disponible.",
      );
    return toSale(rows[0], await getLines(connection, saleId));
  }

  async function replay(
    connection,
    { actorId, key, operation, hash, warehouseIds },
  ) {
    const [rows] = await connection.execute(
      `SELECT operation, request_hash, sale_id FROM sale_requests
       WHERE actor_id = ? AND idempotency_key = ? LIMIT 1`,
      [actorId, key],
    );
    const prior = rows[0];
    if (!prior) return null;
    if (prior.operation !== operation || prior.request_hash !== hash) {
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "La clave de idempotencia ya fue usada con otros datos.",
      );
    }
    return loadSale(connection, prior.sale_id, warehouseIds);
  }

  async function recordRequest(
    connection,
    { actorId, key, operation, hash, sale },
  ) {
    await connection.execute(
      `INSERT INTO sale_requests (actor_id, idempotency_key, operation, request_hash, sale_id, response_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [actorId, key, operation, hash, sale.id, sale.version],
    );
  }

  async function validateSaleReferences(connection, input, userId) {
    const [customers] = await connection.execute(
      "SELECT id, name, identification_number, is_active FROM customers WHERE id = ? FOR UPDATE",
      [input.customerId],
    );
    if (!customers[0] || !customers[0].is_active)
      throw invalid("Selecciona un cliente existente y activo.");
    const warehouse = await assertWriteWarehouse(
      connection,
      userId,
      input.warehouseId,
    );
    return { customer: customers[0], warehouse };
  }

  async function validateProducts(connection, lines) {
    const ids = lines
      .map((line) => line.productId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const products = new Map();
    for (const id of ids) {
      const [rows] = await connection.execute(
        `SELECT id, sku, name, unit, sale_price, minimum_sale_quantity,
                minimum_sale_enabled, is_active
         FROM products WHERE id = ? FOR UPDATE`,
        [id],
      );
      const product = rows[0];
      if (!product || !product.is_active)
        throw invalid("Todos los productos deben existir y estar activos.");
      const line = lines.find((item) => item.productId === id);
      if (
        product.minimum_sale_enabled &&
        line.quantity < Number(product.minimum_sale_quantity)
      ) {
        throw invalid(
          `La cantidad mínima para ${product.name} es ${product.minimum_sale_quantity}.`,
        );
      }
      products.set(id, product);
    }
    return products;
  }

  async function replaceLines(connection, saleId, lines, products) {
    const [existing] = await connection.execute(
      "SELECT id, product_id FROM sale_lines WHERE sale_id = ? FOR UPDATE",
      [saleId],
    );
    const byProduct = new Map(
      existing.map((row) => [String(row.product_id), row]),
    );
    const retained = new Set();
    for (const [index, line] of lines.entries()) {
      const product = products.get(line.productId);
      const lineCents = cents(line.unitPrice) * BigInt(line.quantity);
      const lineTotal = money(lineCents);
      const prior = byProduct.get(line.productId);
      if (prior) {
        retained.add(String(prior.id));
        await connection.execute(
          `UPDATE sale_lines SET position = ?, sku_snapshot = ?, product_name_snapshot = ?,
             unit_snapshot = ?, quantity = ?, unit_price = ?, line_total = ? WHERE id = ?`,
          [
            index + 1,
            product.sku,
            product.name,
            product.unit,
            line.quantity,
            line.unitPrice,
            lineTotal,
            prior.id,
          ],
        );
      } else {
        await connection.execute(
          `INSERT INTO sale_lines
            (sale_id, product_id, position, sku_snapshot, product_name_snapshot, unit_snapshot, quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            line.productId,
            index + 1,
            product.sku,
            product.name,
            product.unit,
            line.quantity,
            line.unitPrice,
            lineTotal,
          ],
        );
      }
    }
    for (const prior of existing) {
      if (
        !retained.has(String(prior.id)) &&
        !lines.some((line) => line.productId === String(prior.product_id))
      ) {
        await connection.execute("DELETE FROM sale_lines WHERE id = ?", [
          prior.id,
        ]);
      }
    }
  }

  async function getById(id, { warehouseIds }) {
    if (!warehouseIds.length)
      throw new HttpError(
        404,
        "SALE_NOT_FOUND",
        "No se encontró la venta disponible.",
      );
    const sale = await loadSale(dbPool, id, warehouseIds);
    return withReturnSummary(dbPool, id, sale);
  }

  async function withReturnSummary(connection, id, sale) {
    const [lines] = await connection.execute(
      `SELECT sl.id, sl.quantity, COALESCE(SUM(crl.quantity_received), 0) AS returned,
              COALESCE(SUM(crl.quantity_restocked), 0) AS restocked
       FROM sale_lines sl LEFT JOIN customer_return_lines crl
         ON crl.sale_line_id = sl.id AND crl.sale_id = sl.sale_id
       WHERE sl.sale_id = ? GROUP BY sl.id`,
      [id],
    );
    const summary = new Map(lines.map((line) => [String(line.id), line]));
    sale.lines = sale.lines.map((line) => {
      const totals = summary.get(line.id);
      const returnedQuantity = Number(totals?.returned || 0);
      return {
        ...line,
        returnedQuantity,
        returnableQuantity: Math.max(0, line.quantity - returnedQuantity),
        restockedQuantity: Number(totals?.restocked || 0),
      };
    });
    sale.returnStatus = sale.lines.every((line) => line.returnedQuantity === 0)
      ? "none"
      : sale.lines.every((line) => line.returnableQuantity === 0)
        ? "complete"
        : "partial";
    return sale;
  }

  async function list({ warehouseIds, query }) {
    if (!warehouseIds.length)
      return {
        items: [],
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: 0,
          pageCount: 0,
        },
      };
    const where = [`s.warehouse_id IN (${placeholders(warehouseIds)})`];
    const params = [...warehouseIds];
    if (query.status !== "all") {
      where.push("s.status = ?");
      params.push(query.status);
    }
    if (query.customerId) {
      where.push("s.customer_id = ?");
      params.push(query.customerId);
    }
    if (query.warehouseId) {
      where.push("s.warehouse_id = ?");
      params.push(query.warehouseId);
    }
    if (query.dateFrom) {
      where.push("s.sale_date >= ?");
      params.push(query.dateFrom);
    }
    if (query.dateTo) {
      where.push("s.sale_date <= ?");
      params.push(query.dateTo);
    }
    if (query.q) {
      const term = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(
        "(s.commercial_code LIKE ? OR s.customer_name_snapshot LIKE ? OR s.customer_identification_snapshot LIKE ?)",
      );
      params.push(term, term, term);
    }
    const filter = where.join(" AND ");
    const [[count]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM sales AS s WHERE ${filter}`,
      params,
    );
    const sort = sorts[query.sortBy] || sorts.date;
    const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
    const [rows] = await dbPool.execute(
      `SELECT s.*, DATE_FORMAT(s.sale_date, '%Y-%m-%d') AS sale_date,
         CAST(COALESCE(SUM(sl.line_total), 0) AS CHAR) AS total
       FROM sales AS s LEFT JOIN sale_lines AS sl ON sl.sale_id = s.id
       WHERE ${filter} GROUP BY s.id ORDER BY ${sort} ${direction}, s.id ${direction}
       LIMIT ? OFFSET ?`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    const total = Number(count.total);
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        number: row.commercial_code,
        saleDate: row.sale_date,
        customerId: String(row.customer_id),
        customerName: row.customer_name_snapshot,
        warehouseId: String(row.warehouse_id),
        warehouseName: row.warehouse_name_snapshot,
        status: row.status,
        version: Number(row.version),
        total: money(cents(row.total)),
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.ceil(total / query.pageSize),
      },
    };
  }

  async function write({ operation, id = null, input, actor, request, key }) {
    const connection = await dbPool.getConnection();
    const inputHash = hashRequest(operation, id, input);
    try {
      await connection.beginTransaction();
      const replayed = await replay(connection, {
        actorId: actor.user.id,
        key,
        operation,
        hash: inputHash,
        warehouseIds: [...actor.warehouseIds],
      });
      if (replayed) {
        await connection.commit();
        return replayed;
      }

      let saleId = id;
      if (operation === "create") {
        const { customer, warehouse } = await validateSaleReferences(
          connection,
          input,
          actor.user.id,
        );
        const products = await validateProducts(connection, input.lines);
        totalCents(
          input.lines.map((line) => ({
            line_total: money(cents(line.unitPrice) * BigInt(line.quantity)),
          })),
        );
        const [created] = await connection.execute(
          `INSERT INTO sales (commercial_code, customer_id, customer_name_snapshot, customer_identification_snapshot,
             warehouse_id, warehouse_code_snapshot, warehouse_name_snapshot, warehouse_location_snapshot,
             sale_date, notes, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `TMP-${randomUUID()}`,
            customer.id,
            customer.name,
            customer.identification_number,
            warehouse.id,
            warehouse.code,
            warehouse.name,
            warehouse.location,
            input.saleDate,
            input.notes,
            actor.user.id,
            actor.user.id,
          ],
        );
        saleId = String(created.insertId);
        await connection.execute(
          "UPDATE sales SET commercial_code = ? WHERE id = ?",
          [`VE-${saleId.padStart(6, "0")}`, saleId],
        );
        await replaceLines(connection, saleId, input.lines, products);
        await writeAudit(connection, {
          userId: actor.user.id,
          action: "sales.draft_created",
          saleId,
          details: {
            customerId: input.customerId,
            customerName: customer.name,
            warehouseId: input.warehouseId,
            warehouseName: warehouse.name,
            saleDate: input.saleDate,
            lines: input.lines.map((line) => ({
              productId: line.productId,
              sku: products.get(line.productId).sku,
              name: products.get(line.productId).name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
          },
          request,
        });
      } else {
        const [rows] = await connection.execute(
          "SELECT s.* FROM sales AS s WHERE s.id = ? FOR UPDATE",
          [id],
        );
        const current = rows[0];
        if (!current)
          throw new HttpError(
            404,
            "SALE_NOT_FOUND",
            "No se encontró la venta disponible.",
          );
        if (!actor.warehouseIds.has(String(current.warehouse_id)))
          throw new HttpError(
            404,
            "SALE_NOT_FOUND",
            "No se encontró la venta disponible.",
          );
        if (Number(current.version) !== input.expectedVersion)
          throw conflict(
            "SALE_VERSION_CONFLICT",
            "La venta cambió en otra sesión. Actualiza la información antes de guardar.",
          );
        if (current.status !== "draft")
          throw conflict(
            "SALE_NOT_EDITABLE",
            "Solo se pueden editar ventas en borrador.",
          );
        if (
          actor.user.role === "seller" &&
          String(current.created_by) !== actor.user.id
        )
          throw new HttpError(
            403,
            "SALE_OWNER_REQUIRED",
            "Solo puedes editar tus propios borradores.",
          );
        if (operation === "update") {
          const previous = await loadSale(connection, id, [
            ...actor.warehouseIds,
          ]);
          const { customer, warehouse } = await validateSaleReferences(
            connection,
            input,
            actor.user.id,
          );
          const products = await validateProducts(connection, input.lines);
          totalCents(
            input.lines.map((line) => ({
              line_total: money(cents(line.unitPrice) * BigInt(line.quantity)),
            })),
          );
          await connection.execute(
            `UPDATE sales SET customer_id = ?, customer_name_snapshot = ?, customer_identification_snapshot = ?,
               warehouse_id = ?, warehouse_code_snapshot = ?, warehouse_name_snapshot = ?, warehouse_location_snapshot = ?,
               sale_date = ?, notes = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ?`,
            [
              customer.id,
              customer.name,
              customer.identification_number,
              warehouse.id,
              warehouse.code,
              warehouse.name,
              warehouse.location,
              input.saleDate,
              input.notes,
              actor.user.id,
              id,
              input.expectedVersion,
            ],
          );
          await replaceLines(connection, id, input.lines, products);
          await writeAudit(connection, {
            userId: actor.user.id,
            action: "sales.draft_updated",
            saleId: id,
            details: {
              expectedVersion: input.expectedVersion,
              version: input.expectedVersion + 1,
              previous: {
                customerId: previous.customerId,
                warehouseId: previous.warehouseId,
                saleDate: previous.saleDate,
                total: previous.total,
                lines: previous.lines,
              },
              current: {
                customerId: input.customerId,
                warehouseId: input.warehouseId,
                saleDate: input.saleDate,
                lines: input.lines.map((line) => ({
                  ...line,
                  sku: products.get(line.productId).sku,
                  name: products.get(line.productId).name,
                })),
              },
            },
            request,
          });
        } else {
          await connection.execute(
            `UPDATE sales SET status = 'cancelled', cancelled_by = ?, cancelled_at = UTC_TIMESTAMP(3),
               cancellation_reason = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ?`,
            [
              actor.user.id,
              input.reason,
              actor.user.id,
              id,
              input.expectedVersion,
            ],
          );
          await writeAudit(connection, {
            userId: actor.user.id,
            action: "sales.draft_cancelled",
            saleId: id,
            details: {
              reason: input.reason,
              expectedVersion: input.expectedVersion,
              version: input.expectedVersion + 1,
            },
            request,
          });
        }
      }
      const sale = await loadSale(connection, saleId, [...actor.warehouseIds]);
      await recordRequest(connection, {
        actorId: actor.user.id,
        key,
        operation,
        hash: inputHash,
        sale,
      });
      await connection.commit();
      return sale;
    } catch (error) {
      await connection.rollback();
      if (
        error.code === "ER_DUP_ENTRY" &&
        String(error.message).includes("uq_sale_requests_actor_key")
      ) {
        const replayed = await replay(dbPool, {
          actorId: actor.user.id,
          key,
          operation,
          hash: inputHash,
          warehouseIds: [...actor.warehouseIds],
        });
        if (replayed) return replayed;
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  function confirmationPayload(sale, lines, expectedVersions, expectedVersion) {
    return {
      type: "sale_issue",
      sourceWarehouseId: String(sale.warehouse_id),
      destinationWarehouseId: null,
      sourceType: "sale",
      sourceId: String(sale.id),
      reason: `Confirmación de ${sale.commercial_code} versión ${expectedVersion}`,
      reference: sale.commercial_code,
      lines: lines.map((line) => ({
        productId: String(line.product_id),
        quantity: Number(line.quantity),
        expectedVersion: expectedVersions.get(String(line.product_id)),
      })),
    };
  }

  async function confirmAttempt({ id, expectedVersion, actor, request, key }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      if (!actor.warehouseIds.size)
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      const [sales] = await connection.execute(
        `SELECT s.* FROM sales AS s
         JOIN user_warehouses AS uw
           ON uw.warehouse_id = s.warehouse_id AND uw.user_id = ?
         WHERE s.id = ? FOR UPDATE`,
        [actor.user.id, id],
      );
      const sale = sales[0];
      if (!sale)
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      if (!actor.warehouseIds.has(String(sale.warehouse_id)))
        throw new HttpError(
          404,
          "SALE_NOT_FOUND",
          "No se encontró la venta disponible.",
        );
      if (!new Set(["administrator", "seller"]).has(actor.user.role))
        throw new HttpError(
          403,
          "PERMISSION_DENIED",
          "Este rol no puede confirmar ventas.",
        );
      if (
        actor.user.role === "seller" &&
        String(sale.created_by) !== actor.user.id
      )
        throw new HttpError(
          403,
          "SALE_OWNER_REQUIRED",
          "Solo puedes confirmar tus propios borradores.",
        );

      const [saleRequests] = await connection.execute(
        `SELECT operation, request_hash FROM sale_requests
         WHERE actor_id = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [actor.user.id, key],
      );
      if (saleRequests[0])
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "La clave de idempotencia ya fue usada para otra operación.",
        );

      const [priorOperations] = await connection.execute(
        `SELECT id, operation_type, source_type, source_id
         FROM inventory_operations
         WHERE created_by = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [actor.user.id, key],
      );
      const priorOperation = priorOperations[0];
      if (
        priorOperation &&
        (priorOperation.operation_type !== "sale_issue" ||
          priorOperation.source_type !== "sale" ||
          String(priorOperation.source_id) !== String(id))
      )
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "La clave de idempotencia ya fue usada para otra operación.",
        );

      const lines = await getLines(connection, id);
      if (!lines.length)
        throw conflict(
          "SALE_DOCUMENT_INVALID",
          "La venta no contiene productos para confirmar.",
        );
      const expectedVersions = new Map();

      if (priorOperation) {
        const [movements] = await connection.execute(
          `SELECT product_id, warehouse_id, direction, quantity, balance_version
           FROM inventory_movements WHERE operation_id = ? ORDER BY product_id`,
          [priorOperation.id],
        );
        const byProduct = new Map(
          movements.map((movement) => [String(movement.product_id), movement]),
        );
        if (movements.length !== lines.length)
          throw new HttpError(
            500,
            "SALE_INVENTORY_INCONSISTENT",
            "La operación de inventario no coincide con la venta.",
          );
        for (const line of lines) {
          const movement = byProduct.get(String(line.product_id));
          if (
            !movement ||
            movement.direction !== "OUT" ||
            Number(movement.quantity) !== Number(line.quantity) ||
            String(movement.warehouse_id) !== String(sale.warehouse_id)
          )
            throw new HttpError(
              500,
              "SALE_INVENTORY_INCONSISTENT",
              "La operación de inventario no coincide con la venta.",
            );
          expectedVersions.set(
            String(line.product_id),
            (BigInt(movement.balance_version) - 1n).toString(),
          );
        }
        const result = await inventoryEngine.applyWithinTransaction({
          connection,
          userId: actor.user.id,
          idempotencyKey: key,
          payload: confirmationPayload(
            sale,
            lines,
            expectedVersions,
            expectedVersion,
          ),
          internal: true,
          allowSaleIssue: true,
          request,
        });
        if (result.replayed) {
          if (sale.status === "cancelled") {
            const [reversals] = await connection.execute(
              `SELECT sc.id FROM sale_cancellations sc
               JOIN inventory_operations reversal
                 ON reversal.id = sc.source_operation_id
               WHERE sc.sale_id = ?
                 AND reversal.operation_type = 'sale_reversal'
                 AND reversal.source_type = 'sale_cancellation'
               LIMIT 1`,
              [id],
            );
            if (!reversals[0])
              throw new HttpError(
                500,
                "SALE_INVENTORY_INCONSISTENT",
                "Existe un descuento de inventario sin una anulación compensatoria válida.",
              );
            const replayed = await loadSale(connection, id, [
              ...actor.warehouseIds,
            ]);
            await connection.commit();
            return replayed;
          }
          if (sale.status !== "confirmed")
            throw new HttpError(
              500,
              "SALE_INVENTORY_INCONSISTENT",
              "Existe un descuento de inventario sin confirmación documental.",
            );
          const replayed = await loadSale(connection, id, [
            ...actor.warehouseIds,
          ]);
          await connection.commit();
          return replayed;
        }
        throw new HttpError(
          500,
          "SALE_INVENTORY_INCONSISTENT",
          "La operación de inventario no pudo recuperarse de forma idempotente.",
        );
      }

      if (sale.status !== "draft")
        throw conflict(
          "SALE_NOT_CONFIRMABLE",
          "Solo se pueden confirmar ventas en borrador.",
        );
      if (Number(sale.version) !== expectedVersion)
        throw conflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de confirmarlo.",
        );

      const [customers] = await connection.execute(
        "SELECT id, is_active FROM customers WHERE id = ? FOR UPDATE",
        [sale.customer_id],
      );
      if (!customers[0] || !customers[0].is_active)
        throw conflict(
          "SALE_CUSTOMER_INACTIVE",
          "El cliente de la venta está inactivo. Revisa el documento antes de confirmar.",
        );

      for (const line of lines) {
        const [balances] = await connection.execute(
          `SELECT CAST(version AS CHAR) AS version
           FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?`,
          [line.product_id, sale.warehouse_id],
        );
        expectedVersions.set(
          String(line.product_id),
          balances[0]?.version || "0",
        );
      }

      const payload = confirmationPayload(
        sale,
        lines,
        expectedVersions,
        expectedVersion,
      );
      const inventoryResult = await inventoryEngine.applyWithinTransaction({
        connection,
        userId: actor.user.id,
        idempotencyKey: key,
        payload,
        internal: true,
        allowSaleIssue: true,
        request,
        validateProducts: async ({ products }) => {
          let total = 0n;
          for (const line of lines) {
            const product = products.get(String(line.product_id));
            if (!product)
              throw conflict(
                "SALE_PRODUCT_INACTIVE",
                `El producto ${line.product_name_snapshot} ya no está disponible.`,
              );
            if (product.unit !== line.unit_snapshot)
              throw conflict(
                "SALE_PRODUCT_UNIT_CHANGED",
                `La unidad comercial de ${line.product_name_snapshot} cambió. Revisa el borrador.`,
              );
            if (
              product.minimum_sale_enabled &&
              Number(line.quantity) < Number(product.minimum_sale_quantity)
            )
              throw conflict(
                "SALE_MINIMUM_CHANGED",
                `La cantidad mínima vigente para ${line.product_name_snapshot} es ${product.minimum_sale_quantity}. Revisa el borrador.`,
              );
            const unitPrice = cents(line.unit_price);
            const expectedLineTotal = unitPrice * BigInt(line.quantity);
            if (
              unitPrice <= 0n ||
              expectedLineTotal <= 0n ||
              expectedLineTotal !== cents(line.line_total)
            )
              throw conflict(
                "SALE_TOTAL_INCONSISTENT",
                `El precio o subtotal de ${line.product_name_snapshot} no es válido.`,
              );
            total += expectedLineTotal;
          }
          if (total > maxCents)
            throw conflict(
              "SALE_TOTAL_INCONSISTENT",
              "El total de la venta supera el límite permitido.",
            );
        },
      });

      const [updated] = await connection.execute(
        `UPDATE sales SET status = 'confirmed', confirmed_by = ?, confirmed_at = UTC_TIMESTAMP(3),
           updated_by = ?, version = version + 1
         WHERE id = ? AND status = 'draft' AND version = ?`,
        [actor.user.id, actor.user.id, id, expectedVersion],
      );
      if (updated.affectedRows !== 1)
        throw conflict(
          "SALE_VERSION_CONFLICT",
          "La venta cambió. Actualiza el documento antes de confirmarlo.",
        );
      await writeAudit(connection, {
        userId: actor.user.id,
        action: "sales.confirmed",
        saleId: id,
        details: {
          expectedVersion,
          version: expectedVersion + 1,
          sourceOperationId: inventoryResult.operationId,
          warehouseId: String(sale.warehouse_id),
          lineCount: lines.length,
          total: money(totalCents(lines)),
        },
        request,
      });
      const confirmed = await loadSale(connection, id, [...actor.warehouseIds]);
      await connection.commit();
      return confirmed;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function confirm({ id, expectedVersion, actor, request, key }) {
    let attempt = 0;
    while (true) {
      try {
        return await confirmAttempt({
          id,
          expectedVersion,
          actor,
          request,
          key,
        });
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }

  return {
    list,
    getById,
    getReversal,
    getCustomerReturn,
    listCustomerReturns,
    createCustomerReturn,
    getCustomerReturnPdf,
    write,
    confirm,
    reverse,
  };
}
