CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name),
  KEY idx_categories_active_name (is_active, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (code, name, module, description) VALUES
  ('categories.read', 'Consultar categorías', 'categories', 'Consultar las categorías de productos.'),
  ('categories.manage', 'Administrar categorías', 'categories', 'Crear, actualizar y cambiar el estado de categorías.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  module = VALUES(module),
  description = VALUES(description);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles AS r CROSS JOIN permissions AS p
WHERE r.code = 'administrator' AND p.code IN ('categories.read', 'categories.manage')
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles AS r CROSS JOIN permissions AS p
WHERE r.code IN ('seller', 'warehouse', 'auditor') AND p.code = 'categories.read'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);
