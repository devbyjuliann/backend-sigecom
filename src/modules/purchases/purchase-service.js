import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";
import { createInventoryEngine } from "../inventory/inventory-engine.js";

const maxQuantity = 4_294_967_295;
const maxTotalCents = BigInt("9".repeat(22));
const sortColumns = {
  number: "po.commercial_code",
  date: "po.order_date",
  supplier: "s.business_name",
  warehouse: "w.name",
  status: "po.status",
  createdAt: "po.created_at",
};

function invalid(message = "Revisa los datos de la orden de compra.") {
  return new HttpError(400, "INVALID_PURCHASE_ORDER", message);
}

function conflict(code, message) {
  return new HttpError(409, code, message);
}

function receiptRequestHash({ orderId, input }) {
  const canonical = {
    orderId,
    expectedVersion: input.expectedVersion,
    reference: input.reference,
    notes: input.notes,
    lines: [...input.lines]
      .map(({ purchaseOrderLineId, quantity }) => ({
        purchaseOrderLineId,
        quantity,
      }))
      .sort((left, right) =>
        BigInt(left.purchaseOrderLineId) < BigInt(right.purchaseOrderLineId)
          ? -1
          : 1,
      ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function closureRequestHash({ orderId, input, userId }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        orderId,
        userId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      }),
    )
    .digest("hex");
}

