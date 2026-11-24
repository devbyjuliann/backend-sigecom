import { HttpError } from "../../shared/http-error.js";

const allowedRoles = new Set(["administrator", "auditor"]);
const stockPermissions = ["reports.read", "warehouses.read", "inventory.read"];
const activityPermissions = [
  "reports.read",
  "warehouses.read",
  "inventory.movements.read",
];
const idPattern = /^[1-9]\d{0,19}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function civilDate(value) {
  if (typeof value !== "string" || !datePattern.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return year >= 1000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

export function validateInventoryActivityPeriod(dateFrom, dateTo) {
  const from = civilDate(dateFrom);
  const to = civilDate(dateTo);
  if (!from || !to || from > to || (to - from) / 86_400_000 > 91) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PERIOD",
      "El período debe ser válido, estar ordenado y no superar 92 días calendario.",
    );
  }
  const next = new Date(to.getTime() + 86_400_000);
  const format = (date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} 05:00:00.000`;
  return { startUtc: format(from), endUtc: format(next) };
}

export function buildInventoryActivityCtes(warehouseIds, filters = {}) {
  const list = idValues(warehouseIds);
  return {
    sql: `
      WITH scoped_operations AS (
        SELECT io.* FROM inventory_operations io
         WHERE io.created_at >= ? AND io.created_at < ?
           AND EXISTS (SELECT 1 FROM inventory_movements scoped_movement
             WHERE scoped_movement.operation_id=io.id
               AND scoped_movement.warehouse_id IN (${list.sql}))
       ), transfer_integrity_candidates AS (
         SELECT io.id,
           CASE WHEN NOT EXISTS (SELECT 1 FROM inventory_movements any_movement
                                  WHERE any_movement.operation_id=io.id) THEN 1
             WHEN EXISTS (SELECT 1 FROM inventory_movements im
                           WHERE im.operation_id=io.id AND (
                             NOT ((im.direction='OUT' AND im.warehouse_id=io.source_warehouse_id)
                               OR (im.direction='IN' AND im.warehouse_id=io.destination_warehouse_id))
                             OR NOT EXISTS (
                               SELECT 1 FROM inventory_movements counterpart
                                WHERE counterpart.operation_id=io.id
                                  AND counterpart.product_id=im.product_id
                                  AND counterpart.warehouse_id=IF(im.direction='OUT',io.destination_warehouse_id,io.source_warehouse_id)
                                  AND counterpart.direction=IF(im.direction='OUT','IN','OUT')
                                  AND counterpart.quantity=im.quantity
                                  AND BINARY counterpart.unit_snapshot=BINARY im.unit_snapshot
                             )
                           )) THEN 1 ELSE 0 END AS incomplete
           FROM inventory_operations io
          WHERE io.operation_type='transfer' AND io.created_at>=? AND io.created_at<?
            AND (io.source_warehouse_id IN (${list.sql})
              OR io.destination_warehouse_id IN (${list.sql}))
       ), effect_scope AS (
         SELECT CAST(NULL AS UNSIGNED) AS product_id,id AS warehouse_id
           FROM warehouses WHERE id IN (${list.sql})
       ), ${expectedDocumentEffectsCte()}, expected AS (
        SELECT pr.source_operation_id AS operation_id, pol.product_id, po.warehouse_id,
               'IN' AS direction, prl.quantity, pol.unit_snapshot AS unit
          FROM purchase_receipts pr JOIN scoped_operations so ON so.id=pr.source_operation_id
            AND so.operation_type='purchase_receipt' AND so.source_type='purchase_receipt'
            AND so.source_id=CAST(pr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          JOIN purchase_orders po ON po.id=pr.purchase_order_id
          JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id=pr.id
            AND prl.purchase_order_id=pr.purchase_order_id
          JOIN purchase_order_lines pol ON pol.id=prl.purchase_order_line_id
            AND pol.purchase_order_id=pr.purchase_order_id
         WHERE po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
        UNION ALL
        SELECT sr.source_operation_id, srl.product_id, po.warehouse_id,
               'OUT', srl.quantity, srl.unit_snapshot
          FROM supplier_returns sr JOIN scoped_operations so ON so.id=sr.source_operation_id
            AND so.operation_type='supplier_return' AND so.source_type='supplier_return'
            AND so.source_id=CAST(sr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          JOIN purchase_orders po ON po.id=sr.purchase_order_id
          JOIN supplier_return_lines srl ON srl.supplier_return_id=sr.id
            AND srl.purchase_order_id=sr.purchase_order_id
            AND srl.purchase_receipt_id=sr.purchase_receipt_id
         WHERE po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
        UNION ALL
        SELECT so.id, sl.product_id, s.warehouse_id, 'OUT', sl.quantity, sl.unit_snapshot
          FROM scoped_operations so JOIN sales s ON so.operation_type='sale_issue'
            AND so.source_type='sale'
            AND so.source_id REGEXP '^[1-9][0-9]*$'
            AND s.id=CAST(so.source_id AS UNSIGNED)
          JOIN sale_lines sl ON sl.sale_id=s.id
         WHERE s.confirmed_at IS NOT NULL AND s.status IN ('confirmed','cancelled')
        UNION ALL
        SELECT sc.source_operation_id, sl.product_id, s.warehouse_id,
               'IN', sl.quantity, sl.unit_snapshot
          FROM sale_cancellations sc JOIN scoped_operations so ON so.id=sc.source_operation_id
            AND so.operation_type='sale_reversal' AND so.source_type='sale_cancellation'
            AND so.source_id=CAST(sc.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          JOIN sales s ON s.id=sc.sale_id JOIN sale_lines sl ON sl.sale_id=s.id
         WHERE s.status='cancelled' AND s.confirmed_at IS NOT NULL AND s.cancelled_at IS NOT NULL
        UNION ALL
        SELECT cr.source_operation_id, crl.product_id, s.warehouse_id,
               'IN', crl.quantity_restocked, crl.unit_snapshot
          FROM customer_returns cr JOIN scoped_operations so ON so.id=cr.source_operation_id
            AND so.operation_type='customer_return' AND so.source_type='customer_return'
            AND so.source_id=CAST(cr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          JOIN sales s ON s.id=cr.sale_id JOIN customer_return_lines crl
            ON crl.customer_return_id=cr.id AND crl.sale_id=cr.sale_id
         WHERE crl.quantity_restocked > 0
           AND s.status='confirmed' AND s.confirmed_at IS NOT NULL
      ), operation_checks AS (
        SELECT so.id AS operation_id, so.operation_type, so.source_warehouse_id,
               so.destination_warehouse_id,
               COUNT(im.id) AS movement_count,
               SUM(CASE WHEN im.id IS NOT NULL AND (
                 im.quantity=0 OR (im.direction='IN' AND im.balance_after<>im.balance_before+im.quantity)
                 OR (im.direction='OUT' AND im.balance_before<>im.balance_after+im.quantity)
                 OR NOT (
                   (so.operation_type='transfer' AND (
                     (im.direction='OUT' AND im.warehouse_id=so.source_warehouse_id)
                     OR (im.direction='IN' AND im.warehouse_id=so.destination_warehouse_id)))
                   OR (so.operation_type IN ('initial_stock','adjustment_in','purchase_receipt','sale_reversal','customer_return')
                       AND im.direction='IN' AND im.warehouse_id=so.source_warehouse_id)
                   OR (so.operation_type IN ('adjustment_out','supplier_return','sale_issue')
                       AND im.direction='OUT' AND im.warehouse_id=so.source_warehouse_id)
                 )
               ) THEN 1 ELSE 0 END) AS physical_errors,
               SUM(CASE WHEN im.id IS NOT NULL AND so.operation_type='transfer' AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements counterpart
                  WHERE counterpart.operation_id=so.id AND counterpart.product_id=im.product_id
                    AND counterpart.warehouse_id=IF(im.direction='OUT',so.destination_warehouse_id,so.source_warehouse_id)
                    AND counterpart.direction=IF(im.direction='OUT','IN','OUT')
                    AND counterpart.quantity=im.quantity AND BINARY counterpart.unit_snapshot=BINARY im.unit_snapshot
               ) THEN 1 ELSE 0 END) AS transfer_errors,
               COUNT(DISTINCT e.product_id,e.warehouse_id,e.direction,e.unit) AS expected_count,
               SUM(CASE WHEN e.operation_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements match_movement
                  WHERE match_movement.operation_id=e.operation_id
                    AND match_movement.product_id=e.product_id AND match_movement.warehouse_id=e.warehouse_id
                    AND match_movement.direction=e.direction AND match_movement.quantity=e.quantity
                    AND BINARY match_movement.unit_snapshot=BINARY e.unit
               ) THEN 1 ELSE 0 END) AS missing_expected,
               SUM(CASE WHEN im.id IS NOT NULL AND so.operation_type IN
                 ('purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return')
                 AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.operation_id=so.id
                   AND e.product_id=im.product_id AND e.warehouse_id=im.warehouse_id
                   AND e.direction=im.direction AND e.quantity=im.quantity
                   AND BINARY e.unit=BINARY im.unit_snapshot)
               THEN 1 ELSE 0 END) AS unexpected_movements,
               (SELECT COUNT(*) FROM expected e WHERE e.operation_id=so.id) AS document_line_count
          FROM scoped_operations so
          LEFT JOIN inventory_movements im ON im.operation_id=so.id
          LEFT JOIN expected e ON e.operation_id=so.id
         GROUP BY so.id,so.operation_type,so.source_warehouse_id,so.destination_warehouse_id
      ), valid_operations AS (
        SELECT operation_id,
          CASE WHEN movement_count=0 OR physical_errors>0 OR transfer_errors>0 THEN 0
            WHEN operation_type IN ('initial_stock','adjustment_in','adjustment_out','transfer')
              THEN source_warehouse_id IS NOT NULL AND (operation_type='transfer' OR destination_warehouse_id IS NULL)
                AND NOT EXISTS (SELECT 1 FROM scoped_operations internal_op
                  WHERE internal_op.id=operation_checks.operation_id
                    AND (internal_op.source_type IS NOT NULL OR internal_op.source_id IS NOT NULL))
            WHEN operation_type IN ('purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return')
              THEN expected_count=document_line_count AND missing_expected=0 AND unexpected_movements=0
            ELSE 0 END AS is_valid
          ,CASE WHEN movement_count=0 OR physical_errors>0 OR transfer_errors>0 THEN 'inconsistent'
            WHEN operation_type IN ('purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return')
              AND document_line_count=0 THEN 'insufficient'
            WHEN operation_type IN ('purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return')
              AND (expected_count<>document_line_count OR missing_expected>0 OR unexpected_movements>0) THEN 'inconsistent'
            WHEN operation_type IN ('initial_stock','adjustment_in','adjustment_out','transfer')
              AND NOT EXISTS (SELECT 1 FROM scoped_operations internal_op
                WHERE internal_op.id=operation_checks.operation_id
                  AND internal_op.source_type IS NULL AND internal_op.source_id IS NULL) THEN 'inconsistent'
            WHEN operation_type NOT IN ('initial_stock','adjustment_in','adjustment_out','transfer',
              'purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return') THEN 'insufficient'
            ELSE NULL END AS exclusion_class
          FROM operation_checks
       ), uncredited_document_effects AS (
         SELECT e.* FROM expected_document_effects e
          WHERE NOT EXISTS (
            SELECT 1 FROM inventory_operations io
            JOIN inventory_movements im ON im.operation_id=io.id
            JOIN valid_operations vo ON vo.operation_id=io.id AND vo.is_valid=1
             WHERE BINARY io.operation_type=BINARY e.operation_type
               AND BINARY io.source_type=BINARY e.source_type
               AND BINARY io.source_id=BINARY e.source_id
               AND io.source_warehouse_id=e.warehouse_id
               AND im.product_id=e.product_id AND im.warehouse_id=e.warehouse_id
               AND BINARY im.direction=BINARY e.direction AND im.quantity=e.quantity
               AND BINARY im.unit_snapshot=BINARY e.unit_snapshot
          )
       ), candidate_movements AS (
        SELECT im.id, im.operation_id, im.product_id, im.warehouse_id,
               im.direction, im.quantity, im.unit_snapshot,
               io.operation_type, io.created_at AS operation_created_at,
               w.code AS warehouse_code,w.name AS warehouse_name,w.is_active AS warehouse_active,
                vo.is_valid,vo.exclusion_class
          FROM scoped_operations io JOIN inventory_movements im ON im.operation_id=io.id
          JOIN valid_operations vo ON vo.operation_id=io.id
          JOIN warehouses w ON w.id=im.warehouse_id
         WHERE im.warehouse_id IN (${list.sql})
       ), filtered_candidates AS (
         SELECT * FROM candidate_movements WHERE 1=1
           ${filters.unit ? "AND unit_snapshot=?" : ""}
           ${filters.operationType ? "AND operation_type=?" : ""}
           ${filters.direction ? "AND direction=?" : ""}
       ), filtered_eligible AS (
         SELECT * FROM filtered_candidates WHERE is_valid=1
       )`,
    values: [
      ...(filters.unit ? [filters.unit] : []),
      ...(filters.operationType ? [filters.operationType] : []),
      ...(filters.direction ? [filters.direction] : []),
    ],
    periodValues: null,
    warehouseIds,
  };
}

function denied() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar el resumen de inventario.",
  );
}

function validatePage(page, pageSize) {
  const currentPage = page ?? 1;
  const size = pageSize ?? 20;
  if (
    !Number.isSafeInteger(currentPage) ||
    currentPage < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 50 ||
    (currentPage - 1) * size > 10_000
  ) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PAGINATION",
      "La paginación no es válida.",
    );
  }
  return {
    page: currentPage,
    pageSize: size,
    offset: (currentPage - 1) * size,
  };
}

function pagination(page, pageSize, total) {
  const count = BigInt(total);
  return {
    page,
    pageSize,
    total: count.toString(),
    totalPages: ((count + BigInt(pageSize) - 1n) / BigInt(pageSize)).toString(),
  };
}

function idValues(ids) {
  if (!ids.length) return { sql: "NULL", values: [] };
  return { sql: ids.map(() => "?").join(","), values: ids };
}

// Keep the indexed equality beside the BINARY check: lookups use
// (source_type, source_id) without weakening exact identifier matching.
function expectedDocumentEffectsCte() {
  return `expected_document_effects AS (
    SELECT 'sale_issue' AS operation_type, 'sale' AS source_type,
           CAST(s.id AS CHAR) AS source_id, s.warehouse_id, sl.product_id,
           'OUT' AS direction, sl.quantity, sl.unit_snapshot,
           COALESCE(io.created_at,s.confirmed_at) AS occurred_at
      FROM effect_scope scope
      JOIN sales s ON s.warehouse_id=scope.warehouse_id
      JOIN sale_lines sl ON sl.sale_id=s.id
        AND (scope.product_id IS NULL OR scope.product_id=sl.product_id)
      LEFT JOIN inventory_operations io ON io.operation_type='sale_issue'
        AND io.source_type='sale'
        AND io.source_id=CAST(s.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
        AND BINARY io.source_id=BINARY CAST(s.id AS CHAR)
     WHERE s.confirmed_at IS NOT NULL AND s.status IN ('confirmed','cancelled')
    UNION ALL
    SELECT 'sale_reversal','sale_cancellation',CAST(sc.id AS CHAR),s.warehouse_id,
           sl.product_id,'IN',sl.quantity,sl.unit_snapshot,
           COALESCE(io.created_at,sc.created_at)
      FROM effect_scope scope
      JOIN sales s ON s.warehouse_id=scope.warehouse_id AND s.status='cancelled'
        AND s.confirmed_at IS NOT NULL AND s.cancelled_at IS NOT NULL
      JOIN sale_cancellations sc ON sc.sale_id=s.id
      JOIN sale_lines sl ON sl.sale_id=s.id
        AND (scope.product_id IS NULL OR scope.product_id=sl.product_id)
      LEFT JOIN inventory_operations io ON io.operation_type='sale_reversal'
        AND io.source_type='sale_cancellation'
        AND io.source_id=CAST(sc.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
        AND BINARY io.source_id=BINARY CAST(sc.id AS CHAR)
    UNION ALL
    SELECT 'customer_return','customer_return',CAST(cr.id AS CHAR),s.warehouse_id,
           crl.product_id,'IN',crl.quantity_restocked,crl.unit_snapshot,
           COALESCE(io.created_at,cr.returned_at)
      FROM effect_scope scope
      JOIN sales s ON s.warehouse_id=scope.warehouse_id AND s.status='confirmed'
        AND s.confirmed_at IS NOT NULL
      JOIN customer_returns cr ON cr.sale_id=s.id
      JOIN customer_return_lines crl ON crl.customer_return_id=cr.id
        AND crl.sale_id=cr.sale_id AND crl.quantity_restocked>0
        AND (scope.product_id IS NULL OR scope.product_id=crl.product_id)
      LEFT JOIN inventory_operations io ON io.operation_type='customer_return'
        AND io.source_type='customer_return'
        AND io.source_id=CAST(cr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
        AND BINARY io.source_id=BINARY CAST(cr.id AS CHAR)
    UNION ALL
    SELECT 'purchase_receipt','purchase_receipt',CAST(pr.id AS CHAR),po.warehouse_id,
           pol.product_id,'IN',prl.quantity,pol.unit_snapshot,
           COALESCE(io.created_at,pr.received_at)
      FROM effect_scope scope
      JOIN purchase_orders po ON po.warehouse_id=scope.warehouse_id
        AND po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
      JOIN purchase_receipts pr ON pr.purchase_order_id=po.id
      JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id=pr.id
        AND prl.purchase_order_id=pr.purchase_order_id
      JOIN purchase_order_lines pol ON pol.id=prl.purchase_order_line_id
        AND pol.purchase_order_id=pr.purchase_order_id
        AND (scope.product_id IS NULL OR scope.product_id=pol.product_id)
      LEFT JOIN inventory_operations io ON io.operation_type='purchase_receipt'
        AND io.source_type='purchase_receipt'
        AND io.source_id=CAST(pr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
        AND BINARY io.source_id=BINARY CAST(pr.id AS CHAR)
    UNION ALL
    SELECT 'supplier_return','supplier_return',CAST(sr.id AS CHAR),po.warehouse_id,
           srl.product_id,'OUT',srl.quantity,srl.unit_snapshot,
           COALESCE(io.created_at,sr.returned_at)
      FROM effect_scope scope
      JOIN purchase_orders po ON po.warehouse_id=scope.warehouse_id
        AND po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
      JOIN supplier_returns sr ON sr.purchase_order_id=po.id
      JOIN supplier_return_lines srl ON srl.supplier_return_id=sr.id
        AND srl.purchase_order_id=sr.purchase_order_id
        AND srl.purchase_receipt_id=sr.purchase_receipt_id
        AND (scope.product_id IS NULL OR scope.product_id=srl.product_id)
      LEFT JOIN inventory_operations io ON io.operation_type='supplier_return'
        AND io.source_type='supplier_return'
        AND io.source_id=CAST(sr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
        AND BINARY io.source_id=BINARY CAST(sr.id AS CHAR)
  )`;
}

function uncreditedDocumentEffectsCte() {
  return `uncredited_document_effects AS (
    SELECT e.* FROM expected_document_effects e
     WHERE NOT EXISTS (
       SELECT 1 FROM inventory_operations io
       JOIN inventory_movements im ON im.operation_id=io.id
         WHERE io.operation_type=e.operation_type COLLATE utf8mb4_unicode_ci
           AND io.source_type=e.source_type COLLATE utf8mb4_unicode_ci
           AND io.source_id=e.source_id COLLATE utf8mb4_unicode_ci
           AND BINARY io.operation_type=BINARY e.operation_type
           AND BINARY io.source_type=BINARY e.source_type
           AND BINARY io.source_id=BINARY e.source_id
           AND io.source_warehouse_id=e.warehouse_id
          AND im.product_id=e.product_id AND im.warehouse_id=e.warehouse_id
          AND BINARY im.direction=BINARY e.direction AND im.quantity=e.quantity
          AND BINARY im.unit_snapshot=BINARY e.unit_snapshot
     )
  )`;
}

export function buildCurrentInventoryCtes(warehouseIds, filters = {}) {
  const list = idValues(warehouseIds);
  return {
    sql: `
      WITH scoped_balances AS (
        SELECT ib.product_id, ib.warehouse_id, ib.quantity, ib.version,
               p.unit AS catalog_unit, p.minimum_stock, p.is_active AS product_active,
               w.code AS warehouse_code, w.name AS warehouse_name,
               w.is_active AS warehouse_active
          FROM inventory_balances ib
          JOIN products p ON p.id = ib.product_id
          JOIN warehouses w ON w.id = ib.warehouse_id
         WHERE ib.warehouse_id IN (${list.sql})
      ), effect_scope AS (
        SELECT product_id,warehouse_id FROM scoped_balances GROUP BY product_id,warehouse_id
      ), ${expectedDocumentEffectsCte()}, ${uncreditedDocumentEffectsCte()}, transfer_effects AS (
        SELECT io.id AS operation_id,im.product_id,io.destination_warehouse_id AS warehouse_id,
               'IN' AS direction,im.quantity,im.unit_snapshot
          FROM inventory_operations io JOIN inventory_movements im ON im.operation_id=io.id
         WHERE io.operation_type='transfer' AND im.warehouse_id=io.source_warehouse_id
           AND im.direction='OUT'
        UNION ALL
        SELECT io.id,im.product_id,io.source_warehouse_id,'OUT',im.quantity,im.unit_snapshot
          FROM inventory_operations io JOIN inventory_movements im ON im.operation_id=io.id
         WHERE io.operation_type='transfer' AND im.warehouse_id=io.destination_warehouse_id
           AND im.direction='IN'
      ), transfer_gaps AS (
        SELECT te.product_id,te.warehouse_id,COUNT(*) AS missing_document_effects
          FROM transfer_effects te JOIN scoped_balances sb
            ON sb.product_id=te.product_id AND sb.warehouse_id=te.warehouse_id
         WHERE NOT EXISTS (
           SELECT 1 FROM inventory_movements counterpart
            WHERE counterpart.operation_id=te.operation_id
              AND counterpart.product_id=te.product_id AND counterpart.warehouse_id=te.warehouse_id
              AND BINARY counterpart.direction=BINARY te.direction
              AND counterpart.quantity=te.quantity
              AND BINARY counterpart.unit_snapshot=BINARY te.unit_snapshot
         ) GROUP BY te.product_id,te.warehouse_id
      ), document_gaps AS (
        SELECT product_id,warehouse_id,SUM(missing_document_effects) AS missing_document_effects
          FROM (
            SELECT product_id,warehouse_id,COUNT(*) AS missing_document_effects
              FROM uncredited_document_effects GROUP BY product_id,warehouse_id
            UNION ALL
            SELECT product_id,warehouse_id,missing_document_effects FROM transfer_gaps
          ) gaps GROUP BY product_id,warehouse_id
      ), history AS (
        SELECT sb.product_id, sb.warehouse_id, COUNT(im.id) AS movement_count,
               MIN(im.balance_version) AS first_version,
               MAX(im.balance_version) AS last_version,
               MAX(CASE WHEN im.balance_version = sb.version THEN im.balance_after END) AS latest_balance,
               MAX(CASE WHEN im.balance_version = sb.version THEN im.unit_snapshot END) AS latest_unit,
               COUNT(DISTINCT im.unit_snapshot) AS unit_count,
               SUM(CASE WHEN im.id IS NOT NULL AND (
                 (im.direction = 'IN' AND im.balance_after <> im.balance_before + im.quantity)
                 OR (im.direction = 'OUT' AND im.balance_before <> im.balance_after + im.quantity)
                 OR im.quantity = 0
               ) THEN 1 ELSE 0 END) AS arithmetic_errors,
               SUM(CASE WHEN im.id IS NOT NULL AND NOT (
                  (io.operation_type = 'transfer' AND (
                    ((im.direction = 'OUT' AND im.warehouse_id = io.source_warehouse_id)
                      OR (im.direction = 'IN' AND im.warehouse_id = io.destination_warehouse_id))
                    AND EXISTS (
                      SELECT 1 FROM inventory_movements counterpart
                       WHERE counterpart.operation_id=io.id
                         AND counterpart.product_id=im.product_id
                         AND counterpart.warehouse_id=IF(im.direction='OUT',io.destination_warehouse_id,io.source_warehouse_id)
                         AND counterpart.direction=IF(im.direction='OUT','IN','OUT')
                         AND counterpart.quantity=im.quantity
                         AND BINARY counterpart.unit_snapshot=BINARY im.unit_snapshot
                    )
                  ))
                 OR (io.operation_type IN ('initial_stock','adjustment_in','purchase_receipt','sale_reversal','customer_return')
                     AND im.direction = 'IN' AND im.warehouse_id = io.source_warehouse_id)
                OR (io.operation_type IN ('adjustment_out','supplier_return','sale_issue')
                      AND im.direction = 'OUT' AND im.warehouse_id = io.source_warehouse_id)
                ) THEN 1 ELSE 0 END) AS operation_shape_errors,
                SUM(CASE WHEN im.id IS NOT NULL AND (
                  (io.operation_type IN ('initial_stock','adjustment_in','adjustment_out','transfer')
                    AND (io.source_type IS NOT NULL OR io.source_id IS NOT NULL))
                  OR (io.operation_type = 'purchase_receipt' AND NOT EXISTS (
                    SELECT 1 FROM purchase_receipts pr JOIN purchase_orders po ON po.id=pr.purchase_order_id
                    JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id=pr.id
                    JOIN purchase_order_lines pol ON pol.id=prl.purchase_order_line_id
                      AND pol.purchase_order_id=pr.purchase_order_id
                     WHERE pr.source_operation_id=io.id AND io.source_type='purchase_receipt'
                       AND io.source_id=CAST(pr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                       AND po.warehouse_id=io.source_warehouse_id
                       AND po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
                       AND pol.product_id=im.product_id
                       AND prl.quantity=im.quantity AND BINARY pol.unit_snapshot=BINARY im.unit_snapshot
                       AND im.warehouse_id=po.warehouse_id AND im.direction='IN'
                  ))
                  OR (io.operation_type = 'supplier_return' AND NOT EXISTS (
                    SELECT 1 FROM supplier_returns sr JOIN purchase_orders po ON po.id=sr.purchase_order_id
                    JOIN supplier_return_lines srl ON srl.supplier_return_id=sr.id
                      AND srl.purchase_order_id=sr.purchase_order_id
                      AND srl.purchase_receipt_id=sr.purchase_receipt_id
                     WHERE sr.source_operation_id=io.id AND io.source_type='supplier_return'
                       AND io.source_id=CAST(sr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                       AND po.warehouse_id=io.source_warehouse_id
                       AND po.confirmed_at IS NOT NULL AND po.status IN ('confirmed','cancelled')
                       AND srl.product_id=im.product_id
                       AND srl.quantity=im.quantity AND BINARY srl.unit_snapshot=BINARY im.unit_snapshot
                       AND im.warehouse_id=po.warehouse_id AND im.direction='OUT'
                  ))
                  OR (io.operation_type = 'sale_issue' AND NOT EXISTS (
                    SELECT 1 FROM sales s JOIN sale_lines sl ON sl.sale_id=s.id
                     WHERE io.source_type='sale'
                       AND io.source_id REGEXP '^[1-9][0-9]*$'
                       AND s.id=CAST(io.source_id AS UNSIGNED)
                       AND s.warehouse_id=io.source_warehouse_id AND s.confirmed_at IS NOT NULL
                       AND s.status IN ('confirmed','cancelled') AND sl.product_id=im.product_id
                       AND sl.quantity=im.quantity AND BINARY sl.unit_snapshot=BINARY im.unit_snapshot
                       AND im.warehouse_id=s.warehouse_id AND im.direction='OUT'
                  ))
                  OR (io.operation_type = 'sale_reversal' AND NOT EXISTS (
                    SELECT 1 FROM sale_cancellations sc JOIN sales s ON s.id=sc.sale_id
                    JOIN sale_lines sl ON sl.sale_id=s.id
                     WHERE sc.source_operation_id=io.id AND io.source_type='sale_cancellation'
                       AND io.source_id=CAST(sc.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                       AND s.warehouse_id=io.source_warehouse_id AND s.status='cancelled'
                       AND s.confirmed_at IS NOT NULL AND s.cancelled_at IS NOT NULL
                       AND sl.product_id=im.product_id
                       AND sl.quantity=im.quantity AND BINARY sl.unit_snapshot=BINARY im.unit_snapshot
                       AND im.warehouse_id=s.warehouse_id AND im.direction='IN'
                  ))
                  OR (io.operation_type = 'customer_return' AND NOT EXISTS (
                    SELECT 1 FROM customer_returns cr JOIN sales s ON s.id=cr.sale_id
                    JOIN customer_return_lines crl ON crl.customer_return_id=cr.id
                      AND crl.sale_id=cr.sale_id
                     WHERE cr.source_operation_id=io.id AND io.source_type='customer_return'
                       AND io.source_id=CAST(cr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                       AND s.warehouse_id=io.source_warehouse_id AND s.status='confirmed'
                       AND s.confirmed_at IS NOT NULL AND crl.product_id=im.product_id
                       AND crl.quantity_restocked=im.quantity
                       AND BINARY crl.unit_snapshot=BINARY im.unit_snapshot
                       AND im.warehouse_id=s.warehouse_id AND im.direction='IN'
                  ))
                  OR (io.operation_type IN ('purchase_receipt','supplier_return','sale_issue','sale_reversal','customer_return')
                    AND (SELECT COUNT(*) FROM inventory_movements op_movement WHERE op_movement.operation_id=io.id)
                      <> CASE io.operation_type
                        WHEN 'purchase_receipt' THEN (SELECT COUNT(*) FROM purchase_receipts pr
                          JOIN purchase_receipt_lines prl ON prl.purchase_receipt_id=pr.id
                          WHERE pr.source_operation_id=io.id AND io.source_type='purchase_receipt'
                            AND io.source_id=CAST(pr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci)
                        WHEN 'supplier_return' THEN (SELECT COUNT(*) FROM supplier_returns sr
                          JOIN supplier_return_lines srl ON srl.supplier_return_id=sr.id
                          WHERE sr.source_operation_id=io.id AND io.source_type='supplier_return'
                            AND io.source_id=CAST(sr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci)
                        WHEN 'sale_issue' THEN (SELECT COUNT(*) FROM sales s JOIN sale_lines sl ON sl.sale_id=s.id
                          WHERE io.source_type='sale' AND io.source_id REGEXP '^[1-9][0-9]*$'
                            AND s.id=CAST(io.source_id AS UNSIGNED)
                            AND s.confirmed_at IS NOT NULL AND s.status IN ('confirmed','cancelled'))
                        WHEN 'sale_reversal' THEN (SELECT COUNT(*) FROM sale_cancellations sc
                          JOIN sale_lines sl ON sl.sale_id=sc.sale_id WHERE sc.source_operation_id=io.id
                            AND io.source_type='sale_cancellation'
                            AND io.source_id=CAST(sc.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci)
                        WHEN 'customer_return' THEN (SELECT COUNT(*) FROM customer_returns cr
                          JOIN customer_return_lines crl ON crl.customer_return_id=cr.id
                          WHERE cr.source_operation_id=io.id AND io.source_type='customer_return'
                            AND io.source_id=CAST(cr.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
                            AND crl.quantity_restocked>0)
                      END)
                ) THEN 1 ELSE 0 END) AS document_link_errors,
               SUM(CASE WHEN im.id IS NOT NULL AND (
                 (im.balance_version = 1 AND im.balance_before <> 0)
                 OR (im.balance_version > 1 AND NOT EXISTS (
                   SELECT 1 FROM inventory_movements prior
                    WHERE prior.product_id=im.product_id AND prior.warehouse_id=im.warehouse_id
                      AND prior.balance_version=im.balance_version-1
                      AND prior.balance_after=im.balance_before
                 ))
               ) THEN 1 ELSE 0 END) AS chain_errors
          FROM scoped_balances sb
          LEFT JOIN inventory_movements im
            ON im.product_id=sb.product_id AND im.warehouse_id=sb.warehouse_id
          LEFT JOIN inventory_operations io ON io.id=im.operation_id
         GROUP BY sb.product_id, sb.warehouse_id
      ), classified AS (
        SELECT sb.*, h.movement_count, h.latest_unit,
               CASE WHEN sb.version=0 AND sb.quantity=0 AND h.movement_count=0 THEN 1
                    WHEN sb.version>0 AND h.movement_count=sb.version
                      AND h.first_version=1 AND h.last_version=sb.version
                       AND h.latest_balance=sb.quantity AND h.latest_unit IS NOT NULL
                       AND h.unit_count=1 AND h.arithmetic_errors=0
                       AND h.operation_shape_errors=0
                       AND h.chain_errors=0 THEN 1 ELSE 0 END AS verified
                 ,CASE WHEN h.document_link_errors=0 AND COALESCE(dg.missing_document_effects,0)=0
                       THEN 1 ELSE 0 END AS documentary_verified
           FROM scoped_balances sb JOIN history h
             ON h.product_id=sb.product_id AND h.warehouse_id=sb.warehouse_id
           LEFT JOIN document_gaps dg ON dg.product_id=sb.product_id AND dg.warehouse_id=sb.warehouse_id
        ), filtered_eligible AS (
          SELECT warehouse_id, warehouse_code, warehouse_name, warehouse_active,
                 COALESCE(latest_unit,catalog_unit) AS unit,
                quantity, minimum_stock, product_active,
                (verified=1 AND documentary_verified=1) AS verified,
                (verified=0) AS inconsistent,
                (verified=1 AND documentary_verified=0) AS insufficient,
                 (verified=0 OR documentary_verified=0) AS unverified,
                (verified=1 AND documentary_verified=1 AND quantity>0) AS positive,
                (verified=1 AND documentary_verified=1 AND quantity=0) AS depleted,
                  (verified=1 AND documentary_verified=1 AND minimum_stock>0 AND quantity<minimum_stock) AS below_minimum
           FROM classified
          WHERE 1=1
            ${filters.unit ? "AND COALESCE(latest_unit,catalog_unit)=?" : ""}
            ${filters.status === "positive" ? "AND verified=1 AND documentary_verified=1 AND quantity>0" : ""}
            ${filters.status === "depleted" ? "AND verified=1 AND documentary_verified=1 AND quantity=0" : ""}
            ${filters.status === "below_minimum" ? "AND verified=1 AND documentary_verified=1 AND minimum_stock>0 AND quantity<minimum_stock" : ""}
            ${filters.status === "inconsistent" ? "AND verified=0" : ""}
            ${filters.status === "insufficient" ? "AND verified=1 AND documentary_verified=0" : ""}
            ${filters.productStatus === "active" ? "AND product_active=1" : ""}
            ${filters.productStatus === "inactive" ? "AND product_active=0" : ""}
        )`,
    values: [...list.values, ...(filters.unit ? [filters.unit] : [])],
  };
}

export function createInventoryReportsService({ dbPool }) {
  if (!dbPool) throw new TypeError("dbPool is required.");

  async function withReadTransaction(connection, operation) {
    if (connection) return operation(connection);
    const owned = await dbPool.getConnection();
    try {
      await owned.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await owned.query("SET TRANSACTION READ ONLY");
      await owned.beginTransaction();
      const result = await operation(owned);
      await owned.commit();
      return result;
    } catch (error) {
      await owned.rollback();
      throw error;
    } finally {
      owned.release();
    }
  }

  async function authorize(connection, auth, permissions) {
    if (!auth?.user?.id || !auth.sessionId || !allowedRoles.has(auth.user.role))
      denied();
    const [sessions] = await connection.execute(
      `SELECT u.id,r.code AS role_code,u.password_change_required
         FROM user_sessions us JOIN users u ON u.id=us.user_id JOIN roles r ON r.id=u.role_id
        WHERE us.id=? AND us.user_id=? AND us.revoked_at IS NULL
          AND us.expires_at>UTC_TIMESTAMP(3) AND u.is_active=1 LIMIT 1`,
      [auth.sessionId, auth.user.id],
    );
    if (
      !sessions[0] ||
      sessions[0].password_change_required ||
      sessions[0].role_code !== auth.user.role
    )
      denied();
    const [grants] = await connection.execute(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?) AND p.code IN (${permissions.map(() => "?").join(",")})`,
      [auth.user.id, ...permissions],
    );
    const granted = new Set(grants.map(({ code }) => code));
    if (permissions.some((permission) => !granted.has(permission))) denied();
    const [assignments] = await connection.execute(
      "SELECT warehouse_id FROM user_warehouses WHERE user_id=? ORDER BY warehouse_id",
      [auth.user.id],
    );
    return assignments.map(({ warehouse_id }) => String(warehouse_id));
  }

  async function currentStock({
    auth,
    connection,
    warehouseId,
    page,
    pageSize,
    unit,
    status,
    productStatus,
  }) {
    const paging = validatePage(page, pageSize);
    if (
      warehouseId !== undefined &&
      (typeof warehouseId !== "string" || !idPattern.test(warehouseId))
    ) {
      throw new HttpError(
        400,
        "INVALID_WAREHOUSE_ID",
        "La bodega indicada no es válida.",
      );
    }
    return withReadTransaction(connection, async (tx) => {
      const assigned = await authorize(tx, auth, stockPermissions);
      if (warehouseId !== undefined && !assigned.includes(warehouseId)) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const warehouseIds = warehouseId === undefined ? assigned : [warehouseId];
      if (!warehouseIds.length) {
        return {
          summary: {
            candidatePairs: "0",
            verifiedPairs: "0",
            excludedPairs: "0",
            inconsistentPairs: "0",
            insufficientPairs: "0",
            positivePairs: "0",
            depletedPairs: "0",
            belowMinimumPairs: "0",
            units: [],
          },
          groups: [],
          pagination: pagination(paging.page, paging.pageSize, "0"),
          coverage: {
            observation: "product_warehouse_pairs",
            candidateUniverse:
              "registered_balance_pairs_in_authorized_warehouses",
            candidatePairs: "0",
            verifiedPairs: "0",
            excludedPairs: "0",
            completeWithinCandidates: true,
            scope: "no_assigned_warehouses",
          },
          generatedAt: new Date().toISOString(),
        };
      }
      const ctes = buildCurrentInventoryCtes(warehouseIds, {
        unit,
        status,
        productStatus,
      });
      const filteredSql = ctes.sql;
      // The sentinel preserves a zero-valued grand total for an empty scope.
      const [reportRows] = await tx.execute(
        `${filteredSql}, stock_rows AS (
          SELECT filtered_eligible.*,0 AS is_sentinel FROM filtered_eligible
          UNION ALL
          SELECT NULL,NULL,NULL,NULL,'',0,0,0,0,0,0,0,0,0,0,1
        ), stock_rollup AS (
          SELECT unit, warehouse_id,
            CASE WHEN warehouse_id IS NULL THEN NULL ELSE MAX(warehouse_code) END AS warehouse_code,
            CASE WHEN warehouse_id IS NULL THEN NULL ELSE MAX(warehouse_name) END AS warehouse_name,
            CASE WHEN warehouse_id IS NULL THEN NULL ELSE MAX(warehouse_active) END AS warehouse_active,
            SUM(CASE WHEN is_sentinel=0 AND verified=1 THEN quantity ELSE 0 END) AS verified_quantity,
            COUNT(CASE WHEN is_sentinel=0 THEN 1 END) AS candidate_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN verified ELSE 0 END) AS verified_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN unverified ELSE 0 END) AS excluded_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN inconsistent ELSE 0 END) AS inconsistent_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN insufficient ELSE 0 END) AS insufficient_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN positive ELSE 0 END) AS positive_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN depleted ELSE 0 END) AS depleted_pairs,
            SUM(CASE WHEN is_sentinel=0 THEN below_minimum ELSE 0 END) AS below_minimum_pairs,
            SUM(CASE WHEN is_sentinel=0 AND verified=1 AND product_active=0 THEN 1 ELSE 0 END)
              AS inactive_product_pairs
            FROM stock_rows
           GROUP BY unit,warehouse_id WITH ROLLUP
        ), stock_classified AS (
          SELECT stock_rollup.*,
            CASE WHEN unit='' THEN 'sentinel'
                 WHEN unit IS NULL THEN 'totals'
                 WHEN warehouse_id IS NULL THEN 'unit'
                 ELSE 'group' END AS row_type
            FROM stock_rollup
        ), stock_ranked AS (
          SELECT stock_classified.*,
            CASE WHEN row_type='group' THEN
              ROW_NUMBER() OVER (
                PARTITION BY row_type
                ORDER BY warehouse_name,warehouse_id,unit
              )
            END AS group_row_number,
            COUNT(CASE WHEN row_type='group' THEN 1 END) OVER () AS group_count
            FROM stock_classified
        )
        SELECT row_type,unit,warehouse_id,warehouse_code,warehouse_name,warehouse_active,
               verified_quantity,candidate_pairs,verified_pairs,excluded_pairs,
               inconsistent_pairs,insufficient_pairs,positive_pairs,depleted_pairs,
               below_minimum_pairs,inactive_product_pairs,group_count
          FROM stock_ranked
         WHERE row_type<>'sentinel'
           AND (row_type<>'group' OR (group_row_number>? AND group_row_number<=?))
         ORDER BY CASE row_type WHEN 'unit' THEN 1 WHEN 'totals' THEN 2 ELSE 3 END,
                  warehouse_name,warehouse_id,unit`,
        [...ctes.values, paging.offset, paging.offset + paging.pageSize],
      );
      const units = reportRows
        .filter(({ row_type }) => row_type === "unit")
        .map((row) => ({
          unit: row.unit,
          candidatePairs: String(row.candidate_pairs),
          verifiedPairs: String(row.verified_pairs),
          quantity: String(row.verified_quantity ?? "0"),
          excludedPairs: String(row.excluded_pairs),
          inconsistentPairs: String(row.inconsistent_pairs),
          insufficientPairs: String(row.insufficient_pairs),
          inactiveProductPairs: String(row.inactive_product_pairs),
        }));
      const totals =
        reportRows.find(({ row_type }) => row_type === "totals") ?? {};
      const groups = reportRows
        .filter(({ row_type }) => row_type === "group")
        .map((row) => ({
          warehouseId: String(row.warehouse_id),
          warehouseCode: row.warehouse_code,
          warehouseName: row.warehouse_name,
          warehouseActive: Boolean(row.warehouse_active),
          unit: row.unit,
          quantity: String(row.verified_quantity ?? "0"),
          candidatePairs: String(row.candidate_pairs),
          verifiedPairs: String(row.verified_pairs),
          excludedPairs: String(row.excluded_pairs),
          inconsistentPairs: String(row.inconsistent_pairs),
          insufficientPairs: String(row.insufficient_pairs),
          positivePairs: String(row.positive_pairs),
          depletedPairs: String(row.depleted_pairs),
          belowMinimumPairs: String(row.below_minimum_pairs),
          inactiveProductPairs: String(row.inactive_product_pairs),
        }));
      const groupCount = String(reportRows[0]?.group_count ?? "0");
      return {
        summary: {
          ...Object.fromEntries(
            Object.entries(totals)
              .filter(([key]) => key.endsWith("_pairs"))
              .map(([key, value]) => [
                key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                String(value ?? "0"),
              ]),
          ),
          units,
        },
        groups,
        pagination: pagination(paging.page, paging.pageSize, groupCount),
        coverage: {
          observation: "product_warehouse_pairs",
          candidateUniverse:
            "registered_balance_pairs_in_authorized_warehouses",
          candidatePairs: String(totals.candidate_pairs ?? "0"),
          verifiedPairs: String(totals.verified_pairs ?? "0"),
          excludedPairs: String(totals.excluded_pairs ?? "0"),
          completeWithinCandidates: BigInt(totals.excluded_pairs ?? 0) === 0n,
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async function periodActivity({
    auth,
    connection,
    dateFrom,
    dateTo,
    warehouseId,
    page,
    pageSize,
    unit,
    operationType,
    direction,
  }) {
    const period = validateInventoryActivityPeriod(dateFrom, dateTo);
    const paging = validatePage(page, pageSize);
    if (
      warehouseId !== undefined &&
      (typeof warehouseId !== "string" || !idPattern.test(warehouseId))
    ) {
      throw new HttpError(
        400,
        "INVALID_WAREHOUSE_ID",
        "La bodega indicada no es válida.",
      );
    }
    return withReadTransaction(connection, async (tx) => {
      const assigned = await authorize(tx, auth, activityPermissions);
      if (warehouseId !== undefined && !assigned.includes(warehouseId)) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const warehouseIds = warehouseId === undefined ? assigned : [warehouseId];
      const empty = {
        summary: {
          candidateMovements: "0",
          verifiedMovements: "0",
          excludedMovements: "0",
          inconsistentMovements: "0",
          insufficientMovements: "0",
          documentEffects: {
            observation: "commercial_document_line_effects",
            unit: "document_line_effects",
            candidateEffects: "0",
            uncreditedEffects: "0",
          },
          transferIntegrity: {
            observation: "transfer_operations",
            candidateOperations: "0",
            incompleteOperations: "0",
          },
          units: [],
        },
        groups: [],
        pagination: pagination(paging.page, paging.pageSize, "0"),
        coverage: {
          observation: "physical_movements",
          candidateUniverse:
            "movements_in_authorized_warehouses_for_scoped_operations",
          candidateMovements: "0",
          verifiedMovements: "0",
          excludedMovements: "0",
          completeWithinCandidates: true,
          scope: "no_assigned_warehouses",
          documentEffects: {
            observation: "commercial_document_line_effects",
            unit: "document_line_effects",
            candidateEffects: "0",
            uncreditedEffects: "0",
            completeWithinCandidates: true,
          },
          transferIntegrity: {
            observation: "transfer_operations",
            candidateOperations: "0",
            incompleteOperations: "0",
            completeWithinCandidates: true,
          },
        },
        criteria: {
          dateFrom,
          dateTo,
          timestamp: "inventory_operations.created_at",
          timeZone: "America/Bogota",
          periodSemantics:
            "Actividad física registrada durante el período; no representa un saldo de cierre.",
        },
        generatedAt: new Date().toISOString(),
      };
      if (!warehouseIds.length) return empty;

      const ctes = buildInventoryActivityCtes(warehouseIds, {
        unit,
        operationType,
        direction,
      });
      const effectFilter = [
        unit ? "AND unit_snapshot=?" : "",
        operationType ? "AND operation_type=?" : "",
        direction ? "AND direction=?" : "",
      ].join(" ");
      const effectFilterValues = [
        ...(unit ? [unit] : []),
        ...(operationType ? [operationType] : []),
        ...(direction ? [direction] : []),
      ];
      const values = [
        period.startUtc,
        period.endUtc,
        ...ctes.warehouseIds,
        period.startUtc,
        period.endUtc,
        ...ctes.warehouseIds,
        ...ctes.warehouseIds,
        ...ctes.warehouseIds,
        ...ctes.warehouseIds,
        ...ctes.values,
      ];
      const [[documentEffectTotals]] = await tx.execute(
        `${ctes.sql} SELECT COUNT(*) AS candidate_effects,
          (SELECT COUNT(*) FROM uncredited_document_effects u
            WHERE u.occurred_at>=? AND u.occurred_at<? ${effectFilter}) AS uncredited_effects
         FROM expected_document_effects e WHERE e.occurred_at>=? AND e.occurred_at<? ${effectFilter}`,
        [
          ...values,
          period.startUtc,
          period.endUtc,
          ...effectFilterValues,
          period.startUtc,
          period.endUtc,
          ...effectFilterValues,
        ],
      );
      const transferFilter = [
        operationType && operationType !== "transfer" ? "AND 1=0" : "",
        unit
          ? `AND EXISTS (SELECT 1 FROM inventory_movements tm WHERE tm.operation_id=tic.id
              AND tm.warehouse_id IN (${warehouseIds.map(() => "?").join(",")}) AND tm.unit_snapshot=?)`
          : "",
        direction
          ? `AND EXISTS (SELECT 1 FROM inventory_movements tm WHERE tm.operation_id=tic.id
              AND tm.warehouse_id IN (${warehouseIds.map(() => "?").join(",")}) AND tm.direction=?)`
          : "",
      ].join(" ");
      const transferFilterValues = [
        ...(unit ? [...warehouseIds, unit] : []),
        ...(direction ? [...warehouseIds, direction] : []),
      ];
      const [[transferTotals]] = await tx.execute(
        `${ctes.sql} SELECT COUNT(*) AS candidate_operations,
          COALESCE(SUM(incomplete=1),0) AS incomplete_operations
         FROM transfer_integrity_candidates tic WHERE 1=1 ${transferFilter}`,
        [...values, ...transferFilterValues],
      );
      const [[totals]] = await tx.execute(
        `${ctes.sql} SELECT COUNT(*) AS candidate_movements,
          SUM(is_valid=1) AS verified_movements,SUM(is_valid=0) AS excluded_movements,
          SUM(exclusion_class='inconsistent') AS inconsistent_movements,
          SUM(exclusion_class='insufficient') AS insufficient_movements
          FROM filtered_candidates`,
        values,
      );
      const [unitRows] = await tx.execute(
        `${ctes.sql} SELECT unit_snapshot AS unit,COUNT(*) AS verified_movements,
          SUM(CASE WHEN direction='IN' THEN quantity ELSE 0 END) AS entries,
          SUM(CASE WHEN direction='OUT' THEN quantity ELSE 0 END) AS exits,
          SUM(CASE WHEN direction='IN' THEN quantity ELSE -quantity END) AS net_change
          FROM filtered_eligible GROUP BY unit_snapshot ORDER BY unit_snapshot`,
        values,
      );
      const [[countRow]] = await tx.execute(
        `${ctes.sql} SELECT COUNT(*) AS total FROM (
           SELECT warehouse_id,operation_type,unit_snapshot FROM filtered_eligible
          GROUP BY warehouse_id,operation_type,unit_snapshot
        ) grouped`,
        values,
      );
      const [groups] = await tx.execute(
        `${ctes.sql} SELECT warehouse_id,warehouse_code,warehouse_name,warehouse_active,
          operation_type,unit_snapshot AS unit,COUNT(*) AS verified_movements,
          SUM(CASE WHEN direction='IN' THEN quantity ELSE 0 END) AS entries,
          SUM(CASE WHEN direction='OUT' THEN quantity ELSE 0 END) AS exits,
          SUM(CASE WHEN direction='IN' THEN quantity ELSE -quantity END) AS net_change
          FROM filtered_eligible
         GROUP BY warehouse_id,warehouse_code,warehouse_name,warehouse_active,operation_type,unit_snapshot
         ORDER BY warehouse_name,warehouse_id,operation_type,unit_snapshot LIMIT ? OFFSET ?`,
        [...values, paging.pageSize, paging.offset],
      );
      return {
        summary: {
          candidateMovements: String(totals.candidate_movements ?? "0"),
          verifiedMovements: String(totals.verified_movements ?? "0"),
          excludedMovements: String(totals.excluded_movements ?? "0"),
          inconsistentMovements: String(totals.inconsistent_movements ?? "0"),
          insufficientMovements: String(totals.insufficient_movements ?? "0"),
          documentEffects: {
            observation: "commercial_document_line_effects",
            unit: "document_line_effects",
            candidateEffects: String(
              documentEffectTotals.candidate_effects ?? "0",
            ),
            uncreditedEffects: String(
              documentEffectTotals.uncredited_effects ?? "0",
            ),
          },
          transferIntegrity: {
            observation: "transfer_operations",
            candidateOperations: String(
              transferTotals.candidate_operations ?? "0",
            ),
            incompleteOperations: String(
              transferTotals.incomplete_operations ?? "0",
            ),
          },
          units: unitRows.map((row) => ({
            unit: row.unit,
            verifiedMovements: String(row.verified_movements),
            entries: String(row.entries),
            exits: String(row.exits),
            netChange: String(row.net_change),
          })),
        },
        groups: groups.map((row) => ({
          warehouseId: String(row.warehouse_id),
          warehouseCode: row.warehouse_code,
          warehouseName: row.warehouse_name,
          warehouseActive: Boolean(row.warehouse_active),
          operationType: row.operation_type,
          unit: row.unit,
          verifiedMovements: String(row.verified_movements),
          entries: String(row.entries),
          exits: String(row.exits),
          netChange: String(row.net_change),
        })),
        pagination: pagination(paging.page, paging.pageSize, countRow.total),
        coverage: {
          observation: "physical_movements",
          candidateUniverse:
            "movements_in_authorized_warehouses_for_scoped_operations",
          candidateMovements: String(totals.candidate_movements ?? "0"),
          verifiedMovements: String(totals.verified_movements ?? "0"),
          excludedMovements: String(totals.excluded_movements ?? "0"),
          completeWithinCandidates:
            BigInt(totals.excluded_movements ?? 0) === 0n,
          documentEffects: {
            observation: "commercial_document_line_effects",
            unit: "document_line_effects",
            candidateEffects: String(
              documentEffectTotals.candidate_effects ?? "0",
            ),
            uncreditedEffects: String(
              documentEffectTotals.uncredited_effects ?? "0",
            ),
            completeWithinCandidates:
              BigInt(documentEffectTotals.uncredited_effects ?? 0) === 0n,
          },
          transferIntegrity: {
            observation: "transfer_operations",
            candidateOperations: String(
              transferTotals.candidate_operations ?? "0",
            ),
            incompleteOperations: String(
              transferTotals.incomplete_operations ?? "0",
            ),
            completeWithinCandidates:
              BigInt(transferTotals.incomplete_operations ?? 0) === 0n,
          },
        },
        criteria: {
          dateFrom,
          dateTo,
          timestamp:
            "inventory_operations.created_at_or_unlinked_document_event_at",
          timeZone: "America/Bogota",
          periodSemantics:
            "Actividad física registrada durante el período; no representa un saldo de cierre.",
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async function listAuthorizedWarehouses({
    auth,
    view,
    connection,
    q = "",
    page = 1,
    pageSize = 20,
  }) {
    const permissions =
      view === "balances"
        ? stockPermissions
        : view === "movements"
          ? activityPermissions
          : null;
    if (!permissions) {
      throw new HttpError(
        400,
        "INVALID_INVENTORY_VIEW",
        "La vista de Inventario indicada no es válida.",
      );
    }
    return withReadTransaction(connection, async (tx) => {
      const assigned = await authorize(tx, auth, permissions);
      if (!assigned.length) {
        return {
          items: [],
          pagination: { page: 1, pageSize: 20, total: "0", totalPages: "0" },
        };
      }
      const filter = q ? "AND (code LIKE ? OR name LIKE ?)" : "";
      const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const searchValues = q ? [search, search] : [];
      const [[count]] = await tx.execute(
        `SELECT COUNT(*) AS total FROM warehouses
          WHERE id IN (${assigned.map(() => "?").join(",")}) ${filter}`,
        [...assigned, ...searchValues],
      );
      const [rows] = await tx.execute(
        `SELECT id,code,name,is_active FROM warehouses
          WHERE id IN (${assigned.map(() => "?").join(",")}) ${filter}
          ORDER BY name,id LIMIT ? OFFSET ?`,
        [...assigned, ...searchValues, pageSize, (page - 1) * pageSize],
      );
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          code: row.code,
          name: row.name,
          isActive: Boolean(row.is_active),
        })),
        pagination: {
          page,
          pageSize,
          total: String(count.total),
          totalPages: pagination(page, pageSize, count.total).totalPages,
        },
      };
    });
  }

  return { currentStock, periodActivity, listAuthorizedWarehouses };
}
