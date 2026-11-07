import { HttpError } from "../../shared/http-error.js";

const allowedRoles = new Set(["administrator", "auditor"]);
const requiredPermissions = [
  "reports.read",
  "warehouses.read",
  "purchases.read",
];
const maxId = 18446744073709551615n;
const idPattern = /^[1-9]\d{0,19}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validId(value) {
  return (
    typeof value === "string" && idPattern.test(value) && BigInt(value) <= maxId
  );
}

function validCivilDate(value) {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    year >= 1000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validatePurchaseOrdersPeriod(dateFrom, dateTo) {
  if (
    !validCivilDate(dateFrom) ||
    !validCivilDate(dateTo) ||
    dateFrom > dateTo
  ) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PERIOD",
      "El período debe usar fechas válidas YYYY-MM-DD y no superar 92 días calendario.",
    );
  }
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${dateTo}T00:00:00Z`);
  if ((to - from) / 86400000 > 91) {
    throw new HttpError(
      400,
      "INVALID_REPORT_PERIOD",
      "El período debe usar fechas válidas YYYY-MM-DD y no superar 92 días calendario.",
    );
  }
  return true;
}

function quantity(value) {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text))
    throw new TypeError("La cantidad SQL no es un entero válido.");
  return BigInt(text);
}

function moneyCents(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new TypeError("El importe SQL no es un DECIMAL válido.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function moneyText(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function sumUnits(lines, selector) {
  const totals = new Map();
  for (const line of lines) {
    const value = selector(line);
    if (value === null || value === 0n) continue;
    totals.set(line.unit, (totals.get(line.unit) || 0n) + value);
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, value]) => ({ unit, quantity: value.toString() }));
}

export function calculatePurchaseOrderSituation({ status, closedAt, lines }) {
  if (!new Set(["draft", "confirmed", "cancelled"]).has(status))
    throw new TypeError("Estado documental no reconocido.");
  if (!Array.isArray(lines))
    throw new TypeError("Las líneas de la orden no son válidas.");
  const normalized = lines.map((line) => {
    const ordered = quantity(line.quantity);
    const received = quantity(line.receivedQuantity);
    if (ordered <= 0n || received > ordered)
      throw new TypeError(
        "La cantidad recibida excede la cantidad ordenada o la línea no es válida.",
      );
    const pending = ordered - received;
    return {
      ...line,
      quantity: ordered.toString(),
      receivedQuantity: received.toString(),
      pendingQuantity: null,
      closedQuantity: "0",
      _ordered: ordered,
      _received: received,
      _pending: pending,
    };
  });

  const hasClosure = closedAt !== null && closedAt !== undefined;
  let situation;
  let receiptProgress = "not_applicable";
  if (status === "draft")
    situation = normalized.length ? "draft" : "draft_without_lines";
  else if (status === "cancelled") situation = "cancelled";
  else {
    if (!normalized.length)
      throw new TypeError("Una orden confirmada debe tener líneas activas.");
    const anyReceived = normalized.some((line) => line._received > 0n);
    const anyPending = normalized.some((line) => line._pending > 0n);
    receiptProgress = anyPending
      ? anyReceived
        ? "partial"
        : "none"
      : "complete";
    if (hasClosure) situation = "closed_with_remnant";
    else if (anyPending && anyReceived) situation = "partially_received";
    else if (anyPending) situation = "confirmed_without_receipts";
    else situation = "fully_received";
  }

  let orderedValue = 0n;
  for (const line of normalized) {
    const total = moneyCents(line.lineTotal);
    if (line._ordered * moneyCents(line.unitCost ?? "0.00") !== total)
      throw new TypeError(
        "El subtotal documental no coincide con cantidad por costo unitario.",
      );
    orderedValue += total;
    line.pendingQuantity =
      status === "confirmed" && !hasClosure
        ? line._pending.toString()
        : status === "confirmed"
          ? "0"
          : null;
    line.closedQuantity =
      status === "confirmed" && hasClosure ? line._pending.toString() : "0";
    delete line._ordered;
    delete line._received;
    delete line._pending;
  }
  return {
    situation,
    receiptProgress,
    hasClosure,
    orderedValue: moneyText(status === "confirmed" ? orderedValue : 0n),
    orderedByUnit: sumUnits(normalized, (line) => quantity(line.quantity)),
    receivedByUnit: sumUnits(normalized, (line) =>
      quantity(line.receivedQuantity),
    ),
    pendingByUnit:
      status === "confirmed" && !hasClosure
        ? sumUnits(normalized, (line) => quantity(line.pendingQuantity))
        : [],
    closedByUnit:
      status === "confirmed" && hasClosure
        ? sumUnits(normalized, (line) => quantity(line.closedQuantity))
        : [],
    lines: normalized,
  };
}

function denied() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Órdenes de Compra y Pendientes.",
  );
}

const orderFactsSql = `
WITH scoped_orders AS (
  SELECT po.* FROM purchase_orders po
   WHERE po.warehouse_id IN (__WAREHOUSES__) __ORDER_FILTER__
), scoped_receipts AS (
  SELECT pr.id, pr.purchase_order_id, pr.received_at, pr.source_operation_id,
         so.warehouse_id, so.status, so.confirmed_at, so.closed_at,
         io.operation_type, io.source_type, io.source_id,
         io.source_warehouse_id, io.destination_warehouse_id
    FROM scoped_orders so JOIN purchase_receipts pr ON pr.purchase_order_id=so.id
    LEFT JOIN inventory_operations io ON io.id=pr.source_operation_id
), receipt_integrity AS (
  SELECT sr.id, sr.purchase_order_id,
    CASE WHEN sr.status <> 'confirmed' OR sr.confirmed_at IS NULL OR sr.confirmed_at > sr.received_at
       OR (sr.closed_at IS NOT NULL AND sr.received_at > sr.closed_at)
       OR sr.source_operation_id IS NULL OR sr.operation_type <> 'purchase_receipt'
       OR sr.source_type <> 'purchase_receipt' OR sr.source_id IS NULL
       OR BINARY sr.source_id <> BINARY CAST(sr.id AS CHAR)
       OR sr.source_warehouse_id <> sr.warehouse_id OR sr.destination_warehouse_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM purchase_receipt_lines x WHERE x.purchase_receipt_id=sr.id)
       OR EXISTS (SELECT 1 FROM purchase_receipt_lines x WHERE x.purchase_receipt_id=sr.id AND x.purchase_order_id<>sr.purchase_order_id)
       OR (SELECT COUNT(*) FROM inventory_movements im WHERE im.operation_id=sr.source_operation_id)
          <> (SELECT COUNT(*) FROM purchase_receipt_lines x WHERE x.purchase_receipt_id=sr.id)
       OR EXISTS (
         SELECT 1 FROM purchase_receipt_lines x
         LEFT JOIN purchase_order_lines pol ON pol.id=x.purchase_order_line_id AND pol.purchase_order_id=x.purchase_order_id
         WHERE x.purchase_receipt_id=sr.id AND (pol.id IS NULL OR pol.is_active<>1 OR NOT EXISTS (
           SELECT 1 FROM inventory_movements im WHERE im.operation_id=sr.source_operation_id
            AND im.product_id=pol.product_id AND im.warehouse_id=sr.warehouse_id
            AND im.direction='IN' AND im.quantity=x.quantity
            AND BINARY im.unit_snapshot=BINARY pol.unit_snapshot
         ))
       )
       OR EXISTS (SELECT 1 FROM inventory_movements im WHERE im.operation_id=sr.source_operation_id AND NOT EXISTS (
         SELECT 1 FROM purchase_receipt_lines x JOIN purchase_order_lines pol ON pol.id=x.purchase_order_line_id AND pol.purchase_order_id=x.purchase_order_id
          WHERE x.purchase_receipt_id=sr.id AND pol.product_id=im.product_id AND im.warehouse_id=sr.warehouse_id
            AND im.direction='IN' AND im.quantity=x.quantity AND BINARY im.unit_snapshot=BINARY pol.unit_snapshot
       )) THEN 1 ELSE 0 END AS invalid
    FROM scoped_receipts sr
), order_integrity AS (
  SELECT so.id,
     CASE WHEN (so.status='draft' AND (so.confirmed_at IS NOT NULL OR so.confirmed_by IS NOT NULL OR so.cancelled_at IS NOT NULL OR so.cancelled_by IS NOT NULL OR so.cancellation_reason IS NOT NULL OR so.closed_at IS NOT NULL))
        OR (so.status='confirmed' AND (so.confirmed_at IS NULL OR so.confirmed_by IS NULL OR so.cancelled_at IS NOT NULL OR so.cancelled_by IS NOT NULL OR so.cancellation_reason IS NOT NULL))
        OR (so.status='cancelled' AND (so.cancelled_at IS NULL OR so.cancelled_by IS NULL OR so.closed_at IS NOT NULL OR ((so.confirmed_at IS NULL) <> (so.confirmed_by IS NULL)) OR so.cancellation_reason IS NULL))
       OR (so.closed_at IS NULL AND (so.closure_reason IS NOT NULL OR so.closed_by IS NOT NULL OR so.closure_idempotency_key IS NOT NULL OR so.closure_request_hash IS NOT NULL))
       OR (so.closed_at IS NOT NULL AND (so.status<>'confirmed' OR so.closure_reason IS NULL OR so.closed_by IS NULL OR so.closure_idempotency_key IS NULL OR so.closure_request_hash IS NULL
         OR NOT EXISTS (SELECT 1 FROM purchase_order_lines closed_line WHERE closed_line.purchase_order_id=so.id AND closed_line.is_active=1)
         OR NOT EXISTS (SELECT 1 FROM purchase_receipt_lines received_line JOIN purchase_receipts received_doc ON received_doc.id=received_line.purchase_receipt_id AND received_doc.purchase_order_id=received_line.purchase_order_id WHERE received_line.purchase_order_id=so.id)
         OR NOT EXISTS (SELECT 1 FROM purchase_order_lines pending_line WHERE pending_line.purchase_order_id=so.id AND pending_line.is_active=1 AND pending_line.quantity>COALESCE((SELECT SUM(received_line.quantity) FROM purchase_receipt_lines received_line WHERE received_line.purchase_order_line_id=pending_line.id),0))))
       OR (so.status='confirmed' AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id=so.id AND pol.is_active=1))
       OR EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id=so.id AND pol.is_active=1 AND (pol.quantity=0 OR pol.unit_cost<0 OR pol.line_total<>pol.quantity*pol.unit_cost))
       OR EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id=so.id AND pol.is_active=0 AND EXISTS (SELECT 1 FROM purchase_receipt_lines prl WHERE prl.purchase_order_line_id=pol.id))
       OR EXISTS (SELECT 1 FROM receipt_integrity ri WHERE ri.purchase_order_id=so.id AND ri.invalid=1)
       OR EXISTS (SELECT 1 FROM purchase_receipt_lines prl JOIN purchase_order_lines pol ON pol.id=prl.purchase_order_line_id AND pol.purchase_order_id=prl.purchase_order_id WHERE prl.purchase_order_id=so.id GROUP BY pol.id,pol.quantity HAVING SUM(prl.quantity)>pol.quantity)
       OR (so.status IN ('draft','cancelled') AND EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.purchase_order_id=so.id))
       OR EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.purchase_order_id=so.id AND (pr.received_at<so.confirmed_at OR (so.closed_at IS NOT NULL AND pr.received_at>so.closed_at)))
       THEN 1 ELSE 0 END AS invalid
    FROM scoped_orders so
)
 SELECT so.id, so.commercial_code, DATE_FORMAT(so.order_date, '%Y-%m-%d') AS order_date, so.status, so.warehouse_id, so.confirmed_at,
       so.cancelled_at, so.closed_at, so.reference, oi.invalid AS order_invalid,
       pol.id AS line_id, pol.product_id, pol.sku_snapshot, pol.name_snapshot, pol.unit_snapshot,
       CAST(pol.quantity AS CHAR) AS quantity, CAST(pol.unit_cost AS CHAR) AS unit_cost,
       CAST(pol.line_total AS CHAR) AS line_total,
       CAST(COALESCE((SELECT SUM(prl.quantity) FROM purchase_receipt_lines prl JOIN purchase_receipts pr ON pr.id=prl.purchase_receipt_id AND pr.purchase_order_id=prl.purchase_order_id WHERE prl.purchase_order_line_id=pol.id AND prl.purchase_order_id=so.id),0) AS CHAR) AS received_quantity
  FROM scoped_orders so JOIN order_integrity oi ON oi.id=so.id
  LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=so.id AND pol.is_active=1
 ORDER BY so.order_date,so.id,pol.position,pol.id`;

export function buildPurchaseOrdersFactsQuery({
  warehouseIds,
  mode,
  dateFrom,
  dateTo,
}) {
  if (!Array.isArray(warehouseIds) || warehouseIds.length === 0)
    throw new TypeError("Se requiere un alcance de bodegas no vacío.");
  const orderFilter =
    mode === "pending"
      ? "AND po.status='confirmed' AND po.closed_at IS NULL"
      : "AND po.order_date >= ? AND po.order_date <= ?";
  const sql = orderFactsSql
    .replaceAll("__WAREHOUSES__", warehouseIds.map(() => "?").join(","))
    .replace("__ORDER_FILTER__", orderFilter);
  return {
    sql,
    params:
      mode === "pending"
        ? [...warehouseIds]
        : [...warehouseIds, dateFrom, dateTo],
  };
}

const situationSql = `CASE
  WHEN om.status='draft' AND om.line_count=0 THEN 'draft_without_lines'
  WHEN om.status='draft' THEN 'draft'
  WHEN om.status='cancelled' THEN 'cancelled'
  WHEN om.closed_at IS NOT NULL THEN 'closed_with_remnant'
  WHEN om.has_pending=1 AND om.has_received=1 THEN 'partially_received'
  WHEN om.has_pending=1 THEN 'confirmed_without_receipts'
  ELSE 'fully_received' END`;

function purchaseOrdersEligibilityCte({
  warehouseIds,
  mode,
  dateFrom,
  dateTo,
  q,
}) {
  if (!Array.isArray(warehouseIds) || !warehouseIds.length)
    throw new TypeError("Se requiere un alcance de bodegas no vacío.");
  if (mode !== "pending" && mode !== "period")
    throw new TypeError("La modalidad de consulta no es válida.");
  if (mode === "period") validatePurchaseOrdersPeriod(dateFrom, dateTo);
  const marker = " SELECT so.id, so.commercial_code";
  const boundary = orderFactsSql.indexOf(marker);
  const integrityCtes = orderFactsSql.slice(0, boundary).trimEnd();
  const orderFilter = [
    q === undefined ? "" : "AND po.commercial_code LIKE ? ESCAPE '!'",
    mode === "pending"
      ? "AND po.status='confirmed' AND po.closed_at IS NULL"
      : "AND po.order_date >= ? AND po.order_date <= ?",
  ]
    .filter(Boolean)
    .join(" ");
  const ctes = integrityCtes
    .replace("__WAREHOUSES__", warehouseIds.map(() => "?").join(","))
    .replace("__ORDER_FILTER__", orderFilter);
  return {
    sql: `${ctes}, receipt_totals AS (
      SELECT prl.purchase_order_id, prl.purchase_order_line_id,
             SUM(prl.quantity) AS received_quantity
        FROM purchase_receipt_lines prl JOIN scoped_orders scoped
          ON scoped.id=prl.purchase_order_id
        JOIN purchase_receipts pr ON pr.id=prl.purchase_receipt_id
          AND pr.purchase_order_id=prl.purchase_order_id
       GROUP BY prl.purchase_order_id, prl.purchase_order_line_id
    ), order_facts AS (
      SELECT so.id, so.commercial_code, so.order_date, so.status, so.warehouse_id,
             so.confirmed_at, so.cancelled_at, so.closed_at, so.reference,
             oi.invalid AS order_invalid, pol.id AS line_id, pol.product_id,
             pol.sku_snapshot, pol.name_snapshot, pol.unit_snapshot,
             pol.quantity, pol.unit_cost, pol.line_total,
             COALESCE(rt.received_quantity,0) AS received_quantity
        FROM scoped_orders so JOIN order_integrity oi ON oi.id=so.id
        LEFT JOIN purchase_order_lines pol
          ON pol.purchase_order_id=so.id AND pol.is_active=1
        LEFT JOIN receipt_totals rt
          ON rt.purchase_order_id=so.id AND rt.purchase_order_line_id=pol.id
    ), line_metrics AS (
      SELECT id, COUNT(line_id) AS line_count,
             SUM(CASE WHEN received_quantity>quantity THEN 1 ELSE 0 END) AS over_received,
             MAX(CASE WHEN received_quantity>0 THEN 1 ELSE 0 END) AS has_received,
             MAX(CASE WHEN quantity>received_quantity THEN 1 ELSE 0 END) AS has_pending,
             SUM(line_total) AS order_value,
             MAX(order_invalid) AS order_invalid,
             MAX(CASE WHEN line_id IS NOT NULL AND
               (quantity<=0 OR unit_cost<0 OR line_total<>quantity*unit_cost)
               THEN 1 ELSE 0 END) AS invalid_line
        FROM order_facts GROUP BY id
    ), eligible_orders AS (
      SELECT om.*, ${situationSql} AS situation,
             CAST(CASE WHEN om.status='confirmed' THEN om.order_value ELSE 0 END AS CHAR) AS ordered_value
        FROM (SELECT so.id, so.commercial_code,
                     DATE_FORMAT(so.order_date,'%Y-%m-%d') order_date,
                     so.status, so.warehouse_id, so.confirmed_at, so.cancelled_at,
                     so.closed_at, so.reference, lm.order_invalid, lm.line_count,
                     lm.has_received, lm.has_pending, lm.order_value,
                     lm.invalid_line, lm.over_received
                FROM scoped_orders so JOIN line_metrics lm ON lm.id=so.id) om
       WHERE om.order_invalid=0 AND om.invalid_line=0 AND om.over_received=0
         AND (om.status<>'confirmed' OR om.line_count>0)
    )`,
    params:
      mode === "pending"
        ? q === undefined
          ? [...warehouseIds]
          : [...warehouseIds, `%${q.replace(/[!%_]/g, "!$&")}%`]
        : q === undefined
          ? [...warehouseIds, dateFrom, dateTo]
          : [
              ...warehouseIds,
              `%${q.replace(/[!%_]/g, "!$&")}%`,
              dateFrom,
              dateTo,
            ],
  };
}

export function buildPurchaseOrdersEligibleQuery({
  warehouseIds,
  mode,
  dateFrom,
  dateTo,
  q,
  situation,
  pageSize,
  offset,
}) {
  const base = purchaseOrdersEligibilityCte({
    warehouseIds,
    mode,
    dateFrom,
    dateTo,
    q,
  });
  const pendingClause =
    mode === "pending"
      ? " AND situation IN ('confirmed_without_receipts','partially_received')"
      : "";
  const situationClause = situation ? " AND situation = ?" : "";
  const order =
    mode === "pending" ? "order_date ASC, id ASC" : "order_date DESC, id DESC";
  return {
    sql: `${base.sql} SELECT * FROM eligible_orders
      WHERE 1=1${pendingClause}${situationClause}
      ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: [
      ...base.params,
      ...(situation ? [situation] : []),
      pageSize,
      offset,
    ],
  };
}

