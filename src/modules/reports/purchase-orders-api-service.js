import { HttpError } from "../../shared/http-error.js";
import {
  calculatePurchaseOrderSituation,
  createPurchaseOrdersService,
} from "./purchase-orders-service.js";

const allowedRoles = new Set(["administrator", "auditor"]);
const requiredPermissions = [
  "reports.read",
  "warehouses.read",
  "purchases.read",
];
const documentCoverage =
  "Solo incluye órdenes cuya integridad documental puede verificarse completamente.";

function denied() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Órdenes de Compra y Pendientes.",
  );
}

function emptySummary() {
  return {
    verifiedOrders: "0",
    byDocumentStatus: { draft: "0", confirmed: "0", cancelled: "0" },
    bySituation: {
      draft_without_lines: "0",
      draft: "0",
      cancelled: "0",
      confirmed_without_receipts: "0",
      partially_received: "0",
      fully_received: "0",
      closed_with_remnant: "0",
    },
    ordersWithPending: "0",
    ordersClosedWithRemnant: "0",
    originalConfirmedOrderValue: "0.00",
    pendingByUnit: [],
    closedByUnit: [],
  };
}

function criteria({ mode, dateFrom, dateTo, warehouseId, situation, q }) {
  return {
    mode,
    period: mode === "period" ? { dateFrom, dateTo } : null,
    warehouseId: warehouseId ?? null,
    warehouseScope: warehouseId === undefined ? "all_assigned" : "selected",
    filters: { situation: situation ?? null, q: q ?? null },
    currency: "COP",
    timeZone: "America/Bogota",
    periodSemantics:
      mode === "period"
        ? "Filtro inclusivo sobre purchase_orders.order_date (DATE), máximo 92 días calendario; se presenta la situación actual, no una reconstrucción histórica."
        : null,
    pendingSemantics:
      mode === "pending"
        ? "Pendientes operativos actuales, sin límite de antigüedad, dentro del alcance de bodegas autorizadas."
        : null,
    situationSemantics:
      "Situación actual del documento al momento de la consulta.",
    documentCoverage,
  };
}

function pagination(page, pageSize, total) {
  const totalCount = BigInt(total);
  return {
    page,
    pageSize,
    total: totalCount.toString(),
    totalPages: (
      (totalCount + BigInt(pageSize) - 1n) /
      BigInt(pageSize)
    ).toString(),
  };
}

