CREATE TABLE IF NOT EXISTS sales (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  commercial_code VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  customer_name_snapshot VARCHAR(180) NOT NULL,
  customer_identification_snapshot VARCHAR(64) NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  warehouse_code_snapshot VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  warehouse_name_snapshot VARCHAR(120) NOT NULL,
  warehouse_location_snapshot VARCHAR(255) NULL,
  sale_date DATE NOT NULL,
  notes VARCHAR(1000) NULL,
  status ENUM('draft', 'confirmed', 'cancelled') NOT NULL DEFAULT 'draft',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  confirmed_by BIGINT UNSIGNED NULL,
  confirmed_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancelled_at DATETIME(3) NULL,
  cancellation_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_commercial_code (commercial_code),
  KEY idx_sales_warehouse_status_date (warehouse_id, status, sale_date, id),
  KEY idx_sales_customer_date (customer_id, sale_date, id),
  KEY idx_sales_created (created_at, id),
  KEY idx_sales_creator_status (created_by, status, id),
  CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_confirmed_by FOREIGN KEY (confirmed_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_sales_version CHECK (version > 0),
  CONSTRAINT chk_sales_confirmation CHECK ((status = 'draft' AND confirmed_at IS NULL AND confirmed_by IS NULL) OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL) OR (status = 'cancelled' AND ((confirmed_at IS NULL AND confirmed_by IS NULL) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)))),
  CONSTRAINT chk_sales_cancellation CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL) OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  sku_snapshot VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_name_snapshot VARCHAR(160) NOT NULL,
  unit_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price DECIMAL(15,2) NOT NULL,
  line_total DECIMAL(22,2) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_lines_id_sale (id, sale_id),
  UNIQUE KEY uq_sale_lines_product (sale_id, product_id),
  KEY idx_sale_lines_sale_position (sale_id, position),
  KEY idx_sale_lines_product (product_id, sale_id),
  CONSTRAINT fk_sale_lines_sale FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_lines_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT chk_sale_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_sale_lines_price CHECK (unit_price > 0 AND line_total > 0),
  CONSTRAINT chk_sale_lines_unit CHECK (unit_snapshot IN ('unidad', 'caja', 'paquete', 'docena', 'display', 'bulto', 'par'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sale_id BIGINT UNSIGNED NOT NULL,
  response_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_requests_actor_key (actor_id, idempotency_key),
  KEY idx_sale_requests_sale (sale_id, created_at),
  CONSTRAINT fk_sale_requests_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_requests_sale FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE RESTRICT,
  CONSTRAINT chk_sale_requests_operation CHECK (operation IN ('create', 'update', 'cancel'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE sales
SET commercial_code = CONCAT('VE-', LPAD(CAST(id AS CHAR), 6, '0'))
WHERE commercial_code IS NULL;

ALTER TABLE sales
  MODIFY COLUMN commercial_code VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
