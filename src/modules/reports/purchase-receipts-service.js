import { HttpError } from "../../shared/http-error.js";
import { bogotaUtcBoundaries } from "./sales-activity-service.js";

const allowedRoles = new Set(["administrator", "auditor"]);
const requiredPermissions = [
  "reports.read",
  "purchases.read",
  "warehouses.read",
];
const idPattern = /^[1-9]\d{0,19}$/;
const maxUnsignedBigint = 18446744073709551615n;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validId(value) {
  return (
    typeof value === "string" &&
    idPattern.test(value) &&
    BigInt(value) <= maxUnsignedBigint
  );
}

function civilDate(value) {
  if (typeof value !== "string" || !datePattern.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function validatePurchaseReceiptsPeriod(dateFrom, dateTo) {
  const from = civilDate(dateFrom);
  const to = civilDate(dateTo);
  if (
    !from ||
    !to ||
    from > to ||
    (to.getTime() - from.getTime()) / 86400000 > 91
  ) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PERIOD",
      "El período debe ser válido y no superar 92 días calendario.",
    );
  }
  return true;
}

function decimalToMinorUnits(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new TypeError("El importe SQL no es un DECIMAL válido.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function minorUnitsToDecimal(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function normalizeSqlMoney(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new TypeError("El importe SQL no es un DECIMAL válido.");
  return `${match[1]}.${(match[2] || "").padEnd(2, "0")}`;
}

export function calculateReferenceNetReceived(receivedValue, returnedValue) {
  return minorUnitsToDecimal(
    decimalToMinorUnits(receivedValue) - decimalToMinorUnits(returnedValue),
  );
}

export function calculateUnitDifferences(rows) {
  return rows.map(({ unit, received, returned }) => {
    if (
      typeof received !== "string" ||
      !/^(0|[1-9]\d*)$/.test(received) ||
      typeof returned !== "string" ||
      !/^(0|[1-9]\d*)$/.test(returned)
    ) {
      throw new TypeError("La cantidad SQL no es un entero válido.");
    }
    return {
      unit,
      quantityReceived: received,
      quantityReturned: returned,
      quantityDifference: (BigInt(received) - BigInt(returned)).toString(),
    };
  });
}

const eligibleFactsSql = `
WITH scoped_receipts AS (
  SELECT pr.id, pr.purchase_order_id, pr.source_operation_id, pr.received_at,
         po.warehouse_id, po.status AS order_status, po.confirmed_at,
         io.id AS operation_id, io.operation_type, io.source_type,
         io.source_id, io.source_warehouse_id, io.destination_warehouse_id
    FROM purchase_receipts pr
    JOIN purchase_orders po ON po.id = pr.purchase_order_id
    LEFT JOIN inventory_operations io ON io.id = pr.source_operation_id
   WHERE po.warehouse_id IN (__WAREHOUSE_IDS__)
     AND (
       (pr.received_at >= ? AND pr.received_at < ?)
       OR EXISTS (
         SELECT 1 FROM supplier_returns candidate_return
          WHERE candidate_return.purchase_receipt_id = pr.id
            AND candidate_return.purchase_order_id = pr.purchase_order_id
            AND candidate_return.returned_at >= ?
            AND candidate_return.returned_at < ?
       )
     )
), receipt_integrity AS (
  SELECT sr.*,
         CASE
           WHEN sr.order_status <> 'confirmed' OR sr.confirmed_at IS NULL
             OR sr.confirmed_at > sr.received_at
             THEN 'unconfirmed_order'
           WHEN sr.source_operation_id IS NULL OR sr.operation_id IS NULL
             OR sr.operation_type <> 'purchase_receipt'
             OR sr.source_type IS NULL OR sr.source_type <> 'purchase_receipt'
             OR sr.source_id IS NULL
             OR BINARY sr.source_id <> BINARY CAST(sr.id AS CHAR)
             OR sr.source_warehouse_id <> sr.warehouse_id
             OR sr.destination_warehouse_id IS NOT NULL
             THEN 'invalid_inventory_operation'
            WHEN NOT EXISTS (
              SELECT 1 FROM purchase_receipt_lines missing_line
               WHERE missing_line.purchase_receipt_id = sr.id
                 AND missing_line.purchase_order_id = sr.purchase_order_id
            ) THEN 'missing_receipt_lines'
            WHEN EXISTS (
              SELECT 1 FROM purchase_receipt_lines wrong_order_line
               WHERE wrong_order_line.purchase_receipt_id = sr.id
                 AND wrong_order_line.purchase_order_id <> sr.purchase_order_id
            ) THEN 'receipt_line_order_mismatch'
            WHEN (SELECT COUNT(*) FROM inventory_movements all_movements
                  WHERE all_movements.operation_id = sr.operation_id)
                <> (SELECT COUNT(*) FROM purchase_receipt_lines all_lines
                     WHERE all_lines.purchase_receipt_id = sr.id)
             OR EXISTS (
               SELECT 1
                 FROM purchase_receipt_lines prl
                 JOIN purchase_order_lines pol
                   ON pol.id = prl.purchase_order_line_id
                  AND pol.purchase_order_id = prl.purchase_order_id
                WHERE prl.purchase_receipt_id = sr.id
                   AND (pol.is_active <> 1 OR NOT EXISTS (
                    SELECT 1 FROM inventory_movements im
                     WHERE im.operation_id = sr.operation_id
                       AND im.product_id = pol.product_id
                       AND im.warehouse_id = sr.warehouse_id
                       AND im.direction = 'IN'
                       AND im.quantity = prl.quantity
                        AND BINARY im.unit_snapshot = BINARY pol.unit_snapshot
                   ))
              ) OR EXISTS (
                SELECT 1 FROM inventory_movements unmatched_movement
                 WHERE unmatched_movement.operation_id = sr.operation_id
                   AND NOT EXISTS (
                     SELECT 1
                       FROM purchase_receipt_lines matched_line
                       JOIN purchase_order_lines matched_order_line
                         ON matched_order_line.id = matched_line.purchase_order_line_id
                        AND matched_order_line.purchase_order_id = matched_line.purchase_order_id
                      WHERE matched_line.purchase_receipt_id = sr.id
                        AND matched_line.purchase_order_id = sr.purchase_order_id
                        AND matched_order_line.product_id = unmatched_movement.product_id
                        AND unmatched_movement.warehouse_id = sr.warehouse_id
                        AND unmatched_movement.direction = 'IN'
                        AND unmatched_movement.quantity = matched_line.quantity
                        AND BINARY unmatched_movement.unit_snapshot = BINARY matched_order_line.unit_snapshot
                   )
              ) THEN 'inventory_movement_mismatch'
           ELSE NULL
         END AS exclusion_reason
    FROM scoped_receipts sr
), eligible_receipts AS (
  SELECT * FROM receipt_integrity WHERE exclusion_reason IS NULL
), scoped_returns AS (
  SELECT sr.id, sr.purchase_order_id, sr.purchase_receipt_id,
         sr.source_operation_id, sr.returned_at,
         po.warehouse_id, po.status AS order_status, po.confirmed_at,
         io.id AS operation_id, io.operation_type, io.source_type,
         io.source_id, io.source_warehouse_id, io.destination_warehouse_id,
         pr.received_at AS receipt_received_at,
         pr.source_operation_id AS receipt_source_operation_id,
         receipt_operation.operation_type AS receipt_operation_type,
         receipt_operation.source_type AS receipt_source_type,
         receipt_operation.source_id AS receipt_source_id,
         receipt_operation.source_warehouse_id AS receipt_source_warehouse_id,
         ri.exclusion_reason AS receipt_exclusion_reason
    FROM supplier_returns sr
    JOIN purchase_orders po ON po.id = sr.purchase_order_id
    JOIN purchase_receipts pr
      ON pr.id = sr.purchase_receipt_id
     AND pr.purchase_order_id = sr.purchase_order_id
    LEFT JOIN inventory_operations io ON io.id = sr.source_operation_id
    LEFT JOIN inventory_operations receipt_operation
      ON receipt_operation.id = pr.source_operation_id
    LEFT JOIN receipt_integrity ri ON ri.id = pr.id
   WHERE po.warehouse_id IN (__WAREHOUSE_IDS__)
     AND sr.returned_at >= ? AND sr.returned_at < ?
), return_integrity AS (
  SELECT sr.*,
         CASE
           WHEN sr.order_status <> 'confirmed' OR sr.confirmed_at IS NULL
             OR sr.confirmed_at > sr.receipt_received_at
             THEN 'unconfirmed_order'
           WHEN sr.receipt_exclusion_reason IS NOT NULL
             OR sr.receipt_source_operation_id IS NULL
             OR sr.receipt_operation_type <> 'purchase_receipt'
             OR sr.receipt_source_type IS NULL
             OR sr.receipt_source_type <> 'purchase_receipt'
             OR sr.receipt_source_id IS NULL
             OR BINARY sr.receipt_source_id <> BINARY CAST(sr.purchase_receipt_id AS CHAR)
             OR sr.receipt_source_warehouse_id <> sr.warehouse_id
             THEN 'unverified_source_receipt'
           WHEN sr.returned_at < sr.receipt_received_at
             THEN 'return_before_receipt'
           WHEN sr.source_operation_id IS NULL OR sr.operation_id IS NULL
             OR sr.operation_type <> 'supplier_return'
             OR sr.source_type IS NULL OR sr.source_type <> 'supplier_return'
             OR sr.source_id IS NULL
             OR BINARY sr.source_id <> BINARY CAST(sr.id AS CHAR)
             OR sr.source_warehouse_id <> sr.warehouse_id
             OR sr.destination_warehouse_id IS NOT NULL
             THEN 'invalid_inventory_operation'
           WHEN NOT EXISTS (
             SELECT 1 FROM supplier_return_lines missing_line
              WHERE missing_line.supplier_return_id = sr.id
                AND missing_line.purchase_order_id = sr.purchase_order_id
                AND missing_line.purchase_receipt_id = sr.purchase_receipt_id
           ) THEN 'missing_return_lines'
           WHEN EXISTS (
             SELECT 1
               FROM supplier_return_lines srl
               JOIN purchase_receipt_lines prl
                 ON prl.id = srl.purchase_receipt_line_id
                AND prl.purchase_receipt_id = srl.purchase_receipt_id
                AND prl.purchase_order_line_id = srl.purchase_order_line_id
                AND prl.purchase_order_id = srl.purchase_order_id
                JOIN purchase_order_lines pol
                  ON pol.id = srl.purchase_order_line_id
                 AND pol.purchase_order_id = srl.purchase_order_id
                 AND pol.product_id = srl.product_id
                WHERE srl.supplier_return_id = sr.id
                 AND (pol.is_active <> 1
                  OR BINARY srl.sku_snapshot <> BINARY pol.sku_snapshot
                  OR BINARY srl.name_snapshot <> BINARY pol.name_snapshot
                  OR BINARY srl.unit_snapshot <> BINARY pol.unit_snapshot
                  OR (SELECT COALESCE(SUM(all_returns.quantity), 0)
                        FROM supplier_return_lines all_returns
                        JOIN supplier_returns all_return_documents
                          ON all_return_documents.id = all_returns.supplier_return_id
                       WHERE all_returns.purchase_receipt_line_id = prl.id
                         AND (all_return_documents.returned_at < sr.returned_at
                           OR (all_return_documents.returned_at = sr.returned_at
                             AND all_return_documents.id <= sr.id)))
                     > prl.quantity)
           ) THEN 'invalid_return_reference_or_quantity'
           WHEN (SELECT COUNT(*) FROM inventory_movements all_movements
                  WHERE all_movements.operation_id = sr.operation_id)
                <> (SELECT COUNT(*) FROM supplier_return_lines all_lines
                     WHERE all_lines.supplier_return_id = sr.id)
             OR EXISTS (
               SELECT 1
                 FROM supplier_return_lines srl
                WHERE srl.supplier_return_id = sr.id
                  AND NOT EXISTS (
                    SELECT 1
                      FROM inventory_movements im
                     WHERE im.operation_id = sr.operation_id
                       AND im.product_id = srl.product_id
                       AND im.warehouse_id = sr.warehouse_id
                       AND im.direction = 'OUT'
                       AND im.quantity = srl.quantity
                       AND BINARY im.unit_snapshot = BINARY srl.unit_snapshot
                  )
             ) THEN 'inventory_movement_mismatch'
           ELSE NULL
         END AS exclusion_reason
    FROM scoped_returns sr
), eligible_returns AS (
  SELECT * FROM return_integrity WHERE exclusion_reason IS NULL
), receipt_documents AS (
  SELECT er.id,
         CAST(SUM(prl.quantity * pol.unit_cost) AS CHAR) AS amount
    FROM eligible_receipts er
    JOIN purchase_receipt_lines prl
      ON prl.purchase_receipt_id = er.id
     AND prl.purchase_order_id = er.purchase_order_id
    JOIN purchase_order_lines pol
      ON pol.id = prl.purchase_order_line_id
     AND pol.purchase_order_id = prl.purchase_order_id
   WHERE er.received_at >= ? AND er.received_at < ?
   GROUP BY er.id
), return_documents AS (
  SELECT er.id,
         CAST(SUM(srl.quantity * pol.unit_cost) AS CHAR) AS amount
    FROM eligible_returns er
    JOIN supplier_return_lines srl
      ON srl.supplier_return_id = er.id
     AND srl.purchase_order_id = er.purchase_order_id
     AND srl.purchase_receipt_id = er.purchase_receipt_id
    JOIN purchase_order_lines pol
      ON pol.id = srl.purchase_order_line_id
     AND pol.purchase_order_id = srl.purchase_order_id
     AND pol.product_id = srl.product_id
   GROUP BY er.id
), quantity_facts AS (
  SELECT pol.unit_snapshot AS unit, SUM(prl.quantity) AS received, 0 AS returned
    FROM eligible_receipts er
    JOIN purchase_receipt_lines prl
      ON prl.purchase_receipt_id = er.id
     AND prl.purchase_order_id = er.purchase_order_id
    JOIN purchase_order_lines pol
      ON pol.id = prl.purchase_order_line_id
     AND pol.purchase_order_id = prl.purchase_order_id
   WHERE er.received_at >= ? AND er.received_at < ?
   GROUP BY pol.unit_snapshot
  UNION ALL
  SELECT srl.unit_snapshot AS unit, 0 AS received, SUM(srl.quantity) AS returned
    FROM eligible_returns er
    JOIN supplier_return_lines srl
      ON srl.supplier_return_id = er.id
     AND srl.purchase_order_id = er.purchase_order_id
     AND srl.purchase_receipt_id = er.purchase_receipt_id
   GROUP BY srl.unit_snapshot
), unit_totals AS (
  SELECT unit, CAST(SUM(received) AS CHAR) AS received,
         CAST(SUM(returned) AS CHAR) AS returned
    FROM quantity_facts GROUP BY unit
 ), summary_values AS (
   SELECT CAST(COALESCE((SELECT SUM(amount) FROM receipt_documents), CAST(0 AS DECIMAL(65,2))) AS CHAR) AS received_value,
          CAST(COALESCE((SELECT SUM(amount) FROM return_documents), CAST(0 AS DECIMAL(65,2))) AS CHAR) AS returned_value
 ), excluded_documents AS (
  SELECT 'purchase_receipt' AS document_type, exclusion_reason AS reason, COUNT(*) AS total
    FROM receipt_integrity
   WHERE exclusion_reason IS NOT NULL AND received_at >= ? AND received_at < ?
   GROUP BY exclusion_reason
  UNION ALL
  SELECT 'supplier_return', exclusion_reason, COUNT(*)
    FROM return_integrity
    WHERE exclusion_reason IS NOT NULL
    GROUP BY exclusion_reason
 )
 SELECT 'summary' AS row_type, NULL AS unit, received_value,
        returned_value, NULL AS received, NULL AS returned,
        NULL AS document_type, NULL AS reason, NULL AS excluded_count
   FROM summary_values
 UNION ALL
 SELECT 'unit', unit, NULL, NULL, received, returned, NULL, NULL, NULL
   FROM unit_totals
 UNION ALL
 SELECT 'excluded', NULL, NULL, NULL, NULL, NULL,
        document_type, reason, CAST(total AS CHAR)
   FROM excluded_documents
 `;

const eligibleDocumentsCte = eligibleFactsSql.slice(
  0,
  eligibleFactsSql.indexOf("receipt_documents AS ("),
);

export function buildPurchaseReceiptActivitiesQuery({
  warehouseIds,
  startUtc,
  endUtc,
  pageSize,
  offset,
}) {
  const activitiesCte = `activities AS (
      SELECT CONCAT('purchase_receipt:',CAST(er.id AS CHAR)) AS activity_id,
             'purchase_receipt' AS activity_type,er.received_at AS occurred_at,
             CAST(er.id AS CHAR) AS source_id,
             CAST(er.purchase_order_id AS CHAR) AS purchase_order_id,
             CAST(er.id AS CHAR) AS purchase_receipt_id,
             NULL AS supplier_return_id,CAST(er.warehouse_id AS CHAR) AS warehouse_id,
             w.code AS warehouse_code,w.name AS warehouse_name,
             CAST(SUM(prl.quantity*pol.unit_cost) AS CHAR) AS amount
        FROM eligible_receipts er
        JOIN purchase_receipt_lines prl
          ON prl.purchase_receipt_id=er.id
         AND prl.purchase_order_id=er.purchase_order_id
        JOIN purchase_order_lines pol
          ON pol.id=prl.purchase_order_line_id
         AND pol.purchase_order_id=prl.purchase_order_id
        JOIN warehouses w ON w.id=er.warehouse_id
       WHERE er.received_at>=? AND er.received_at<?
       GROUP BY er.id,er.received_at,er.purchase_order_id,er.warehouse_id,w.code,w.name
      UNION ALL
      SELECT CONCAT('supplier_return:',CAST(er.id AS CHAR)),
             'supplier_return',er.returned_at,CAST(er.id AS CHAR),
             CAST(er.purchase_order_id AS CHAR),CAST(er.purchase_receipt_id AS CHAR),
             CAST(er.id AS CHAR),CAST(er.warehouse_id AS CHAR),w.code,w.name,
             CAST(SUM(srl.quantity*pol.unit_cost) AS CHAR)
        FROM eligible_returns er
        JOIN supplier_return_lines srl
          ON srl.supplier_return_id=er.id
         AND srl.purchase_order_id=er.purchase_order_id
         AND srl.purchase_receipt_id=er.purchase_receipt_id
        JOIN purchase_order_lines pol
          ON pol.id=srl.purchase_order_line_id
         AND pol.purchase_order_id=srl.purchase_order_id
         AND pol.product_id=srl.product_id
        JOIN warehouses w ON w.id=er.warehouse_id
       GROUP BY er.id,er.returned_at,er.purchase_order_id,
                er.purchase_receipt_id,er.warehouse_id,w.code,w.name
    )`;
  const params = [
    ...warehouseIds,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
    ...warehouseIds,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
  ];
  const cte =
    `${eligibleDocumentsCte.replace(/,\s*$/, "")}, ${activitiesCte}`.replaceAll(
      "__WAREHOUSE_IDS__",
      placeholders(warehouseIds),
    );
  return {
    countSql: `${cte} SELECT COUNT(*) AS total FROM activities`,
    pageSql: `${cte} SELECT * FROM activities ORDER BY occurred_at DESC,activity_type ASC,activity_id ASC LIMIT ? OFFSET ?`,
    params,
    pageParams: [...params, pageSize, offset],
  };
}

function unauthorized() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Recepciones y devoluciones de Compras.",
  );
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

