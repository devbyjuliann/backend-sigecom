ALTER TABLE purchase_receipts
  ADD UNIQUE KEY uq_purchase_receipts_id_order (id, purchase_order_id);

ALTER TABLE purchase_order_lines
  ADD UNIQUE KEY uq_purchase_order_lines_id_order_product
    (id, purchase_order_id, product_id);

ALTER TABLE purchase_receipt_lines
  ADD UNIQUE KEY uq_purchase_receipt_lines_source
    (id, purchase_receipt_id, purchase_order_line_id, purchase_order_id);

CREATE TABLE IF NOT EXISTS supplier_returns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  purchase_receipt_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  source_operation_id BIGINT UNSIGNED NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  returned_by BIGINT UNSIGNED NOT NULL,
  returned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_returns_receipt_reference
    (purchase_receipt_id, reference),
  UNIQUE KEY uq_supplier_returns_actor_idempotency
    (returned_by, idempotency_key),
  UNIQUE KEY uq_supplier_returns_source_operation (source_operation_id),
  UNIQUE KEY uq_supplier_returns_id_order_receipt
    (id, purchase_order_id, purchase_receipt_id),
  KEY idx_supplier_returns_order_returned
    (purchase_order_id, returned_at, id),
  KEY idx_supplier_returns_receipt_returned
    (purchase_receipt_id, returned_at, id),
  CONSTRAINT fk_supplier_returns_receipt_order
    FOREIGN KEY (purchase_receipt_id, purchase_order_id)
    REFERENCES purchase_receipts (id, purchase_order_id) ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_returns_source_operation
    FOREIGN KEY (source_operation_id) REFERENCES inventory_operations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_returns_user
    FOREIGN KEY (returned_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_supplier_returns_reference
    CHECK (CHAR_LENGTH(TRIM(reference)) BETWEEN 1 AND 120),
  CONSTRAINT chk_supplier_returns_reason
    CHECK (CHAR_LENGTH(TRIM(reason)) BETWEEN 1 AND 500),
  CONSTRAINT chk_supplier_returns_idempotency
    CHECK (CHAR_LENGTH(TRIM(idempotency_key)) BETWEEN 1 AND 128),
  CONSTRAINT chk_supplier_returns_request_hash
    CHECK (request_hash REGEXP '^[a-f0-9]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_return_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_return_id BIGINT UNSIGNED NOT NULL,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  purchase_receipt_id BIGINT UNSIGNED NOT NULL,
  purchase_receipt_line_id BIGINT UNSIGNED NOT NULL,
  purchase_order_line_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  sku_snapshot VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name_snapshot VARCHAR(160) NOT NULL,
  unit_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_return_lines_source
    (supplier_return_id, purchase_receipt_line_id),
  KEY idx_supplier_return_lines_receipt_source
    (purchase_receipt_line_id, purchase_receipt_id),
  KEY idx_supplier_return_lines_product
    (product_id, supplier_return_id),
  CONSTRAINT fk_supplier_return_lines_return
    FOREIGN KEY (supplier_return_id, purchase_order_id, purchase_receipt_id)
    REFERENCES supplier_returns (id, purchase_order_id, purchase_receipt_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_return_lines_receipt_line
    FOREIGN KEY (purchase_receipt_line_id, purchase_receipt_id,
                 purchase_order_line_id, purchase_order_id)
    REFERENCES purchase_receipt_lines
      (id, purchase_receipt_id, purchase_order_line_id, purchase_order_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_return_lines_order_line_product
    FOREIGN KEY (purchase_order_line_id, purchase_order_id, product_id)
    REFERENCES purchase_order_lines (id, purchase_order_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_supplier_return_lines_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT chk_supplier_return_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_supplier_return_lines_unit CHECK (unit_snapshot IN (
    'unidad', 'caja', 'paquete', 'docena', 'display', 'bulto', 'par'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
