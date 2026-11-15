import mysql from "mysql2/promise";

const EXPECTED_DATABASE = "sigecom_h2_concurrency";
const EXPECTED_ACCOUNT = "sigecom_h2_runner@127.0.0.1";

async function readCount(connection, sql, values = []) {
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("El verificador solo permite consultas SELECT.");
  }
  const [[row]] = await connection.execute(sql, values);
  return Number(row.total);
}

const residueChecks = [
  [
    "usuarios",
    `SELECT COUNT(*) AS total FROM users
     WHERE email LIKE 'h2-%@sigecom.invalid' OR email LIKE 'h2c7-%@sigecom.invalid'`,
  ],
  [
    "bodegas",
    `SELECT COUNT(*) AS total FROM warehouses
     WHERE code LIKE 'H2-%' OR code LIKE 'H2C7-%'`,
  ],
  [
    "proveedores",
    `SELECT COUNT(*) AS total FROM suppliers
     WHERE identification_number LIKE 'H2-%' OR identification_number LIKE 'H2C7-%'`,
  ],
  [
    "categorías",
    `SELECT COUNT(*) AS total FROM categories
     WHERE name LIKE 'H2-%' OR name LIKE 'H2C7-%'`,
  ],
  [
    "productos",
    `SELECT COUNT(*) AS total FROM products
     WHERE sku LIKE 'H2-%' OR sku LIKE 'H2C7-%'`,
  ],
  [
    "órdenes de compra",
    `SELECT COUNT(*) AS total FROM purchase_orders
     WHERE reference LIKE 'H2-%' OR reference LIKE 'H2C7-%'`,
  ],
  [
    "ventas",
    `SELECT COUNT(*) AS total FROM sales
     WHERE commercial_code LIKE 'H2-%' OR commercial_code LIKE 'H2C7-%'
        OR notes LIKE 'H2C7-%'`,
  ],
  [
    "clientes",
    `SELECT COUNT(*) AS total FROM customers
     WHERE identification_number LIKE 'H2-%' OR identification_number LIKE 'H2C7-%'`,
  ],
  [
    "roles",
    `SELECT COUNT(*) AS total FROM roles
     WHERE code LIKE 'h2-%' OR code LIKE 'h2c7_%'`,
  ],
];