export function createPurchaseOrdersApiService({ dbPool }) {
  const engine = createPurchaseOrdersService({ dbPool });

  async function withReadTransaction(operation) {
    const connection = await dbPool.getConnection();
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function authorize(connection, auth) {
    if (!auth?.user?.id || !auth.sessionId || !allowedRoles.has(auth.user.role))
      denied();
    const [sessions] = await connection.execute(
      `SELECT u.id,r.code AS role_code,u.password_change_required
         FROM user_sessions us
         JOIN users u ON u.id=us.user_id
         JOIN roles r ON r.id=u.role_id
        WHERE us.id=? AND us.user_id=? AND us.revoked_at IS NULL
          AND us.expires_at>UTC_TIMESTAMP(3) AND u.is_active=1 LIMIT 1`,
      [auth.sessionId, auth.user.id],
    );
    const session = sessions[0];
    if (
      !session ||
      session.password_change_required ||
      session.role_code !== auth.user.role
    ) {
      denied();
    }
    const [grants] = await connection.execute(
      `SELECT p.code FROM role_permissions rp
         JOIN permissions p ON p.id=rp.permission_id
        WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?)
          AND p.code IN (?,?,?)`,
      [auth.user.id, ...requiredPermissions],
    );
    const granted = new Set(grants.map(({ code }) => code));
    if (requiredPermissions.some((permission) => !granted.has(permission)))
      denied();
  }

  async function list({
    auth,
    mode,
    dateFrom,
    dateTo,
    warehouseId,
    situation,
    q,
    page,
    pageSize,
  }) {
    return withReadTransaction(async (connection) => {
      await authorize(connection, auth);
      const [assignments] = await connection.execute(
        `SELECT uw.warehouse_id FROM user_warehouses uw
           JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ORDER BY uw.warehouse_id`,
        [auth.user.id],
      );
      const assignedIds = assignments.map(({ warehouse_id }) =>
        String(warehouse_id),
      );
      if (warehouseId !== undefined && !assignedIds.includes(warehouseId)) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const warehouseIds =
        warehouseId === undefined ? assignedIds : [warehouseId];
      const effectiveCriteria = criteria({
        mode,
        dateFrom,
        dateTo,
        warehouseId,
        situation,
        q,
      });
      if (!warehouseIds.length) {
        return {
          criteria: effectiveCriteria,
          summary: emptySummary(),
          orders: [],
          pagination: pagination(page, pageSize, "0"),
          generatedAt: new Date().toISOString(),
          coverage: documentCoverage,
        };
      }

      const filters = {
        connection,
        warehouseIds,
        mode,
        ...(mode === "period" ? { dateFrom, dateTo } : {}),
        ...(situation ? { situation } : {}),
        ...(q ? { q } : {}),
      };
      const summary = await engine.summarizeEligible(filters);
      const total = await engine.countEligible(filters);
      const pageRows = await engine.pageEligible({
        ...filters,
        pageSize,
        offset: (page - 1) * pageSize,
      });
      const ids = pageRows.map(({ id }) => String(id));
      const lineRows = await engine.linesForPage({
        connection,
        warehouseIds,
        mode,
        ...(mode === "period" ? { dateFrom, dateTo } : {}),
        ids,
      });
      const pageWarehouseIds = [
        ...new Set(pageRows.map(({ warehouse_id }) => String(warehouse_id))),
      ];
      const [warehouseRows] = pageWarehouseIds.length
        ? await connection.execute(
            `SELECT id,code,name,is_active FROM warehouses
              WHERE id IN (${pageWarehouseIds.map(() => "?").join(",")})`,
            pageWarehouseIds,
          )
        : [[]];
      const warehouses = new Map(
        warehouseRows.map((warehouse) => [String(warehouse.id), warehouse]),
      );
      const linesByOrder = new Map(ids.map((id) => [id, []]));
      for (const line of lineRows) {
        const id = String(line.id);
        const lines = linesByOrder.get(id);
        if (!lines) continue;
        lines.push({
          id: String(line.line_id),
          productId: String(line.product_id),
          sku: line.sku_snapshot,
          name: line.name_snapshot,
          unit: line.unit_snapshot,
          quantity: String(line.quantity),
          receivedQuantity: String(line.received_quantity),
          unitCost: String(line.unit_cost),
          lineTotal: String(line.line_total),
        });
      }
      const orders = pageRows.map((row) => {
        const id = String(row.id);
        const warehouse = warehouses.get(String(row.warehouse_id));
        if (!warehouse || !linesByOrder.has(id))
          throw new Error(
            "La página del reporte perdió su alcance autorizado.",
          );
        const lines = linesByOrder.get(id);
        const facts = calculatePurchaseOrderSituation({
          status: row.status,
          closedAt: row.closed_at,
          lines: lines.map((line) => ({
            ...line,
            receivedQuantity: line.receivedQuantity,
            unitCost: line.unitCost,
            lineTotal: line.lineTotal,
          })),
        });
        return {
          id,
          commercialCode: row.commercial_code,
          orderDate: row.order_date,
          warehouse: {
            id: String(warehouse.id),
            code: warehouse.code,
            name: warehouse.name,
            isActive: Boolean(warehouse.is_active),
          },
          status: row.status,
          situation: row.situation,
          confirmedAt: row.confirmed_at,
          cancelledAt: row.cancelled_at,
          closedAt: row.closed_at,
          orderedValue: String(row.ordered_value),
          receiptProgress: facts.receiptProgress,
          hasClosure: facts.hasClosure,
          lines: facts.lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            sku: line.sku,
            name: line.name,
            unit: line.unit,
            quantity: line.quantity,
            receivedQuantity: line.receivedQuantity,
            pendingQuantity: line.pendingQuantity,
            closedQuantity: line.closedQuantity,
            unitCost: line.unitCost,
            lineTotal: line.lineTotal,
          })),
        };
      });
      return {
        criteria: effectiveCriteria,
        summary,
        orders,
        pagination: pagination(page, pageSize, total),
        generatedAt: new Date().toISOString(),
        coverage: documentCoverage,
      };
    });
  }

  return { list };
}
