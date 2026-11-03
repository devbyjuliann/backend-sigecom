import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";

const MODULES = [
  "auth",
  "categories",
  "customers",
  "inventory",
  "products",
  "profile",
  "purchases",
  "roles",
  "sales",
  "suppliers",
  "users",
  "warehouses",
];

const ACTIONS = [
  "auth.login_failed",
  "auth.login_succeeded",
  "auth.logout",
  "auth.password_changed",
  "categories.created",
  "categories.updated",
  "categories.activated",
  "categories.deactivated",
  "customers.created",
  "customers.updated",
  "customers.activated",
  "customers.deactivated",
  "inventory.adjustment_in",
  "inventory.adjustment_out",
  "inventory.customer_return",
  "inventory.initial_stock",
  "inventory.purchase_receipt",
  "inventory.sale_issue",
  "inventory.sale_reversal",
  "inventory.supplier_return",
  "inventory.transfer",
  "products.created",
  "products.updated",
  "products.activated",
  "products.deactivated",
  "profile.updated",
  "purchases.receipt_confirmed",
  "purchases.return_confirmed",
  "roles.permissions_updated",
  "sales.confirmed",
  "sales.draft_created",
  "sales.draft_updated",
  "sales.return_confirmed",
  "sales.reversed",
  "suppliers.created",
  "suppliers.updated",
  "suppliers.activated",
  "suppliers.deactivated",
  "users.activated",
  "users.created",
  "users.deactivated",
  "users.password_reset",
  "users.updated",
  "warehouses.activated",
  "warehouses.created",
  "warehouses.deactivated",
  "warehouses.updated",
];

const SAFE_FIELDS = {
  categories: new Set(["name", "description", "isActive"]),
  customers: new Set([
    "name",
    "phone",
    "email",
    "address",
    "identificationNumber",
  ]),
  products: new Set([
    "sku",
    "name",
    "description",
    "categoryId",
    "unit",
    "purchasePrice",
    "salePrice",
    "minimumSaleQuantity",
    "minimumStock",
    "isActive",
  ]),
  profile: new Set(["displayName", "phone", "address"]),
  suppliers: new Set([
    "businessName",
    "contactName",
    "phone",
    "email",
    "address",
    "identificationNumber",
  ]),
  users: new Set([
    "displayName",
    "email",
    "roleCode",
    "isActive",
    "warehouseIds",
  ]),
  warehouses: new Set([
    "code",
    "name",
    "location",
    "responsibleUserId",
    "isActive",
  ]),
};

const SQL_ENTITY_ID = `CASE WHEN ae.entity_id REGEXP '^[1-9][0-9]{0,19}$'
  THEN CAST(ae.entity_id AS UNSIGNED) ELSE NULL END`;

function assigned(warehouseExpression) {
  return `EXISTS (SELECT 1 FROM user_warehouses AS audit_uw
    WHERE audit_uw.user_id = ? AND audit_uw.warehouse_id = ${warehouseExpression})`;
}

function assignedWarehouseArray(
  jsonExpression,
  assignmentJson,
  params,
  userId,
) {
  params.push(String(userId));
  return `(JSON_TYPE(${jsonExpression}) = 'ARRAY'
    AND JSON_LENGTH(${jsonExpression}) <= 64
    AND JSON_CONTAINS(${assignmentJson}, ${jsonExpression}) = 1
    AND JSON_LENGTH(${jsonExpression}) = (
      SELECT COUNT(*) FROM user_warehouses AS audit_array_uw
       WHERE audit_array_uw.user_id = ?
         AND JSON_CONTAINS(${jsonExpression}, JSON_QUOTE(CAST(audit_array_uw.warehouse_id AS CHAR))) = 1
    ))`;
}

function safeJsonId(jsonExpression) {
  const value = `JSON_UNQUOTE(${jsonExpression})`;
  return `CASE WHEN ${value} REGEXP '^[1-9][0-9]{0,19}$'
    THEN CAST(${value} AS UNSIGNED) ELSE NULL END`;
}

function detailJson(row) {
  if (row.details === null || row.details === undefined) return null;
  if (typeof row.details === "string") {
    try {
      return JSON.parse(row.details);
    } catch {
      return null;
    }
  }
  return row.details;
}

function positiveId(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d{0,19}$/.test(text)) return null;
  try {
    return BigInt(text) <= 18446744073709551615n ? text : null;
  } catch {
    return null;
  }
}

function boundedString(value, max = 160) {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : null;
}

function fieldNames(value, module) {
  if (!Array.isArray(value) || !SAFE_FIELDS[module]) return [];
  return [
    ...new Set(value.filter((field) => SAFE_FIELDS[module].has(field))),
  ].sort();
}