export function buildPurchaseOrdersCountQuery(criteria) {
  const base = purchaseOrdersEligibilityCte(criteria);
  const pendingClause =
    criteria.mode === "pending"
      ? " AND situation IN ('confirmed_without_receipts','partially_received')"
      : "";
  const situationClause = criteria.situation ? " AND situation = ?" : "";
  return {
    sql: `${base.sql} SELECT CAST(COUNT(*) AS CHAR) AS total FROM eligible_orders
      WHERE 1=1${pendingClause}${situationClause}`,
    params: [
      ...base.params,
      ...(criteria.situation ? [criteria.situation] : []),
    ],
  };
}

export function buildPurchaseOrdersSummaryQuery(criteria) {
  const base = purchaseOrdersEligibilityCte(criteria);
  const pendingClause =
    criteria.mode === "pending"
      ? " AND situation IN ('confirmed_without_receipts','partially_received')"
      : "";
  const situationClause = criteria.situation ? " AND situation = ?" : "";
  return {
    sql: `${base.sql} SELECT CAST(COUNT(*) AS CHAR) AS verified_orders,
      CAST(SUM(status='draft') AS CHAR) AS drafts,
      CAST(SUM(status='confirmed') AS CHAR) AS confirmed,
      CAST(SUM(status='cancelled') AS CHAR) AS cancelled,
      CAST(SUM(situation='draft_without_lines') AS CHAR) AS draft_without_lines,
      CAST(SUM(situation='draft') AS CHAR) AS draft_situation,
      CAST(SUM(situation='cancelled') AS CHAR) AS cancelled_situation,
      CAST(SUM(situation='confirmed_without_receipts') AS CHAR) AS confirmed_without_receipts,
      CAST(SUM(situation='partially_received') AS CHAR) AS partially_received,
      CAST(SUM(situation='fully_received') AS CHAR) AS fully_received,
      CAST(SUM(situation='closed_with_remnant') AS CHAR) AS closed_with_remnant,
      CAST(SUM(situation IN ('confirmed_without_receipts','partially_received')) AS CHAR) AS orders_with_pending,
      CAST(SUM(situation='closed_with_remnant') AS CHAR) AS orders_closed_with_remnant,
      CAST(COALESCE(SUM(CASE WHEN status='confirmed' THEN CAST(ordered_value AS DECIMAL(65,2)) ELSE 0 END),0) AS CHAR) AS original_confirmed_value
      FROM eligible_orders WHERE 1=1${pendingClause}${situationClause}`,
    params: [
      ...base.params,
      ...(criteria.situation ? [criteria.situation] : []),
    ],
  };
}

