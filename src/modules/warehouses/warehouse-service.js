import { HttpError } from "../../shared/http-error.js";

const sortColumns = {
  code: "w.code",
  name: "w.name",
  location: "w.location",
  status: "w.is_active",
  responsible: "responsible_name",
  createdAt: "w.created_at",
  updatedAt: "w.updated_at",
};

function warehouseFromRow(row) {
  return {
    id: String(row.id),
    code: row.code,
    name: row.name,
    location: row.location,
    responsibleUserId:
      row.responsible_user_id === null ? null : String(row.responsible_user_id),
    responsibleName: row.responsible_name,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function duplicateCode(error) {
  return (
    error.code === "ER_DUP_ENTRY" &&
    error.message.includes("uq_warehouses_code")
  );
}

function auditMetadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

async function writeAudit(
  connection,
  { userId, action, warehouseId, details, request },
) {
  const { ipAddress, userAgent } = auditMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'warehouses', 'warehouse', ?, ?, ?, ?)`,
    [
      userId,
      action,
      String(warehouseId),
      JSON.stringify(details),
      ipAddress,
      userAgent,
    ],
  );
}

const warehouseSelect = `
  SELECT w.id, w.code, w.name, w.location, w.responsible_user_id,
         responsible.display_name AS responsible_name,
         w.is_active, w.created_at, w.updated_at
  FROM warehouses AS w
  LEFT JOIN users AS responsible ON responsible.id = w.responsible_user_id`;

export function createWarehouseService({ dbPool }) {
  async function listForResponsibles(query) {
    const [rows] = await dbPool.execute(
      `SELECT id, display_name, email
       FROM users
       WHERE is_active = 1
         AND (? = '' OR display_name LIKE ? OR email LIKE ?)
       ORDER BY display_name, id
       LIMIT 100`,
      [query, `%${query}%`, `%${query}%`],
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: row.display_name || row.email,
      email: row.email,
    }));
  }

  async function getById(id, userId) {
    const [rows] = await dbPool.execute(
      `${warehouseSelect}
       WHERE w.id = ? AND EXISTS (
         SELECT 1 FROM user_warehouses AS access
         WHERE access.warehouse_id = w.id AND access.user_id = ?
       )
       LIMIT 1`,
      [id, userId],
    );
    if (!rows[0]) {
      throw new HttpError(
        404,
        "WAREHOUSE_NOT_FOUND",
        "No se encontró la bodega disponible para tu usuario.",
      );
    }
    return warehouseFromRow(rows[0]);
  }

  async function list({
    userId,
    page,
    pageSize,
    query,
    status,
    sortBy,
    sortOrder,
  }) {
    const filters = [
      `EXISTS (
        SELECT 1 FROM user_warehouses AS access
        WHERE access.warehouse_id = w.id AND access.user_id = ?
      )`,
    ];
    const values = [userId];

    if (status !== "all") {
      filters.push("w.is_active = ?");
      values.push(status === "active" ? 1 : 0);
    }
    if (query) {
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      filters.push(
        `(w.code LIKE ? ESCAPE '\\\\'
          OR w.name LIKE ? ESCAPE '\\\\'
          OR w.location LIKE ? ESCAPE '\\\\'
          OR responsible.display_name LIKE ? ESCAPE '\\\\')`,
      );
      values.push(...Array(4).fill(`%${escaped}%`));
    }

    const where = `WHERE ${filters.join(" AND ")}`;
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total
       FROM warehouses AS w
       LEFT JOIN users AS responsible ON responsible.id = w.responsible_user_id
       ${where}`,
      values,
    );
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `${warehouseSelect}
       ${where}
       ORDER BY ${sortColumns[sortBy]} ${direction}, w.id ASC
       LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    const total = Number(countRow.total);

    return {
      items: rows.map(warehouseFromRow),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function ensureResponsibleIsActive(connection, responsibleUserId) {
    if (responsibleUserId === null) return null;
    const [rows] = await connection.execute(
      `SELECT id FROM users WHERE id = ? AND is_active = 1 FOR UPDATE`,
      [responsibleUserId],
    );
    if (!rows[0]) {
      throw new HttpError(
        400,
        "INVALID_RESPONSIBLE_USER",
        "Selecciona un responsable existente y activo.",
      );
    }
    return String(rows[0].id);
  }

  async function create({ input, userId, request }) {
    const connection = await dbPool.getConnection();
    let warehouseId;
    try {
      await connection.beginTransaction();
      // Serialize new administrator assignments with global role-permission edits.
      const [administratorRole] = await connection.execute(
        "SELECT id FROM roles WHERE code = 'administrator' FOR UPDATE",
      );
      if (!administratorRole[0])
        throw new Error("Falta el rol Administrador del sistema.");
      const responsibleUserId = await ensureResponsibleIsActive(
        connection,
        input.responsibleUserId,
      );
      const [result] = await connection.execute(
        `INSERT INTO warehouses
           (code, name, location, responsible_user_id)
         VALUES (?, ?, ?, ?)`,
        [input.code, input.name, input.location, responsibleUserId],
      );
      warehouseId = String(result.insertId);

      await connection.execute(
        `INSERT IGNORE INTO user_warehouses
           (user_id, warehouse_id, assigned_by)
         SELECT administrator.id, ?, ?
         FROM users AS administrator
         JOIN roles AS role ON role.id = administrator.role_id
         WHERE role.code = 'administrator' AND administrator.is_active = 1`,
        [warehouseId, userId],
      );

      await writeAudit(connection, {
        userId,
        action: "warehouses.created",
        warehouseId,
        details: {
          code: input.code,
          name: input.name,
          location: input.location,
          responsibleUserId,
        },
        request,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (duplicateCode(error)) {
        throw new HttpError(
          409,
          "WAREHOUSE_CODE_TAKEN",
          "Ya existe una bodega con ese código.",
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    return getById(warehouseId, userId);
  }

  async function lockAssignedWarehouse(connection, id, userId) {
    const [rows] = await connection.execute(
      `SELECT w.id, w.code, w.name, w.location, w.responsible_user_id,
              w.is_active
       FROM warehouses AS w
       JOIN user_warehouses AS access
         ON access.warehouse_id = w.id AND access.user_id = ?
       WHERE w.id = ?
       LIMIT 1 FOR UPDATE`,
      [userId, id],
    );
    if (!rows[0]) {
      throw new HttpError(
        404,
        "WAREHOUSE_NOT_FOUND",
        "No se encontró la bodega disponible para tu usuario.",
      );
    }
    return rows[0];
  }

  async function update({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const current = await lockAssignedWarehouse(connection, id, userId);
      const responsibleUserId = await ensureResponsibleIsActive(
        connection,
        input.responsibleUserId,
      );
      const changedFields = [
        ...(current.code !== input.code ? ["code"] : []),
        ...(current.name !== input.name ? ["name"] : []),
        ...(current.location !== input.location ? ["location"] : []),
        ...(current.responsible_user_id === null
          ? responsibleUserId === null
            ? []
            : ["responsibleUserId"]
          : String(current.responsible_user_id) !== responsibleUserId
            ? ["responsibleUserId"]
            : []),
      ];

      if (changedFields.length) {
        await connection.execute(
          `UPDATE warehouses
           SET code = ?, name = ?, location = ?, responsible_user_id = ?
           WHERE id = ?`,
          [input.code, input.name, input.location, responsibleUserId, id],
        );
        await writeAudit(connection, {
          userId,
          action: "warehouses.updated",
          warehouseId: id,
          details: { fields: changedFields },
          request,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (duplicateCode(error)) {
        throw new HttpError(
          409,
          "WAREHOUSE_CODE_TAKEN",
          "Ya existe una bodega con ese código.",
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    return getById(id, userId);
  }

  async function setStatus({ id, isActive, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const current = await lockAssignedWarehouse(connection, id, userId);
      if (Boolean(current.is_active) !== isActive) {
        if (!isActive) {
          // Keep this as a consistent read, not a locking read: purchase
          // confirmation locks its order before this warehouse. The warehouse
          // lock above serializes both operations without reversing that order.
          const [[pendingPurchases]] = await connection.execute(
            `SELECT COUNT(*) AS blocking_orders
             FROM purchase_orders AS po
             WHERE po.warehouse_id = ?
               AND po.status = 'confirmed'
               AND po.closed_at IS NULL
               AND EXISTS (
                 SELECT 1
                 FROM purchase_order_lines AS pol
                 WHERE pol.purchase_order_id = po.id
                   AND pol.is_active = 1
                   AND pol.quantity > COALESCE(
                     (
                       SELECT SUM(prl.quantity)
                       FROM purchase_receipt_lines AS prl
                       WHERE prl.purchase_order_id = po.id
                         AND prl.purchase_order_line_id = pol.id
                     ),
                     0
                   )
               )`,
            [id],
          );
          const blockingOrderCount = Number(pendingPurchases.blocking_orders);
          if (blockingOrderCount > 0) {
            throw new HttpError(
              409,
              "WAREHOUSE_HAS_PENDING_PURCHASES",
              `No puedes desactivar esta bodega: tiene ${blockingOrderCount} ${blockingOrderCount === 1 ? "orden de compra confirmada" : "órdenes de compra confirmadas"} con cantidades pendientes de recibir. Registra las recepciones o cierra las cantidades pendientes antes de volver a intentarlo.`,
            );
          }

          const [[stock]] = await connection.execute(
            "SELECT EXISTS(SELECT 1 FROM inventory_balances WHERE warehouse_id = ? AND quantity > 0) AS has_stock",
            [id],
          );
          if (stock.has_stock) {
            throw new HttpError(
              409,
              "WAREHOUSE_HAS_STOCK",
              "No puedes desactivar una bodega que conserva existencias.",
            );
          }
        }
        await connection.execute(
          "UPDATE warehouses SET is_active = ? WHERE id = ?",
          [Number(isActive), id],
        );
        await writeAudit(connection, {
          userId,
          action: isActive ? "warehouses.activated" : "warehouses.deactivated",
          warehouseId: id,
          details: { isActive },
          request,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return getById(id, userId);
  }

  return { listForResponsibles, getById, list, create, update, setStatus };
}
