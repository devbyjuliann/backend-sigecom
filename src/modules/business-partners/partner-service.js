import { HttpError } from "../../shared/http-error.js";

const sortColumns = {
  identification: "identification_number",
  name: "name",
  status: "is_active",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const supplierSortColumns = {
  ...sortColumns,
  name: "business_name",
};

function partnerFromRow(row, resource) {
  const common = {
    id: String(row.id),
    identificationType: row.identification_type,
    identificationNumber: row.identification_number,
    phone: row.phone,
    email: row.email,
    address: row.address,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (resource === "customers") return { ...common, name: row.name };
  return {
    ...common,
    businessName: row.business_name,
    contactName: row.contact_name,
  };
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
  { userId, resource, action, id, fields, request },
) {
  const { ipAddress, userAgent } = auditMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      action,
      resource,
      resource === "customers" ? "customer" : "supplier",
      String(id),
      JSON.stringify({ fields }),
      ipAddress,
      userAgent,
    ],
  );
}

function isDuplicateIdentification(error, resource) {
  return (
    error.code === "ER_DUP_ENTRY" &&
    error.message.includes(`uq_${resource}_identification_key`)
  );
}

function conflictError(resource) {
  const label = resource === "customers" ? "cliente" : "proveedor";
  return new HttpError(
    409,
    `${resource === "customers" ? "CUSTOMER" : "SUPPLIER"}_IDENTIFICATION_TAKEN`,
    `Ya existe un ${label} con ese número de identificación.`,
  );
}

function duplicateAsHttp(error, resource) {
  return isDuplicateIdentification(error, resource)
    ? conflictError(resource)
    : error;
}

function columnsFor(resource) {
  return resource === "customers"
    ? "id, identification_type, identification_number, name, phone, email, address, is_active, created_at, updated_at"
    : "id, identification_type, identification_number, business_name, contact_name, phone, email, address, is_active, created_at, updated_at";
}

function valuesFor(input, resource) {
  return resource === "customers"
    ? [
        input.identificationType,
        input.identificationNumber,
        input.name,
        input.phone,
        input.email,
        input.address,
        Number(input.isActive),
      ]
    : [
        input.identificationType,
        input.identificationNumber,
        input.businessName,
        input.contactName,
        input.phone,
        input.email,
        input.address,
        Number(input.isActive),
      ];
}

function fieldsFor(input, resource) {
  const fields = [
    "identificationType",
    "identificationNumber",
    resource === "customers" ? "name" : "businessName",
  ];
  if (resource === "suppliers") fields.push("contactName");
  fields.push("phone", "email", "address", "isActive");
  return fields;
}