function projectDetails(row, allowedWarehouseIds) {
  const source = detailJson(row);
  const output = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { detailState: "partial", details: output };
  }
  const copyId = (key, target = key) => {
    const value = positiveId(source[key]);
    if (value) output[target] = value;
  };
  const copyCount = (key, target = key) => {
    const value = Number(source[key]);
    if (Number.isSafeInteger(value) && value >= 0) output[target] = value;
  };
  const copyVersion = (key) => copyCount(key);
  const wh = (value) => {
    const id = positiveId(value);
    return id && allowedWarehouseIds.has(id) ? id : null;
  };
  const copyWarehouses = (sourceKey, targetKey = sourceKey) => {
    if (!Array.isArray(source[sourceKey])) return;
    const ids = source[sourceKey].map(wh);
    if (ids.every(Boolean)) output[targetKey] = [...new Set(ids)];
  };
  const action = row.action.startsWith(`${row.module}.`)
    ? row.action
    : `${row.module}.${row.action}`;

  switch (action) {
    case "auth.login_succeeded":
      if (["password", "session_refresh"].includes(source.method))
        output.method = source.method;
      break;
    case "auth.password_changed":
      copyCount("revokedSessions");
      break;
    case "users.activated":
    case "users.deactivated":
    case "warehouses.activated":
    case "warehouses.deactivated":
      if (
        typeof source.isActive === "boolean" ||
        source.isActive === 0 ||
        source.isActive === 1
      )
        output.isActive = Boolean(source.isActive);
      break;
    case "users.password_reset":
      copyCount("revokedSessions");
      if (typeof source.passwordChangeRequired === "boolean")
        output.passwordChangeRequired = source.passwordChangeRequired;
      break;
    case "users.created":
      if (
        ["administrator", "seller", "warehouse", "auditor"].includes(
          source.roleCode,
        )
      )
        output.roleCode = source.roleCode;
      copyWarehouses("warehouseIds");
      break;
    case "users.updated": {
      output.fields = fieldNames(source.fields, "users");
      if (source.roleCode && typeof source.roleCode === "object") {
        const previous = source.roleCode.previous;
        const current = source.roleCode.current;
        if (
          ["administrator", "seller", "warehouse", "auditor"].includes(
            previous,
          ) &&
          ["administrator", "seller", "warehouse", "auditor"].includes(current)
        )
          output.roleCode = { previous, current };
      }
      for (const key of ["addedWarehouseIds", "removedWarehouseIds"]) {
        if (Array.isArray(source[key])) copyWarehouses(key);
      }
      break;
    }
    case "roles.permissions_updated":
      if (
        ["administrator", "seller", "warehouse", "auditor"].includes(
          source.roleCode,
        )
      )
        output.roleCode = source.roleCode;
      copyVersion("policyVersion");
      copyCount("affectedAccountCount");
      copyCount("revokedSessionCount");
      if (Array.isArray(source.addedPermissionCodes))
        output.addedPermissionCount = source.addedPermissionCodes.length;
      if (Array.isArray(source.removedPermissionCodes))
        output.removedPermissionCount = source.removedPermissionCodes.length;
      break;
    case "categories.created":
      if (boundedString(source.name, 80))
        output.name = boundedString(source.name, 80);
      break;
    case "categories.updated":
    case "products.updated":
    case "products.activated":
    case "products.deactivated":
      output.fields = fieldNames(source.fields, row.module);
      break;
    case "products.created":
      if (boundedString(source.sku, 64))
        output.sku = boundedString(source.sku, 64);
      if (boundedString(source.name, 160))
        output.name = boundedString(source.name, 160);
      break;
    case "customers.created":
    case "customers.updated":
    case "customers.activated":
    case "customers.deactivated":
    case "suppliers.created":
    case "suppliers.updated":
    case "suppliers.activated":
    case "suppliers.deactivated":
    case "profile.updated":
      output.fields = fieldNames(source.fields, row.module);
      break;
    case "warehouses.created":
      for (const key of ["code", "name"])
        if (boundedString(source[key], 120))
          output[key] = boundedString(source[key], 120);
      break;
    case "warehouses.updated":
      output.fields = fieldNames(source.fields, "warehouses");
      break;
    case "sales.draft_created":
      if (
        typeof source.saleDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(source.saleDate)
      )
        output.saleDate = source.saleDate;
      if (Array.isArray(source.lines)) output.lineCount = source.lines.length;
      copyId("warehouseId");
      break;
    case "sales.draft_updated":
      copyVersion("expectedVersion");
      copyVersion("version");
      if (
        source.previous &&
        typeof source.previous === "object" &&
        source.current &&
        typeof source.current === "object"
      ) {
        const previousWarehouseId = wh(source.previous.warehouseId);
        const currentWarehouseId = wh(source.current.warehouseId);
        if (previousWarehouseId && currentWarehouseId)
          output.warehouses = [
            ...new Set([previousWarehouseId, currentWarehouseId]),
          ];
      }
      break;
    case "sales.confirmed":
      copyVersion("expectedVersion");
      copyVersion("version");
      copyId("sourceOperationId");
      copyCount("lineCount");
      copyId("warehouseId");
      if (
        typeof source.total === "string" &&
        /^\d{1,63}\.\d{2}$/.test(source.total)
      )
        output.total = source.total;
      break;
    case "sales.reversed":
      copyId("reversalId");
      copyId("sourceIssueOperationId");
      copyId("sourceOperationId");
      copyVersion("expectedVersion");
      copyVersion("version");
      for (const key of [
        "neverDispatched",
        "allQuantitiesPresent",
        "allProductsSaleable",
      ])
        if (typeof source[key] === "boolean") output[key] = source[key];
      copyId("warehouseId");
      break;
    case "sales.return_confirmed":
      copyId("returnId");
      copyId("sourceOperationId");
      copyVersion("expectedVersion");
      copyVersion("version");
      if (Array.isArray(source.lines)) output.lineCount = source.lines.length;
      break;
    case "purchases.receipt_confirmed":
      if (row.entity_type === "purchase_order") copyIdFromEntityId(output, row);
      else copyId("orderId");
      copyId("receiptId");
      copyId("sourceOperationId");
      copyCount("lineCount");
      copyCount("receivedQuantity");
      break;
    case "purchases.return_confirmed":
      copyId("orderId");
      copyId("receiptId");
      copyId("sourceOperationId");
      if (
        Array.isArray(source.lines) &&
        source.lines.every(
          (line) =>
            line &&
            typeof line === "object" &&
            positiveId(line.receiptLineId) &&
            positiveId(line.productId) &&
            ((typeof line.quantity === "number" &&
              Number.isSafeInteger(line.quantity) &&
              line.quantity > 0) ||
              (typeof line.quantity === "string" &&
                /^[1-9]\d{0,63}$/.test(line.quantity))),
        )
      ) {
        output.lineCount = source.lines.length;
        output.returnedQuantity = source.lines
          .reduce((sum, line) => sum + BigInt(line.quantity), 0n)
          .toString();
      }
      break;
    default:
      if (row.module === "inventory") {
        copyId("operationId");
        copyCount("movementCount");
        if (
          typeof source.operationType === "string" &&
          source.operationType === row.action.slice("inventory.".length)
        )
          output.operationType = source.operationType;
        copyId("sourceWarehouseId");
        copyId("destinationWarehouseId");
      }
  }

  const requiredKeys = {
    "auth.login_succeeded": ["method"],
    "categories.created": ["name"],
    "products.created": ["sku", "name"],
    "sales.confirmed": ["sourceOperationId", "warehouseId", "total"],
    "sales.draft_created": ["warehouseId"],
    "sales.draft_updated": ["warehouses"],
    "sales.reversed": [
      "sourceOperationId",
      "sourceIssueOperationId",
      "warehouseId",
    ],
    "purchases.receipt_confirmed": [
      "orderId",
      "receiptId",
      "sourceOperationId",
      "lineCount",
      "receivedQuantity",
    ],
    "purchases.return_confirmed": [
      "orderId",
      "receiptId",
      "sourceOperationId",
      "lineCount",
      "returnedQuantity",
    ],
  }[action];
  const requiredKnown =
    !requiredKeys || requiredKeys.every((key) => Object.hasOwn(output, key));
  return {
    detailState: requiredKnown ? "complete" : "partial",
    details: output,
  };
}

