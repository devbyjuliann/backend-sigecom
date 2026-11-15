import { createRequire } from "node:module";
import mysql from "mysql2/promise";
import { getH2E2EConfig, verifyH2E2EConnection } from "./preflight.js";

const require = createRequire(import.meta.url);
const bcrypt = require("bcrypt");
const markerFor = (runId) => `H2E2E-${runId}`;
export const buildH2E2EIdempotencyLikePattern = (runId) =>
  `${markerFor(runId)}%`;
export function buildH2E2EFixturePermissionRevocation(runId, permissionCode) {
  if (!/^[a-f0-9]{12}$/.test(runId || "")) {
    throw new Error("RUN_ID H2 E2E debe contener 12 caracteres hexadecimales.");
  }
  if (permissionCode !== "dashboard.read") {
    throw new Error("Permission revocation is not allowed for this code.");
  }
  return {
    sql: `DELETE rp FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id
       WHERE r.code = ? AND p.code = ?`,
    values: [`h2e2e_${runId}_seller`, permissionCode],
  };
}
const emailFor = (runId, identity) =>
  `h2e2e-${runId}-${identity}@sigecom.invalid`;

async function connect(config) {
  return mysql.createConnection({
    host: config.sqlHost,
    port: config.sqlPort,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: 5000,
    timezone: "Z",
  });
}

