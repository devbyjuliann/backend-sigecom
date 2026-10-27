import { HttpError } from "../../shared/http-error.js";

const balanceSortColumns = {
  sku: "p.sku",
  product: "p.name",
  warehouse: "w.name",
  quantity: "ib.quantity",
  minimumStock: "p.minimum_stock",
  status: "p.is_active",
};
const movementSortColumns = {
  createdAt: "im.created_at",
  product: "p.name",
  warehouse: "w.name",
  quantity: "im.quantity",
  type: "io.operation_type",
};

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function pagination(page, pageSize, total) {
  return { page, pageSize, total, pageCount: Math.ceil(total / pageSize) };
}

function balanceFromRow(row) {
  const hasBalance = row.balance_id !== null;
  const quantity = hasBalance ? Number(row.quantity) : null;
  const minimumStock = Number(row.minimum_stock);
  return {
    productId: String(row.product_id),
    sku: row.sku,
    productName: row.product_name,
    categoryId: String(row.category_id),
    categoryName: row.category_name,
    unit: row.unit,
    productIsActive: Boolean(row.product_is_active),
    warehouseId: String(row.warehouse_id),
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    warehouseIsActive: Boolean(row.warehouse_is_active),
    hasBalance,
    quantity,
    minimumStock,
    isLowStock: hasBalance && minimumStock > 0 && quantity < minimumStock,
    updatedAt: row.balance_updated_at,
  };
}

function movementFromRow(row) {
  const canSeeAllWarehouses = Boolean(row.can_see_all_warehouses);
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    operationType: row.operation_type,
    reason: row.reason,
    reference: row.reference,
    sourceWarehouseId:
      canSeeAllWarehouses && row.source_warehouse_id !== null
        ? String(row.source_warehouse_id)
        : null,
    destinationWarehouseId:
      canSeeAllWarehouses && row.destination_warehouse_id !== null
        ? String(row.destination_warehouse_id)
        : null,
    productId: String(row.product_id),
    sku: row.sku,
    productName: row.product_name,
    warehouseId: String(row.warehouse_id),
    warehouseName: row.warehouse_name,
    direction: row.direction,
    quantity: Number(row.quantity),
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    balanceVersion: String(row.balance_version),
    unit: row.unit_snapshot,
    responsibleUserId: String(row.created_by),
    responsibleName: row.responsible_name,
    createdAt: row.operation_created_at,
  };
}

const movementSelect = `
  SELECT im.id, im.operation_id, io.operation_type, io.reason, io.reference,
         io.source_warehouse_id, io.destination_warehouse_id,
         io.created_by, io.created_at AS operation_created_at,
         responsible.display_name AS responsible_name,
         im.product_id, p.sku, p.name AS product_name, im.warehouse_id,
         w.name AS warehouse_name, im.direction, im.quantity,
         im.balance_before, im.balance_after, im.balance_version,
         im.unit_snapshot,
         CASE
           WHEN io.destination_warehouse_id IS NULL THEN 1
           WHEN EXISTS (
             SELECT 1 FROM user_warehouses access_source
             WHERE access_source.user_id = ?
               AND access_source.warehouse_id = io.source_warehouse_id
           ) AND EXISTS (
             SELECT 1 FROM user_warehouses access_destination
             WHERE access_destination.user_id = ?
               AND access_destination.warehouse_id = io.destination_warehouse_id
           ) THEN 1 ELSE 0
         END AS can_see_all_warehouses
  FROM inventory_movements im
  JOIN inventory_operations io ON io.id = im.operation_id
  JOIN products p ON p.id = im.product_id
  JOIN warehouses w ON w.id = im.warehouse_id
  JOIN users responsible ON responsible.id = io.created_by`;

