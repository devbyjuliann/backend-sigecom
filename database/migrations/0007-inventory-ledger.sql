ALTER TABLE inventory_balances
  ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER quantity,
  ADD UNIQUE KEY uq_inventory_balances_product_warehouse_version
    (product_id, warehouse_id, version);

CREATE TABLE IF NOT EXISTS inventory_operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_type VARCHAR(40) NOT NULL,
  source_warehouse_id BIGINT UNSIGNED NULL,
  destination_warehouse_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  reference VARCHAR(120) NULL,
  source_type VARCHAR(40) NULL,
  source_id VARCHAR(128) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_operations_actor_idempotency (created_by, idempotency_key),
  UNIQUE KEY uq_inventory_operations_source (source_type, source_id),
  KEY idx_inventory_operations_created (created_at, id),
  KEY idx_inventory_operations_actor_created (created_by, created_at, id),
  KEY idx_inventory_operations_source_warehouse (source_warehouse_id, created_at, id),
  KEY idx_inventory_operations_destination_warehouse (destination_warehouse_id, created_at, id),
  CONSTRAINT fk_inventory_operations_source_warehouse
    FOREIGN KEY (source_warehouse_id) REFERENCES warehouses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_operations_destination_warehouse
    FOREIGN KEY (destination_warehouse_id) REFERENCES warehouses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_operations_user
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_operations_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT chk_inventory_operations_idempotency CHECK (CHAR_LENGTH(TRIM(idempotency_key)) > 0),
  CONSTRAINT chk_inventory_operations_warehouses CHECK (
    (operation_type = 'transfer'
      AND source_warehouse_id IS NOT NULL
      AND destination_warehouse_id IS NOT NULL
      AND source_warehouse_id <> destination_warehouse_id)
    OR (operation_type <> 'transfer'
      AND source_warehouse_id IS NOT NULL
      AND destination_warehouse_id IS NULL)
  ),
  CONSTRAINT chk_inventory_operations_type CHECK (operation_type IN (
    'initial_stock', 'adjustment_in', 'adjustment_out', 'transfer',
    'purchase_receipt', 'sale_issue', 'sale_reversal',
    'customer_return', 'supplier_return'
  )),
  CONSTRAINT chk_inventory_operations_source CHECK (
    (source_type IS NULL AND source_id IS NULL)
    OR (source_type IS NOT NULL AND source_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(3) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  balance_before INT UNSIGNED NOT NULL,
  balance_after INT UNSIGNED NOT NULL,
  balance_version BIGINT UNSIGNED NOT NULL,
  unit_snapshot VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_movements_operation_balance
    (operation_id, product_id, warehouse_id),
  UNIQUE KEY uq_inventory_movements_balance_version
    (product_id, warehouse_id, balance_version),
  KEY idx_inventory_movements_warehouse_created
    (warehouse_id, created_at, id),
  KEY idx_inventory_movements_product_created
    (product_id, created_at, id),
  CONSTRAINT fk_inventory_movements_operation
    FOREIGN KEY (operation_id) REFERENCES inventory_operations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movements_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movements_warehouse
    FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movements_balance_version
    FOREIGN KEY (product_id, warehouse_id, balance_version)
    REFERENCES inventory_balances (product_id, warehouse_id, version) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_movements_quantity CHECK (quantity > 0),
  CONSTRAINT chk_inventory_movements_direction CHECK (direction IN ('IN', 'OUT')),
  CONSTRAINT chk_inventory_movements_unit CHECK (unit_snapshot IN (
    'unidad', 'caja', 'paquete', 'docena', 'display', 'bulto', 'par'
  )),
  CONSTRAINT chk_inventory_movements_balance CHECK (
    (direction = 'IN' AND balance_after = balance_before + quantity)
    OR (direction = 'OUT' AND balance_before = balance_after + quantity)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
