import { HttpError } from "../../shared/http-error.js";

const requiredPermissions = ["reports.read", "sales.read", "warehouses.read"];
const allowedRoles = new Set(["administrator", "auditor"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxUnsignedBigint = 18446744073709551615n;

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
  )
    return null;
  return date;
}

export function validateSalesActivityPeriod(dateFrom, dateTo) {
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

function formatUtcBoundary(date) {
  return `${date.toISOString().slice(0, 10)} 05:00:00.000`;
}

export function bogotaUtcBoundaries(dateFrom, dateTo) {
  validateSalesActivityPeriod(dateFrom, dateTo);
  const start = civilDate(dateFrom);
  const end = civilDate(dateTo);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startUtc: formatUtcBoundary(start), endUtc: formatUtcBoundary(end) };
}

function decimalToMinorUnits(value) {
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new TypeError("El importe SQL no es un DECIMAL válido.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function minorUnitsToDecimal(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function calculateReferenceBalance(gross, cancellations, returns) {
  return minorUnitsToDecimal(
    decimalToMinorUnits(gross) -
      decimalToMinorUnits(cancellations) -
      decimalToMinorUnits(returns),
  );
}

function emptySummary() {
  return {
    grossConfirmed: "0.00",
    cancellations: "0.00",
    returnEquivalent: "0.00",
    referenceCommercialBalance: "0.00",
    quantitiesByUnit: [],
  };
}

function deny() {
  throw new HttpError(
    403,
    "PERMISSION_DENIED",
    "No tienes permiso para consultar Actividad de Ventas.",
  );
}

function validDatabaseId(value) {
  return (
    /^[1-9]\d{0,19}$/.test(String(value)) && BigInt(value) <= maxUnsignedBigint
  );
}

export function createSalesActivityService({ dbPool }) {
  if (!dbPool) throw new TypeError("dbPool es obligatorio.");

  async function summarize({
    auth,
    dateFrom,
    dateTo,
    warehouseId,
    connection: suppliedConnection,
  } = {}) {
    validateSalesActivityPeriod(dateFrom, dateTo);
    if (
      !auth?.user?.id ||
      !auth?.sessionId ||
      !allowedRoles.has(auth.user.role)
    )
      deny();
    if (!validDatabaseId(auth.user.id) || !validDatabaseId(auth.sessionId))
      deny();
    if (warehouseId !== undefined && !validDatabaseId(warehouseId)) {
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
        await connection.query("SET TRANSACTION READ ONLY");
        await connection.beginTransaction();
      }

      const [sessionRows] = await connection.execute(
        `SELECT u.id, r.code AS role_code, u.password_change_required
           FROM user_sessions us
           JOIN users u ON u.id = us.user_id
           JOIN roles r ON r.id = u.role_id
          WHERE us.id = ? AND us.user_id = ? AND us.revoked_at IS NULL
            AND us.expires_at > UTC_TIMESTAMP(3) AND u.is_active = 1
          LIMIT 1`,
        [auth.sessionId, auth.user.id],
      );
      const session = sessionRows[0];
      if (
        !session ||
        session.password_change_required ||
        session.role_code !== auth.user.role
      )
        deny();

      const [permissionRows] = await connection.execute(
        `SELECT p.code FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          JOIN roles r ON r.id = rp.role_id
          WHERE r.code = ? AND p.code IN (?, ?, ?)`,
        [session.role_code, ...requiredPermissions],
      );
      const currentPermissions = new Set(permissionRows.map((row) => row.code));
      if (
        requiredPermissions.some(
          (permission) => !currentPermissions.has(permission),
        )
      )
        deny();

      const [assignmentRows] = await connection.execute(
        `SELECT uw.warehouse_id
           FROM user_warehouses uw
           JOIN warehouses w ON w.id = uw.warehouse_id
          WHERE uw.user_id = ? ORDER BY uw.warehouse_id`,
        [auth.user.id],
      );
      const assignedIds = assignmentRows.map((row) => String(row.warehouse_id));
      if (
        warehouseId !== undefined &&
        !assignedIds.includes(String(warehouseId))
      ) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      const warehouseIds =
        warehouseId === undefined ? assignedIds : [String(warehouseId)];
      if (!warehouseIds.length) {
        if (ownsConnection) await connection.commit();
        return {
          period: { dateFrom, dateTo, timeZone: "America/Bogota" },
          summary: emptySummary(),
        };
      }

      const { startUtc, endUtc } = bogotaUtcBoundaries(dateFrom, dateTo);
      const warehouseParams = warehouseIds;
      const placeholders = warehouseIds.map(() => "?").join(", ");
      const dateParams = [startUtc, endUtc];

      const [grossRows] = await connection.execute(
        `SELECT CAST(COALESCE(SUM(document_totals.amount), 0) AS CHAR) AS amount
           FROM (
             SELECT s.id, SUM(sl.line_total) AS amount
               FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
              WHERE s.warehouse_id IN (${placeholders})
                AND s.confirmed_at >= ? AND s.confirmed_at < ?
                AND s.confirmed_at IS NOT NULL
              GROUP BY s.id
           ) document_totals`,
        [...warehouseParams, ...dateParams],
      );
      const [cancellationRows] = await connection.execute(
        `SELECT CAST(COALESCE(SUM(document_totals.amount), 0) AS CHAR) AS amount
           FROM (
             SELECT sc.id, SUM(sl.line_total) AS amount
               FROM sale_cancellations sc
               JOIN sales s ON s.id = sc.sale_id
               JOIN sale_lines sl ON sl.sale_id = s.id
              WHERE s.warehouse_id IN (${placeholders})
                AND s.status = 'cancelled'
                AND s.confirmed_at IS NOT NULL
                AND sc.created_at >= ? AND sc.created_at < ?
              GROUP BY sc.id
           ) document_totals`,
        [...warehouseParams, ...dateParams],
      );
      const [returnRows] = await connection.execute(
        `SELECT CAST(COALESCE(SUM(crl.quantity_received * sl.unit_price), 0) AS CHAR) AS amount
           FROM customer_returns cr
           JOIN sales s ON s.id = cr.sale_id
           JOIN customer_return_lines crl ON crl.customer_return_id = cr.id
             AND crl.sale_id = cr.sale_id
           JOIN sale_lines sl ON sl.id = crl.sale_line_id AND sl.sale_id = cr.sale_id
          WHERE s.warehouse_id IN (${placeholders})
            AND s.confirmed_at IS NOT NULL
            AND cr.returned_at >= ? AND cr.returned_at < ?`,
        [...warehouseParams, ...dateParams],
      );
      const [quantityRows] = await connection.execute(
        `SELECT crl.unit_snapshot AS unit,
                CAST(SUM(crl.quantity_received) AS CHAR) AS quantity_received,
                CAST(SUM(crl.quantity_restocked) AS CHAR) AS quantity_restocked
           FROM customer_returns cr
           JOIN sales s ON s.id = cr.sale_id
           JOIN customer_return_lines crl ON crl.customer_return_id = cr.id
             AND crl.sale_id = cr.sale_id
          WHERE s.warehouse_id IN (${placeholders})
            AND s.confirmed_at IS NOT NULL
            AND cr.returned_at >= ? AND cr.returned_at < ?
          GROUP BY crl.unit_snapshot ORDER BY crl.unit_snapshot`,
        [...warehouseParams, ...dateParams],
      );

      const gross = String(grossRows[0]?.amount ?? "0.00");
      const cancellations = String(cancellationRows[0]?.amount ?? "0.00");
      const returnEquivalent = String(returnRows[0]?.amount ?? "0.00");
      const summary = {
        grossConfirmed: gross,
        cancellations,
        returnEquivalent,
        referenceCommercialBalance: calculateReferenceBalance(
          gross,
          cancellations,
          returnEquivalent,
        ),
        quantitiesByUnit: quantityRows.map((row) => ({
          unit: row.unit,
          quantityReceived: String(row.quantity_received),
          quantityRestocked: String(row.quantity_restocked),
        })),
      };
      if (ownsConnection) await connection.commit();
      return {
        period: { dateFrom, dateTo, timeZone: "America/Bogota" },
        summary,
      };
    } catch (error) {
      if (ownsConnection) await connection.rollback();
      throw error;
    } finally {
      if (ownsConnection) connection.release();
    }
  }

  return { summarize };
}
