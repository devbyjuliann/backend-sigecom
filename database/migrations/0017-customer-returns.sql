CREATE TABLE IF NOT EXISTS customer_returns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  physical_observation VARCHAR(1000) NOT NULL,
  received_physical TINYINT UNSIGNED NOT NULL,
  inspected TINYINT UNSIGNED NOT NULL,
  source_operation_id BIGINT UNSIGNED NULL,
  returned_by BIGINT UNSIGNED NOT NULL,
  returned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_returns_sale_reference (sale_id, reference),
  UNIQUE KEY uq_customer_returns_source_operation (source_operation_id),
  UNIQUE KEY uq_customer_returns_id_sale (id, sale_id),
  KEY idx_customer_returns_sale_date (sale_id, returned_at, id),
  CONSTRAINT fk_customer_returns_sale
    FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_returns_source_operation
    FOREIGN KEY (source_operation_id) REFERENCES inventory_operations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_returns_user
    FOREIGN KEY (returned_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_returns_reference CHECK (CHAR_LENGTH(TRIM(reference)) BETWEEN 1 AND 120),
  CONSTRAINT chk_customer_returns_reason CHECK (CHAR_LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
  CONSTRAINT chk_customer_returns_observation CHECK (CHAR_LENGTH(TRIM(physical_observation)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_customer_returns_declarations CHECK (received_physical = 1 AND inspected = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_return_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_return_id BIGINT UNSIGNED NOT NULL,
  sale_id BIGINT UNSIGNED NOT NULL,
  sale_line_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  sku_snapshot VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_name_snapshot VARCHAR(160) NOT NULL,
  unit_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity_received INT UNSIGNED NOT NULL,
  quantity_restocked INT UNSIGNED NOT NULL,
  non_restock_reason VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_return_lines_sale_source (customer_return_id, sale_line_id),
  KEY idx_customer_return_lines_sale_line (sale_line_id, customer_return_id),
  KEY idx_customer_return_lines_product (product_id, customer_return_id),
  CONSTRAINT fk_customer_return_lines_return
    FOREIGN KEY (customer_return_id, sale_id)
    REFERENCES customer_returns (id, sale_id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_return_lines_sale_line
    FOREIGN KEY (sale_line_id, sale_id)
    REFERENCES sale_lines (id, sale_id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_return_lines_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT chk_customer_return_lines_received CHECK (quantity_received > 0),
  CONSTRAINT chk_customer_return_lines_restocked CHECK (quantity_restocked <= quantity_received),
  CONSTRAINT chk_customer_return_lines_non_restock_reason CHECK
    ((quantity_restocked = quantity_received AND non_restock_reason IS NULL)
     OR (quantity_restocked < quantity_received AND CHAR_LENGTH(TRIM(non_restock_reason)) BETWEEN 1 AND 500)),
  CONSTRAINT chk_customer_return_lines_unit CHECK (unit_snapshot IN ('unidad', 'caja', 'paquete', 'docena', 'display', 'bulto', 'par'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE sale_requests
  ADD COLUMN return_id BIGINT UNSIGNED NULL AFTER reversal_id,
  DROP CONSTRAINT chk_sale_requests_operation,
  ADD CONSTRAINT chk_sale_requests_operation
    CHECK (operation IN ('create', 'update', 'cancel', 'reversal', 'return')),
  DROP CONSTRAINT chk_sale_requests_reversal,
  ADD CONSTRAINT chk_sale_requests_reversal
    CHECK ((operation = 'reversal' AND reversal_id IS NOT NULL AND return_id IS NULL)
        OR (operation = 'return' AND reversal_id IS NULL AND return_id IS NOT NULL)
        OR (operation NOT IN ('reversal', 'return') AND reversal_id IS NULL AND return_id IS NULL)),
  ADD CONSTRAINT fk_sale_requests_return
    FOREIGN KEY (return_id) REFERENCES customer_returns (id) ON DELETE RESTRICT;

INSERT IGNORE INTO permissions (code, name, module, description)
VALUES ('sales.return', 'Registrar devoluciones de ventas', 'sales', 'Registrar devoluciones autorizadas de mercancía recibida.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code = 'administrator' AND permission.code = 'sales.return'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);