function compileFactsSql(warehouseIds, [startUtc, endUtc]) {
  const sql = eligibleFactsSql.replaceAll(
    "__WAREHOUSE_IDS__",
    placeholders(warehouseIds),
  );
  const params = [
    ...warehouseIds,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
    ...warehouseIds,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
    startUtc,
    endUtc,
  ];
  return { sql, params };
}

export function createPurchaseReceiptsService({ dbPool }) {
  if (!dbPool) throw new TypeError("dbPool es obligatorio.");

  async function summarize({
    auth,
    dateFrom,
    dateTo,
    warehouseId,
    connection: suppliedConnection,
  } = {}) {
    validatePurchaseReceiptsPeriod(dateFrom, dateTo);
    if (
      !auth?.user?.id ||
      !auth?.sessionId ||
      !allowedRoles.has(auth.user.role) ||
      !validId(String(auth.user.id)) ||
      !validId(String(auth.sessionId))
    ) {
      unauthorized();
    }
    if (warehouseId !== undefined && !validId(String(warehouseId))) {
      throw new HttpError(
        404,
        "WAREHOUSE_NOT_FOUND",
        "No se encontró la bodega autorizada.",
      );
    }

    const ownsConnection = !suppliedConnection;
    const connection = suppliedConnection || (await dbPool.getConnection());
    try {
      if (ownsConnection) {
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        );
        await connection.query("SET TRANSACTION READ ONLY");
        await connection.beginTransaction();
      }

      const [sessions] = await connection.execute(
        `SELECT u.id, r.code AS role_code, u.password_change_required
           FROM user_sessions us
           JOIN users u ON u.id = us.user_id
           JOIN roles r ON r.id = u.role_id
          WHERE us.id = ? AND us.user_id = ? AND us.revoked_at IS NULL
            AND us.expires_at > UTC_TIMESTAMP(3) AND u.is_active = 1
          LIMIT 1`,
        [auth.sessionId, auth.user.id],
      );
      const session = sessions[0];
      if (
        !session ||
        session.password_change_required ||
        session.role_code !== auth.user.role
      ) {
        unauthorized();
      }
      const [permissionRows] = await connection.execute(
        `SELECT p.code
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = (SELECT role_id FROM users WHERE id = ?)
            AND p.code IN (?, ?, ?)`,
        [auth.user.id, ...requiredPermissions],
      );
      const permissionCodes = new Set(permissionRows.map(({ code }) => code));
      if (requiredPermissions.some((code) => !permissionCodes.has(code))) {
        unauthorized();
      }

      const [assignmentRows] = await connection.execute(
        `SELECT uw.warehouse_id
           FROM user_warehouses uw
           JOIN warehouses w ON w.id = uw.warehouse_id
          WHERE uw.user_id = ? ORDER BY uw.warehouse_id`,
        [auth.user.id],
      );
      const assignedWarehouseIds = assignmentRows.map((row) =>
        String(row.warehouse_id),
      );
      if (
        warehouseId !== undefined &&
        !assignedWarehouseIds.includes(String(warehouseId))
      ) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const warehouseIds =
        warehouseId === undefined
          ? assignedWarehouseIds
          : [String(warehouseId)];
      if (!warehouseIds.length) {
        if (ownsConnection) await connection.commit();
        return emptyResult(dateFrom, dateTo);
      }

      const { startUtc, endUtc } = bogotaUtcBoundaries(dateFrom, dateTo);
      const dateParams = [startUtc, endUtc];
      const { sql, params } = compileFactsSql(warehouseIds, dateParams);
      const [rows] = await connection.execute(sql, params);
      const summaryRow = rows.find((row) => row.row_type === "summary");
      const receivedValue = normalizeSqlMoney(
        summaryRow?.received_value ?? "0.00",
      );
      const supplierReturnEquivalent = normalizeSqlMoney(
        summaryRow?.returned_value ?? "0.00",
      );
      const quantitiesByUnit = rows
        .filter((row) => row.row_type === "unit")
        .map((row) => ({
          unit: row.unit,
          received: String(row.received),
          returned: String(row.returned),
        }));
      const diagnostics = rows
        .filter((row) => row.row_type === "excluded")
        .map((row) => ({
          documentType: row.document_type,
          reason: row.reason,
          count: String(row.excluded_count),
        }));
      const result = {
        period: { dateFrom, dateTo, timeZone: "America/Bogota" },
        summary: {
          receivedValue,
          supplierReturnEquivalent,
          referenceNetReceivedValue: calculateReferenceNetReceived(
            receivedValue,
            supplierReturnEquivalent,
          ),
          quantitiesByUnit: calculateUnitDifferences(quantitiesByUnit),
        },
        diagnostics,
      };
      if (ownsConnection) await connection.commit();
      return result;
    } catch (error) {
      if (ownsConnection) await connection.rollback();
      throw error;
    } finally {
      if (ownsConnection) connection.release();
    }
  }

  return { summarize };
}

function emptyResult(dateFrom, dateTo) {
  return {
    period: { dateFrom, dateTo, timeZone: "America/Bogota" },
    summary: {
      receivedValue: "0.00",
      supplierReturnEquivalent: "0.00",
      referenceNetReceivedValue: "0.00",
      quantitiesByUnit: [],
    },
    diagnostics: [],
  };
}
