CREATE TABLE IF NOT EXISTS sale_cancellations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id BIGINT UNSIGNED NOT NULL,
  verification_reference VARCHAR(120) NOT NULL,
  physical_observation VARCHAR(1000) NOT NULL,
  never_dispatched TINYINT UNSIGNED NOT NULL,
  all_quantities_present TINYINT UNSIGNED NOT NULL,
  all_products_saleable TINYINT UNSIGNED NOT NULL,
  source_operation_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_cancellations_sale (sale_id),
  UNIQUE KEY uq_sale_cancellations_source_operation (source_operation_id),
  UNIQUE KEY uq_sale_cancellations_id_sale (id, sale_id),
  CONSTRAINT fk_sale_cancellations_sale
    FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_cancellations_source_operation
    FOREIGN KEY (source_operation_id) REFERENCES inventory_operations (id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_sale_cancellations_reference
    CHECK (CHAR_LENGTH(TRIM(verification_reference)) BETWEEN 1 AND 120),
  CONSTRAINT chk_sale_cancellations_observation
    CHECK (CHAR_LENGTH(TRIM(physical_observation)) BETWEEN 1 AND 1000),
  CONSTRAINT chk_sale_cancellations_declarations
    CHECK (never_dispatched = 1 AND all_quantities_present = 1 AND all_products_saleable = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE sale_requests
  ADD COLUMN reversal_id BIGINT UNSIGNED NULL AFTER sale_id,
  DROP CONSTRAINT chk_sale_requests_operation,
  ADD CONSTRAINT chk_sale_requests_operation
    CHECK (operation IN ('create', 'update', 'cancel', 'reversal')),
  ADD CONSTRAINT chk_sale_requests_reversal
    CHECK ((operation = 'reversal' AND reversal_id IS NOT NULL)
        OR (operation <> 'reversal' AND reversal_id IS NULL)),
  ADD CONSTRAINT fk_sale_requests_reversal
    FOREIGN KEY (reversal_id) REFERENCES sale_cancellations (id) ON DELETE RESTRICT;
