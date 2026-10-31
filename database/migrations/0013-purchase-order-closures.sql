ALTER TABLE purchase_orders
  ADD COLUMN closure_reason VARCHAR(500) NULL AFTER cancellation_reason,
  ADD COLUMN closed_by BIGINT UNSIGNED NULL AFTER closure_reason,
  ADD COLUMN closed_at DATETIME(3) NULL AFTER closed_by,
  ADD COLUMN closure_idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER closed_at,
  ADD COLUMN closure_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER closure_idempotency_key,
  ADD UNIQUE KEY uq_purchase_orders_closure_idempotency_key (closure_idempotency_key),
  ADD KEY idx_purchase_orders_closed_by (closed_by),
  ADD CONSTRAINT fk_purchase_orders_closed_by FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_purchase_orders_closure CHECK (
    (closure_reason IS NULL AND closed_by IS NULL AND closed_at IS NULL AND closure_idempotency_key IS NULL AND closure_request_hash IS NULL)
    OR
    (closure_reason IS NOT NULL AND CHAR_LENGTH(TRIM(closure_reason)) BETWEEN 3 AND 500 AND closed_by IS NOT NULL AND closed_at IS NOT NULL AND closure_idempotency_key IS NOT NULL AND closure_request_hash IS NOT NULL)
  );

INSERT INTO permissions (code, name, module, description) VALUES
  ('purchases.close', 'Cerrar cantidades pendientes', 'purchases', 'Cerrar definitivamente el remanente pendiente de órdenes parcialmente recibidas.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  module = VALUES(module),
  description = VALUES(description);

DELETE role_permission
FROM role_permissions AS role_permission
JOIN roles AS role ON role.id = role_permission.role_id
JOIN permissions AS permission ON permission.id = role_permission.permission_id
WHERE permission.code = 'purchases.close' AND role.code <> 'administrator';

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code = 'administrator' AND permission.code = 'purchases.close'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);