export async function setupH2E2EFixtures(env = process.env) {
  const config = getH2E2EConfig(env);
  const connection = await connect(config);
  let transaction = false;
  try {
    await verifyH2E2EConnection(connection, config, { checkCollisions: true });
    const [[administrator]] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    const [[seller]] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'seller'",
    );
    if (!administrator || !seller) {
      throw new Error("Faltan los roles semilla para las fixtures H2 E2E.");
    }

    const passwordHash = await bcrypt.hash(config.fixturePassword, 4);
    const marker = markerFor(config.runId);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await connection.beginTransaction();
    transaction = true;

    const [roleResult] = await connection.execute(
      "INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)",
      [
        `h2e2e_${config.runId}_seller`,
        `${marker} vendedor aislado`,
        "Rol sintético de la ejecución H2 E2E.",
      ],
    );
    const roleId = roleResult.insertId;
    await connection.execute(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT ?, permission_id FROM role_permissions WHERE role_id = ?`,
      [roleId, seller.id],
    );

    const [userAResult] = await connection.execute(
      `INSERT INTO users
         (role_id, email, display_name, password_hash, is_active, password_change_required)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [
        administrator.id,
        emailFor(config.runId, "a"),
        `${marker} administrador A`,
        passwordHash,
      ],
    );
    const userAId = userAResult.insertId;
    const [userBResult] = await connection.execute(
      `INSERT INTO users
         (role_id, email, display_name, password_hash, is_active, password_change_required, created_by)
       VALUES (?, ?, ?, ?, 1, 0, ?)`,
      [
        roleId,
        emailFor(config.runId, "b"),
        `${marker} vendedor B`,
        passwordHash,
        userAId,
      ],
    );
    const userBId = userBResult.insertId;

    const [warehouseAResult] = await connection.execute(
      "INSERT INTO warehouses (code, name, location, is_active) VALUES (?, ?, ?, 1)",
      [`${marker}-A`, `${marker} Bodega A`, "Fixture sintética H2 E2E A"],
    );
    const warehouseAId = warehouseAResult.insertId;
    const [warehouseBResult] = await connection.execute(
      "INSERT INTO warehouses (code, name, location, is_active) VALUES (?, ?, ?, 1)",
      [`${marker}-B`, `${marker} Bodega B`, "Fixture sintética H2 E2E B"],
    );
    const warehouseBId = warehouseBResult.insertId;
    await connection.execute(
      `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by)
       VALUES (?, ?, ?), (?, ?, ?)`,
      [userAId, warehouseAId, userAId, userBId, warehouseBId, userAId],
    );

    const [categoryResult] = await connection.execute(
      "INSERT INTO categories (name, description, is_active) VALUES (?, ?, 1)",
      [`${marker} Categoría`, "Fixture sintética H2 E2E."],
    );
    const [productResult] = await connection.execute(
      `INSERT INTO products
         (sku, name, category_id, unit, purchase_price, sale_price, minimum_sale_quantity,
          minimum_sale_enabled, minimum_stock, is_active)
       VALUES (?, ?, ?, 'unidad', 7.00, 20.00, NULL, 0, 8, 1)`,
      [`${marker}-SKU`, `${marker} Producto`, categoryResult.insertId],
    );
    const [customerResult] = await connection.execute(
      "INSERT INTO customers (identification_number, name) VALUES (?, ?)",
      [`${marker}-CC`, `${marker} Cliente`],
    );
    const [supplierResult] = await connection.execute(
      "INSERT INTO suppliers (identification_number, business_name) VALUES (?, ?)",
      [`${marker}-NIT`, `${marker} Proveedor`],
    );

    await connection.commit();
    transaction = false;
    return {
      runId: config.runId,
      marker,
      today,
      userAEmail: emailFor(config.runId, "a"),
      userBEmail: emailFor(config.runId, "b"),
      warehouseAId: String(warehouseAId),
      warehouseBId: String(warehouseBId),
      productId: String(productResult.insertId),
      customerId: String(customerResult.insertId),
      supplierId: String(supplierResult.insertId),
      sellerRoleId: String(roleId),
    };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function revokeH2E2EFixtureDashboardPermission(env = process.env) {
  const config = getH2E2EConfig(env);
  const connection = await connect(config);
  let transaction = false;
  try {
    await verifyH2E2EConnection(connection, config, { checkCollisions: false });
    const [[role]] = await connection.execute(
      "SELECT id FROM roles WHERE code = ?",
      [`h2e2e_${config.runId}_seller`],
    );
    if (!role) throw new Error("No existe el rol aislado H2 E2E.");
    await connection.beginTransaction();
    transaction = true;
    const query = buildH2E2EFixturePermissionRevocation(
      config.runId,
      "dashboard.read",
    );
    const [result] = await connection.execute(query.sql, query.values);
    if (result.affectedRows !== 1) {
      throw new Error("No se revocó exactamente el permiso del rol fixture.");
    }
    await connection.commit();
    transaction = false;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function cleanupH2E2EFixtures(env = process.env) {
  const config = getH2E2EConfig(env);
  const connection = await connect(config);
  let transaction = false;
  let stage = "connection verification";
  try {
    await verifyH2E2EConnection(connection, config, { checkCollisions: false });
    const marker = markerFor(config.runId);
    await connection.beginTransaction();
    transaction = true;

    stage = "sale request references";
    await connection.execute(
      `DELETE FROM sale_requests
        WHERE actor_id IN (SELECT id FROM users WHERE email LIKE ?)
           OR sale_id IN (SELECT id FROM sales WHERE notes LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`, `${marker}-%`],
    );
    stage = "customer return lines";
    await connection.execute(
      `DELETE crl FROM customer_return_lines crl
        JOIN customer_returns cr ON cr.id = crl.customer_return_id
        JOIN sales s ON s.id = cr.sale_id WHERE s.notes LIKE ?`,
      [`${marker}-%`],
    );
    stage = "sale cancellation references";
    await connection.execute(
      `DELETE sc FROM sale_cancellations sc
        JOIN sales s ON s.id = sc.sale_id WHERE s.notes LIKE ?`,
      [`${marker}-%`],
    );
    stage = "customer return records";
    await connection.execute(
      `DELETE cr FROM customer_returns cr
        JOIN sales s ON s.id = cr.sale_id WHERE s.notes LIKE ?`,
      [`${marker}-%`],
    );

    stage = "supplier return lines";
    await connection.execute(
      `DELETE srl FROM supplier_return_lines srl
        JOIN supplier_returns sr ON sr.id = srl.supplier_return_id
        JOIN purchase_orders po ON po.id = sr.purchase_order_id
       WHERE po.reference LIKE ?`,
      [`${marker}-%`],
    );
    stage = "supplier return records";
    await connection.execute(
      `DELETE sr FROM supplier_returns sr
        JOIN purchase_orders po ON po.id = sr.purchase_order_id
       WHERE po.reference LIKE ?`,
      [`${marker}-%`],
    );

    stage = "purchase receipt lines";
    await connection.execute(
      `DELETE prl FROM purchase_receipt_lines prl
        JOIN purchase_orders po ON po.id = prl.purchase_order_id
       WHERE po.reference LIKE ?`,
      [`${marker}-%`],
    );
    stage = "purchase receipt records";
    await connection.execute(
      `DELETE pr FROM purchase_receipts pr
        JOIN purchase_orders po ON po.id = pr.purchase_order_id
       WHERE po.reference LIKE ?`,
      [`${marker}-%`],
    );
    stage = "sale lines";
    await connection.execute(
      `DELETE sl FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.notes LIKE ?`,
      [`${marker}-%`],
    );
    stage = "sales and purchase lines";
    await connection.execute("DELETE FROM sales WHERE notes LIKE ?", [
      `${marker}-%`,
    ]);
    stage = "purchase orders";
    await connection.execute(
      "DELETE FROM purchase_order_lines WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE reference LIKE ?)",
      [`${marker}-%`],
    );
    await connection.execute(
      "DELETE FROM purchase_orders WHERE reference LIKE ?",
      [`${marker}-%`],
    );

    stage = "inventory movement rows";
    await connection.execute(
      `DELETE FROM inventory_movements WHERE product_id IN
        (SELECT id FROM products WHERE UPPER(sku) LIKE UPPER(?))`,
      [`${marker}-%`],
    );
    const [[remainingFixtureMovements]] = await connection.execute(
      `SELECT COUNT(*) AS total,
              GROUP_CONCAT(DISTINCT product.sku) AS skus
         FROM inventory_movements movement
       JOIN inventory_operations operation ON operation.id = movement.operation_id
       JOIN products product ON product.id = movement.product_id
       WHERE operation.created_by IN
         (SELECT id FROM users WHERE email LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`],
    );
    if (Number(remainingFixtureMovements.total) > 0) {
      throw new Error(
        `La limpieza encontró ${remainingFixtureMovements.total} movimientos vinculados a operaciones de la fixture (${remainingFixtureMovements.skus}).`,
      );
    }
    stage = "marked inventory operation references";
    await connection.execute(
      `DELETE FROM inventory_operations WHERE idempotency_key LIKE ?`,
      [buildH2E2EIdempotencyLikePattern(config.runId)],
    );
    stage = "fixture-user inventory operation references";
    await connection.execute(
      `DELETE FROM inventory_operations WHERE created_by IN
        (SELECT id FROM users WHERE email LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`],
    );
    stage = "inventory balances and audit";
    await connection.execute(
      `DELETE ib FROM inventory_balances ib
        JOIN products p ON p.id = ib.product_id WHERE UPPER(p.sku) LIKE UPPER(?)`,
      [`${marker}-%`],
    );
    stage = "sessions and assignments";
    await connection.execute(
      `DELETE FROM audit_events WHERE user_id IN
        (SELECT id FROM users WHERE email LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`],
    );
    await connection.execute(
      `DELETE FROM user_sessions WHERE user_id IN
        (SELECT id FROM users WHERE email LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`],
    );
    await connection.execute(
      `DELETE FROM user_warehouses WHERE user_id IN
        (SELECT id FROM users WHERE email LIKE ?)`,
      [`h2e2e-${config.runId}-%@sigecom.invalid`],
    );
    stage = "products and partners";
    await connection.execute(
      "DELETE FROM products WHERE UPPER(sku) LIKE UPPER(?)",
      [`${marker}-%`],
    );
    await connection.execute("DELETE FROM categories WHERE name LIKE ?", [
      `${marker}%`,
    ]);
    await connection.execute(
      "DELETE FROM customers WHERE identification_number LIKE ?",
      [`${marker}-%`],
    );
    await connection.execute(
      "DELETE FROM suppliers WHERE identification_number LIKE ?",
      [`${marker}-%`],
    );
    stage = "warehouses and fixture users";
    await connection.execute("DELETE FROM warehouses WHERE code LIKE ?", [
      `${marker}-%`,
    ]);
    await connection.execute("DELETE FROM users WHERE email = ?", [
      emailFor(config.runId, "b"),
    ]);
    await connection.execute("DELETE FROM users WHERE email = ?", [
      emailFor(config.runId, "a"),
    ]);
    await connection.execute("DELETE FROM roles WHERE code = ?", [
      `h2e2e_${config.runId}_seller`,
    ]);

    await connection.commit();
    transaction = false;
  } catch (error) {
    if (transaction) await connection.rollback();
    error.h2CleanupStage = stage;
    error.h2CleanupDetail = error.sqlMessage || error.message;
    throw error;
  } finally {
    await connection.end();
  }

  const verifier = await connect(config);
  try {
    await verifyH2E2EConnection(verifier, config, { checkCollisions: true });
  } finally {
    await verifier.end();
  }
}