export function createPartnerService({ dbPool, resource }) {
  const table = resource;
  const nameColumn = resource === "customers" ? "name" : "business_name";
  const identityConflictCode =
    resource === "customers" ? "CUSTOMER_NOT_FOUND" : "SUPPLIER_NOT_FOUND";

  async function getById(id) {
    const [rows] = await dbPool.execute(
      `SELECT ${columnsFor(resource)} FROM ${table} WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) {
      throw new HttpError(
        404,
        identityConflictCode,
        `No se encontró el ${resource === "customers" ? "cliente" : "proveedor"}.`,
      );
    }
    return partnerFromRow(rows[0], resource);
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
      const searchColumns =
        resource === "customers"
          ? "identification_number LIKE ? ESCAPE '\\\\' OR name LIKE ? ESCAPE '\\\\' OR email LIKE ? ESCAPE '\\\\'"
          : "identification_number LIKE ? ESCAPE '\\\\' OR business_name LIKE ? ESCAPE '\\\\' OR contact_name LIKE ? ESCAPE '\\\\' OR email LIKE ? ESCAPE '\\\\'";
      const terms = resource === "customers" ? 3 : 4;
      filters.push(`(${searchColumns})`);
      values.push(...Array(terms).fill(`%${escaped}%`));
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [[count]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM ${table} ${where}`,
      values,
    );
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const columns =
      resource === "customers" ? sortColumns : supplierSortColumns;
    const [rows] = await dbPool.execute(
      `SELECT ${columnsFor(resource)} FROM ${table} ${where}
       ORDER BY ${columns[sortBy]} ${direction}, id ASC LIMIT ? OFFSET ?`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    const total = Number(count.total);
    return {
      items: rows.map((row) => partnerFromRow(row, resource)),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function create({ input, userId, request }) {
    const connection = await dbPool.getConnection();
    let id;
    try {
      await connection.beginTransaction();
      const columns =
        resource === "customers"
          ? "identification_type, identification_number, name, phone, email, address, is_active"
          : "identification_type, identification_number, business_name, contact_name, phone, email, address, is_active";
      const placeholders =
        resource === "customers"
          ? "?, ?, ?, ?, ?, ?, ?"
          : "?, ?, ?, ?, ?, ?, ?, ?";
      const [result] = await connection.execute(
        `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
        valuesFor(input, resource),
      );
      id = String(result.insertId);
      await writeAudit(connection, {
        userId,
        resource,
        action: `${resource}.created`,
        id,
        fields: fieldsFor(input, resource),
        request,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw duplicateAsHttp(error, resource);
    } finally {
      connection.release();
    }
    return getById(id);
  }

  async function update({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT ${columnsFor(resource)} FROM ${table} WHERE id = ? FOR UPDATE`,
        [id],
      );
      const current = rows[0];
      if (!current) {
        throw new HttpError(
          404,
          identityConflictCode,
          `No se encontró el ${resource === "customers" ? "cliente" : "proveedor"}.`,
        );
      }
      const comparisons = [
        [
          "identificationType",
          current.identification_type,
          input.identificationType,
        ],
        [
          "identificationNumber",
          current.identification_number,
          input.identificationNumber,
        ],
        [
          resource === "customers" ? "name" : "businessName",
          current[nameColumn],
          input[resource === "customers" ? "name" : "businessName"],
        ],
        ...(resource === "suppliers"
          ? [["contactName", current.contact_name, input.contactName]]
          : []),
        ["phone", current.phone, input.phone],
        ["email", current.email, input.email],
        ["address", current.address, input.address],
        ["isActive", Boolean(current.is_active), input.isActive],
      ];
      const changedFields = comparisons
        .filter(([, before, after]) => before !== after)
        .map(([field]) => field);
      if (changedFields.length) {
        const columnNames =
          resource === "customers"
            ? "identification_type = ?, identification_number = ?, name = ?, phone = ?, email = ?, address = ?, is_active = ?"
            : "identification_type = ?, identification_number = ?, business_name = ?, contact_name = ?, phone = ?, email = ?, address = ?, is_active = ?";
        await connection.execute(
          `UPDATE ${table} SET ${columnNames} WHERE id = ?`,
          [...valuesFor(input, resource), id],
        );
        const action =
          Boolean(current.is_active) !== input.isActive
            ? input.isActive
              ? `${resource}.activated`
              : `${resource}.deactivated`
            : `${resource}.updated`;
        await writeAudit(connection, {
          userId,
          resource,
          action,
          id,
          fields: changedFields,
          request,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw duplicateAsHttp(error, resource);
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
        `SELECT id, is_active FROM ${table} WHERE id = ? FOR UPDATE`,
        [id],
      );
      if (!rows[0]) {
        throw new HttpError(
          404,
          identityConflictCode,
          `No se encontró el ${resource === "customers" ? "cliente" : "proveedor"}.`,
        );
      }
      if (Boolean(rows[0].is_active) !== isActive) {
        await connection.execute(
          `UPDATE ${table} SET is_active = ? WHERE id = ?`,
          [Number(isActive), id],
        );
        await writeAudit(connection, {
          userId,
          resource,
          action: isActive
            ? `${resource}.activated`
            : `${resource}.deactivated`,
          id,
          fields: ["isActive"],
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