function copyIdFromEntityId(output, row, key = "orderId") {
  const value = positiveId(row.entity_id);
  if (value) output[key] = value;
}

function toMysqlUtc(isoValue) {
  return isoValue
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})\d+$/, "$1");
}

function normalizeDateTime(value) {
  if (value instanceof Date) return toMysqlUtc(value.toISOString());
  return String(value).replace("T", " ").replace(/Z$/, "");
}

function hmac(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest();
}

function contextHash(context) {
  return createHash("sha256")
    .update(JSON.stringify(context))
    .digest("base64url");
}

function encodeCursor({ last, upper, context }, secret) {
  const payload = Buffer.from(
    JSON.stringify({ last, upper, context }),
  ).toString("base64url");
  return `${payload}.${hmac(payload, secret).toString("base64url")}`;
}

function decodeCursor(value, secret, expectedContext) {
  if (typeof value !== "string" || value.length > 1024) throw invalidCursor();
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw invalidCursor();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw invalidCursor();
  }
  const expected = hmac(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw invalidCursor();
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const validTuple = (tuple) =>
      Array.isArray(tuple) &&
      tuple.length === 2 &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(tuple[0]) &&
      positiveId(tuple[1]) !== null;
    if (
      decoded.context !== expectedContext ||
      !validTuple(decoded.last) ||
      !validTuple(decoded.upper)
    )
      throw invalidCursor();
    if (
      decoded.last[0] > decoded.upper[0] ||
      (decoded.last[0] === decoded.upper[0] &&
        BigInt(decoded.last[1]) > BigInt(decoded.upper[1]))
    )
      throw invalidCursor();
    return decoded;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidCursor();
  }
}