export function buildPurchaseOrdersUnitTotalsQuery(criteria) {
  const base = purchaseOrdersEligibilityCte(criteria);
  const pendingClause =
    criteria.mode === "pending"
      ? " AND eo.situation IN ('confirmed_without_receipts','partially_received')"
      : "";
  const situationClause = criteria.situation ? " AND eo.situation = ?" : "";
  return {
    sql: `${base.sql}, selected_orders AS (
      SELECT eo.id, eo.status, eo.closed_at, eo.situation
        FROM eligible_orders eo WHERE 1=1${pendingClause}${situationClause}
    ), unit_quantities AS (
      SELECT f.unit_snapshot AS unit,
        SUM(CASE WHEN f.status='confirmed' AND f.closed_at IS NULL
          THEN f.quantity-f.received_quantity ELSE 0 END) AS pending_quantity,
        SUM(CASE WHEN f.status='confirmed' AND f.closed_at IS NOT NULL
          THEN f.quantity-f.received_quantity ELSE 0 END) AS closed_quantity
      FROM order_facts f JOIN selected_orders so ON so.id=f.id
      WHERE f.line_id IS NOT NULL GROUP BY f.unit_snapshot
    ) SELECT unit, CAST(pending_quantity AS CHAR) pending_quantity,
      CAST(closed_quantity AS CHAR) closed_quantity FROM unit_quantities
      ORDER BY unit`,
    params: [
      ...base.params,
      ...(criteria.situation ? [criteria.situation] : []),
    ],
  };
}