function supplierReturnRequestHash({ orderId, receiptId, input }) {
  const canonical = {
    orderId,
    receiptId,
    reference: input.reference,
    reason: input.reason,
    lines: [...input.lines]
      .map(({ purchaseReceiptLineId, quantity }) => ({
        purchaseReceiptLineId,
        quantity,
      }))
      .sort((left, right) =>
        BigInt(left.purchaseReceiptLineId) < BigInt(right.purchaseReceiptLineId)
          ? -1
          : BigInt(left.purchaseReceiptLineId) >
              BigInt(right.purchaseReceiptLineId)
            ? 1
            : 0,
      ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function toCents(value) {
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0"));
}

function money(value) {
  return (
    (BigInt(value) / 100n).toString() +
    "." +
    (BigInt(value) % 100n).toString().padStart(2, "0")
  );
}

function document(row, lines = []) {
  const totalCents = lines.reduce(
    (sum, line) => sum + toCents(String(line.line_total)),
    0n,
  );
  return {
    id: String(row.id),
    number: row.commercial_code,
    supplierId: String(row.supplier_id),
    supplierName: row.supplier_name,
    supplierIdentification: row.supplier_identification,
    warehouseId: String(row.warehouse_id),
    warehouseName: row.warehouse_name,
    orderDate: row.order_date,
    reference: row.reference,
    notes: row.notes,
    status: row.status,
    version: Number(row.version),
    closure: row.closed_at
      ? {
          reason: row.closure_reason,
          closedBy: String(row.closed_by),
          closedByName: row.closed_by_name,
          closedAt: row.closed_at,
        }
      : null,
    total: money(totalCents),
    lines: lines.map((line) => ({
      id: String(line.id),
      productId: String(line.product_id),
      sku: line.sku_snapshot,
      name: line.name_snapshot,
      unit: line.unit_snapshot,
      quantity: Number(line.quantity),
      receivedQuantity: Number(line.received_quantity || 0),
      closedQuantity: Number(line.closed_quantity || 0),
      pendingQuantity: Math.max(0, Number(line.pending_quantity)),
      unitCost: String(line.unit_cost),
      lineTotal: String(line.line_total),
    })),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
    confirmedAt: row.confirmed_at,
    cancelledBy: row.cancelled_by === null ? null : String(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const orderSelect = `
  SELECT po.*, DATE_FORMAT(po.order_date, '%Y-%m-%d') AS order_date, s.business_name AS supplier_name,
         s.identification_number AS supplier_identification, w.name AS warehouse_name,
         closure_actor.display_name AS closed_by_name
  FROM purchase_orders AS po
  JOIN suppliers AS s ON s.id = po.supplier_id
  JOIN warehouses AS w ON w.id = po.warehouse_id
  LEFT JOIN users AS closure_actor ON closure_actor.id = po.closed_by`;

async function writeAudit(
  connection,
  { userId, action, orderId, details, request },
) {
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'purchases', 'purchase_order', ?, ?, ?, ?)`,
    [
      userId,
      action,
      String(orderId),
      JSON.stringify(details),
      request?.ip || null,
      request?.get("user-agent")?.slice(0, 512) || null,
    ],
  );
}

async function writeReceiptAudit(
  connection,
  { userId, receiptId, details, request },
) {
  const userAgent = request?.get("user-agent");
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, 'purchases.receipt_confirmed', 'purchases', 'purchase_receipt', ?, ?, ?, ?)`,
    [
      userId,
      String(receiptId),
      JSON.stringify(details),
      request?.ip || null,
      typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    ],
  );
}

async function writeSupplierReturnAudit(
  connection,
  { userId, returnId, details, request },
) {
  const userAgent = request?.get?.("user-agent");
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, 'purchases.return_confirmed', 'purchases', 'supplier_return', ?, ?, ?, ?)`,
    [
      userId,
      String(returnId),
      JSON.stringify(details),
      request?.ip || null,
      typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
    ],
  );
}

export function createPurchaseService({ dbPool }) {
  const inventoryEngine = createInventoryEngine({ dbPool });
  async function ensureWritableWarehouse(
    connection,
    { userId, warehouseId, active = true },
  ) {
    const [rows] = await connection.execute(
      `SELECT w.id, w.is_active FROM warehouses AS w
       JOIN user_warehouses AS uw ON uw.warehouse_id = w.id AND uw.user_id = ?
       WHERE w.id = ? FOR UPDATE`,
      [userId, warehouseId],
    );
    if (!rows[0]) {
      throw new HttpError(
        403,
        "WAREHOUSE_ACCESS_DENIED",
        "No tienes acceso a esta bodega.",
      );
    }
    if (active && !rows[0].is_active) {
      throw invalid("Selecciona una bodega activa y autorizada.");
    }
  }

  async function ensureSupplier(connection, supplierId) {
    const [rows] = await connection.execute(
      "SELECT id, is_active FROM suppliers WHERE id = ? FOR UPDATE",
      [supplierId],
    );
    if (!rows[0] || !rows[0].is_active) {
      throw invalid("Selecciona un proveedor existente y activo.");
    }
  }

  async function readProducts(
    connection,
    lines,
    { requireActive = true } = {},
  ) {
    const ids = lines
      .map(({ productId }) => productId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const products = new Map();
    for (const id of ids) {
      const [rows] = await connection.execute(
        "SELECT id, sku, name, unit, is_active FROM products WHERE id = ? FOR UPDATE",
        [id],
      );
      const product = rows[0];
      if (!product || (requireActive && !product.is_active)) {
        throw invalid("Todos los productos deben existir y estar activos.");
      }
      products.set(String(product.id), product);
    }
    return products;
  }

  function calculateTotal(lines) {
    let total = 0n;
    for (const line of lines) {
      const subtotal = toCents(line.unitCost) * BigInt(line.quantity);
      total += subtotal;
      if (total > maxTotalCents)
        throw invalid("El total de la orden supera el límite permitido.");
    }
    return total;
  }

  async function replaceLines(connection, orderId, lines, products) {
    await connection.execute(
      "UPDATE purchase_order_lines SET is_active = 0 WHERE purchase_order_id = ?",
      [orderId],
    );
    for (const [index, line] of lines.entries()) {
      const product = products.get(line.productId);
      const lineTotal = toCents(line.unitCost) * BigInt(line.quantity);
      const [existingRows] = await connection.execute(
        "SELECT id FROM purchase_order_lines WHERE purchase_order_id = ? AND product_id = ? FOR UPDATE",
        [orderId, line.productId],
      );
      if (existingRows[0]) {
        await connection.execute(
          `UPDATE purchase_order_lines
           SET position = ?, sku_snapshot = ?, name_snapshot = ?, unit_snapshot = ?,
               quantity = ?, unit_cost = ?, line_total = ?, is_active = 1
           WHERE id = ?`,
          [
            index + 1,
            product.sku,
            product.name,
            product.unit,
            line.quantity,
            line.unitCost,
            money(lineTotal),
            existingRows[0].id,
          ],
        );
      } else {
        await connection.execute(
          `INSERT INTO purchase_order_lines
            (purchase_order_id, product_id, position, sku_snapshot, name_snapshot,
             unit_snapshot, quantity, unit_cost, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
            line.productId,
            index + 1,
            product.sku,
            product.name,
            product.unit,
            line.quantity,
            line.unitCost,
            money(lineTotal),
          ],
        );
      }
    }
  }

  async function getById(id, userId) {
    const [rows] = await dbPool.execute(
      `${orderSelect}
       JOIN user_warehouses AS access ON access.warehouse_id = po.warehouse_id AND access.user_id = ?
       WHERE po.id = ? LIMIT 1`,
      [userId, id],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "PURCHASE_ORDER_NOT_FOUND",
        "No se encontró la orden de compra disponible.",
      );
    const lines = await readOrderLines(dbPool, id);
    return document(rows[0], lines);
  }

  async function updateCommercialCode({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT po.id, po.commercial_code, po.version
         FROM purchase_orders AS po
         JOIN user_warehouses AS access
           ON access.warehouse_id = po.warehouse_id AND access.user_id = ?
         WHERE po.id = ? FOR UPDATE`,
        [userId, id],
      );
      const order = rows[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra disponible.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió en otra sesión. Actualiza la información antes de guardar.",
        );
      if (order.commercial_code === input.commercialCode) {
        await connection.commit();
        return getById(id, userId);
      }

      await connection.execute(
        `UPDATE purchase_orders
         SET commercial_code = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [input.commercialCode, userId, id, input.expectedVersion],
      );
      await writeAudit(connection, {
        userId,
        action: "purchases.order_code_changed",
        orderId: id,
        details: {
          previousCode: order.commercial_code,
          commercialCode: input.commercialCode,
        },
        request,
      });
      await connection.commit();
      return getById(id, userId);
    } catch (error) {
      await connection.rollback();
      if (
        error.code === "ER_DUP_ENTRY" &&
        String(error.message).includes("uq_purchase_orders_commercial_code")
      ) {
        throw conflict(
          "PURCHASE_ORDER_CODE_TAKEN",
          "Ese código comercial ya pertenece a otra orden.",
        );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function readOrderLines(connection, orderId, { lock = false } = {}) {
    const [rows] = await connection.execute(
      `SELECT pol.id, pol.product_id, pol.sku_snapshot, pol.name_snapshot,
               pol.unit_snapshot, pol.quantity, pol.unit_cost, pol.line_total,
               COALESCE(SUM(prl.quantity), 0) AS received_quantity,
               CASE WHEN po.closed_at IS NULL THEN 0
                    ELSE GREATEST(pol.quantity - COALESCE(SUM(prl.quantity), 0), 0)
               END AS closed_quantity,
               CASE WHEN po.closed_at IS NULL
                    THEN GREATEST(pol.quantity - COALESCE(SUM(prl.quantity), 0), 0)
                    ELSE 0
               END AS pending_quantity
       FROM purchase_order_lines AS pol
       JOIN purchase_orders AS po ON po.id = pol.purchase_order_id
       LEFT JOIN purchase_receipt_lines AS prl
         ON prl.purchase_order_line_id = pol.id
        AND prl.purchase_order_id = pol.purchase_order_id
       WHERE pol.purchase_order_id = ? AND pol.is_active = 1
        GROUP BY pol.id, po.closed_at
       ORDER BY pol.product_id, pol.id${lock ? " FOR UPDATE" : ""}`,
      [orderId],
    );
    return rows.map(mapOrderLine);
  }

  function mapOrderLine(line) {
    return {
      ...line,
      ordered_quantity: line.quantity,
      received_quantity: Number(line.received_quantity),
      closed_quantity: Number(line.closed_quantity),
      pending_quantity: Number(line.pending_quantity),
    };
  }

  async function readOrderLinesForOrders(connection, orderIds) {
    const linesByOrder = new Map(
      orderIds.map((orderId) => [String(orderId), []]),
    );
    if (!orderIds.length) return linesByOrder;

    const [rows] = await connection.execute(
      `SELECT pol.purchase_order_id, pol.id, pol.product_id,
               pol.sku_snapshot, pol.name_snapshot, pol.unit_snapshot,
               pol.quantity, pol.unit_cost, pol.line_total,
               COALESCE(SUM(prl.quantity), 0) AS received_quantity,
               CASE WHEN po.closed_at IS NULL THEN 0
                    ELSE GREATEST(pol.quantity - COALESCE(SUM(prl.quantity), 0), 0)
               END AS closed_quantity,
               CASE WHEN po.closed_at IS NULL
                    THEN GREATEST(pol.quantity - COALESCE(SUM(prl.quantity), 0), 0)
                    ELSE 0
               END AS pending_quantity
       FROM purchase_order_lines AS pol
       JOIN purchase_orders AS po ON po.id = pol.purchase_order_id
       LEFT JOIN purchase_receipt_lines AS prl
         ON prl.purchase_order_line_id = pol.id
        AND prl.purchase_order_id = pol.purchase_order_id
       WHERE pol.purchase_order_id IN (${orderIds.map(() => "?").join(",")})
         AND pol.is_active = 1
        GROUP BY pol.id, po.closed_at
       ORDER BY pol.purchase_order_id, pol.product_id, pol.id`,
      orderIds,
    );
    for (const line of rows) {
      linesByOrder
        .get(String(line.purchase_order_id))
        ?.push(mapOrderLine(line));
    }
    return linesByOrder;
  }

  function receiptFromRows(header, lines, replayed = false) {
    return {
      id: String(header.id),
      number: `REC-${String(header.id).padStart(6, "0")}`,
      purchaseOrderId: String(header.purchase_order_id),
      purchaseOrderNumber: header.commercial_code,
      reference: header.reference,
      notes: header.notes,
      warehouseId: String(header.warehouse_id),
      warehouseName: header.warehouse_name,
      receivedBy:
        header.received_by === null ? null : String(header.received_by),
      receivedByName: header.received_by_name,
      receivedAt: header.received_at,
      sourceOperationId:
        header.source_operation_id === null
          ? null
          : String(header.source_operation_id),
      replayed,
      lines: lines.map((line) => ({
        id: String(line.id),
        purchaseOrderLineId: String(line.purchase_order_line_id),
        productId: String(line.product_id),
        sku: line.sku_snapshot,
        name: line.name_snapshot,
        unit: line.unit_snapshot,
        orderedQuantity: Number(line.ordered_quantity),
        receivedBefore: Number(line.received_before),
        quantity: Number(line.quantity),
        returnedQuantity: Number(line.returned_quantity || 0),
        returnableQuantity: Math.max(
          0,
          Number(line.quantity) - Number(line.returned_quantity || 0),
        ),
        receivedQuantity: Number(line.received_before) + Number(line.quantity),
        pendingQuantity:
          Number(line.ordered_quantity) -
          Number(line.received_before) -
          Number(line.quantity),
      })),
    };
  }

  async function readReceipt(connection, receiptId, replayed = false) {
    const [headers] = await connection.execute(
      `SELECT receipt.id, receipt.purchase_order_id, receipt.reference,
              receipt.notes, receipt.source_operation_id, receipt.received_by,
              receipt.received_at, po.warehouse_id, po.commercial_code,
              warehouse.name AS warehouse_name,
              user.display_name AS received_by_name
       FROM purchase_receipts AS receipt
       JOIN purchase_orders AS po ON po.id = receipt.purchase_order_id
       JOIN warehouses AS warehouse ON warehouse.id = po.warehouse_id
       JOIN users AS user ON user.id = receipt.received_by
       WHERE receipt.id = ? LIMIT 1`,
      [receiptId],
    );
    if (!headers[0])
      throw new HttpError(
        404,
        "PURCHASE_RECEIPT_NOT_FOUND",
        "No se encontró la recepción.",
      );
    const [lines] = await connection.execute(
      `SELECT receipt_line.id, receipt_line.purchase_order_line_id,
              order_line.product_id, order_line.sku_snapshot,
              order_line.name_snapshot, order_line.unit_snapshot,
               order_line.quantity AS ordered_quantity, receipt_line.quantity,
               COALESCE((SELECT SUM(srl.quantity) FROM supplier_return_lines srl
                 WHERE srl.purchase_receipt_line_id = receipt_line.id), 0) AS returned_quantity,
              COALESCE((
                SELECT SUM(previous_line.quantity)
                FROM purchase_receipt_lines AS previous_line
                JOIN purchase_receipts AS previous_receipt
                  ON previous_receipt.id = previous_line.purchase_receipt_id
                WHERE previous_line.purchase_order_id = receipt_line.purchase_order_id
                  AND previous_line.purchase_order_line_id = receipt_line.purchase_order_line_id
                  AND previous_receipt.id <> receipt_line.purchase_receipt_id
                  AND (previous_receipt.received_at < current_receipt.received_at
                    OR (previous_receipt.received_at = current_receipt.received_at
                      AND previous_receipt.id < current_receipt.id))
              ), 0) AS received_before
       FROM purchase_receipt_lines AS receipt_line
       JOIN purchase_receipts AS current_receipt
         ON current_receipt.id = receipt_line.purchase_receipt_id
       JOIN purchase_order_lines AS order_line
         ON order_line.id = receipt_line.purchase_order_line_id
        AND order_line.purchase_order_id = receipt_line.purchase_order_id
       WHERE receipt_line.purchase_receipt_id = ?
       ORDER BY order_line.position, order_line.id`,
      [receiptId],
    );
    return receiptFromRows(headers[0], lines, replayed);
  }

  async function assertReceiptWarehouseAccess(connection, userId, warehouseId) {
    const [rows] = await connection.execute(
      `SELECT warehouse.id, warehouse.is_active
       FROM warehouses AS warehouse
       JOIN user_warehouses AS assignment
         ON assignment.warehouse_id = warehouse.id AND assignment.user_id = ?
       WHERE warehouse.id = ? LOCK IN SHARE MODE`,
      [userId, warehouseId],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "PURCHASE_ORDER_NOT_FOUND",
        "No se encontró la orden de compra disponible.",
      );
    if (!rows[0].is_active)
      throw conflict(
        "INACTIVE_WAREHOUSE",
        "No se pueden recibir mercancías en una bodega inactiva.",
      );
  }

  async function listReceipts({ orderId, userId }) {
    const order = await getById(orderId, userId);
    const [rows] = await dbPool.execute(
      `SELECT id FROM purchase_receipts
       WHERE purchase_order_id = ? ORDER BY received_at DESC, id DESC`,
      [orderId],
    );
    const items = [];
    for (const row of rows)
      items.push(
        await getReceiptById({ orderId, receiptId: String(row.id), userId }),
      );
    return { orderId: order.id, items };
  }

  async function getReceiptById({ orderId, receiptId, userId }) {
    const [rows] = await dbPool.execute(
      `SELECT receipt.id
       FROM purchase_receipts AS receipt
       JOIN purchase_orders AS po ON po.id = receipt.purchase_order_id
       JOIN user_warehouses AS assignment
         ON assignment.warehouse_id = po.warehouse_id AND assignment.user_id = ?
       WHERE receipt.id = ? AND receipt.purchase_order_id = ? LIMIT 1`,
      [userId, receiptId, orderId],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "PURCHASE_RECEIPT_NOT_FOUND",
        "No se encontró la recepción disponible.",
      );
    return readReceipt(dbPool, receiptId);
  }

  async function readSupplierReturn(connection, returnId, replayed = false) {
    const [headers] = await connection.execute(
      `SELECT sr.*, po.commercial_code, po.warehouse_id, w.name AS warehouse_name,
              receipt.reference AS receipt_reference, receipt.received_at,
              s.business_name AS supplier_name, actor.display_name AS returned_by_name
       FROM supplier_returns sr
       JOIN purchase_orders po ON po.id = sr.purchase_order_id
       JOIN purchase_receipts receipt ON receipt.id = sr.purchase_receipt_id
       JOIN warehouses w ON w.id = po.warehouse_id
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN users actor ON actor.id = sr.returned_by
       WHERE sr.id = ? LIMIT 1`,
      [returnId],
    );
    if (!headers[0])
      throw new HttpError(
        404,
        "SUPPLIER_RETURN_NOT_FOUND",
        "No se encontró la devolución.",
      );
    const [lines] = await connection.execute(
      `SELECT id, purchase_receipt_line_id, purchase_order_line_id,
              product_id, sku_snapshot, name_snapshot, unit_snapshot, quantity
       FROM supplier_return_lines WHERE supplier_return_id = ? ORDER BY id`,
      [returnId],
    );
    const row = headers[0];
    return {
      id: String(row.id),
      number: `DEV-${String(row.id).padStart(6, "0")}`,
      purchaseOrderId: String(row.purchase_order_id),
      purchaseOrderNumber: row.commercial_code,
      purchaseReceiptId: String(row.purchase_receipt_id),
      receiptReference: row.receipt_reference,
      receivedAt: row.received_at,
      supplierName: row.supplier_name,
      warehouseId: String(row.warehouse_id),
      warehouseName: row.warehouse_name,
      reference: row.reference,
      reason: row.reason,
      sourceOperationId:
        row.source_operation_id === null
          ? null
          : String(row.source_operation_id),
      returnedBy: String(row.returned_by),
      returnedByName: row.returned_by_name,
      returnedAt: row.returned_at,
      replayed,
      lines: lines.map((line) => ({
        id: String(line.id),
        purchaseReceiptLineId: String(line.purchase_receipt_line_id),
        purchaseOrderLineId: String(line.purchase_order_line_id),
        productId: String(line.product_id),
        sku: line.sku_snapshot,
        name: line.name_snapshot,
        unit: line.unit_snapshot,
        quantity: Number(line.quantity),
      })),
    };
  }

  async function getSupplierReturn({ orderId, returnId, userId }) {
    const [rows] = await dbPool.execute(
      `SELECT sr.id FROM supplier_returns sr
       JOIN purchase_orders po ON po.id = sr.purchase_order_id
       JOIN user_warehouses access ON access.warehouse_id = po.warehouse_id
         AND access.user_id = ?
       WHERE sr.id = ? AND sr.purchase_order_id = ? LIMIT 1`,
      [userId, returnId, orderId],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "SUPPLIER_RETURN_NOT_FOUND",
        "No se encontró la devolución disponible.",
      );
    return readSupplierReturn(dbPool, returnId);
  }

  async function listSupplierReturns({ orderId, userId }) {
    await getById(orderId, userId);
    const [rows] = await dbPool.execute(
      `SELECT id FROM supplier_returns WHERE purchase_order_id = ? ORDER BY returned_at DESC, id DESC`,
      [orderId],
    );
    const items = [];
    for (const row of rows)
      items.push(await readSupplierReturn(dbPool, String(row.id)));
    return { orderId: String(orderId), items };
  }

  async function createSupplierReturnAttempt({
    orderId,
    receiptId,
    input,
    userId,
    idempotencyKey,
    request,
  }) {
    const requestHash = supplierReturnRequestHash({
      orderId,
      receiptId,
      input,
    });
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute(
        `SELECT po.id, po.warehouse_id FROM purchase_orders po
         JOIN user_warehouses access ON access.warehouse_id = po.warehouse_id AND access.user_id = ?
         WHERE po.id = ? FOR UPDATE`,
        [userId, orderId],
      );
      const order = orders[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden disponible.",
        );
      const [keyRows] = await connection.execute(
        `SELECT id, purchase_order_id, purchase_receipt_id, request_hash
         FROM supplier_returns WHERE returned_by = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [userId, idempotencyKey],
      );
      if (keyRows[0]) {
        const existing = keyRows[0];
        if (
          String(existing.purchase_order_id) !== String(orderId) ||
          String(existing.purchase_receipt_id) !== String(receiptId) ||
          existing.request_hash !== requestHash
        )
          throw conflict(
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otros datos.",
          );
        const result = await readSupplierReturn(
          connection,
          String(existing.id),
          true,
        );
        await connection.commit();
        return result;
      }
      const [receipts] = await connection.execute(
        "SELECT id FROM purchase_receipts WHERE id = ? AND purchase_order_id = ? FOR UPDATE",
        [receiptId, orderId],
      );
      if (!receipts[0])
        throw new HttpError(
          404,
          "PURCHASE_RECEIPT_NOT_FOUND",
          "No se encontró la recepción de esta orden.",
        );
      const [warehouses] = await connection.execute(
        `SELECT w.id, w.is_active FROM warehouses w
         JOIN user_warehouses access ON access.warehouse_id = w.id AND access.user_id = ?
         WHERE w.id = ? LOCK IN SHARE MODE`,
        [userId, order.warehouse_id],
      );
      if (!warehouses[0])
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden disponible.",
        );
      if (!warehouses[0].is_active)
        throw conflict(
          "INACTIVE_WAREHOUSE",
          "No se pueden devolver mercancías desde una bodega inactiva.",
        );
      const [receiptLines] = await connection.execute(
        `SELECT rl.id, rl.purchase_order_line_id, rl.quantity AS received_quantity,
                pol.product_id, pol.sku_snapshot, pol.name_snapshot, pol.unit_snapshot,
                COALESCE((SELECT SUM(srl.quantity) FROM supplier_return_lines srl WHERE srl.purchase_receipt_line_id = rl.id), 0) AS returned_quantity
         FROM purchase_receipt_lines rl
         JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id AND pol.purchase_order_id = rl.purchase_order_id
         WHERE rl.purchase_receipt_id = ? ORDER BY rl.id FOR UPDATE`,
        [receiptId],
      );
      const byId = new Map(receiptLines.map((line) => [String(line.id), line]));
      const selected = input.lines.map((line) => {
        const source = byId.get(line.purchaseReceiptLineId);
        if (!source)
          throw invalid("Una línea no pertenece a la recepción seleccionada.");
        const available =
          Number(source.received_quantity) - Number(source.returned_quantity);
        if (line.quantity > available)
          throw conflict(
            "RETURN_QUANTITY_EXCEEDED",
            `La cantidad disponible para devolver de ${source.name_snapshot} es ${available}.`,
          );
        return { ...line, source };
      });
      const [products] = await connection.execute(
        `SELECT id, is_active, unit FROM products WHERE id IN (${selected.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`,
        selected.map(({ source }) => source.product_id),
      );
      const productById = new Map(
        products.map((product) => [String(product.id), product]),
      );
      for (const { source } of selected) {
        const product = productById.get(String(source.product_id));
        if (!product?.is_active)
          throw conflict(
            "INACTIVE_PRODUCT",
            `El producto ${source.name_snapshot} está inactivo y no puede devolverse.`,
          );
        if (product.unit !== source.unit_snapshot)
          throw conflict(
            "PURCHASE_PRODUCT_UNIT_CHANGED",
            `La unidad de ${source.name_snapshot} no coincide con la recepción.`,
          );
      }
      const [duplicates] = await connection.execute(
        "SELECT id FROM supplier_returns WHERE purchase_receipt_id = ? AND reference = ? LIMIT 1 FOR UPDATE",
        [receiptId, input.reference],
      );
      if (duplicates.length)
        throw conflict(
          "DUPLICATE_RETURN_REFERENCE",
          "Esta referencia ya se registró para la recepción.",
        );
      const [insert] = await connection.execute(
        `INSERT INTO supplier_returns (purchase_order_id, purchase_receipt_id, reference, reason, idempotency_key, request_hash, returned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          receiptId,
          input.reference,
          input.reason,
          idempotencyKey,
          requestHash,
          userId,
        ],
      );
      const returnId = String(insert.insertId);
      for (const { source, quantity } of selected) {
        await connection.execute(
          `INSERT INTO supplier_return_lines (supplier_return_id, purchase_order_id, purchase_receipt_id, purchase_receipt_line_id, purchase_order_line_id, product_id, sku_snapshot, name_snapshot, unit_snapshot, quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            returnId,
            orderId,
            receiptId,
            source.id,
            source.purchase_order_line_id,
            source.product_id,
            source.sku_snapshot,
            source.name_snapshot,
            source.unit_snapshot,
            quantity,
          ],
        );
      }
      const inventoryLines = [];
      for (const { source, quantity } of selected) {
        const [balances] = await connection.execute(
          "SELECT CAST(version AS CHAR) AS version, quantity FROM inventory_balances WHERE product_id = ? AND warehouse_id = ? FOR UPDATE",
          [source.product_id, order.warehouse_id],
        );
        const balance = balances[0];
        if (!balance || Number(balance.quantity) < quantity)
          throw conflict(
            "INSUFFICIENT_STOCK",
            `No hay existencias suficientes de ${source.name_snapshot} en la bodega original.`,
          );
        inventoryLines.push({
          productId: String(source.product_id),
          quantity,
          expectedVersion: String(balance.version),
        });
      }
      const operation = await inventoryEngine.applyWithinTransaction({
        connection,
        userId,
        idempotencyKey,
        payload: {
          type: "supplier_return",
          sourceWarehouseId: String(order.warehouse_id),
          destinationWarehouseId: null,
          sourceType: "supplier_return",
          sourceId: returnId,
          reason: input.reason,
          reference: input.reference,
          lines: inventoryLines,
        },
        internal: true,
        request,
      });
      await connection.execute(
        "UPDATE supplier_returns SET source_operation_id = ? WHERE id = ?",
        [operation.operationId, returnId],
      );
      await connection.execute(
        "UPDATE purchase_orders SET version = version + 1, updated_by = ? WHERE id = ?",
        [userId, orderId],
      );
      await writeSupplierReturnAudit(connection, {
        userId,
        returnId,
        details: {
          orderId,
          receiptId,
          reference: input.reference,
          sourceOperationId: operation.operationId,
          lines: selected.map(({ source, quantity }) => ({
            receiptLineId: String(source.id),
            productId: String(source.product_id),
            quantity,
          })),
        },
        request,
      });
      const result = await readSupplierReturn(connection, returnId);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (error.code === "ER_DUP_ENTRY") {
        if (
          String(error.message).includes(
            "uq_supplier_returns_receipt_reference",
          )
        )
          throw conflict(
            "DUPLICATE_RETURN_REFERENCE",
            "Esta referencia ya se registró para la recepción.",
          );
        if (
          String(error.message).includes(
            "uq_supplier_returns_actor_idempotency",
          )
        )
          throw conflict(
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otros datos.",
          );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function createSupplierReturn(args) {
    let attempt = 0;
    while (true) {
      try {
        return await createSupplierReturnAttempt(args);
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, 15 * 2 ** (attempt - 1)),
        );
      }
    }
  }

  async function receiveAttempt({
    orderId,
    input,
    userId,
    idempotencyKey,
    request,
  }) {
    const requestHash = receiptRequestHash({ orderId, input });
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute(
        "SELECT id, warehouse_id, status, version FROM purchase_orders WHERE id = ? FOR UPDATE",
        [orderId],
      );
      const order = orders[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra.",
        );
      await assertReceiptWarehouseAccess(
        connection,
        userId,
        String(order.warehouse_id),
      );

      const [previousReceipts] = await connection.execute(
        `SELECT id, request_hash FROM purchase_receipts
         WHERE received_by = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [userId, idempotencyKey],
      );
      if (previousReceipts[0]) {
        if (previousReceipts[0].request_hash !== requestHash)
          throw conflict(
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otros datos.",
          );
        const result = await readReceipt(
          connection,
          String(previousReceipts[0].id),
          true,
        );
        await connection.commit();
        return result;
      }

      if (order.status !== "confirmed")
        throw conflict(
          "PURCHASE_ORDER_NOT_RECEIVABLE",
          "Solo se reciben órdenes confirmadas.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió. Actualiza sus cantidades pendientes antes de recibir.",
        );

      const orderLines = await readOrderLines(connection, orderId, {
        lock: true,
      });
      const orderLinesById = new Map(
        orderLines.map((line) => [String(line.id), line]),
      );
      const selectedLines = input.lines.map((line) => {
        const orderLine = orderLinesById.get(line.purchaseOrderLineId);
        if (!orderLine)
          throw invalid(
            "Una de las líneas no pertenece a esta orden confirmada.",
          );
        if (line.quantity > orderLine.pending_quantity)
          throw conflict(
            "PURCHASE_RECEIPT_EXCEEDS_PENDING",
            `La cantidad supera lo pendiente para ${orderLine.name_snapshot}.`,
          );
        return { ...line, orderLine };
      });

      const [products] = await connection.execute(
        `SELECT id, unit, is_active FROM products
         WHERE id IN (${selectedLines.map(() => "?").join(",")})
         ORDER BY id FOR UPDATE`,
        selectedLines.map(({ orderLine }) => orderLine.product_id),
      );
      const productById = new Map(
        products.map((product) => [String(product.id), product]),
      );
      for (const { orderLine } of selectedLines) {
        const product = productById.get(String(orderLine.product_id));
        if (!product || !product.is_active)
          throw conflict(
            "INACTIVE_PRODUCT",
            `El producto ${orderLine.name_snapshot} está inactivo y no puede recibirse.`,
          );
        if (product.unit !== orderLine.unit_snapshot)
          throw conflict(
            "PURCHASE_PRODUCT_UNIT_CHANGED",
            `La unidad de ${orderLine.name_snapshot} no coincide con la orden confirmada.`,
          );
      }

      const [duplicateReferences] = await connection.execute(
        "SELECT id FROM purchase_receipts WHERE purchase_order_id = ? AND reference = ? LIMIT 1 FOR UPDATE",
        [orderId, input.reference],
      );
      if (duplicateReferences.length)
        throw conflict(
          "DUPLICATE_RECEIPT_REFERENCE",
          "Esta referencia de entrega ya se registró para la orden.",
        );

      await connection.execute(
        `INSERT INTO purchase_receipts
          (purchase_order_id, reference, notes, idempotency_key, request_hash, received_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          input.reference,
          input.notes,
          idempotencyKey,
          requestHash,
          userId,
        ],
      );
      const [[receiptIdentity]] = await connection.query(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
      );
      const receiptId = receiptIdentity.id;
      for (const { purchaseOrderLineId, quantity } of selectedLines) {
        await connection.execute(
          `INSERT INTO purchase_receipt_lines
            (purchase_receipt_id, purchase_order_id, purchase_order_line_id, quantity)
           VALUES (?, ?, ?, ?)`,
          [receiptId, orderId, purchaseOrderLineId, quantity],
        );
      }

      const inventoryLines = [];
      for (const {
        purchaseOrderLineId,
        quantity,
        orderLine,
      } of selectedLines) {
        const [balances] = await connection.execute(
          `SELECT CAST(version AS CHAR) AS version FROM inventory_balances
           WHERE product_id = ? AND warehouse_id = ? LIMIT 1`,
          [orderLine.product_id, order.warehouse_id],
        );
        inventoryLines.push({
          productId: String(orderLine.product_id),
          quantity,
          expectedVersion: balances[0]?.version || "0",
          purchaseOrderLineId,
        });
      }
      const operation = await inventoryEngine.applyWithinTransaction({
        connection,
        userId,
        idempotencyKey,
        payload: {
          type: "purchase_receipt",
          sourceWarehouseId: String(order.warehouse_id),
          destinationWarehouseId: null,
          sourceType: "purchase_receipt",
          sourceId: receiptId,
          reason: `Recepción de orden OC-${String(orderId).padStart(6, "0")}`,
          reference: input.reference,
          lines: inventoryLines,
        },
        internal: true,
        request,
      });
      await connection.execute(
        "UPDATE purchase_receipts SET source_operation_id = ? WHERE id = ?",
        [operation.operationId, receiptId],
      );
      await connection.execute(
        "UPDATE purchase_orders SET version = version + 1, updated_by = ? WHERE id = ? AND version = ?",
        [userId, orderId, input.expectedVersion],
      );
      await writeReceiptAudit(connection, {
        userId,
        receiptId,
        details: {
          orderId,
          receiptId,
          reference: input.reference,
          sourceOperationId: operation.operationId,
          lineCount: selectedLines.length,
          receivedQuantity: selectedLines.reduce(
            (sum, line) => sum + line.quantity,
            0,
          ),
        },
        request,
      });
      const result = await readReceipt(connection, receiptId, false);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (error.code === "ER_DUP_ENTRY") {
        if (
          String(error.message).includes("uq_purchase_receipts_order_reference")
        )
          throw conflict(
            "DUPLICATE_RECEIPT_REFERENCE",
            "Esta referencia de entrega ya se registró para la orden.",
          );
        if (String(error.message).includes("uq_purchase_receipts_actor_key"))
          throw conflict(
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otra recepción.",
          );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function receive({ orderId, input, userId, idempotencyKey, request }) {
    let attempt = 0;
    while (true) {
      try {
        return await receiveAttempt({
          orderId,
          input,
          userId,
          idempotencyKey,
          request,
        });
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, 15 * 2 ** (attempt - 1)),
        );
      }
    }
  }

  async function closeAttempt({
    orderId,
    input,
    userId,
    idempotencyKey,
    request,
  }) {
    const requestHash = closureRequestHash({ orderId, input, userId });
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute(
        `SELECT id, warehouse_id, status, version, closed_by,
                closure_request_hash
         FROM purchase_orders WHERE id = ? FOR UPDATE`,
        [orderId],
      );
      const order = orders[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra.",
        );

      const [assignments] = await connection.execute(
        `SELECT 1 FROM user_warehouses
         WHERE user_id = ? AND warehouse_id = ? LOCK IN SHARE MODE`,
        [userId, order.warehouse_id],
      );
      if (!assignments[0])
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra disponible.",
        );

      const [keyUses] = await connection.execute(
        `SELECT id, id AS purchase_order_id, closed_by, closure_request_hash
         FROM purchase_orders
         WHERE closure_idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [idempotencyKey],
      );
      if (keyUses[0]) {
        const previous = keyUses[0];
        if (
          String(previous.id) !== String(orderId) ||
          String(previous.closed_by) !== String(userId) ||
          previous.closure_request_hash !== requestHash
        )
          throw conflict(
            "IDEMPOTENCY_CONFLICT",
            "La clave de idempotencia ya se utilizó con otros datos.",
          );
        await connection.commit();
        return { ...(await getById(orderId, userId)), replayed: true };
      }

      if (order.status !== "confirmed")
        throw conflict(
          "PURCHASE_ORDER_NOT_CLOSABLE",
          "Solo se pueden cerrar órdenes confirmadas.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió. Actualiza sus cantidades antes de cerrar el remanente.",
        );
      if (order.closed_by !== null)
        throw conflict(
          "PURCHASE_ORDER_ALREADY_CLOSED",
          "Las cantidades pendientes de esta orden ya se cerraron.",
        );

      const lines = await readOrderLines(connection, orderId, { lock: true });
      const [[receiptCount]] = await connection.execute(
        "SELECT COUNT(*) AS total FROM purchase_receipts WHERE purchase_order_id = ?",
        [orderId],
      );
      if (Number(receiptCount.total) === 0)
        throw conflict(
          "PURCHASE_ORDER_HAS_NO_RECEIPTS",
          "Las órdenes sin recepciones deben cancelarse mediante la acción existente.",
        );
      const pendingLines = lines.filter((line) => line.pending_quantity > 0);
      if (!pendingLines.length)
        throw conflict(
          "PURCHASE_ORDER_HAS_NO_PENDING_QUANTITY",
          "La orden no tiene cantidades pendientes para cerrar.",
        );

      await connection.execute(
        `UPDATE purchase_orders
         SET closure_reason = ?, closed_by = ?, closed_at = UTC_TIMESTAMP(3),
             closure_idempotency_key = ?, closure_request_hash = ?,
             updated_by = ?, version = version + 1
         WHERE id = ? AND version = ? AND closed_by IS NULL`,
        [
          input.reason,
          userId,
          idempotencyKey,
          requestHash,
          userId,
          orderId,
          input.expectedVersion,
        ],
      );
      await writeAudit(connection, {
        userId,
        action: "purchases.order_closed",
        orderId,
        details: {
          reason: input.reason,
          lineCount: pendingLines.length,
          closedLines: pendingLines.map((line) => ({
            lineId: String(line.id),
            quantity: line.pending_quantity,
            unit: line.unit_snapshot,
          })),
        },
        request,
      });
      await connection.commit();
      return { ...(await getById(orderId, userId)), replayed: false };
    } catch (error) {
      await connection.rollback();
      if (
        error.code === "ER_DUP_ENTRY" &&
        String(error.message).includes(
          "uq_purchase_orders_closure_idempotency_key",
        )
      )
        throw conflict(
          "IDEMPOTENCY_CONFLICT",
          "La clave de idempotencia ya se utilizó con otros datos.",
        );
      throw error;
    } finally {
      connection.release();
    }
  }

  async function close({ orderId, input, userId, idempotencyKey, request }) {
    let attempt = 0;
    while (true) {
      try {
        return await closeAttempt({
          orderId,
          input,
          userId,
          idempotencyKey,
          request,
        });
      } catch (error) {
        if (![1213, 1205].includes(error.errno) || attempt >= 2) throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, 15 * 2 ** (attempt - 1)),
        );
      }
    }
  }

  async function list({
    warehouseIds,
    page,
    pageSize,
    query,
    status,
    supplierId,
    warehouseId,
    dateFrom,
    dateTo,
    sortBy,
    sortOrder,
  }) {
    if (!warehouseIds.length)
      return {
        items: [],
        pagination: { page, pageSize, total: 0, pageCount: 0 },
      };
    const filters = [
      `po.warehouse_id IN (${warehouseIds.map(() => "?").join(",")})`,
    ];
    const values = [...warehouseIds];
    if (status !== "all") {
      filters.push("po.status = ?");
      values.push(status);
    }
    if (supplierId) {
      filters.push("po.supplier_id = ?");
      values.push(supplierId);
    }
    if (warehouseId) {
      filters.push("po.warehouse_id = ?");
      values.push(warehouseId);
    }
    if (dateFrom) {
      filters.push("po.order_date >= ?");
      values.push(dateFrom);
    }
    if (dateTo) {
      filters.push("po.order_date <= ?");
      values.push(dateTo);
    }
    if (query) {
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      filters.push(
        "(po.commercial_code LIKE ? OR CAST(po.id AS CHAR) LIKE ? OR s.business_name LIKE ? OR po.reference LIKE ?)",
      );
      values.push(...Array(4).fill(`%${escaped}%`));
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const [[count]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${where}`,
      values,
    );
    const [rows] = await dbPool.execute(
      `${orderSelect} ${where}
       ORDER BY ${sortColumns[sortBy]} ${sortOrder === "desc" ? "DESC" : "ASC"}, po.id DESC
       LIMIT ? OFFSET ?`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const orderIds = rows.map((row) => String(row.id));
    const linesByOrder = await readOrderLinesForOrders(dbPool, orderIds);
    const items = rows.map((row) =>
      document(row, linesByOrder.get(String(row.id)) || []),
    );
    const total = Number(count.total);
    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function create({ input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      await ensureSupplier(connection, input.supplierId);
      await ensureWritableWarehouse(connection, {
        userId,
        warehouseId: input.warehouseId,
      });
      const products = await readProducts(connection, input.lines);
      calculateTotal(input.lines);
      const [result] = await connection.execute(
        `INSERT INTO purchase_orders (commercial_code, supplier_id, warehouse_id, order_date, reference, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `TMP-${randomUUID().toUpperCase()}`,
          input.supplierId,
          input.warehouseId,
          input.orderDate,
          input.reference,
          input.notes,
          userId,
          userId,
        ],
      );
      const id = String(result.insertId);
      await connection.execute(
        "UPDATE purchase_orders SET commercial_code = ? WHERE id = ?",
        [`OC-${id.padStart(6, "0")}`, id],
      );
      await replaceLines(connection, id, input.lines, products);
      await writeAudit(connection, {
        userId,
        action: "purchases.order_created",
        orderId: id,
        details: { status: "draft", lineCount: input.lines.length },
        request,
      });
      await connection.commit();
      return getById(id, userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function update({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE",
        [id],
      );
      const order = rows[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió en otra sesión. Actualiza la información antes de guardar.",
        );
      if (order.status !== "draft")
        throw conflict(
          "PURCHASE_ORDER_NOT_EDITABLE",
          "Solo se pueden editar órdenes en borrador.",
        );
      await ensureSupplier(connection, input.supplierId);
      await ensureWritableWarehouse(connection, {
        userId,
        warehouseId: input.warehouseId,
      });
      const products = await readProducts(connection, input.lines);
      calculateTotal(input.lines);
      await connection.execute(
        `UPDATE purchase_orders SET supplier_id = ?, warehouse_id = ?, order_date = ?, reference = ?, notes = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [
          input.supplierId,
          input.warehouseId,
          input.orderDate,
          input.reference,
          input.notes,
          userId,
          id,
          input.expectedVersion,
        ],
      );
      await replaceLines(connection, id, input.lines, products);
      await writeAudit(connection, {
        userId,
        action: "purchases.order_updated",
        orderId: id,
        details: { status: "draft", lineCount: input.lines.length },
        request,
      });
      await connection.commit();
      return getById(id, userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function confirm({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE",
        [id],
      );
      const order = rows[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió en otra sesión. Actualiza la información antes de confirmar.",
        );
      if (order.status !== "draft")
        throw conflict(
          "PURCHASE_ORDER_NOT_CONFIRMABLE",
          "Solo se pueden confirmar órdenes en borrador.",
        );
      await ensureSupplier(connection, order.supplier_id);
      await ensureWritableWarehouse(connection, {
        userId,
        warehouseId: String(order.warehouse_id),
      });
      const [lines] = await connection.execute(
        "SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? AND is_active = 1 ORDER BY product_id FOR UPDATE",
        [id],
      );
      if (!lines.length)
        throw invalid("Agrega al menos un producto antes de confirmar.");
      const zeroCostLines = lines.filter(
        (line) => toCents(String(line.unit_cost)) === 0n,
      );
      if (zeroCostLines.length && !input.confirmZeroCost)
        throw conflict(
          "ZERO_COST_CONFIRMATION_REQUIRED",
          "La orden contiene productos con costo cero. Revisa y confirma expresamente esos costos.",
        );
      for (const line of lines) {
        const [products] = await connection.execute(
          "SELECT is_active, unit FROM products WHERE id = ? FOR UPDATE",
          [line.product_id],
        );
        if (!products[0]?.is_active || products[0].unit !== line.unit_snapshot)
          throw conflict(
            "PURCHASE_PRODUCT_CHANGED",
            "Un producto está inactivo o cambió su unidad desde la creación del borrador.",
          );
      }
      await connection.execute(
        `UPDATE purchase_orders SET status = 'confirmed', confirmed_by = ?, confirmed_at = UTC_TIMESTAMP(3), updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [userId, userId, id, input.expectedVersion],
      );
      await writeAudit(connection, {
        userId,
        action: "purchases.order_confirmed",
        orderId: id,
        details: {
          lineCount: lines.length,
          zeroCostLineCount: zeroCostLines.length,
        },
        request,
      });
      await connection.commit();
      return getById(id, userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function cancel({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE",
        [id],
      );
      const order = rows[0];
      if (!order)
        throw new HttpError(
          404,
          "PURCHASE_ORDER_NOT_FOUND",
          "No se encontró la orden de compra.",
        );
      if (Number(order.version) !== input.expectedVersion)
        throw conflict(
          "PURCHASE_ORDER_VERSION_CONFLICT",
          "La orden cambió en otra sesión. Actualiza la información antes de cancelar.",
        );
      if (!["draft", "confirmed"].includes(order.status))
        throw conflict(
          "PURCHASE_ORDER_NOT_CANCELLABLE",
          "La orden ya está cancelada.",
        );
      await ensureWritableWarehouse(connection, {
        userId,
        warehouseId: String(order.warehouse_id),
        active: false,
      });
      const [[receiptCount]] = await connection.execute(
        "SELECT COUNT(*) AS total FROM purchase_receipts WHERE purchase_order_id = ?",
        [id],
      );
      if (Number(receiptCount.total) > 0)
        throw conflict(
          "PURCHASE_ORDER_HAS_RECEIPTS",
          "No se puede cancelar una orden que ya tiene recepciones.",
        );
      await connection.execute(
        `UPDATE purchase_orders SET status = 'cancelled', cancelled_by = ?, cancelled_at = UTC_TIMESTAMP(3), cancellation_reason = ?, updated_by = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [userId, input.reason, userId, id, input.expectedVersion],
      );
      await writeAudit(connection, {
        userId,
        action: "purchases.order_cancelled",
        orderId: id,
        details: { previousStatus: order.status, reason: input.reason },
        request,
      });
      await connection.commit();
      return getById(id, userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return {
    list,
    getById,
    updateCommercialCode,
    create,
    update,
    confirm,
    cancel,
    listReceipts,
    getReceiptById,
    createSupplierReturn,
    listSupplierReturns,
    getSupplierReturn,
    receive,
    close,
  };
}

export { maxQuantity };
