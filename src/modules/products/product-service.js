import { HttpError } from "../../shared/http-error.js";

const sortColumns = {
  sku: "p.sku",
  name: "p.name",
  category: "c.name",
  salePrice: "p.sale_price",
  status: "p.is_active",
  updatedAt: "p.updated_at",
};

const productSelect = `
  SELECT p.id, p.sku, p.name, p.description, p.category_id,
         c.name AS category_name, p.unit, p.purchase_price, p.sale_price,
         p.minimum_sale_quantity, p.minimum_sale_enabled, p.minimum_stock,
         p.is_active, p.created_at, p.updated_at
  FROM products AS p
  JOIN categories AS c ON c.id = p.category_id`;

function productFromRow(row) {
  return {
    id: String(row.id),
    sku: row.sku,
    name: row.name,
    description: row.description,
    categoryId: String(row.category_id),
    categoryName: row.category_name,
    unit: row.unit,
    purchasePrice: String(row.purchase_price),
    salePrice: String(row.sale_price),
    minimumSaleQuantity:
      row.minimum_sale_quantity === null
        ? null
        : Number(row.minimum_sale_quantity),
    minimumSaleEnabled: Boolean(row.minimum_sale_enabled),
    minimumStock: Number(row.minimum_stock),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  { userId, action, productId, details, request },
) {
  const { ipAddress, userAgent } = auditMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'products', 'product', ?, ?, ?, ?)`,
    [
      userId,
      action,
      String(productId),
      JSON.stringify(details),
      ipAddress,
      userAgent,
    ],
  );
}

function isDuplicateSku(error) {
  return (
    error.code === "ER_DUP_ENTRY" && error.message.includes("uq_products_sku")
  );
}

function uniqueViolation(error) {
  if (!isDuplicateSku(error)) return error;
  return new HttpError(
    409,
    "PRODUCT_SKU_TAKEN",
    "Ya existe un producto con ese SKU.",
  );
}

export function createProductService({ dbPool }) {
  async function getById(id) {
    const [rows] = await dbPool.execute(
      `${productSelect} WHERE p.id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) {
      throw new HttpError(
        404,
        "PRODUCT_NOT_FOUND",
        "No se encontró el producto.",
      );
    }
    return productFromRow(rows[0]);
  }

  async function list({
    page,
    pageSize,
    query,
    status,
    categoryId,
    sortBy,
    sortOrder,
  }) {
    const filters = [];
    const values = [];
    if (status !== "all") {
      filters.push("p.is_active = ?");
      values.push(status === "active" ? 1 : 0);
    }
    if (categoryId) {
      filters.push("p.category_id = ?");
      values.push(categoryId);
    }
    if (query) {
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      filters.push(
        "(p.sku LIKE ? ESCAPE '\\\\' OR p.name LIKE ? ESCAPE '\\\\')",
      );
      values.push(`%${escaped}%`, `%${escaped}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const [[countRow]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM products AS p ${where}`,
      values,
    );
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `${productSelect} ${where}
       ORDER BY ${sortColumns[sortBy]} ${direction}, p.id ASC
       LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    const total = Number(countRow.total);
    return {
      items: rows.map(productFromRow),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function ensureCategory(connection, categoryId, isActiveProduct) {
    const [rows] = await connection.execute(
      "SELECT id, is_active FROM categories WHERE id = ? FOR UPDATE",
      [categoryId],
    );
    if (!rows[0]) {
      throw new HttpError(
        400,
        "INVALID_PRODUCT_CATEGORY",
        "Selecciona una categoría existente.",
      );
    }
    if (isActiveProduct && !rows[0].is_active) {
      throw new HttpError(
        400,
        "INACTIVE_PRODUCT_CATEGORY",
        "Los productos activos requieren una categoría activa.",
      );
    }
    return rows[0];
  }

  async function create({ input, userId, request }) {
    const connection = await dbPool.getConnection();
    let productId;
    try {
      await connection.beginTransaction();
      await ensureCategory(connection, input.categoryId, input.isActive);
      const [result] = await connection.execute(
        `INSERT INTO products
          (sku, name, description, category_id, unit, purchase_price, sale_price,
           minimum_sale_quantity, minimum_sale_enabled, minimum_stock, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.sku,
          input.name,
          input.description,
          input.categoryId,
          input.unit,
          input.purchasePrice,
          input.salePrice,
          input.minimumSaleQuantity,
          Number(input.minimumSaleEnabled),
          input.minimumStock,
          Number(input.isActive),
        ],
      );
      productId = String(result.insertId);
      await writeAudit(connection, {
        userId,
        action: "products.created",
        productId,
        details: { sku: input.sku, name: input.name },
        request,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw uniqueViolation(error);
    } finally {
      connection.release();
    }
    return getById(productId);
  }

  async function update({ id, input, userId, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, sku, name, description, category_id, unit,
                purchase_price, sale_price, minimum_sale_quantity,
                minimum_sale_enabled, minimum_stock, is_active
         FROM products WHERE id = ? FOR UPDATE`,
        [id],
      );
      const current = rows[0];
      if (!current) {
        throw new HttpError(
          404,
          "PRODUCT_NOT_FOUND",
          "No se encontró el producto.",
        );
      }
      await ensureCategory(connection, input.categoryId, input.isActive);
      const changedFields = [
        ...(current.sku !== input.sku ? ["sku"] : []),
        ...(current.name !== input.name ? ["name"] : []),
        ...(current.description !== input.description ? ["description"] : []),
        ...(String(current.category_id) !== input.categoryId
          ? ["categoryId"]
          : []),
        ...(current.unit !== input.unit ? ["unit"] : []),
        ...(String(current.purchase_price) !== input.purchasePrice
          ? ["purchasePrice"]
          : []),
        ...(String(current.sale_price) !== input.salePrice
          ? ["salePrice"]
          : []),
        ...(current.minimum_sale_quantity === null
          ? input.minimumSaleQuantity === null
            ? []
            : ["minimumSaleQuantity"]
          : Number(current.minimum_sale_quantity) !== input.minimumSaleQuantity
            ? ["minimumSaleQuantity"]
            : []),
        ...(Boolean(current.minimum_sale_enabled) !== input.minimumSaleEnabled
          ? ["minimumSaleEnabled"]
          : []),
        ...(Number(current.minimum_stock) !== input.minimumStock
          ? ["minimumStock"]
          : []),
        ...(Boolean(current.is_active) !== input.isActive ? ["isActive"] : []),
      ];
      if (changedFields.length) {
        await connection.execute(
          `UPDATE products SET sku = ?, name = ?, description = ?, category_id = ?,
             unit = ?, purchase_price = ?, sale_price = ?, minimum_sale_quantity = ?,
             minimum_sale_enabled = ?, minimum_stock = ?, is_active = ?
           WHERE id = ?`,
          [
            input.sku,
            input.name,
            input.description,
            input.categoryId,
            input.unit,
            input.purchasePrice,
            input.salePrice,
            input.minimumSaleQuantity,
            Number(input.minimumSaleEnabled),
            input.minimumStock,
            Number(input.isActive),
            id,
          ],
        );
        const action =
          current.is_active !== Number(input.isActive)
            ? input.isActive
              ? "products.activated"
              : "products.deactivated"
            : "products.updated";
        await writeAudit(connection, {
          userId,
          action,
          productId: id,
          details: { fields: changedFields },
          request,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw uniqueViolation(error);
    } finally {
      connection.release();
    }
    return getById(id);
  }

  async function balances({ productId, warehouseId, userId }) {
    const [rows] = await dbPool.execute(
      `SELECT p.id AS product_id, w.id AS warehouse_id, w.name AS warehouse_name,
              ib.id AS balance_id, ib.quantity, ib.updated_at
       FROM products AS p
       JOIN user_warehouses AS access
         ON access.user_id = ?
       JOIN warehouses AS w
         ON w.id = access.warehouse_id AND w.is_active = 1
       LEFT JOIN inventory_balances AS ib
         ON ib.product_id = p.id AND ib.warehouse_id = w.id
       WHERE p.id = ? AND (? IS NULL OR w.id = ?)
       ORDER BY w.name, w.id`,
      [userId, productId, warehouseId, warehouseId],
    );
    if (!rows.length) {
      const [[product]] = await dbPool.execute(
        "SELECT id FROM products WHERE id = ? LIMIT 1",
        [productId],
      );
      if (!product) {
        throw new HttpError(
          404,
          "PRODUCT_NOT_FOUND",
          "No se encontró el producto.",
        );
      }
      if (warehouseId) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega asignada.",
        );
      }
    }
    return {
      productId,
      items: rows.map((row) => ({
        warehouseId: String(row.warehouse_id),
        warehouseName: row.warehouse_name,
        hasBalance: row.balance_id !== null,
        quantity: row.balance_id === null ? null : Number(row.quantity),
        updatedAt: row.updated_at,
      })),
    };
  }

  return { list, getById, create, update, balances };
}
