ALTER TABLE purchase_orders
  ADD COLUMN commercial_code VARCHAR(40)
    CHARACTER SET ascii COLLATE ascii_bin NULL AFTER id;

UPDATE purchase_orders
SET commercial_code = CONCAT('OC-', LPAD(CAST(id AS CHAR), 6, '0'))
WHERE commercial_code IS NULL;

ALTER TABLE purchase_orders
  MODIFY COLUMN commercial_code VARCHAR(40)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD UNIQUE KEY uq_purchase_orders_commercial_code (commercial_code);