function invalidCursor() {
  return new HttpError(
    400,
    "INVALID_AUDIT_CURSOR",
    "El cursor de auditoría no es válido.",
  );
}

function parseWarehouseArray(row) {
  let value = row.scope_warehouse_ids;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positiveId).filter(Boolean))];
}

function baseVisibility({ permissions, userId, assignmentJson }) {
  const groups = [];
  const params = [];
  const has = (permission) => permissions.has(permission);
  const scope = (expression) => {
    params.push(String(userId));
    return assigned(expression);
  };

  groups.push(`(ae.module = 'auth' AND (
    (ae.action = 'auth.login_failed' AND ae.entity_type IS NULL)
    OR (ae.action = 'auth.login_succeeded' AND ae.entity_type = 'user_session')
    OR (ae.action = 'auth.logout' AND ae.entity_type = 'user_session')
    OR (ae.action = 'auth.password_changed' AND ae.entity_type = 'user')
  ))`);
  groups.push(`(ae.module = 'users' AND ae.entity_type = 'user' AND ae.action IN
    ('users.activated','users.deactivated','users.password_reset'))`);
  groups.push(`(ae.module = 'users' AND ae.entity_type = 'user' AND ae.action = 'users.updated'
    AND JSON_TYPE(JSON_EXTRACT(ae.details, '$.addedWarehouseIds')) IS NULL
    AND JSON_TYPE(JSON_EXTRACT(ae.details, '$.removedWarehouseIds')) IS NULL)`);
  groups.push(
    `(ae.module = 'profile' AND ae.action = 'profile.updated' AND ae.entity_type = 'user')`,
  );
  groups.push(
    `(ae.module = 'roles' AND ae.action = 'roles.permissions_updated' AND ae.entity_type = 'role')`,
  );

  if (has("categories.read"))
    groups.push(
      `(ae.module = 'categories' AND ae.action IN ('categories.created','categories.updated','categories.activated','categories.deactivated') AND ae.entity_type = 'category')`,
    );
  if (has("products.read"))
    groups.push(
      `(ae.module = 'products' AND ae.action IN ('products.created','products.updated','products.activated','products.deactivated') AND ae.entity_type = 'product')`,
    );
  if (has("customers.read"))
    groups.push(
      `(ae.module = 'customers' AND ae.action IN ('customers.created','customers.updated','customers.activated','customers.deactivated') AND ae.entity_type = 'customer')`,
    );
  if (has("suppliers.read"))
    groups.push(
      `(ae.module = 'suppliers' AND ae.action IN ('suppliers.created','suppliers.updated','suppliers.activated','suppliers.deactivated') AND ae.entity_type = 'supplier')`,
    );

  if (has("warehouses.read")) {
    groups.push(`(ae.module = 'warehouses' AND ae.entity_type = 'warehouse'
      AND ae.action IN ('warehouses.created','warehouses.updated','warehouses.activated','warehouses.deactivated')
      AND ${scope(SQL_ENTITY_ID)})`);
  }

  if (has("warehouses.read")) {
    const idList = "JSON_EXTRACT(?, '$')";
    const createdWarehouseIds = "JSON_EXTRACT(ae.details, '$.warehouseIds')";
    params.push(assignmentJson);
    const assignedCreatedWarehouses = assignedWarehouseArray(
      createdWarehouseIds,
      idList,
      params,
      userId,
    );
    groups.push(`(ae.module = 'users' AND ae.entity_type = 'user' AND ae.action = 'users.created'
      AND ${assignedCreatedWarehouses}
      AND JSON_LENGTH(${createdWarehouseIds}) > 0)`);
    const addedWarehouseIds = "JSON_EXTRACT(ae.details, '$.addedWarehouseIds')";
    const removedWarehouseIds =
      "JSON_EXTRACT(ae.details, '$.removedWarehouseIds')";
    params.push(assignmentJson);
    const assignedAddedWarehouses = assignedWarehouseArray(
      addedWarehouseIds,
      idList,
      params,
      userId,
    );
    params.push(assignmentJson);
    const assignedRemovedWarehouses = assignedWarehouseArray(
      removedWarehouseIds,
      idList,
      params,
      userId,
    );
    groups.push(`(ae.module = 'users' AND ae.entity_type = 'user' AND ae.action = 'users.updated'
      AND (JSON_TYPE(JSON_EXTRACT(ae.details, '$.addedWarehouseIds')) = 'ARRAY'
        OR JSON_TYPE(JSON_EXTRACT(ae.details, '$.removedWarehouseIds')) = 'ARRAY')
      AND (JSON_TYPE(JSON_EXTRACT(ae.details, '$.addedWarehouseIds')) IS NULL OR JSON_TYPE(JSON_EXTRACT(ae.details, '$.addedWarehouseIds')) = 'ARRAY')
      AND (JSON_TYPE(JSON_EXTRACT(ae.details, '$.removedWarehouseIds')) IS NULL OR JSON_TYPE(JSON_EXTRACT(ae.details, '$.removedWarehouseIds')) = 'ARRAY')
      AND (${addedWarehouseIds} IS NULL OR ${assignedAddedWarehouses})
      AND (${removedWarehouseIds} IS NULL OR ${assignedRemovedWarehouses}))`);
  }

  if (has("sales.read") && has("warehouses.read")) {
    const draftWarehouse = safeJsonId(
      "JSON_EXTRACT(ae.details, '$.warehouseId')",
    );
    const previousWarehouse = safeJsonId(
      "JSON_EXTRACT(ae.details, '$.previous.warehouseId')",
    );
    const currentWarehouse = safeJsonId(
      "JSON_EXTRACT(ae.details, '$.current.warehouseId')",
    );
    groups.push(`(ae.module = 'sales' AND ae.action = 'sales.draft_created' AND ae.entity_type = 'sale'
      AND ${draftWarehouse} IS NOT NULL AND ${scope(draftWarehouse)})`);
    groups.push(`(ae.module = 'sales' AND ae.action = 'sales.draft_updated' AND ae.entity_type = 'sale'
      AND ${previousWarehouse} IS NOT NULL AND ${currentWarehouse} IS NOT NULL
      AND ${scope(previousWarehouse)} AND ${scope(currentWarehouse)})`);
    groups.push(`(ae.module = 'sales' AND ae.action = 'sales.confirmed' AND ae.entity_type = 'sale'
      AND ${draftWarehouse} IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceOperationId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND EXISTS (SELECT 1 FROM inventory_operations AS audit_io
        WHERE audit_io.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.sourceOperationId')")}
          AND audit_io.operation_type = 'sale_issue' AND audit_io.source_type = 'sale'
          AND audit_io.source_id = ae.entity_id AND audit_io.source_warehouse_id = ${draftWarehouse}
          AND audit_io.destination_warehouse_id IS NULL)
      AND ${scope(draftWarehouse)})`);
    groups.push(`(ae.module = 'sales' AND ae.action = 'sales.reversed' AND ae.entity_type = 'sale'
      AND ${draftWarehouse} IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceIssueOperationId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceOperationId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND EXISTS (SELECT 1 FROM inventory_operations AS audit_issue
        JOIN inventory_operations AS audit_reversal
          ON audit_reversal.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.sourceOperationId')")}
        WHERE audit_issue.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.sourceIssueOperationId')")}
          AND audit_issue.operation_type = 'sale_issue' AND audit_issue.source_type = 'sale'
          AND audit_issue.source_id = ae.entity_id AND audit_issue.source_warehouse_id = ${draftWarehouse}
          AND audit_reversal.operation_type = 'sale_reversal' AND audit_reversal.source_type = 'sale_cancellation'
          AND audit_reversal.source_id = CONVERT(JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.reversalId')) USING utf8mb4) COLLATE utf8mb4_unicode_ci
          AND audit_reversal.source_warehouse_id = audit_issue.source_warehouse_id)
      AND ${scope(draftWarehouse)})`);
    groups.push(`(ae.module = 'sales' AND ae.action = 'sales.return_confirmed' AND ae.entity_type = 'sale'
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.returnId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND EXISTS (SELECT 1 FROM customer_returns AS audit_return
        JOIN inventory_operations AS audit_issue
           ON audit_issue.operation_type = 'sale_issue' AND audit_issue.source_type = 'sale'
          AND audit_issue.source_id = ae.entity_id
        LEFT JOIN inventory_operations AS audit_restock
          ON audit_restock.id = audit_return.source_operation_id
        WHERE audit_return.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.returnId')")}
          AND audit_return.sale_id = ${SQL_ENTITY_ID}
          AND (audit_return.source_operation_id IS NULL OR
            (audit_restock.operation_type = 'customer_return' AND audit_restock.source_type = 'customer_return'
              AND audit_restock.source_id = CAST(audit_return.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
             AND audit_restock.source_warehouse_id = audit_issue.source_warehouse_id)))
      AND EXISTS (SELECT 1 FROM inventory_operations AS audit_issue
          WHERE audit_issue.operation_type = 'sale_issue' AND audit_issue.source_type = 'sale'
          AND audit_issue.source_id = ae.entity_id AND ${scope("audit_issue.source_warehouse_id")}))`);
  }

  if (has("purchases.read") && has("warehouses.read")) {
    groups.push(`(ae.module = 'purchases' AND ae.action = 'purchases.receipt_confirmed'
      AND ae.entity_type IN ('purchase_receipt','purchase_order')
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.receiptId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceOperationId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND EXISTS (SELECT 1 FROM purchase_receipts AS audit_receipt
        JOIN purchase_orders AS audit_order ON audit_order.id = audit_receipt.purchase_order_id
        JOIN inventory_operations AS audit_io ON audit_io.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.sourceOperationId')")}
        WHERE audit_receipt.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.receiptId')")}
          AND ((ae.entity_type = 'purchase_receipt' AND audit_receipt.id = ${SQL_ENTITY_ID}
                AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.orderId')) = CAST(audit_order.id AS CHAR))
            OR (ae.entity_type = 'purchase_order' AND audit_order.id = ${SQL_ENTITY_ID}))
          AND audit_io.operation_type = 'purchase_receipt' AND audit_io.source_type = 'purchase_receipt'
          AND audit_io.source_id = CAST(audit_receipt.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          AND audit_io.source_warehouse_id = audit_order.warehouse_id
          AND audit_io.destination_warehouse_id IS NULL
          AND ${scope("audit_io.source_warehouse_id")}))`);
    groups.push(`(ae.module = 'purchases' AND ae.action = 'purchases.return_confirmed'
      AND ae.entity_type = 'supplier_return'
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.sourceOperationId')) REGEXP '^[1-9][0-9]{0,19}$'
      AND EXISTS (SELECT 1 FROM supplier_returns AS audit_return
        JOIN purchase_orders AS audit_order ON audit_order.id = audit_return.purchase_order_id
        JOIN purchase_receipts AS audit_receipt ON audit_receipt.id = audit_return.purchase_receipt_id
        JOIN inventory_operations AS audit_io ON audit_io.id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.sourceOperationId')")}
        WHERE audit_return.id = ${SQL_ENTITY_ID} AND audit_return.purchase_order_id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.orderId')")}
          AND audit_return.purchase_receipt_id = ${safeJsonId("JSON_EXTRACT(ae.details, '$.receiptId')")}
          AND audit_receipt.purchase_order_id = audit_order.id
          AND audit_io.operation_type = 'supplier_return' AND audit_io.source_type = 'supplier_return'
          AND audit_io.source_id = CAST(audit_return.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
          AND audit_io.source_warehouse_id = audit_order.warehouse_id
          AND audit_io.destination_warehouse_id IS NULL
          AND ${scope("audit_io.source_warehouse_id")}))`);
  }

  if (has("inventory.movements.read") && has("warehouses.read")) {
    const opId = safeJsonId("JSON_EXTRACT(ae.details, '$.operationId')");
    const source = safeJsonId(
      "JSON_EXTRACT(ae.details, '$.sourceWarehouseId')",
    );
    const destination = safeJsonId(
      "JSON_EXTRACT(ae.details, '$.destinationWarehouseId')",
    );
    groups.push(`(ae.module = 'inventory' AND ae.entity_type = 'inventory_operation'
      AND ae.action IN ('inventory.adjustment_in','inventory.adjustment_out','inventory.customer_return','inventory.initial_stock','inventory.purchase_receipt','inventory.sale_issue','inventory.sale_reversal','inventory.supplier_return','inventory.transfer')
      AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, '$.operationId')) = ae.entity_id
      AND ${source} IS NOT NULL
      AND EXISTS (SELECT 1 FROM inventory_operations AS audit_io
        WHERE audit_io.id = ${opId} AND audit_io.operation_type = CONVERT(SUBSTRING(ae.action, 11) USING utf8mb4) COLLATE utf8mb4_unicode_ci
          AND audit_io.source_warehouse_id = ${source}
          AND ((audit_io.destination_warehouse_id IS NULL AND JSON_TYPE(JSON_EXTRACT(ae.details, '$.destinationWarehouseId')) = 'NULL')
            OR audit_io.destination_warehouse_id = ${destination})
          AND ${scope("audit_io.source_warehouse_id")}
          AND (audit_io.destination_warehouse_id IS NULL OR ${scope("audit_io.destination_warehouse_id")})))`);
  }

  if (!groups.length) return { sql: "0 = 1", values: [] };
  return { sql: `(${groups.join(" OR ")})`, values: params };
}

