INSERT INTO permissions (code, name, module, description) VALUES
  ('inventory.movements.read', 'Consultar movimientos', 'inventory', 'Consultar el historial y detalle de movimientos en bodegas autorizadas.'),
  ('inventory.initialize', 'Registrar existencias iniciales', 'inventory', 'Registrar una sola vez el conteo inicial autorizado por producto y bodega.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  module = VALUES(module),
  description = VALUES(description);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
JOIN permissions AS p ON p.code = 'inventory.movements.read'
WHERE r.code IN ('administrator', 'warehouse', 'auditor');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
JOIN permissions AS p ON p.code = 'inventory.initialize'
WHERE r.code = 'administrator';