export function createInventoryService({ dbPool }) {
  async function assertAssignedWarehouse(userId, warehouseId) {
    if (!warehouseId) return;
    const [rows] = await dbPool.execute(
      `SELECT 1 FROM user_warehouses
       WHERE user_id = ? AND warehouse_id = ? LIMIT 1`,
      [userId, warehouseId],
    );
    if (!rows.length) {
      throw new HttpError(
        404,
        "WAREHOUSE_NOT_FOUND",
        "No se encontró la bodega autorizada.",
      );
    }
  }

  function balanceFilters({
    userId,
    query,
    warehouseId,
    categoryId,
    productStatus,
    warehouseStatus,
    stockStatus,
  }) {
    const clauses = ["uw.user_id = ?"];
    const values = [userId];
    if (warehouseId) {
      clauses.push("w.id = ?");
      values.push(warehouseId);
    }
    if (categoryId) {
      clauses.push("p.category_id = ?");
      values.push(categoryId);
    }
    if (productStatus !== "all") {
      clauses.push("p.is_active = ?");
      values.push(productStatus === "active" ? 1 : 0);
    }
    if (warehouseStatus !== "all") {
      clauses.push("w.is_active = ?");
      values.push(warehouseStatus === "active" ? 1 : 0);
    }
    if (query) {
      const term = `%${escapeLike(query)}%`;
      clauses.push(
        "(p.sku LIKE ? ESCAPE '\\\\' OR p.name LIKE ? ESCAPE '\\\\')",
      );
      values.push(term, term);
    }
    if (stockStatus === "low") {
      clauses.push(
        "ib.id IS NOT NULL AND p.minimum_stock > 0 AND ib.quantity < p.minimum_stock",
      );
    } else if (stockStatus === "zero") {
      clauses.push("ib.id IS NOT NULL AND ib.quantity = 0");
    } else if (stockStatus === "unregistered") {
      clauses.push("ib.id IS NULL");
    }
    return { where: clauses.join(" AND "), values };
  }

  async function listBalances(filters) {
    const { userId, page, pageSize, sortBy, sortOrder } = filters;
    await assertAssignedWarehouse(userId, filters.warehouseId);
    const { where, values } = balanceFilters(filters);
    const from = `
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN warehouses w
      JOIN user_warehouses uw ON uw.warehouse_id = w.id
      LEFT JOIN inventory_balances ib
        ON ib.product_id = p.id AND ib.warehouse_id = w.id
      WHERE ${where}`;
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total ${from}`,
      values,
    );
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `SELECT p.id AS product_id, p.sku, p.name AS product_name,
              p.category_id, c.name AS category_name, p.unit,
              p.is_active AS product_is_active, p.minimum_stock,
              w.id AS warehouse_id, w.code AS warehouse_code,
              w.name AS warehouse_name, w.is_active AS warehouse_is_active,
              ib.id AS balance_id, ib.quantity, ib.updated_at AS balance_updated_at
       ${from}
       ORDER BY ${balanceSortColumns[sortBy]} ${direction}, p.id, w.id
       LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    const total = Number(countRow.total);
    return {
      items: rows.map(balanceFromRow),
      pagination: pagination(page, pageSize, total),
    };
  }

  async function listTotals(filters) {
    const { userId, page, pageSize, stockStatus } = filters;
    await assertAssignedWarehouse(userId, filters.warehouseId);
    const { where, values } = balanceFilters({
      ...filters,
      stockStatus: "all",
    });
    const from = `
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN warehouses w
      JOIN user_warehouses uw ON uw.warehouse_id = w.id
      LEFT JOIN inventory_balances ib
        ON ib.product_id = p.id AND ib.warehouse_id = w.id
      WHERE ${where}`;
    const having =
      stockStatus === "low"
        ? "HAVING SUM(ib.id IS NOT NULL AND p.minimum_stock > 0 AND ib.quantity < p.minimum_stock) > 0"
        : stockStatus === "zero"
          ? "HAVING SUM(ib.id IS NOT NULL AND ib.quantity = 0) > 0"
          : stockStatus === "unregistered"
            ? "HAVING SUM(ib.id IS NULL) > 0"
            : "";
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM (
         SELECT p.id ${from} GROUP BY p.id ${having}
       ) AS grouped_products`,
      values,
    );
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `SELECT p.id AS product_id, p.sku, p.name AS product_name,
              p.category_id, c.name AS category_name, p.unit,
              p.is_active AS product_is_active, p.minimum_stock,
              COUNT(w.id) AS authorized_warehouse_count,
              COUNT(ib.id) AS registered_balance_count,
              COALESCE(SUM(ib.quantity), 0) AS total_quantity,
              SUM(ib.id IS NOT NULL AND p.minimum_stock > 0 AND ib.quantity < p.minimum_stock) AS low_stock_warehouse_count,
              SUM(ib.id IS NOT NULL AND ib.quantity = 0) AS zero_balance_count
       ${from}
       GROUP BY p.id, p.sku, p.name, p.category_id, c.name, p.unit,
                p.is_active, p.minimum_stock
       ${having}
       ORDER BY p.name, p.id
       LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    const total = Number(countRow.total);
    return {
      items: rows.map((row) => ({
        productId: String(row.product_id),
        sku: row.sku,
        productName: row.product_name,
        categoryId: String(row.category_id),
        categoryName: row.category_name,
        unit: row.unit,
        productIsActive: Boolean(row.product_is_active),
        minimumStockPerWarehouse: Number(row.minimum_stock),
        authorizedWarehouseCount: Number(row.authorized_warehouse_count),
        registeredBalanceCount: Number(row.registered_balance_count),
        hasRegisteredBalances: Number(row.registered_balance_count) > 0,
        totalQuantity: Number(row.total_quantity),
        lowStockWarehouseCount: Number(row.low_stock_warehouse_count),
        zeroBalanceCount: Number(row.zero_balance_count),
      })),
      pagination: pagination(page, pageSize, total),
    };
  }

  function movementFilters({
    userId,
    query,
    warehouseId,
    productId,
    operationType,
    direction,
    dateFrom,
    dateTo,
  }) {
    const clauses = [
      `EXISTS (
         SELECT 1 FROM user_warehouses access
         WHERE access.user_id = ? AND access.warehouse_id = im.warehouse_id
       )`,
    ];
    const values = [userId];
    if (warehouseId) {
      clauses.push("im.warehouse_id = ?");
      values.push(warehouseId);
    }
    if (productId) {
      clauses.push("im.product_id = ?");
      values.push(productId);
    }
    if (operationType) {
      clauses.push("io.operation_type = ?");
      values.push(operationType);
    }
    if (direction) {
      clauses.push("im.direction = ?");
      values.push(direction);
    }
    if (dateFrom) {
      clauses.push("io.created_at >= ?");
      values.push(`${dateFrom} 00:00:00.000`);
    }
    if (dateTo) {
      clauses.push("io.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      values.push(dateTo);
    }
    if (query) {
      const term = `%${escapeLike(query)}%`;
      clauses.push(
        "(p.sku LIKE ? ESCAPE '\\\\' OR p.name LIKE ? ESCAPE '\\\\' OR io.reason LIKE ? ESCAPE '\\\\' OR io.reference LIKE ? ESCAPE '\\\\')",
      );
      values.push(term, term, term, term);
    }
    return { where: clauses.join(" AND "), values };
  }

  async function listMovements(filters) {
    const { userId, page, pageSize, sortBy, sortOrder } = filters;
    await assertAssignedWarehouse(userId, filters.warehouseId);
    const { where, values } = movementFilters(filters);
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total
       FROM inventory_movements im
       JOIN inventory_operations io ON io.id = im.operation_id
       JOIN products p ON p.id = im.product_id
       WHERE ${where}`,
      values,
    );
    const direction = sortOrder === "asc" ? "ASC" : "DESC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `${movementSelect}
       WHERE ${where}
       ORDER BY ${movementSortColumns[sortBy]} ${direction}, im.id DESC
       LIMIT ? OFFSET ?`,
      [userId, userId, ...values, pageSize, offset],
    );
    const total = Number(countRow.total);
    return {
      items: rows.map(movementFromRow),
      pagination: pagination(page, pageSize, total),
    };
  }

  async function getMovement({ id, userId }) {
    const [rows] = await dbPool.execute(
      `${movementSelect}
       WHERE im.id = ? AND EXISTS (
         SELECT 1 FROM user_warehouses access
         WHERE access.user_id = ? AND access.warehouse_id = im.warehouse_id
       ) LIMIT 1`,
      [userId, userId, id, userId],
    );
    if (!rows[0])
      throw new HttpError(
        404,
        "MOVEMENT_NOT_FOUND",
        "No se encontró el movimiento autorizado.",
      );
    return movementFromRow(rows[0]);
  }

  async function listOperations({
    userId,
    page,
    pageSize,
    query,
    warehouseId,
    operationType,
    dateFrom,
    dateTo,
  }) {
    await assertAssignedWarehouse(userId, warehouseId);
    const clauses = [
      `EXISTS (SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.source_warehouse_id)
       AND (io.destination_warehouse_id IS NULL OR EXISTS (
         SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.destination_warehouse_id
       ))`,
    ];
    const values = [userId, userId];
    if (warehouseId) {
      clauses.push(
        "(io.source_warehouse_id = ? OR io.destination_warehouse_id = ?)",
      );
      values.push(warehouseId, warehouseId);
    }
    if (operationType) {
      clauses.push("io.operation_type = ?");
      values.push(operationType);
    }
    if (dateFrom) {
      clauses.push("io.created_at >= ?");
      values.push(`${dateFrom} 00:00:00.000`);
    }
    if (dateTo) {
      clauses.push("io.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      values.push(dateTo);
    }
    if (query) {
      clauses.push(
        "(io.reason LIKE ? ESCAPE '\\\\' OR io.reference LIKE ? ESCAPE '\\\\')",
      );
      const term = `%${escapeLike(query)}%`;
      values.push(term, term);
    }
    const where = clauses.join(" AND ");
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM inventory_operations io WHERE ${where}`,
      values,
    );
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `SELECT io.id, io.operation_type, io.reason, io.reference,
              io.source_warehouse_id, source.name AS source_warehouse_name,
              io.destination_warehouse_id, destination.name AS destination_warehouse_name,
              io.created_by, responsible.display_name AS responsible_name,
              io.created_at,
              EXISTS (SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.source_warehouse_id)
                AND (io.destination_warehouse_id IS NULL OR EXISTS (
                  SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.destination_warehouse_id
                )) AS can_see_all_warehouses,
              COUNT(im.id) AS movement_count
       FROM inventory_operations io
       LEFT JOIN warehouses source ON source.id = io.source_warehouse_id
       LEFT JOIN warehouses destination ON destination.id = io.destination_warehouse_id
       JOIN users responsible ON responsible.id = io.created_by
        LEFT JOIN inventory_movements im ON im.operation_id = io.id
          AND EXISTS (
            SELECT 1 FROM user_warehouses movement_access
            WHERE movement_access.user_id = ?
              AND movement_access.warehouse_id = im.warehouse_id
          )
       WHERE ${where}
       GROUP BY io.id, io.operation_type, io.reason, io.reference,
                io.source_warehouse_id, source.name,
                io.destination_warehouse_id, destination.name,
                io.created_by, responsible.display_name, io.created_at
       ORDER BY io.created_at DESC, io.id DESC LIMIT ? OFFSET ?`,
      [userId, userId, userId, ...values, pageSize, offset],
    );
    const total = Number(countRow.total);
    return {
      items: rows.map((row) => {
        const allWarehouses = Boolean(row.can_see_all_warehouses);
        return {
          id: String(row.id),
          type: row.operation_type,
          reason: row.reason,
          reference: row.reference,
          sourceWarehouseId:
            allWarehouses && row.source_warehouse_id !== null
              ? String(row.source_warehouse_id)
              : null,
          sourceWarehouseName: allWarehouses ? row.source_warehouse_name : null,
          destinationWarehouseId:
            allWarehouses && row.destination_warehouse_id !== null
              ? String(row.destination_warehouse_id)
              : null,
          destinationWarehouseName: allWarehouses
            ? row.destination_warehouse_name
            : null,
          responsibleUserId: String(row.created_by),
          responsibleName: row.responsible_name,
          movementCount: Number(row.movement_count),
          createdAt: row.created_at,
        };
      }),
      pagination: pagination(page, pageSize, total),
    };
  }

  async function getOperation({ id, userId }) {
    const [operations] = await dbPool.execute(
      `SELECT io.id, io.operation_type, io.reason, io.reference,
              io.source_warehouse_id, source.name AS source_warehouse_name,
              io.destination_warehouse_id, destination.name AS destination_warehouse_name,
              io.created_by, responsible.display_name AS responsible_name,
              io.created_at
       FROM inventory_operations io
       LEFT JOIN warehouses source ON source.id = io.source_warehouse_id
       LEFT JOIN warehouses destination ON destination.id = io.destination_warehouse_id
       JOIN users responsible ON responsible.id = io.created_by
       WHERE io.id = ?
         AND EXISTS (SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.source_warehouse_id)
         AND (io.destination_warehouse_id IS NULL OR EXISTS (
           SELECT 1 FROM user_warehouses a WHERE a.user_id = ? AND a.warehouse_id = io.destination_warehouse_id
         ))
       LIMIT 1`,
      [id, userId, userId],
    );
    if (!operations[0])
      throw new HttpError(
        404,
        "OPERATION_NOT_FOUND",
        "No se encontró la operación autorizada.",
      );
    const [movementRows] = await dbPool.execute(
      `SELECT im.id, im.product_id, p.sku, p.name AS product_name,
              im.warehouse_id, w.name AS warehouse_name, im.direction,
              im.quantity, im.balance_before, im.balance_after,
              im.balance_version, im.unit_snapshot
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       JOIN warehouses w ON w.id = im.warehouse_id
       WHERE im.operation_id = ? ORDER BY im.id`,
      [id],
    );
    const operation = operations[0];
    return {
      id: String(operation.id),
      type: operation.operation_type,
      reason: operation.reason,
      reference: operation.reference,
      sourceWarehouse:
        operation.source_warehouse_id === null
          ? null
          : {
              id: String(operation.source_warehouse_id),
              name: operation.source_warehouse_name,
            },
      destinationWarehouse:
        operation.destination_warehouse_id === null
          ? null
          : {
              id: String(operation.destination_warehouse_id),
              name: operation.destination_warehouse_name,
            },
      responsibleUserId: String(operation.created_by),
      responsibleName: operation.responsible_name,
      createdAt: operation.created_at,
      movements: movementRows.map((row) => ({
        id: String(row.id),
        productId: String(row.product_id),
        sku: row.sku,
        productName: row.product_name,
        warehouseId: String(row.warehouse_id),
        warehouseName: row.warehouse_name,
        direction: row.direction,
        quantity: Number(row.quantity),
        balanceBefore: Number(row.balance_before),
        balanceAfter: Number(row.balance_after),
        balanceVersion: String(row.balance_version),
        unit: row.unit_snapshot,
      })),
    };
  }

  async function reconcile({ userId, warehouseId }) {
    await assertAssignedWarehouse(userId, warehouseId);
    const clauses = [
      `EXISTS (
         SELECT 1 FROM user_warehouses access
         WHERE access.user_id = ? AND access.warehouse_id = ib.warehouse_id
       )`,
    ];
    const values = [userId];
    if (warehouseId) {
      clauses.push("ib.warehouse_id = ?");
      values.push(warehouseId);
    }
    const [rows] = await dbPool.execute(
      `SELECT ib.product_id, p.sku, p.name AS product_name,
              ib.warehouse_id, w.name AS warehouse_name,
              ib.quantity, ib.version,
              COALESCE(history.movement_count, 0) AS movement_count,
              history.latest_version,
              latest.balance_after AS latest_balance
       FROM inventory_balances ib
       JOIN products p ON p.id = ib.product_id
       JOIN warehouses w ON w.id = ib.warehouse_id
       LEFT JOIN (
         SELECT product_id, warehouse_id, COUNT(*) AS movement_count,
                MAX(balance_version) AS latest_version
         FROM inventory_movements GROUP BY product_id, warehouse_id
       ) history
         ON history.product_id = ib.product_id AND history.warehouse_id = ib.warehouse_id
       LEFT JOIN inventory_movements latest
         ON latest.product_id = ib.product_id
        AND latest.warehouse_id = ib.warehouse_id
        AND latest.balance_version = history.latest_version
       WHERE ${clauses.join(" AND ")}
       GROUP BY ib.product_id, p.sku, p.name, ib.warehouse_id,
                w.name, ib.quantity, ib.version, history.movement_count,
                history.latest_version, latest.balance_after
       HAVING (ib.version = 0 AND COALESCE(history.movement_count, 0) > 0)
          OR (ib.version > 0 AND (
                COALESCE(history.movement_count, 0) <> ib.version
                OR history.latest_version <> ib.version
                OR latest.balance_after <> ib.quantity
             ))
       ORDER BY p.sku, ib.product_id, ib.warehouse_id
       LIMIT 100`,
      values,
    );
    return {
      consistent: rows.length === 0,
      discrepancyCount: rows.length,
      items: rows.map((row) => ({
        productId: String(row.product_id),
        sku: row.sku,
        productName: row.product_name,
        warehouseId: String(row.warehouse_id),
        warehouseName: row.warehouse_name,
        balanceQuantity: Number(row.quantity),
        balanceVersion: String(row.version),
        movementCount: Number(row.movement_count),
        latestMovementVersion:
          row.latest_version === null ? null : String(row.latest_version),
        latestMovementBalance:
          row.latest_balance === null ? null : Number(row.latest_balance),
      })),
      truncated: rows.length === 100,
    };
  }

  return {
    listBalances,
    listTotals,
    listMovements,
    getMovement,
    listOperations,
    getOperation,
    reconcile,
  };
}