const relationChecks = [
  [
    "sesiones de usuarios H2",
    `SELECT COUNT(*) AS total FROM user_sessions session
     JOIN users fixture_user ON fixture_user.id = session.user_id
     WHERE fixture_user.email LIKE 'h2-%@sigecom.invalid'
        OR fixture_user.email LIKE 'h2c7-%@sigecom.invalid'`,
  ],
  [
    "asignaciones de usuarios H2",
    `SELECT COUNT(*) AS total FROM user_warehouses assignment
     JOIN users fixture_user ON fixture_user.id = assignment.user_id
     WHERE fixture_user.email LIKE 'h2-%@sigecom.invalid'
        OR fixture_user.email LIKE 'h2c7-%@sigecom.invalid'`,
  ],
  [
    "relaciones de permisos de roles H2C7",
    `SELECT COUNT(*) AS total FROM role_permissions assignment
     JOIN roles fixture_role ON fixture_role.id = assignment.role_id
     WHERE fixture_role.code LIKE 'h2c7_%'`,
  ],
  [
    "usuarios con roles H2C7",
    `SELECT COUNT(*) AS total FROM users fixture_user
     JOIN roles fixture_role ON fixture_role.id = fixture_user.role_id
     WHERE fixture_role.code LIKE 'h2c7_%'`,
  ],
  [
    "relaciones de inventario con bodegas H2",
    `SELECT COUNT(*) AS total FROM inventory_balances balance
     JOIN warehouses fixture_warehouse ON fixture_warehouse.id = balance.warehouse_id
     WHERE fixture_warehouse.code LIKE 'H2-%' OR fixture_warehouse.code LIKE 'H2C7-%'`,
  ],
  [
    "operaciones de inventario con bodegas H2",
    `SELECT COUNT(*) AS total FROM inventory_operations operation
     LEFT JOIN warehouses source_warehouse ON source_warehouse.id = operation.source_warehouse_id
     LEFT JOIN warehouses destination_warehouse ON destination_warehouse.id = operation.destination_warehouse_id
     WHERE source_warehouse.code LIKE 'H2-%' OR source_warehouse.code LIKE 'H2C7-%'
        OR destination_warehouse.code LIKE 'H2-%' OR destination_warehouse.code LIKE 'H2C7-%'`,
  ],
  [
    "líneas de órdenes H2",
    `SELECT COUNT(*) AS total FROM purchase_order_lines line
     JOIN purchase_orders fixture_order ON fixture_order.id = line.purchase_order_id
     WHERE fixture_order.reference LIKE 'H2-%' OR fixture_order.reference LIKE 'H2C7-%'`,
  ],
  [
    "recepciones de órdenes H2",
    `SELECT COUNT(*) AS total FROM purchase_receipts receipt
     JOIN purchase_orders fixture_order ON fixture_order.id = receipt.purchase_order_id
     WHERE fixture_order.reference LIKE 'H2-%' OR fixture_order.reference LIKE 'H2C7-%'`,
  ],
  [
    "devoluciones a proveedor de órdenes H2",
    `SELECT COUNT(*) AS total FROM supplier_returns supplier_return
     JOIN purchase_orders fixture_order ON fixture_order.id = supplier_return.purchase_order_id
     WHERE fixture_order.reference LIKE 'H2-%' OR fixture_order.reference LIKE 'H2C7-%'`,
  ],
  [
    "líneas de ventas H2",
    `SELECT COUNT(*) AS total FROM sale_lines line
     JOIN sales fixture_sale ON fixture_sale.id = line.sale_id
     WHERE fixture_sale.commercial_code LIKE 'H2-%' OR fixture_sale.commercial_code LIKE 'H2C7-%'
        OR fixture_sale.notes LIKE 'H2C7-%'`,
  ],
  [
    "anulaciones y devoluciones de ventas H2",
    `SELECT
       (SELECT COUNT(*) FROM sale_cancellations cancellation
        JOIN sales fixture_sale ON fixture_sale.id = cancellation.sale_id
        WHERE fixture_sale.commercial_code LIKE 'H2-%' OR fixture_sale.commercial_code LIKE 'H2C7-%'
           OR fixture_sale.notes LIKE 'H2C7-%')
       +
       (SELECT COUNT(*) FROM customer_returns customer_return
        JOIN sales fixture_sale ON fixture_sale.id = customer_return.sale_id
        WHERE fixture_sale.commercial_code LIKE 'H2-%' OR fixture_sale.commercial_code LIKE 'H2C7-%'
           OR fixture_sale.notes LIKE 'H2C7-%') AS total`,
  ],
  [
    "solicitudes de ventas H2",
    `SELECT COUNT(*) AS total FROM sale_requests sale_request
     JOIN sales fixture_sale ON fixture_sale.id = sale_request.sale_id
     WHERE fixture_sale.commercial_code LIKE 'H2-%' OR fixture_sale.commercial_code LIKE 'H2C7-%'
        OR fixture_sale.notes LIKE 'H2C7-%'`,
  ],
  [
    "relaciones de clientes con ventas H2",
    `SELECT COUNT(*) AS total FROM sales fixture_sale
     JOIN customers fixture_customer ON fixture_customer.id = fixture_sale.customer_id
     WHERE fixture_customer.identification_number LIKE 'H2-%'
        OR fixture_customer.identification_number LIKE 'H2C7-%'`,
  ],
  [
    "relaciones de proveedores con órdenes H2",
    `SELECT COUNT(*) AS total FROM purchase_orders fixture_order
     JOIN suppliers fixture_supplier ON fixture_supplier.id = fixture_order.supplier_id
     WHERE fixture_supplier.identification_number LIKE 'H2-%'
        OR fixture_supplier.identification_number LIKE 'H2C7-%'`,
  ],
  [
    "productos de categorías H2",
    `SELECT COUNT(*) AS total FROM products fixture_product
     JOIN categories fixture_category ON fixture_category.id = fixture_product.category_id
     WHERE fixture_category.name LIKE 'H2-%' OR fixture_category.name LIKE 'H2C7-%'`,
  ],
  [
    "movimientos vinculados a productos o bodegas H2",
    `SELECT COUNT(*) AS total FROM inventory_movements movement
     LEFT JOIN products fixture_product ON fixture_product.id = movement.product_id
     LEFT JOIN warehouses fixture_warehouse ON fixture_warehouse.id = movement.warehouse_id
     WHERE fixture_product.sku LIKE 'H2-%' OR fixture_product.sku LIKE 'H2C7-%'
        OR fixture_warehouse.code LIKE 'H2-%' OR fixture_warehouse.code LIKE 'H2C7-%'`,
  ],
  [
    "auditoría vinculada a usuarios H2",
    `SELECT COUNT(*) AS total FROM audit_events event
     JOIN users fixture_user ON fixture_user.id = event.user_id
     WHERE fixture_user.email LIKE 'h2-%@sigecom.invalid'
        OR fixture_user.email LIKE 'h2c7-%@sigecom.invalid'`,
  ],
];

let connection;
try {
  const { SIGECOM_H2_DATABASE, SIGECOM_H2_USER, SIGECOM_H2_PASSWORD } =
    process.env;
  if (
    SIGECOM_H2_DATABASE !== EXPECTED_DATABASE ||
    SIGECOM_H2_USER !== "sigecom_h2_runner" ||
    !SIGECOM_H2_PASSWORD
  ) {
    throw new Error(
      "Falta el contexto local autorizado de la cuenta restringida H2; ejecute el verificador mediante el runner protegido.",
    );
  }
  connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    database: EXPECTED_DATABASE,
    user: "sigecom_h2_runner",
    password: SIGECOM_H2_PASSWORD,
    connectTimeout: 5000,
    timezone: "Z",
  });

  const [[identity]] = await connection.query(
    "SELECT DATABASE() AS database_name, CURRENT_USER() AS account, VERSION() AS version",
  );
  if (
    identity.database_name !== EXPECTED_DATABASE ||
    identity.account !== EXPECTED_ACCOUNT
  ) {
    throw new Error("La conexión no corresponde al destino temporal aprobado.");
  }

  console.log(
    `Destino confirmado: ${identity.database_name}; cuenta ${identity.account}; motor ${identity.version}.`,
  );
  const results = [];
  for (const [label, sql] of [...residueChecks, ...relationChecks]) {
    results.push([label, await readCount(connection, sql)]);
  }
  for (const [label, total] of results) {
    console.log(`${label}: ${total}`);
  }
  const residueTotal = results.reduce((sum, [, total]) => sum + total, 0);
  console.log(
    residueTotal === 0
      ? "Verificación de lectura: sin residuos en las nueve categorías ni en las relaciones revisadas."
      : "Verificación de lectura: hay residuos; no se realizó ninguna escritura ni limpieza.",
  );
  if (residueTotal > 0) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