export function buildPurchaseOrdersPageLinesQuery({
  warehouseIds,
  mode,
  dateFrom,
  dateTo,
  ids,
}) {
  if (!Array.isArray(ids) || ids.some((id) => !validId(String(id))))
    throw new TypeError("Los identificadores de página no son válidos.");
  if (!ids.length) return { sql: "SELECT 1 WHERE 0", params: [] };
  const modeFilter =
    mode === "pending"
      ? "po.status='confirmed' AND po.closed_at IS NULL"
      : "po.order_date >= ? AND po.order_date <= ?";
  const params =
    mode === "pending"
      ? [...warehouseIds, ...ids]
      : [...warehouseIds, dateFrom, dateTo, ...ids];
  return {
    sql: `SELECT po.id, po.commercial_code, DATE_FORMAT(po.order_date,'%Y-%m-%d') AS order_date,
      po.status, po.warehouse_id, po.confirmed_at, po.cancelled_at, po.closed_at,
      pol.id AS line_id, pol.product_id, pol.sku_snapshot, pol.name_snapshot,
      pol.unit_snapshot, CAST(pol.quantity AS CHAR) AS quantity,
      CAST(pol.unit_cost AS CHAR) AS unit_cost, CAST(pol.line_total AS CHAR) AS line_total,
      CAST(COALESCE(received.received_quantity,0) AS CHAR) AS received_quantity
      FROM purchase_orders po JOIN purchase_order_lines pol
        ON pol.purchase_order_id=po.id AND pol.is_active=1
      LEFT JOIN (SELECT prl.purchase_order_id, prl.purchase_order_line_id,
          SUM(prl.quantity) received_quantity
        FROM purchase_receipt_lines prl JOIN purchase_receipts pr
          ON pr.id=prl.purchase_receipt_id AND pr.purchase_order_id=prl.purchase_order_id
        GROUP BY prl.purchase_order_id, prl.purchase_order_line_id) received
        ON received.purchase_order_id=po.id AND received.purchase_order_line_id=pol.id
      WHERE po.warehouse_id IN (${warehouseIds.map(() => "?").join(",")})
        AND ${modeFilter} AND po.id IN (${ids.map(() => "?").join(",")})
      ORDER BY po.order_date, po.id, pol.position, pol.id`,
    params,
  };
}

