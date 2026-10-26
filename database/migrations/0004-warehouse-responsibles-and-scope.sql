ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS responsible_user_id BIGINT UNSIGNED NULL AFTER location;

SET @responsible_foreign_key_exists = (
  SELECT COUNT(*)
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'warehouses'
    AND CONSTRAINT_NAME = 'fk_warehouses_responsible_user'
    AND REFERENCED_TABLE_NAME = 'users'
);
SET @responsible_foreign_key_sql = IF(
  @responsible_foreign_key_exists > 0,
  'SELECT 1',
  'ALTER TABLE warehouses ADD CONSTRAINT fk_warehouses_responsible_user FOREIGN KEY (responsible_user_id) REFERENCES users (id) ON DELETE SET NULL'
);
PREPARE responsible_foreign_key_statement FROM @responsible_foreign_key_sql;
EXECUTE responsible_foreign_key_statement;
DEALLOCATE PREPARE responsible_foreign_key_statement;

DELETE rp
FROM role_permissions AS rp
JOIN roles AS r ON r.id = rp.role_id
JOIN permissions AS p ON p.id = rp.permission_id
WHERE r.code = 'warehouse'
  AND p.code = 'warehouses.manage';

INSERT IGNORE INTO user_warehouses (user_id, warehouse_id, assigned_by)
SELECT administrator.id, w.id, NULL
FROM users AS administrator
JOIN roles AS r ON r.id = administrator.role_id AND r.code = 'administrator'
CROSS JOIN warehouses AS w
WHERE administrator.is_active = 1;
