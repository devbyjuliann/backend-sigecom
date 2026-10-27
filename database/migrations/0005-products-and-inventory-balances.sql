CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  unit ENUM('unidad', 'caja', 'paquete', 'docena', 'display', 'bulto', 'par') NOT NULL,
  purchase_price DECIMAL(15,2) NOT NULL,
  sale_price DECIMAL(15,2) NOT NULL,
  minimum_sale_quantity INT UNSIGNED NULL,
  minimum_sale_enabled TINYINT(1) NOT NULL DEFAULT 0,
  minimum_stock INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY idx_products_category_active_name (category_id, is_active, name),
  KEY idx_products_active_name (is_active, name),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
  CONSTRAINT chk_products_prices_nonnegative CHECK (purchase_price >= 0 AND sale_price >= 0),
  CONSTRAINT chk_products_minimum_sale CHECK (
    (minimum_sale_enabled = 0 AND minimum_sale_quantity IS NULL)
    OR (minimum_sale_enabled = 1 AND minimum_sale_quantity > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_balances_product_warehouse (product_id, warehouse_id),
  KEY idx_inventory_balances_warehouse_product (warehouse_id, product_id),
  CONSTRAINT fk_inventory_balances_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_balances_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