export function createPurchaseOrdersService({ dbPool }) {
  if (!dbPool) throw new TypeError("dbPool es obligatorio.");

  async function countEligible({ connection, ...criteria }) {
    if (!connection)
      throw new TypeError("La conexión transaccional es obligatoria.");
    const query = buildPurchaseOrdersCountQuery(criteria);
    const [rows] = await connection.execute(query.sql, query.params);
    return String(rows[0]?.total || "0");
  }

  async function summarizeEligible({ connection, ...criteria }) {
    if (!connection)
      throw new TypeError("La conexión transaccional es obligatoria.");
    const summaryQuery = buildPurchaseOrdersSummaryQuery(criteria);
    const unitQuery = buildPurchaseOrdersUnitTotalsQuery(criteria);
    const [summaryResult] = await connection.execute(
      summaryQuery.sql,
      summaryQuery.params,
    );
    const [unitResult] = await connection.execute(
      unitQuery.sql,
      unitQuery.params,
    );
    const summaryRows = summaryResult;
    const unitRows = unitResult;
    const summary = summaryRows[0] || {};
    const pendingByUnit = unitRows
      .filter(({ pending_quantity }) => BigInt(String(pending_quantity)) > 0n)
      .map(({ unit, pending_quantity }) => ({
        unit,
        quantity: String(pending_quantity),
      }));
    const closedByUnit = unitRows
      .filter(({ closed_quantity }) => BigInt(String(closed_quantity)) > 0n)
      .map(({ unit, closed_quantity }) => ({
        unit,
        quantity: String(closed_quantity),
      }));
    return {
      verifiedOrders: String(summary.verified_orders || "0"),
      byDocumentStatus: {
        draft: String(summary.drafts || "0"),
        confirmed: String(summary.confirmed || "0"),
        cancelled: String(summary.cancelled || "0"),
      },
      bySituation: {
        draft_without_lines: String(summary.draft_without_lines || "0"),
        draft: String(summary.draft_situation || "0"),
        cancelled: String(summary.cancelled_situation || "0"),
        confirmed_without_receipts: String(
          summary.confirmed_without_receipts || "0",
        ),
        partially_received: String(summary.partially_received || "0"),
        fully_received: String(summary.fully_received || "0"),
        closed_with_remnant: String(summary.closed_with_remnant || "0"),
      },
      ordersWithPending: String(summary.orders_with_pending || "0"),
      ordersClosedWithRemnant: String(
        summary.orders_closed_with_remnant || "0",
      ),
      originalConfirmedOrderValue: String(
        summary.original_confirmed_value || "0.00",
      ),
      pendingByUnit,
      closedByUnit,
    };
  }

  async function pageEligible({ connection, pageSize, offset, ...criteria }) {
    if (!connection)
      throw new TypeError("La conexión transaccional es obligatoria.");
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000
    )
      throw new TypeError("La paginación no es válida.");
    const query = buildPurchaseOrdersEligibleQuery({
      ...criteria,
      pageSize,
      offset,
    });
    const [rows] = await connection.execute(query.sql, query.params);
    return rows;
  }

  async function linesForPage({ connection, ...criteria }) {
    if (!connection)
      throw new TypeError("La conexión transaccional es obligatoria.");
    const query = buildPurchaseOrdersPageLinesQuery(criteria);
    const [rows] = await connection.execute(query.sql, query.params);
    return rows;
  }

  async function summarize({
    auth,
    mode,
    dateFrom,
    dateTo,
    warehouseId,
    connection: suppliedConnection,
  } = {}) {
    if (mode === "period") validatePurchaseOrdersPeriod(dateFrom, dateTo);
    else if (
      mode !== "pending" ||
      dateFrom !== undefined ||
      dateTo !== undefined
    )
      throw new HttpError(
        400,
        "INVALID_REPORT_MODE",
        "La modalidad de consulta no es válida.",
      );
    if (
      !auth?.user?.id ||
      !auth.sessionId ||
      !allowedRoles.has(auth.user.role) ||
      !validId(String(auth.user.id)) ||
      !validId(String(auth.sessionId))
    )
      denied();
    if (warehouseId !== undefined && !validId(String(warehouseId)))
      throw new HttpError(
        404,
        "WAREHOUSE_NOT_FOUND",
        "No se encontró la bodega autorizada.",
      );
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
        `SELECT u.id,r.code AS role_code,u.password_change_required FROM user_sessions us JOIN users u ON u.id=us.user_id JOIN roles r ON r.id=u.role_id WHERE us.id=? AND us.user_id=? AND us.revoked_at IS NULL AND us.expires_at>UTC_TIMESTAMP(3) AND u.is_active=1 LIMIT 1`,
        [auth.sessionId, auth.user.id],
      );
      if (
        !sessions[0] ||
        sessions[0].password_change_required ||
        sessions[0].role_code !== auth.user.role
      )
        denied();
      const [grants] = await connection.execute(
        `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?) AND p.code IN (?,?,?)`,
        [auth.user.id, ...requiredPermissions],
      );
      const permissions = new Set(grants.map(({ code }) => code));
      if (requiredPermissions.some((code) => !permissions.has(code))) denied();
      const [assignments] = await connection.execute(
        "SELECT uw.warehouse_id FROM user_warehouses uw JOIN warehouses w ON w.id=uw.warehouse_id WHERE uw.user_id=? ORDER BY uw.warehouse_id",
        [auth.user.id],
      );
      const assignedIds = assignments.map(({ warehouse_id }) =>
        String(warehouse_id),
      );
      if (
        warehouseId !== undefined &&
        !assignedIds.includes(String(warehouseId))
      )
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      const warehouseIds =
        warehouseId === undefined ? assignedIds : [String(warehouseId)];
      if (!warehouseIds.length) {
        if (ownsConnection) await connection.commit();
        return emptyResult(mode, dateFrom, dateTo);
      }
      const query = buildPurchaseOrdersFactsQuery({
        warehouseIds,
        mode,
        dateFrom,
        dateTo,
      });
      const [rows] = await connection.execute(query.sql, query.params);
      const orderRows = new Map();
      for (const row of rows) {
        const id = String(row.id);
        if (!orderRows.has(id)) orderRows.set(id, { row, lines: [] });
        if (row.line_id !== null)
          orderRows.get(id).lines.push({
            id: String(row.line_id),
            productId: String(row.product_id),
            sku: row.sku_snapshot,
            name: row.name_snapshot,
            unit: row.unit_snapshot,
            quantity: String(row.quantity),
            unitCost: String(row.unit_cost),
            lineTotal: String(row.line_total),
            receivedQuantity: String(row.received_quantity),
          });
      }
      const eligible = [];
      let excludedOrders = 0;
      for (const { row, lines } of orderRows.values()) {
        if (Number(row.order_invalid)) {
          excludedOrders += 1;
          continue;
        }
        try {
          const facts = calculatePurchaseOrderSituation({
            status: row.status,
            closedAt: row.closed_at,
            lines,
          });
          eligible.push({
            id: String(row.id),
            commercialCode: row.commercial_code,
            orderDate: row.order_date,
            status: row.status,
            warehouseId: String(row.warehouse_id),
            confirmedAt: row.confirmed_at,
            cancelledAt: row.cancelled_at,
            closedAt: row.closed_at,
            reference: row.reference,
            ...facts,
          });
        } catch {
          excludedOrders += 1;
        }
      }
      const selected =
        mode === "pending"
          ? eligible.filter(
              (order) =>
                order.status === "confirmed" &&
                !order.hasClosure &&
                order.pendingByUnit.some(
                  ({ quantity: value }) => BigInt(value) > 0n,
                ),
            )
          : eligible;
      const summary = summarizeOrders(selected);
      const result = {
        mode,
        semantics:
          mode === "period"
            ? "Órdenes fechadas durante el período seleccionado. Situación actual al consultar."
            : "Pendientes actuales de todas las fechas documentales dentro de las bodegas autorizadas.",
        period: mode === "period" ? { dateFrom, dateTo } : null,
        summary,
        orders: selected,
        diagnostics: {
          excludedOrders,
          coverage: excludedOrders ? "partial" : "complete",
        },
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
  return {
    summarize,
    summarizeEligible,
    countEligible,
    pageEligible,
    linesForPage,
  };
}

