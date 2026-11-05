import { HttpError } from "../../shared/http-error.js";
import { bogotaUtcBoundaries } from "./sales-activity-service.js";
import {
  buildPurchaseReceiptActivitiesQuery,
  createPurchaseReceiptsService,
} from "./purchase-receipts-service.js";

const allowedRoles = new Set(["administrator", "auditor"]);
const requiredPermissions = [
  "reports.read",
  "warehouses.read",
  "purchases.read",
];

function placeholders(values) {
  return values.map(() => "?").join(",");
}

function denied() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Recepciones y devoluciones de Compras.",
  );
}

export function createPurchaseReceiptsApiService({ dbPool }) {
  const summaryService = createPurchaseReceiptsService({ dbPool });

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
    if (
      !auth?.user?.id ||
      !auth.sessionId ||
      !allowedRoles.has(auth.user.role)
    ) {
      denied();
    }
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
    if (requiredPermissions.some((code) => !granted.has(code))) denied();
  }

  async function list({
    auth,
    dateFrom,
    dateTo,
    warehouseId,
    page = 1,
    pageSize = 20,
  }) {
    return withReadTransaction(async (connection) => {
      const facts = await summaryService.summarize({
        auth,
        dateFrom,
        dateTo,
        warehouseId,
        connection,
      });
      const [assignments] = await connection.execute(
        `SELECT uw.warehouse_id FROM user_warehouses uw
           JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ORDER BY uw.warehouse_id`,
        [auth.user.id],
      );
      const assignedIds = assignments.map(({ warehouse_id: id }) => String(id));
      const warehouseIds =
        warehouseId === undefined ? assignedIds : [String(warehouseId)];
      if (!warehouseIds.length) return response(facts, [], 0, page, pageSize);

      const { startUtc, endUtc } = bogotaUtcBoundaries(dateFrom, dateTo);
      const query = buildPurchaseReceiptActivitiesQuery({
        warehouseIds,
        startUtc,
        endUtc,
        pageSize,
        offset: (page - 1) * pageSize,
      });
      const [[count]] = await connection.execute(query.countSql, query.params);
      const [rows] = await connection.execute(query.pageSql, query.pageParams);
      const sourceIds = rows.map(({ source_id: id }) => String(id));
      const quantityByActivity = new Map();
      if (sourceIds.length) {
        const receiptIds = rows
          .filter(({ activity_type: type }) => type === "purchase_receipt")
          .map(({ source_id: id }) => String(id));
        const returnIds = rows
          .filter(({ activity_type: type }) => type === "supplier_return")
          .map(({ source_id: id }) => String(id));
        if (receiptIds.length) {
          const [quantities] = await connection.execute(
            `SELECT prl.purchase_receipt_id AS document_id,pol.unit_snapshot AS unit,
                    CAST(SUM(prl.quantity) AS CHAR) AS quantity
               FROM purchase_receipt_lines prl
               JOIN purchase_order_lines pol
                 ON pol.id=prl.purchase_order_line_id
                AND pol.purchase_order_id=prl.purchase_order_id
              WHERE prl.purchase_receipt_id IN (${placeholders(receiptIds)})
              GROUP BY prl.purchase_receipt_id,pol.unit_snapshot ORDER BY pol.unit_snapshot`,
            receiptIds,
          );
          addQuantities(
            quantityByActivity,
            quantities,
            "purchase_receipt",
            "quantityReceived",
          );
        }
        if (returnIds.length) {
          const [quantities] = await connection.execute(
            `SELECT srl.supplier_return_id AS document_id,srl.unit_snapshot AS unit,
                    CAST(SUM(srl.quantity) AS CHAR) AS quantity
               FROM supplier_return_lines srl
              WHERE srl.supplier_return_id IN (${placeholders(returnIds)})
              GROUP BY srl.supplier_return_id,srl.unit_snapshot ORDER BY srl.unit_snapshot`,
            returnIds,
          );
          addQuantities(
            quantityByActivity,
            quantities,
            "supplier_return",
            "quantityReturned",
          );
        }
      }
      const activities = rows.map((row) => ({
        id: row.activity_id,
        type: row.activity_type,
        occurredAt: row.occurred_at,
        sourceId: String(row.source_id),
        purchaseOrderId: String(row.purchase_order_id),
        purchaseReceiptId: String(row.purchase_receipt_id),
        supplierReturnId:
          row.supplier_return_id === null
            ? null
            : String(row.supplier_return_id),
        warehouse: {
          id: String(row.warehouse_id),
          code: row.warehouse_code,
          name: row.warehouse_name,
        },
        amount: String(row.amount),
        quantitiesByUnit: quantityByActivity.get(row.activity_id) || [],
      }));
      return response(facts, activities, Number(count.total), page, pageSize);
    });
  }

  async function listWarehouses({ auth, q = "", page = 1, pageSize = 20 }) {
    return withReadTransaction(async (connection) => {
      await authorize(connection, auth);
      const filter = q ? "AND (w.code LIKE ? OR w.name LIKE ?)" : "";
      const escaped = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const params = q ? [auth.user.id, escaped, escaped] : [auth.user.id];
      const [[count]] = await connection.execute(
        `SELECT COUNT(*) AS total FROM user_warehouses uw
           JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ${filter}`,
        params,
      );
      const [items] = await connection.execute(
        `SELECT w.id,w.code,w.name,w.is_active FROM user_warehouses uw
           JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ${filter}
          ORDER BY w.name,w.id LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      return {
        items: items.map((row) => ({
          id: String(row.id),
          code: row.code,
          name: row.name,
          isActive: Boolean(row.is_active),
        })),
        pagination: pagination(page, pageSize, Number(count.total)),
      };
    });
  }

  return { list, listWarehouses };
}

function addQuantities(target, rows, type, property) {
  for (const row of rows) {
    const id = `${type}:${row.document_id}`;
    const entries = target.get(id) || [];
    const item = entries.find(({ unit }) => unit === row.unit) || {
      unit: row.unit,
    };
    item[property] = String(row.quantity);
    if (!entries.includes(item)) entries.push(item);
    target.set(id, entries);
  }
}

function pagination(page, pageSize, total) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

function response(facts, activities, total, page, pageSize) {
  return {
    period: facts.period,
    criteria: {
      currency: "COP",
      timeZone: "America/Bogota",
      periodSemantics:
        "Fecha inicial y final inclusivas en America/Bogota; máximo 92 días calendario.",
      documentCoverage:
        "Actividad documental verificable según trazabilidad disponible.",
      receivedValue:
        "Cantidad recibida por costo documentado original de la línea de orden.",
      supplierReturnEquivalent:
        "Cantidad devuelta por costo original; no representa dinero reembolsado.",
      referenceNetReceivedValue:
        "Valor recibido menos equivalencia devuelta; referencia comercial no contable.",
      quantitySemantics:
        "Cantidades agregadas por unidad histórica, sin mezclar unidades distintas.",
    },
    summary: facts.summary,
    activities,
    pagination: pagination(page, pageSize, total),
    generatedAt: new Date().toISOString(),
  };
}