function warehouseIdsExpression(alias = "ae") {
  return `CASE
    WHEN ${alias}.module = 'warehouses' THEN JSON_ARRAY(${alias}.entity_id)
    WHEN ${alias}.module = 'sales' AND ${alias}.action IN ('sales.draft_created','sales.confirmed','sales.reversed') THEN JSON_ARRAY(JSON_UNQUOTE(JSON_EXTRACT(${alias}.details, '$.warehouseId')))
    WHEN ${alias}.module = 'sales' AND ${alias}.action = 'sales.draft_updated' THEN JSON_ARRAY(JSON_UNQUOTE(JSON_EXTRACT(${alias}.details, '$.previous.warehouseId')), JSON_UNQUOTE(JSON_EXTRACT(${alias}.details, '$.current.warehouseId')))
    WHEN ${alias}.module = 'sales' AND ${alias}.action = 'sales.return_confirmed' THEN (SELECT JSON_ARRAY(CAST(io.source_warehouse_id AS CHAR)) FROM inventory_operations io WHERE io.operation_type='sale_issue' AND io.source_type='sale' AND io.source_id=${alias}.entity_id ORDER BY io.id LIMIT 1)
    WHEN ${alias}.module = 'purchases' AND ${alias}.action = 'purchases.receipt_confirmed' THEN (SELECT JSON_ARRAY(CAST(io.source_warehouse_id AS CHAR)) FROM inventory_operations io WHERE io.operation_type='purchase_receipt' AND io.source_type='purchase_receipt' AND io.source_id=CONVERT(JSON_UNQUOTE(JSON_EXTRACT(${alias}.details,'$.receiptId')) USING utf8mb4) COLLATE utf8mb4_unicode_ci ORDER BY io.id LIMIT 1)
    WHEN ${alias}.module = 'purchases' AND ${alias}.action = 'purchases.return_confirmed' THEN (SELECT JSON_ARRAY(CAST(io.source_warehouse_id AS CHAR)) FROM inventory_operations io WHERE io.operation_type='supplier_return' AND io.source_type='supplier_return' AND io.source_id=${alias}.entity_id ORDER BY io.id LIMIT 1)
    WHEN ${alias}.module = 'inventory' THEN JSON_ARRAY(JSON_UNQUOTE(JSON_EXTRACT(${alias}.details, '$.sourceWarehouseId')), JSON_UNQUOTE(JSON_EXTRACT(${alias}.details, '$.destinationWarehouseId')))
    WHEN ${alias}.module = 'users' AND ${alias}.action = 'users.created' THEN JSON_EXTRACT(${alias}.details, '$.warehouseIds')
    WHEN ${alias}.module = 'users' AND ${alias}.action = 'users.updated' THEN JSON_MERGE_PRESERVE(COALESCE(JSON_EXTRACT(${alias}.details, '$.addedWarehouseIds'), JSON_ARRAY()), COALESCE(JSON_EXTRACT(${alias}.details, '$.removedWarehouseIds'), JSON_ARRAY()))
    ELSE JSON_ARRAY() END`;
}

