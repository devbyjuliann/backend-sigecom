import { bogotaUtcBoundaries } from "../reports/sales-activity-service.js";
import { LOW_STOCK_SQL } from "../inventory/stock-criteria.js";

function unavailableIndicator() {
  return { available: false, value: null };
}

function currentBogotaPeriod(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find(({ type }) => type === "year").value;
  const month = parts.find(({ type }) => type === "month").value;
  const dateFrom = `${year}-${month}-01`;
  const dateTo = new Date(Date.UTC(Number(year), Number(month), 0))
    .toISOString()
    .slice(0, 10);
  return {
    dateFrom,
    dateTo,
    timeZone: "America/Bogota",
    ...bogotaUtcBoundaries(dateFrom, dateTo),
  };
}

function recentBogotaPeriods(now, count = 3) {
  const current = currentBogotaPeriod(now);
  const [year, month] = current.dateFrom.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 - count + 1, 1));
  const dateFrom = first.toISOString().slice(0, 10);
  const periods = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(Date.UTC(year, month - 1 - count + 1 + offset, 1));
    periods.push(date.toISOString().slice(0, 7));
  }
  return {
    dateFrom,
    dateTo: current.dateTo,
    periods,
    ...bogotaUtcBoundaries(dateFrom, current.dateTo),
  };
}

function decimalCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new TypeError("El importe del dashboard no es válido.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function decimalText(cents) {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

async function firstRow(dbPool, sql, values = []) {
  const [rows] = await dbPool.execute(sql, values);
  return rows[0] || {};
}

async function count(dbPool, sql, values = []) {
  const [[row]] = await dbPool.execute(sql, values);
  return Number(row.total);
}

export function createDashboardService({ dbPool }) {
  async function getSummary({ userId, permissions, now = new Date() }) {
    const indicators = {
      activeProducts: unavailableIndicator(),
      customers: unavailableIndicator(),
      suppliers: unavailableIndicator(),
      accessibleWarehouses: unavailableIndicator(),
    };
    let productsByCategory = { available: false, items: null };
    const period = currentBogotaPeriod(now);
    const commercial = {
      period: {
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        timeZone: period.timeZone,
      },
      salesNet: unavailableIndicator(),
      purchasesReceived: unavailableIndicator(),
      inventoryValue: unavailableIndicator(),
      stockedProducts: unavailableIndicator(),
      lowStockProducts: unavailableIndicator(),
      pendingReceipts: unavailableIndicator(),
      salesTrend: { available: false, items: null },
      topProducts: { available: false, items: null },
      inventoryByWarehouse: { available: false, items: null },
      recentActivity: { available: false, items: null },
    };
    const queries = [];

    const hasSalesScope =
      permissions.has("sales.read") && permissions.has("warehouses.read");
    const hasPurchaseScope =
      permissions.has("purchases.read") && permissions.has("warehouses.read");
    const hasInventoryScope =
      permissions.has("inventory.read") && permissions.has("warehouses.read");
    const hasInventoryValueScope =
      hasInventoryScope && permissions.has("products.read");

    if (hasSalesScope) {
      const salesPeriods = recentBogotaPeriods(now);
      queries.push(
        dbPool
          .execute(
            `/* dashboard:salesNet dashboard:salesTrend */
           SELECT monthly.month,
                  CAST(SUM(monthly.amount) AS CHAR) AS value
             FROM (
               SELECT DATE_FORMAT(DATE_SUB(s.confirmed_at, INTERVAL 5 HOUR), '%Y-%m') AS month,
                      SUM(sl.line_total) AS amount
                 FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
                WHERE s.warehouse_id IN (
                  SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                ) AND s.confirmed_at >= ? AND s.confirmed_at < ?
                GROUP BY DATE_FORMAT(DATE_SUB(s.confirmed_at, INTERVAL 5 HOUR), '%Y-%m')
               UNION ALL
               SELECT DATE_FORMAT(DATE_SUB(sc.created_at, INTERVAL 5 HOUR), '%Y-%m') AS month,
                      -SUM(sl.line_total) AS amount
                 FROM sale_cancellations sc
                 JOIN sales s ON s.id = sc.sale_id
                 JOIN sale_lines sl ON sl.sale_id = s.id
                 WHERE s.warehouse_id IN (
                   SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                 ) AND s.status = 'cancelled' AND s.confirmed_at IS NOT NULL
                  AND sc.created_at >= ? AND sc.created_at < ?
                GROUP BY DATE_FORMAT(DATE_SUB(sc.created_at, INTERVAL 5 HOUR), '%Y-%m')
               UNION ALL
               SELECT DATE_FORMAT(DATE_SUB(cr.returned_at, INTERVAL 5 HOUR), '%Y-%m') AS month,
                      -SUM(crl.quantity_received * sl.unit_price) AS amount
                 FROM customer_returns cr
                 JOIN sales s ON s.id = cr.sale_id
                 JOIN customer_return_lines crl ON crl.customer_return_id = cr.id
                   AND crl.sale_id = cr.sale_id
                 JOIN sale_lines sl ON sl.id = crl.sale_line_id
                   AND sl.sale_id = cr.sale_id
                WHERE s.warehouse_id IN (
                  SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                ) AND s.confirmed_at IS NOT NULL
                  AND cr.returned_at >= ? AND cr.returned_at < ?
                GROUP BY DATE_FORMAT(DATE_SUB(cr.returned_at, INTERVAL 5 HOUR), '%Y-%m')
             ) monthly
            GROUP BY monthly.month
            ORDER BY monthly.month`,
            [
              userId,
              salesPeriods.startUtc,
              salesPeriods.endUtc,
              userId,
              salesPeriods.startUtc,
              salesPeriods.endUtc,
              userId,
              salesPeriods.startUtc,
              salesPeriods.endUtc,
            ],
          )
          .then(([rows]) => {
            const values = new Map(
              rows.map((row) => [row.month, decimalCents(row.value)]),
            );
            const items = salesPeriods.periods.map((month) => ({
              month,
              value: decimalText(values.get(month) || 0n),
            }));
            commercial.salesTrend = { available: true, items };
            commercial.salesNet = {
              available: true,
              value: items.at(-1)?.value || "0.00",
            };
          }),
      );
      queries.push(
        dbPool
          .execute(
            `/* dashboard:topProducts */
             SELECT activity.product_id, activity.sku, activity.name, activity.unit,
                    CAST(SUM(activity.quantity_delta) AS CHAR) AS quantity,
                    CAST(SUM(activity.amount_delta) AS CHAR) AS amount
               FROM (
                 SELECT sl.product_id, sl.sku_snapshot AS sku,
                        sl.product_name_snapshot AS name, sl.unit_snapshot AS unit,
                        SUM(sl.quantity) AS quantity_delta,
                        SUM(sl.line_total) AS amount_delta
                   FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
                  WHERE s.warehouse_id IN (
                    SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                  ) AND s.confirmed_at >= ? AND s.confirmed_at < ?
                  GROUP BY sl.product_id, sl.sku_snapshot, sl.product_name_snapshot, sl.unit_snapshot
                 UNION ALL
                 SELECT sl.product_id, sl.sku_snapshot, sl.product_name_snapshot, sl.unit_snapshot,
                        -SUM(sl.quantity), -SUM(sl.line_total)
                   FROM sale_cancellations sc JOIN sales s ON s.id = sc.sale_id
                   JOIN sale_lines sl ON sl.sale_id = s.id
                   WHERE s.warehouse_id IN (
                     SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                   ) AND s.status = 'cancelled'
                     AND sc.created_at >= ? AND sc.created_at < ?
                  GROUP BY sl.product_id, sl.sku_snapshot, sl.product_name_snapshot, sl.unit_snapshot
                 UNION ALL
                 SELECT sl.product_id, sl.sku_snapshot, sl.product_name_snapshot, sl.unit_snapshot,
                        -SUM(crl.quantity_received),
                        -SUM(crl.quantity_received * sl.unit_price)
                   FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id
                   JOIN customer_return_lines crl ON crl.customer_return_id = cr.id
                     AND crl.sale_id = cr.sale_id
                   JOIN sale_lines sl ON sl.id = crl.sale_line_id AND sl.sale_id = cr.sale_id
                  WHERE s.warehouse_id IN (
                    SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
                  ) AND cr.returned_at >= ? AND cr.returned_at < ?
                  GROUP BY sl.product_id, sl.sku_snapshot, sl.product_name_snapshot, sl.unit_snapshot
               ) activity
              GROUP BY activity.product_id, activity.sku, activity.name, activity.unit
             HAVING SUM(activity.quantity_delta) > 0 AND SUM(activity.amount_delta) > 0
              ORDER BY SUM(activity.amount_delta) DESC, activity.name, activity.product_id
              LIMIT 5`,
            [
              userId,
              period.startUtc,
              period.endUtc,
              userId,
              period.startUtc,
              period.endUtc,
              userId,
              period.startUtc,
              period.endUtc,
            ],
          )
          .then(([rows]) => {
            commercial.topProducts = {
              available: true,
              items: rows.map((row) => ({
                productId: String(row.product_id),
                sku: row.sku,
                name: row.name,
                unit: row.unit,
                quantity: String(row.quantity),
                amount: decimalText(decimalCents(row.amount || "0")),
              })),
            };
          }),
      );
    }

    if (hasPurchaseScope) {
      queries.push(
        firstRow(
          dbPool,
          `/* dashboard:purchasesReceived */
           SELECT CAST(COALESCE(SUM(prl.quantity * pol.unit_cost), 0) AS CHAR) AS value
             FROM purchase_receipts pr
             JOIN purchase_orders po ON po.id = pr.purchase_order_id
             JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id = pr.id
               AND prl.purchase_order_id = po.id
             JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
               AND pol.purchase_order_id = po.id
            WHERE po.warehouse_id IN (
              SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
            ) AND pr.received_at >= ? AND pr.received_at < ?`,
          [userId, period.startUtc, period.endUtc],
        ).then((row) => {
          commercial.purchasesReceived = {
            available: true,
            value: decimalText(decimalCents(row.value ?? "0")),
          };
        }),
      );
      queries.push(
        firstRow(
          dbPool,
          `/* dashboard:pendingReceipts */
           SELECT COUNT(*) AS total
             FROM purchase_orders po
            WHERE po.status = 'confirmed' AND po.closed_at IS NULL
              AND po.warehouse_id IN (
                SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
              )
              AND EXISTS (
                SELECT 1 FROM purchase_order_lines pol
                 WHERE pol.purchase_order_id = po.id AND pol.is_active = 1
                   AND pol.quantity > COALESCE((
                     SELECT SUM(prl.quantity)
                       FROM purchase_receipt_lines prl
                       JOIN purchase_receipts pr ON pr.id = prl.purchase_receipt_id
                      WHERE prl.purchase_order_id = po.id
                        AND prl.purchase_order_line_id = pol.id
                   ), 0)
              )`,
          [userId],
        ).then((row) => {
          commercial.pendingReceipts = {
            available: true,
            value: Number(row.total || 0),
          };
        }),
      );
    }

    if (hasInventoryScope) {
      if (hasInventoryValueScope) {
        queries.push(
          firstRow(
            dbPool,
            `/* dashboard:inventoryValue */
             SELECT CAST(COALESCE(SUM(ib.quantity * p.purchase_price), 0) AS CHAR) AS value
               FROM inventory_balances ib
               JOIN products p ON p.id = ib.product_id
              WHERE ib.warehouse_id IN (
                SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
              )`,
            [userId],
          ).then((row) => {
            commercial.inventoryValue = {
              available: true,
              value: decimalText(decimalCents(row.value ?? "0")),
            };
          }),
        );
      }
      queries.push(
        firstRow(
          dbPool,
          `/* dashboard:stockedProducts */
           SELECT COUNT(DISTINCT ib.product_id) AS total
             FROM inventory_balances ib
            WHERE ib.quantity > 0 AND ib.warehouse_id IN (
              SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
            )`,
          [userId],
        ).then((row) => {
          commercial.stockedProducts = {
            available: true,
            value: Number(row.total || 0),
          };
        }),
      );
      queries.push(
        firstRow(
          dbPool,
          `/* dashboard:lowStock */
           SELECT COUNT(*) AS total
             FROM products p
            WHERE p.is_active = 1 AND EXISTS (
              SELECT 1 FROM user_warehouses uw
              JOIN inventory_balances ib
                ON ib.warehouse_id = uw.warehouse_id AND ib.product_id = p.id
              WHERE uw.user_id = ? AND ${LOW_STOCK_SQL}
            )`,
          [userId],
        ).then((row) => {
          commercial.lowStockProducts = {
            available: true,
            value: Number(row.total || 0),
          };
        }),
      );
      queries.push(
        dbPool
          .execute(
            `/* dashboard:inventoryByWarehouse */
             SELECT w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
                    COUNT(DISTINCT CASE WHEN ib.quantity > 0 THEN ib.product_id END) AS stocked_products,
                    COUNT(CASE WHEN ib.quantity > 0 THEN 1 END) AS stocked_pairs
               FROM user_warehouses uw
               JOIN warehouses w ON w.id = uw.warehouse_id
               LEFT JOIN inventory_balances ib ON ib.warehouse_id = w.id
              WHERE uw.user_id = ?
              GROUP BY w.id, w.code, w.name
              ORDER BY w.name, w.id`,
            [userId],
          )
          .then(([rows]) => {
            commercial.inventoryByWarehouse = {
              available: true,
              items: rows.map((row) => ({
                warehouseId: String(row.warehouse_id),
                warehouseCode: row.warehouse_code,
                warehouseName: row.warehouse_name,
                stockedProducts: Number(row.stocked_products || 0),
                stockedPairs: Number(row.stocked_pairs || 0),
              })),
            };
          }),
      );
    }

    const activityStreams = [];
    const activityValues = [];
    if (hasSalesScope) {
      activityStreams.push(
        `SELECT CONVERT('sale_confirmation' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
                s.confirmed_at AS occurred_at,
                CONVERT(s.commercial_code USING utf8mb4) COLLATE utf8mb4_unicode_ci AS document_code,
                CONVERT(s.warehouse_code_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_code,
                CONVERT(s.warehouse_name_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_name,
                SUM(sl.line_total) AS amount
           FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
          WHERE s.confirmed_at IS NOT NULL AND s.warehouse_id IN (
            SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
          ) GROUP BY s.id, s.confirmed_at, s.commercial_code,
                   s.warehouse_code_snapshot, s.warehouse_name_snapshot`,
        `SELECT CONVERT('sale_cancellation' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
                sc.created_at AS occurred_at,
                CONVERT(s.commercial_code USING utf8mb4) COLLATE utf8mb4_unicode_ci AS document_code,
                CONVERT(s.warehouse_code_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_code,
                CONVERT(s.warehouse_name_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_name,
                SUM(sl.line_total) AS amount
           FROM sale_cancellations sc JOIN sales s ON s.id = sc.sale_id
           JOIN sale_lines sl ON sl.sale_id = s.id
          WHERE s.warehouse_id IN (
            SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
          ) GROUP BY sc.id, sc.created_at, s.commercial_code,
                   s.warehouse_code_snapshot, s.warehouse_name_snapshot`,
        `SELECT CONVERT('customer_return' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
                cr.returned_at AS occurred_at,
                CONVERT(s.commercial_code USING utf8mb4) COLLATE utf8mb4_unicode_ci AS document_code,
                CONVERT(s.warehouse_code_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_code,
                CONVERT(s.warehouse_name_snapshot USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_name,
                SUM(crl.quantity_received * sl.unit_price) AS amount
           FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id
           JOIN customer_return_lines crl ON crl.customer_return_id = cr.id AND crl.sale_id = cr.sale_id
           JOIN sale_lines sl ON sl.id = crl.sale_line_id AND sl.sale_id = cr.sale_id
          WHERE s.warehouse_id IN (
            SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
          ) GROUP BY cr.id, cr.returned_at, s.commercial_code,
                   s.warehouse_code_snapshot, s.warehouse_name_snapshot`,
      );
      activityValues.push(userId, userId, userId);
    }
    if (hasPurchaseScope) {
      activityStreams.push(
        `SELECT CONVERT('purchase_receipt' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
                pr.received_at AS occurred_at,
                CONVERT(CAST(pr.id AS CHAR) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS document_code,
                CONVERT(w.code USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_code,
                CONVERT(w.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_name,
                SUM(prl.quantity * pol.unit_cost) AS amount
           FROM purchase_receipts pr JOIN purchase_orders po ON po.id = pr.purchase_order_id
           JOIN warehouses w ON w.id = po.warehouse_id
           JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id = pr.id
             AND prl.purchase_order_id = po.id
           JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
             AND pol.purchase_order_id = po.id
          WHERE po.warehouse_id IN (
            SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
          ) GROUP BY pr.id, pr.received_at, w.code, w.name`,
        `SELECT CONVERT('supplier_return' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS type,
                sr.returned_at AS occurred_at,
                CONVERT(sr.reference USING utf8mb4) COLLATE utf8mb4_unicode_ci AS document_code,
                CONVERT(w.code USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_code,
                CONVERT(w.name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS warehouse_name,
                SUM(srl.quantity * pol.unit_cost) AS amount
           FROM supplier_returns sr JOIN purchase_orders po ON po.id = sr.purchase_order_id
           JOIN warehouses w ON w.id = po.warehouse_id
           JOIN supplier_return_lines srl ON srl.supplier_return_id = sr.id
             AND srl.purchase_order_id = po.id
           JOIN purchase_order_lines pol ON pol.id = srl.purchase_order_line_id
             AND pol.purchase_order_id = po.id
          WHERE po.warehouse_id IN (
            SELECT uw.warehouse_id FROM user_warehouses uw WHERE uw.user_id = ?
          ) GROUP BY sr.id, sr.returned_at, sr.reference, w.code, w.name`,
      );
      activityValues.push(userId, userId);
    }
    if (activityStreams.length) {
      queries.push(
        dbPool
          .execute(
            `/* dashboard:recentActivity */
             SELECT type, DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.000Z') AS occurred_at,
                    document_code, warehouse_code, warehouse_name, amount
               FROM (${activityStreams.join(" UNION ALL ")}) recent
              ORDER BY occurred_at DESC, document_code DESC LIMIT 10`,
            activityValues,
          )
          .then(([rows]) => {
            commercial.recentActivity = {
              available: true,
              items: rows.map((row) => ({
                type: row.type,
                occurredAt: row.occurred_at,
                documentCode: row.document_code,
                warehouseCode: row.warehouse_code,
                warehouseName: row.warehouse_name,
                amount:
                  row.amount === null
                    ? null
                    : decimalText(decimalCents(row.amount)),
              })),
            };
          }),
      );
    }

    if (permissions.has("products.read")) {
      queries.push(
        count(
          dbPool,
          "SELECT COUNT(*) AS total FROM products WHERE is_active = 1",
        ).then((value) => {
          indicators.activeProducts = { available: true, value };
        }),
      );
    }

    if (permissions.has("customers.read")) {
      queries.push(
        count(dbPool, "SELECT COUNT(*) AS total FROM customers").then(
          (value) => {
            indicators.customers = { available: true, value };
          },
        ),
      );
    }

    if (permissions.has("suppliers.read")) {
      queries.push(
        count(dbPool, "SELECT COUNT(*) AS total FROM suppliers").then(
          (value) => {
            indicators.suppliers = { available: true, value };
          },
        ),
      );
    }

    if (permissions.has("warehouses.read")) {
      queries.push(
        count(
          dbPool,
          `SELECT COUNT(*) AS total
           FROM user_warehouses AS access
           JOIN warehouses AS warehouse
             ON warehouse.id = access.warehouse_id
           WHERE access.user_id = ?`,
          [userId],
        ).then((value) => {
          indicators.accessibleWarehouses = { available: true, value };
        }),
      );
    }

    if (
      permissions.has("products.read") &&
      permissions.has("categories.read")
    ) {
      queries.push(
        dbPool
          .execute(
            `SELECT category.id AS category_id,
                    category.name AS category_name,
                    COUNT(product.id) AS active_products
             FROM categories AS category
             LEFT JOIN products AS product
               ON product.category_id = category.id AND product.is_active = 1
             WHERE category.is_active = 1
             GROUP BY category.id, category.name
             HAVING COUNT(product.id) > 0
             ORDER BY COUNT(product.id) DESC, category.name, category.id`,
          )
          .then(([rows]) => {
            productsByCategory = {
              available: true,
              items: rows.map((row) => ({
                categoryId: String(row.category_id),
                categoryName: row.category_name,
                activeProducts: Number(row.active_products),
              })),
            };
          }),
      );
    }

    await Promise.all(queries);
    return { indicators, productsByCategory, commercial };
  }

  return { getSummary };
}
