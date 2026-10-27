function unavailableIndicator() {
  return { available: false, value: null };
}

async function count(dbPool, sql, values = []) {
  const [[row]] = await dbPool.execute(sql, values);
  return Number(row.total);
}

export function createDashboardService({ dbPool }) {
  async function getSummary({ userId, permissions }) {
    const indicators = {
      activeProducts: unavailableIndicator(),
      customers: unavailableIndicator(),
      suppliers: unavailableIndicator(),
      accessibleWarehouses: unavailableIndicator(),
    };
    let productsByCategory = { available: false, items: null };
    const queries = [];

    if (permissions.has("products.read")) {
      queries.push(
        count(
          dbPool,
          "SELECT COUNT(*) AS total FROM products WHERE is_active = 1",
        ).then((value) => {
          indicators.activeProducts = { available: true, value };
        }),
      );
    }

    if (permissions.has("customers.read")) {
      queries.push(
        count(dbPool, "SELECT COUNT(*) AS total FROM customers").then(
          (value) => {
            indicators.customers = { available: true, value };
          },
        ),
      );
    }

    if (permissions.has("suppliers.read")) {
      queries.push(
        count(dbPool, "SELECT COUNT(*) AS total FROM suppliers").then(
          (value) => {
            indicators.suppliers = { available: true, value };
          },
        ),
      );
    }

    if (permissions.has("warehouses.read")) {
      queries.push(
        count(
          dbPool,
          `SELECT COUNT(*) AS total
           FROM user_warehouses AS access
           JOIN warehouses AS warehouse
             ON warehouse.id = access.warehouse_id
           WHERE access.user_id = ?`,
          [userId],
        ).then((value) => {
          indicators.accessibleWarehouses = { available: true, value };
        }),
      );
    }

    if (
      permissions.has("products.read") &&
      permissions.has("categories.read")
    ) {
      queries.push(
        dbPool
          .execute(
            `SELECT category.id AS category_id,
                    category.name AS category_name,
                    COUNT(product.id) AS active_products
             FROM categories AS category
             LEFT JOIN products AS product
               ON product.category_id = category.id AND product.is_active = 1
             WHERE category.is_active = 1
             GROUP BY category.id, category.name
             HAVING COUNT(product.id) > 0
             ORDER BY COUNT(product.id) DESC, category.name, category.id`,
          )
          .then(([rows]) => {
            productsByCategory = {
              available: true,
              items: rows.map((row) => ({
                categoryId: String(row.category_id),
                categoryName: row.category_name,
                activeProducts: Number(row.active_products),
              })),
            };
          }),
      );
    }

    await Promise.all(queries);
    return { indicators, productsByCategory };
  }

  return { getSummary };
}