function summarizeOrders(orders) {
  const statuses = { draft: 0, confirmed: 0, cancelled: 0 };
  const situations = {};
  const pending = new Map();
  const closed = new Map();
  let value = 0n;
  let pendingOrders = 0;
  let closedOrders = 0;
  for (const order of orders) {
    statuses[order.status] += 1;
    situations[order.situation] = (situations[order.situation] || 0) + 1;
    if (order.status === "confirmed") value += moneyCents(order.orderedValue);
    if (order.pendingByUnit.some(({ quantity: amount }) => BigInt(amount) > 0n))
      pendingOrders += 1;
    if (order.situation === "closed_with_remnant") closedOrders += 1;
    for (const { unit, quantity: amount } of order.pendingByUnit)
      pending.set(unit, (pending.get(unit) || 0n) + BigInt(amount));
    for (const { unit, quantity: amount } of order.closedByUnit)
      closed.set(unit, (closed.get(unit) || 0n) + BigInt(amount));
  }
  const entries = (map) =>
    [...map]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([unit, amount]) => ({ unit, quantity: amount.toString() }));
  return {
    verifiedOrders: orders.length,
    byDocumentStatus: statuses,
    bySituation: situations,
    ordersWithPending: pendingOrders,
    ordersClosedWithRemnant: closedOrders,
    originalConfirmedOrderValue: moneyText(value),
    pendingByUnit: entries(pending),
    closedByUnit: entries(closed),
  };
}

function emptyResult(mode, dateFrom, dateTo) {
  return {
    mode,
    semantics:
      mode === "period"
        ? "Órdenes fechadas durante el período seleccionado. Situación actual al consultar."
        : "Pendientes actuales de todas las fechas documentales dentro de las bodegas autorizadas.",
    period: mode === "period" ? { dateFrom, dateTo } : null,
    summary: summarizeOrders([]),
    orders: [],
    diagnostics: { excludedOrders: 0, coverage: "complete" },
  };
}
