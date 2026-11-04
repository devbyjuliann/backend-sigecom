import { HttpError } from "../../shared/http-error.js";
import {
  bogotaUtcBoundaries,
  createSalesActivityService,
} from "./sales-activity-service.js";

const roles = new Set(["administrator", "auditor"]);
const permissions = ["reports.read", "sales.read", "warehouses.read"];
const idPattern = /^[1-9]\d{0,19}$/;
const maxId = 18446744073709551615n;

function denied() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Actividad de Ventas.",
  );
}

function validateId(id) {
  return idPattern.test(String(id)) && BigInt(id) <= maxId;
}

async function authorized(connection, auth, { loadWarehouses = true } = {}) {
  if (
    !auth?.user?.id ||
    !auth.sessionId ||
    !roles.has(auth.user.role) ||
    !validateId(auth.user.id) ||
    !validateId(auth.sessionId)
  )
    denied();
  const [sessions] = await connection.execute(
    `SELECT u.id, r.code AS role_code, u.password_change_required
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
      WHERE rp.role_id=(SELECT role_id FROM users WHERE id=?) AND p.code IN (?,?,?)`,
    [auth.user.id, ...permissions],
  );
  const granted = new Set(grants.map(({ code }) => code));
  if (permissions.some((permission) => !granted.has(permission))) denied();
  if (!loadWarehouses) return [];
  const [warehouses] = await connection.execute(
    `SELECT w.id, w.code, w.name, w.is_active FROM user_warehouses uw
       JOIN warehouses w ON w.id=uw.warehouse_id WHERE uw.user_id=? ORDER BY w.name,w.id`,
    [auth.user.id],
  );
  return warehouses;
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

export function createSalesActivityApiService({ dbPool }) {
  const summaryService = createSalesActivityService({ dbPool });

  async function withReadTransaction(operation) {
    const connection = await dbPool.getConnection();
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
      const value = await operation(connection);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
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
      const assigned = await authorized(connection, auth);
      const assignedIds = assigned.map((row) => String(row.id));
      if (
        warehouseId !== undefined &&
        (!validateId(warehouseId) || !assignedIds.includes(String(warehouseId)))
      ) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const scope =
        warehouseId === undefined ? assignedIds : [String(warehouseId)];
      const facts = await summaryService.summarize({
        auth,
        dateFrom,
        dateTo,
        warehouseId,
        connection,
      });
      if (!scope.length) return response(facts, [], 0, page, pageSize);
      const { startUtc, endUtc } = bogotaUtcBoundaries(dateFrom, dateTo);
      const inScope = placeholders(scope);
      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM (
           SELECT CONCAT('sale-confirmation:',CAST(s.id AS CHAR)) AS event_id FROM sales s
            WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at>=? AND s.confirmed_at<? AND s.confirmed_at IS NOT NULL
           UNION ALL
           SELECT CONCAT('sale-cancellation:',CAST(sc.id AS CHAR)) FROM sale_cancellations sc JOIN sales s ON s.id=sc.sale_id
            WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at IS NOT NULL AND sc.created_at>=? AND sc.created_at<?
           UNION ALL
           SELECT CONCAT('customer-return:',CAST(cr.id AS CHAR)) FROM customer_returns cr JOIN sales s ON s.id=cr.sale_id
            WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at IS NOT NULL AND cr.returned_at>=? AND cr.returned_at<?
         ) facts`,
        [
          ...scope,
          startUtc,
          endUtc,
          ...scope,
          startUtc,
          endUtc,
          ...scope,
          startUtc,
          endUtc,
        ],
      );
      const total = Number(countRows[0].total);
      const offset = (page - 1) * pageSize;
      if (offset > 10000)
        throw new HttpError(
          400,
          "PAGE_OFFSET_TOO_LARGE",
          "El desplazamiento máximo permitido es 10.000 registros.",
        );
      const [rows] = await connection.execute(
        `SELECT * FROM (
          SELECT CONCAT('sale-confirmation:',CAST(s.id AS CHAR)) AS id,'sale_confirmation' AS type,
                 s.confirmed_at AS occurred_at,CAST(s.id AS CHAR) AS sale_id,CAST(s.id AS CHAR) AS source_id,
                 s.commercial_code AS sale_code,s.warehouse_id, s.warehouse_code_snapshot AS warehouse_code,
                 s.warehouse_name_snapshot AS warehouse_name, CAST(COALESCE(SUM(sl.line_total),0) AS CHAR) AS amount
            FROM sales s LEFT JOIN sale_lines sl ON sl.sale_id=s.id
           WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at>=? AND s.confirmed_at<? AND s.confirmed_at IS NOT NULL
           GROUP BY s.id,s.confirmed_at,s.commercial_code,s.warehouse_id,s.warehouse_code_snapshot,s.warehouse_name_snapshot
          UNION ALL
          SELECT CONCAT('sale-cancellation:',CAST(sc.id AS CHAR)),'sale_cancellation',sc.created_at,
                 CAST(s.id AS CHAR),CAST(sc.id AS CHAR),s.commercial_code,s.warehouse_id,
                 s.warehouse_code_snapshot,s.warehouse_name_snapshot,CAST(COALESCE(SUM(sl.line_total),0) AS CHAR)
            FROM sale_cancellations sc JOIN sales s ON s.id=sc.sale_id LEFT JOIN sale_lines sl ON sl.sale_id=s.id
           WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at IS NOT NULL AND sc.created_at>=? AND sc.created_at<?
           GROUP BY sc.id,s.id,sc.created_at,s.commercial_code,s.warehouse_id,s.warehouse_code_snapshot,s.warehouse_name_snapshot
          UNION ALL
          SELECT CONCAT('customer-return:',CAST(cr.id AS CHAR)),'customer_return',cr.returned_at,
                 CAST(s.id AS CHAR),CAST(cr.id AS CHAR),s.commercial_code,s.warehouse_id,
                 s.warehouse_code_snapshot,s.warehouse_name_snapshot,
                 CAST(COALESCE(SUM(crl.quantity_received*sl.unit_price),0) AS CHAR)
            FROM customer_returns cr JOIN sales s ON s.id=cr.sale_id
            LEFT JOIN customer_return_lines crl ON crl.customer_return_id=cr.id AND crl.sale_id=cr.sale_id
            LEFT JOIN sale_lines sl ON sl.id=crl.sale_line_id AND sl.sale_id=cr.sale_id
           WHERE s.warehouse_id IN (${inScope}) AND s.confirmed_at IS NOT NULL AND cr.returned_at>=? AND cr.returned_at<?
           GROUP BY cr.id,s.id,cr.returned_at,s.commercial_code,s.warehouse_id,s.warehouse_code_snapshot,s.warehouse_name_snapshot
         ) activity ORDER BY occurred_at DESC,type ASC,id ASC LIMIT ? OFFSET ?`,
        [
          ...scope,
          startUtc,
          endUtc,
          ...scope,
          startUtc,
          endUtc,
          ...scope,
          startUtc,
          endUtc,
          pageSize,
          offset,
        ],
      );
      const returnIds = rows
        .filter((row) => row.type === "customer_return")
        .map((row) => row.source_id);
      const quantities = new Map();
      if (returnIds.length) {
        const [quantityRows] = await connection.execute(
          `SELECT customer_return_id,unit_snapshot,CAST(SUM(quantity_received) AS CHAR) AS received,
                  CAST(SUM(quantity_restocked) AS CHAR) AS restocked
             FROM customer_return_lines WHERE customer_return_id IN (${placeholders(returnIds)})
            GROUP BY customer_return_id,unit_snapshot ORDER BY unit_snapshot`,
          returnIds,
        );
        for (const row of quantityRows) {
          const entries = quantities.get(String(row.customer_return_id)) || [];
          entries.push({
            unit: row.unit_snapshot,
            quantityReceived: String(row.received),
            quantityRestocked: String(row.restocked),
          });
          quantities.set(String(row.customer_return_id), entries);
        }
      }
      return response(
        facts,
        rows.map((row) => ({
          id: row.id,
          type: row.type,
          occurredAt: row.occurred_at,
          sale: { id: String(row.sale_id), number: row.sale_code },
          sourceId: String(row.source_id),
          warehouse: {
            id: String(row.warehouse_id),
            code: row.warehouse_code,
            name: row.warehouse_name,
          },
          amount: row.amount === null ? null : String(row.amount),
          quantitiesByUnit: quantities.get(String(row.source_id)) || [],
        })),
        total,
        page,
        pageSize,
      );
    });
  }

  async function listWarehouses({ auth, q = "", page = 1, pageSize = 20 }) {
    return withReadTransaction(async (connection) => {
      await authorized(connection, auth, { loadWarehouses: false });
      const where = q ? "AND (w.code LIKE ? OR w.name LIKE ?)" : "";
      const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const params = q ? [auth.user.id, search, search] : [auth.user.id];
      const [[count]] = await connection.execute(
        `SELECT COUNT(*) AS total FROM user_warehouses uw JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ${where}`,
        params,
      );
      const total = Number(count.total);
      const [items] = await connection.execute(
        `SELECT w.id,w.code,w.name,w.is_active FROM user_warehouses uw JOIN warehouses w ON w.id=uw.warehouse_id
          WHERE uw.user_id=? ${where} ORDER BY w.name,w.id LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      return {
        items: items.map((row) => ({
          id: String(row.id),
          code: row.code,
          name: row.name,
          isActive: Boolean(row.is_active),
        })),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    });
  }

  return { list, listWarehouses };
}

function response(facts, activities, total, page, pageSize) {
  return {
    period: facts.period,
    criteria: {
      currency: "COP",
      periodSemantics:
        "Fechas inclusivas de America/Bogota; máximo 92 días calendario, contando ambos extremos.",
      calculation:
        "Bruto por fecha de confirmación; anulaciones por fecha de anulación; devoluciones equivalentes por fecha de devolución.",
      returnEquivalentMeaning:
        "No representa necesariamente dinero reembolsado.",
      referenceBalanceMeaning:
        "Referencia comercial; no es un resultado contable.",
    },
    summary: facts.summary,
    activities,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    generatedAt: new Date().toISOString(),
  };
}
