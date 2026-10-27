import { createHash } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";

const maximumQuantity = 4_294_967_295;
const maximumBigInt = 18_446_744_073_709_551_615n;
const movementTypes = new Set([
  "initial_stock",
  "adjustment_in",
  "adjustment_out",
  "transfer",
]);
const requiredPermissions = {
  initial_stock: "inventory.initialize",
  adjustment_in: "inventory.adjust",
  adjustment_out: "inventory.adjust",
  transfer: "inventory.transfer",
};

function invalidRequest(
  message = "Revisa los datos de la operación de inventario.",
) {
  return new HttpError(400, "INVALID_INVENTORY_OPERATION", message);
}

function normalizeId(value, field) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) {
    throw invalidRequest(`Indica un ${field} válido.`);
  }
  if (BigInt(value) > maximumBigInt)
    throw invalidRequest(`El ${field} excede el límite.`);
  return value;
}

function normalizeVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/.test(value)) {
    throw invalidRequest(
      "La versión esperada debe ser un entero sin pérdida de precisión.",
    );
  }
  if (BigInt(value) > maximumBigInt)
    throw invalidRequest("La versión excede el límite permitido.");
  return value;
}

function normalizePayload(payload) {
  if (!payload || !movementTypes.has(payload.type)) {
    throw invalidRequest("El tipo de operación no está habilitado.");
  }
  const sourceWarehouseId = normalizeId(payload.sourceWarehouseId, "bodega");
  const destinationWarehouseId =
    payload.type === "transfer"
      ? normalizeId(payload.destinationWarehouseId, "bodega destino")
      : null;
  if (
    payload.type === "transfer" &&
    sourceWarehouseId === destinationWarehouseId
  ) {
    throw invalidRequest("El origen y el destino deben ser diferentes.");
  }
  if (payload.type !== "transfer" && payload.destinationWarehouseId != null) {
    throw invalidRequest("Esta operación no admite una bodega destino.");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim()) {
    throw invalidRequest("El motivo es obligatorio.");
  }
  const reason = payload.reason.trim();
  if (reason.length > 500)
    throw invalidRequest("El motivo no puede superar 500 caracteres.");
  const reference =
    payload.reference == null ? null : String(payload.reference).trim();
  if (reference && reference.length > 120) {
    throw invalidRequest("La referencia no puede superar 120 caracteres.");
  }
  if (
    !Array.isArray(payload.lines) ||
    payload.lines.length < 1 ||
    payload.lines.length > 50
  ) {
    throw invalidRequest("La operación debe incluir entre 1 y 50 productos.");
  }

  const lines = payload.lines.map((line) => {
    const productId = normalizeId(line?.productId, "producto");
    if (
      !Number.isSafeInteger(line?.quantity) ||
      line.quantity < 1 ||
      line.quantity > maximumQuantity
    ) {
      throw invalidRequest(
        "Las cantidades deben ser enteros positivos dentro del límite permitido.",
      );
    }
    const expectedVersion =
      payload.type === "initial_stock"
        ? null
        : normalizeVersion(line.expectedVersion);
    return { productId, quantity: line.quantity, expectedVersion };
  });
  lines.sort((left, right) => {
    const a = BigInt(left.productId);
    const b = BigInt(right.productId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (new Set(lines.map(({ productId }) => productId)).size !== lines.length) {
    throw invalidRequest("No repitas productos dentro de la misma operación.");
  }

  return {
    type: payload.type,
    sourceWarehouseId,
    destinationWarehouseId,
    reason,
    reference: reference || null,
    lines,
  };
}

function hashRequest(userId, payload) {
  return createHash("sha256")
    .update(JSON.stringify({ userId, ...payload }))
    .digest("hex");
}

function parseBalance(row) {
  return {
    quantity: Number(row.quantity),
    version: BigInt(row.version),
  };
}

function operationResult(operationId, replayed, rows) {
  return {
    operationId: String(operationId),
    replayed,
    movements: rows.map((row) => ({
      movementId: String(row.id),
      productId: String(row.product_id),
      warehouseId: String(row.warehouse_id),
      direction: row.direction,
      quantity: Number(row.quantity),
      balanceBefore: Number(row.balance_before),
      balanceAfter: Number(row.balance_after),
      balanceVersion: String(row.balance_version),
      unit: row.unit_snapshot,
      createdAt: row.created_at,
    })),
  };
}

async function readOperationMovements(connection, operationId) {
  const [rows] = await connection.execute(
    `SELECT id, product_id, warehouse_id, direction, quantity,
            balance_before, balance_after, balance_version, unit_snapshot,
            created_at
     FROM inventory_movements
     WHERE operation_id = ? ORDER BY id`,
    [operationId],
  );
  return rows;
}

export function createInventoryEngine({ dbPool, retryLimit = 2 }) {
  if (!dbPool) throw new TypeError("Se requiere el pool de base de datos.");

  async function validateActorAndWarehouses(connection, userId, payload) {
    const [users] = await connection.execute(
      "SELECT id, role_id, is_active FROM users WHERE id = ? FOR UPDATE",
      [userId],
    );
    const user = users[0];
    if (!user || !user.is_active) {
      throw new HttpError(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    }

    const permission = requiredPermissions[payload.type];
    const [permissions] = await connection.execute(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.code = ? FOR UPDATE`,
      [user.role_id, permission],
    );
    if (!permissions.length) {
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "No tienes permiso para esta operación.",
      );
    }

    const warehouseIds = [
      ...new Set(
        [payload.sourceWarehouseId, payload.destinationWarehouseId].filter(
          Boolean,
        ),
      ),
    ].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
    const assignments = [];
    for (const warehouseId of warehouseIds) {
      const [rows] = await connection.execute(
        `SELECT w.id, w.is_active
         FROM user_warehouses uw
         JOIN warehouses w ON w.id = uw.warehouse_id
         WHERE uw.user_id = ? AND uw.warehouse_id = ?
         FOR UPDATE`,
        [userId, warehouseId],
      );
      if (!rows[0]) {
        throw new HttpError(
          404,
          "WAREHOUSE_NOT_FOUND",
          "No se encontró la bodega autorizada.",
        );
      }
      assignments.push(rows[0]);
    }
    return { permission, assignments };
  }

  async function readIdempotentResult(
    connection,
    userId,
    idempotencyKey,
    requestHash,
  ) {
    const [rows] = await connection.execute(
      `SELECT id, request_hash FROM inventory_operations
       WHERE created_by = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
      [userId, idempotencyKey],
    );
    if (!rows[0]) return null;
    if (rows[0].request_hash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia ya fue utilizada con datos diferentes.",
      );
    }
    const movements = await readOperationMovements(connection, rows[0].id);
    return operationResult(rows[0].id, true, movements);
  }

  async function applyWithinTransaction({
    connection,
    userId: rawUserId,
    idempotencyKey: rawIdempotencyKey,
    payload: rawPayload,
    request,
  }) {
    if (!connection || typeof connection.execute !== "function") {
      throw new TypeError(
        "Se requiere una conexión transaccional del llamador.",
      );
    }
    if (typeof rawUserId === "number" && !Number.isSafeInteger(rawUserId)) {
      throw invalidRequest(
        "El identificador del usuario debe conservarse como texto entero.",
      );
    }
    const userId = normalizeId(String(rawUserId), "usuario");
    if (
      typeof rawIdempotencyKey !== "string" ||
      !rawIdempotencyKey.trim() ||
      rawIdempotencyKey.length > 128
    ) {
      throw invalidRequest("Indica una clave de idempotencia válida.");
    }
    const idempotencyKey = rawIdempotencyKey.trim();
    const payload = normalizePayload(rawPayload);
    const requestHash = hashRequest(userId, payload);
    const { assignments } = await validateActorAndWarehouses(
      connection,
      userId,
      payload,
    );

    const replay = await readIdempotentResult(
      connection,
      userId,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    if (assignments.some(({ is_active }) => !is_active)) {
      throw new HttpError(
        409,
        "INACTIVE_WAREHOUSE",
        "Las nuevas operaciones requieren bodegas activas.",
      );
    }

    const [products] = await connection.execute(
      `SELECT id, unit, is_active FROM products
       WHERE id IN (${payload.lines.map(() => "?").join(",")})
       ORDER BY id FOR UPDATE`,
      payload.lines.map(({ productId }) => productId),
    );
    if (products.length !== payload.lines.length) {
      throw new HttpError(
        404,
        "PRODUCT_NOT_FOUND",
        "No se encontró uno de los productos.",
      );
    }
    if (products.some(({ is_active }) => !is_active)) {
      throw new HttpError(
        409,
        "INACTIVE_PRODUCT",
        "Los productos inactivos no admiten nuevas operaciones.",
      );
    }
    const productsById = new Map(
      products.map((product) => [String(product.id), product]),
    );

    await connection.execute(
      `INSERT INTO inventory_operations
        (operation_type, source_warehouse_id, destination_warehouse_id,
         created_by, reason, reference, idempotency_key, request_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.type,
        payload.sourceWarehouseId,
        payload.destinationWarehouseId,
        userId,
        payload.reason,
        payload.reference,
        idempotencyKey,
        requestHash,
      ],
    );
    const [[operationIdentity]] = await connection.query(
      "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
    );
    const operationId = operationIdentity.id;

    const pairs = [];
    for (const { productId } of payload.lines) {
      pairs.push({ warehouseId: payload.sourceWarehouseId, productId });
      if (payload.type === "transfer") {
        pairs.push({ warehouseId: payload.destinationWarehouseId, productId });
      }
    }
    pairs.sort((left, right) => {
      const warehouseDifference =
        BigInt(left.warehouseId) - BigInt(right.warehouseId);
      if (warehouseDifference !== 0n) return warehouseDifference < 0n ? -1 : 1;
      const productDifference =
        BigInt(left.productId) - BigInt(right.productId);
      return productDifference === 0n ? 0 : productDifference < 0n ? -1 : 1;
    });

    for (const { warehouseId, productId } of pairs) {
      await connection.execute(
        `INSERT IGNORE INTO inventory_balances
          (product_id, warehouse_id, quantity, version)
         VALUES (?, ?, 0, 0)`,
        [productId, warehouseId],
      );
    }
    const pairPredicate = pairs
      .map(() => "(product_id = ? AND warehouse_id = ?)")
      .join(" OR ");
    const pairValues = pairs.flatMap(({ productId, warehouseId }) => [
      productId,
      warehouseId,
    ]);
    const [balanceRows] = await connection.execute(
      `SELECT product_id, warehouse_id, quantity, version
       FROM inventory_balances
       WHERE ${pairPredicate}
       ORDER BY warehouse_id, product_id FOR UPDATE`,
      pairValues,
    );
    const balances = new Map(
      balanceRows.map((row) => [
        `${row.product_id}:${row.warehouse_id}`,
        parseBalance(row),
      ]),
    );

    const movements = [];
    for (const line of payload.lines) {
      const sourceKey = `${line.productId}:${payload.sourceWarehouseId}`;
      const source = balances.get(sourceKey);
      if (!source) throw new Error("No se pudo bloquear el saldo de origen.");
      if (
        payload.type !== "initial_stock" &&
        source.version.toString() !== line.expectedVersion
      ) {
        throw new HttpError(
          409,
          "INVENTORY_VERSION_CONFLICT",
          "El saldo cambió. Actualiza la información y vuelve a intentarlo.",
        );
      }
      if (payload.type === "initial_stock") {
        const [[history]] = await connection.execute(
          `SELECT EXISTS(
             SELECT 1 FROM inventory_movements
             WHERE product_id = ? AND warehouse_id = ?
           ) AS has_history`,
          [line.productId, payload.sourceWarehouseId],
        );
        if (source.version !== 0n || history.has_history) {
          throw new HttpError(
            409,
            "INITIAL_STOCK_ALREADY_REGISTERED",
            "Ya existe historial para este producto en la bodega.",
          );
        }
      }

      const movementSpecs =
        payload.type === "transfer"
          ? [
              { warehouseId: payload.sourceWarehouseId, direction: "OUT" },
              { warehouseId: payload.destinationWarehouseId, direction: "IN" },
            ]
          : [
              {
                warehouseId: payload.sourceWarehouseId,
                direction: payload.type === "adjustment_out" ? "OUT" : "IN",
              },
            ];

      for (const spec of movementSpecs) {
        const key = `${line.productId}:${spec.warehouseId}`;
        const current = balances.get(key);
        if (!current)
          throw new Error("No se pudo bloquear el saldo del movimiento.");
        if (spec.direction === "OUT" && current.quantity < line.quantity) {
          throw new HttpError(
            409,
            "INSUFFICIENT_STOCK",
            "La existencia disponible no es suficiente.",
          );
        }
        const nextQuantity =
          spec.direction === "IN"
            ? current.quantity + line.quantity
            : current.quantity - line.quantity;
        if (
          !Number.isSafeInteger(nextQuantity) ||
          nextQuantity < 0 ||
          nextQuantity > maximumQuantity
        ) {
          throw new HttpError(
            409,
            "INVENTORY_QUANTITY_LIMIT",
            "La operación excede el límite de existencias permitido.",
          );
        }
        const nextVersion = current.version + 1n;
        if (nextVersion > maximumBigInt) {
          throw new HttpError(
            409,
            "INVENTORY_VERSION_LIMIT",
            "La versión del saldo alcanzó el límite permitido.",
          );
        }
        const [updated] = await connection.execute(
          `UPDATE inventory_balances
           SET quantity = ?, version = ?
           WHERE product_id = ? AND warehouse_id = ? AND version = ?`,
          [
            nextQuantity,
            nextVersion.toString(),
            line.productId,
            spec.warehouseId,
            current.version.toString(),
          ],
        );
        if (updated.affectedRows !== 1) {
          throw new HttpError(
            409,
            "INVENTORY_VERSION_CONFLICT",
            "El saldo cambió. Actualiza la información y vuelve a intentarlo.",
          );
        }
        await connection.execute(
          `INSERT INTO inventory_movements
            (operation_id, product_id, warehouse_id, direction, quantity,
             balance_before, balance_after, balance_version, unit_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            line.productId,
            spec.warehouseId,
            spec.direction,
            line.quantity,
            current.quantity,
            nextQuantity,
            nextVersion.toString(),
            productsById.get(line.productId).unit,
          ],
        );
        balances.set(key, { quantity: nextQuantity, version: nextVersion });
        movements.push({
          productId: line.productId,
          warehouseId: spec.warehouseId,
          direction: spec.direction,
          quantity: line.quantity,
          balanceBefore: current.quantity,
          balanceAfter: nextQuantity,
          balanceVersion: nextVersion.toString(),
          unit: productsById.get(line.productId).unit,
        });
      }
    }

    const userAgent = request?.get?.("user-agent");
    const details = {
      operationId,
      operationType: payload.type,
      sourceWarehouseId: payload.sourceWarehouseId,
      destinationWarehouseId: payload.destinationWarehouseId,
      movementCount: movements.length,
    };
    await connection.execute(
      `INSERT INTO audit_events
        (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
       VALUES (?, ?, 'inventory', 'inventory_operation', ?, ?, ?, ?)`,
      [
        userId,
        `inventory.${payload.type}`,
        operationId,
        JSON.stringify(details),
        request?.ip || null,
        typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
      ],
    );
    const rows = await readOperationMovements(connection, operationId);
    return operationResult(operationId, false, rows);
  }

  async function createOperation({ userId, idempotencyKey, payload, request }) {
    let attempt = 0;
    while (true) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await applyWithinTransaction({
          connection,
          userId,
          idempotencyKey,
          payload,
          request,
        });
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original database or domain error.
        }
        const retryable =
          error.errno === 1213 ||
          error.errno === 1205 ||
          error.code === "ER_DUP_ENTRY";
        if (!retryable || attempt >= retryLimit) throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            15 * 2 ** (attempt - 1) + Math.floor(Math.random() * 15),
          ),
        );
      } finally {
        connection.release();
      }
    }
  }

  return { createOperation, applyWithinTransaction };
}

export const inventoryEngineValidation = {
  normalizePayload,
  normalizeVersion,
};