function applyFilters(filters, { omit } = {}) {
  const clauses = [];
  const values = [];
  if (omit !== "module" && filters.module) {
    clauses.push("v.module = ?");
    values.push(filters.module);
  }
  if (omit !== "action" && filters.action) {
    clauses.push("v.action = ?");
    values.push(filters.action);
  }
  if (omit !== "actorId" && filters.actorId) {
    clauses.push("v.user_id = ?");
    values.push(filters.actorId);
  }
  if (omit !== "warehouseId" && filters.warehouseId) {
    clauses.push(
      "JSON_CONTAINS(COALESCE(v.scope_warehouse_ids, JSON_ARRAY()), JSON_QUOTE(?)) = 1",
    );
    values.push(filters.warehouseId);
  }
  if (filters.dateFrom) {
    clauses.push("v.created_at >= ?");
    values.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push("v.created_at < ?");
    values.push(filters.dateTo);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function matchesOptionFilters(row, filters, omit) {
  if (omit !== "module" && filters.module && row.module !== filters.module)
    return false;
  if (omit !== "action" && filters.action && row.action !== filters.action)
    return false;
  if (
    omit !== "actorId" &&
    filters.actorId &&
    String(row.user_id) !== filters.actorId
  )
    return false;
  if (
    omit !== "warehouseId" &&
    filters.warehouseId &&
    !parseWarehouseArray({
      scope_warehouse_ids: row.scope_warehouse_ids,
    }).includes(filters.warehouseId)
  )
    return false;
  return true;
}

function projection(row, { allowedWarehouseIds, role }) {
  const warehouseIds = parseWarehouseArray(row);
  const details = projectDetails(row, allowedWarehouseIds);
  const hideSession = row.entity_type === "user_session";
  return {
    id: String(row.id),
    createdAt: row.created_at,
    module: row.module,
    action: row.action,
    actor:
      row.user_id === null
        ? null
        : {
            id: String(row.user_id),
            label: `Usuario #${row.user_id}`,
            labelSource: "internalId",
          },
    entity:
      !row.entity_type || hideSession
        ? null
        : {
            type: row.entity_type,
            id: row.entity_id === null ? null : String(row.entity_id),
          },
    warehouses: warehouseIds.map((id) => ({ id, label: `Bodega #${id}` })),
    detailState: details.detailState,
    details: details.details,
    viewerRole: role,
  };
}

export function createAuditService({ dbPool, cursorSecret }) {
  if (typeof cursorSecret !== "string" || Buffer.byteLength(cursorSecret) < 32)
    throw new Error("La clave del cursor de Auditoría no es válida.");

  async function contextFor({ userId, permissions }) {
    const [rows] = await dbPool.execute(
      "SELECT CAST(warehouse_id AS CHAR) AS id FROM user_warehouses WHERE user_id = ? ORDER BY warehouse_id",
      [userId],
    );
    const allowedWarehouseIds = new Set(rows.map((row) => String(row.id)));
    const assignmentJson = JSON.stringify([...allowedWarehouseIds]);
    const base = baseVisibility({ permissions, userId, assignmentJson });
    const visibleSql = `SELECT ae.id, ae.user_id, ae.action, ae.module, ae.entity_type, ae.entity_id,
      ae.details, ae.created_at, ${warehouseIdsExpression("ae")} AS scope_warehouse_ids
      FROM audit_events AS ae WHERE ${base.sql}`;
    const context = contextHash({
      userId: String(userId),
      permissions: [...permissions].sort(),
      assignments: [...allowedWarehouseIds].sort(),
    });
    return { allowedWarehouseIds, base, visibleSql, context };
  }

  return {
    async options({ filters, userId, permissions, role }) {
      const context = await contextFor({ userId, permissions });
      const modules = new Set();
      const actions = new Set();
      const actors = new Set();
      const warehouseOptions = new Map();
      const dateFilter = {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      };
      const filter = applyFilters(dateFilter);
      const [rows] = await dbPool.execute(
        `SELECT DISTINCT v.module, v.action, v.user_id, v.scope_warehouse_ids
           FROM (${context.visibleSql}) AS v ${filter.sql}`,
        [...context.base.values, ...filter.values],
      );
      for (const row of rows) {
        if (matchesOptionFilters(row, filters, "module") && row.module)
          modules.add(row.module);
        if (matchesOptionFilters(row, filters, "action") && row.action)
          actions.add(row.action);
        if (
          matchesOptionFilters(row, filters, "actorId") &&
          row.user_id !== null
        )
          actors.add(String(row.user_id));
        if (matchesOptionFilters(row, filters, "warehouseId")) {
          for (const id of parseWarehouseArray({
            scope_warehouse_ids: row.scope_warehouse_ids,
          }))
            warehouseOptions.set(id, { id, label: `Bodega #${id}` });
        }
      }
      return {
        modules: MODULES.filter((module) => modules.has(module)),
        actions: ACTIONS.filter((action) => actions.has(action)),
        actors: [...actors]
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
          .map((id) => ({ id, label: `Usuario #${id}` })),
        warehouses: [...warehouseOptions.values()].sort((a, b) =>
          BigInt(a.id) < BigInt(b.id) ? -1 : 1,
        ),
        viewerRole: role,
      };
    },

    async list({ filters, pageSize, cursor, userId, permissions, role }) {
      const context = await contextFor({ userId, permissions });
      const filter = applyFilters(filters);
      const queryContext = contextHash({ context: context.context, filters });
      let last = null;
      let upper;
      if (cursor) {
        ({ last, upper } = decodeCursor(cursor, cursorSecret, queryContext));
      } else {
        const [latest] = await dbPool.execute(
          `SELECT v.created_at, v.id FROM (${context.visibleSql}) AS v ${filter.sql}
           ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
          [...context.base.values, ...filter.values],
        );
        if (!latest.length)
          return {
            items: [],
            pagination: { pageSize, hasMore: false, nextCursor: null },
          };
        upper = [normalizeDateTime(latest[0].created_at), String(latest[0].id)];
      }
      const clauses = [filter.sql, "(v.created_at, v.id) <= (?, ?)"];
      if (last) clauses.push("(v.created_at, v.id) < (?, ?)");
      const [rows] = await dbPool.execute(
        `SELECT v.* FROM (${context.visibleSql}) AS v ${clauses
          .filter(Boolean)
          .join(" AND ")
          .replace(/^ AND /, "WHERE ")}
         ORDER BY v.created_at DESC, v.id DESC LIMIT ?`,
        [
          ...context.base.values,
          ...filter.values,
          ...upper,
          ...(last || []),
          pageSize + 1,
        ],
      );
      const hasMore = rows.length > pageSize;
      const selected = rows.slice(0, pageSize);
      const items = selected.map((row) =>
        projection(row, {
          allowedWarehouseIds: context.allowedWarehouseIds,
          role,
        }),
      );
      const lastRow = selected.at(-1);
      const nextCursor =
        hasMore && lastRow
          ? encodeCursor(
              {
                last: [
                  normalizeDateTime(lastRow.created_at),
                  String(lastRow.id),
                ],
                upper,
                context: queryContext,
              },
              cursorSecret,
            )
          : null;
      return { items, pagination: { pageSize, hasMore, nextCursor } };
    },

    async get({ id, userId, permissions, role }) {
      const context = await contextFor({ userId, permissions });
      const [rows] = await dbPool.execute(
        `SELECT v.* FROM (${context.visibleSql}) AS v WHERE v.id = ? LIMIT 1`,
        [...context.base.values, id],
      );
      if (!rows.length)
        throw new HttpError(
          404,
          "AUDIT_EVENT_NOT_FOUND",
          "No se encontró el evento de auditoría.",
        );
      return projection(rows[0], {
        allowedWarehouseIds: context.allowedWarehouseIds,
        role,
      });
    },
  };
}

export const auditCatalog = Object.freeze({
  modules: MODULES,
  actions: ACTIONS,
});
