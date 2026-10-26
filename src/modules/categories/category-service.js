import { HttpError } from "../../shared/http-error.js";

const sortColumns = {
  name: "name",
  status: "is_active",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

function categoryFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function duplicateName(error) {
  return (
    error.code === "ER_DUP_ENTRY" &&
    error.message.includes("uq_categories_name")
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
  { userId, action, categoryId, details, request },
) {
  const { ipAddress, userAgent } = auditMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'categories', 'category', ?, ?, ?, ?)`,
    [
      userId,
      action,
      String(categoryId),
      JSON.stringify(details),
      ipAddress,
      userAgent,
    ],
  );
}

export function createCategoryService({ dbPool }) {
  async function getById(id) {
    const [rows] = await dbPool.execute(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM categories WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) {
      throw new HttpError(
        404,
        "CATEGORY_NOT_FOUND",
        "No se encontró la categoría.",
      );
    }
    return categoryFromRow(rows[0]);
  }

  async function list({ page, pageSize, query, status, sortBy, sortOrder }) {
    const filters = [];
    const values = [];
    if (status !== "all") {
      filters.push("is_active = ?");
      values.push(status === "active" ? 1 : 0);
    }
    if (query) {
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      filters.push(
        "(name LIKE ? ESCAPE '\\\\' OR description LIKE ? ESCAPE '\\\\')",
      );
      values.push(`%${escaped}%`, `%${escaped}%`);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [countRows] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM categories ${where}`,
      values,
    );
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM categories ${where}
       ORDER BY ${sortColumns[sortBy]} ${direction}, id ASC
       LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    const total = Number(countRows[0].total);
    return {
      items: rows.map(categoryFromRow),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function create({ name, description, userId, request }) {
    const connection = await dbPool.getConnection();
    let categoryId;
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        "INSERT INTO categories (name, description) VALUES (?, ?)",
        [name, description],
      );
      categoryId = String(result.insertId);
      await writeAudit(connection, {
        userId,
        action: "categories.created",
        categoryId,
        details: { name, description },
        request,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (duplicateName(error)) {
        throw new HttpError(
          409,
          "CATEGORY_NAME_TAKEN",
          "Ya existe una categoría con ese nombre.",
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    return getById(categoryId);
  }

  async function update({ id, name, description, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT id, name, description FROM categories WHERE id = ? FOR UPDATE",
        [id],
      );
      const current = rows[0];
      if (!current) {
        await connection.rollback();
        throw new HttpError(
          404,
          "CATEGORY_NOT_FOUND",
          "No se encontró la categoría.",
        );
      }
      const changedFields = [
        ...(current.name !== name ? ["name"] : []),
        ...(current.description !== description ? ["description"] : []),
      ];
      if (changedFields.length) {
        await connection.execute(
          "UPDATE categories SET name = ?, description = ? WHERE id = ?",
          [name, description, id],
        );
        await writeAudit(connection, {
          userId,
          action: "categories.updated",
          categoryId: id,
          details: { fields: changedFields },
          request,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (duplicateName(error)) {
        throw new HttpError(
          409,
          "CATEGORY_NAME_TAKEN",
          "Ya existe una categoría con ese nombre.",
        );
      }
      throw error;
    } finally {
      connection.release();
    }
    return getById(id);
  }

  async function setStatus({ id, isActive, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT id, is_active FROM categories WHERE id = ? FOR UPDATE",
        [id],
      );
      const current = rows[0];
      if (!current) {
        await connection.rollback();
        throw new HttpError(
          404,
          "CATEGORY_NOT_FOUND",
          "No se encontró la categoría.",
        );
      }
      if (Boolean(current.is_active) !== isActive) {
        await connection.execute(
          "UPDATE categories SET is_active = ? WHERE id = ?",
          [Number(isActive), id],
        );
        await writeAudit(connection, {
          userId,
          action: isActive ? "categories.activated" : "categories.deactivated",
          categoryId: id,
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
    return getById(id);
  }

  return { list, getById, create, update, setStatus };
}
