INSERT INTO roles (code, name, description, is_system) VALUES
  ('administrator', 'Administrador', 'Acceso administrativo completo al sistema.', 1),
  ('seller', 'Vendedor', 'Acceso a clientes, productos de consulta y ventas autorizadas.', 1),
  ('warehouse', 'Bodega', 'Acceso a consultas y operaciones de inventario autorizadas.', 1),
  ('auditor', 'Auditor', 'Acceso de consulta a información operativa y auditoría.', 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  is_system = VALUES(is_system);

INSERT INTO permissions (code, name, module, description) VALUES
  ('dashboard.read', 'Consultar resumen', 'dashboard', 'Consultar el resumen autorizado del sistema.'),
  ('profile.read', 'Consultar perfil propio', 'profile', 'Consultar los datos del perfil propio.'),
  ('profile.update', 'Actualizar perfil propio', 'profile', 'Actualizar los datos del perfil propio.'),
  ('users.read', 'Consultar usuarios', 'users', 'Consultar usuarios autorizados.'),
  ('users.manage', 'Administrar usuarios', 'users', 'Crear, actualizar y desactivar usuarios.'),
  ('roles.manage', 'Administrar roles', 'roles', 'Administrar roles y sus asignaciones.'),
  ('permissions.manage', 'Administrar permisos', 'permissions', 'Administrar permisos asignados a roles.'),
  ('warehouses.read', 'Consultar bodegas', 'warehouses', 'Consultar bodegas autorizadas.'),
  ('warehouses.manage', 'Administrar bodegas', 'warehouses', 'Crear, actualizar y desactivar bodegas.'),
  ('products.read', 'Consultar productos', 'products', 'Consultar el catálogo de productos.'),
  ('products.manage', 'Administrar productos', 'products', 'Crear, actualizar y desactivar productos.'),
  ('customers.read', 'Consultar clientes', 'customers', 'Consultar clientes autorizados.'),
  ('customers.manage', 'Administrar clientes', 'customers', 'Crear, actualizar y desactivar clientes.'),
  ('suppliers.read', 'Consultar proveedores', 'suppliers', 'Consultar proveedores autorizados.'),
  ('suppliers.manage', 'Administrar proveedores', 'suppliers', 'Administrar proveedores.'),
  ('inventory.read', 'Consultar inventario', 'inventory', 'Consultar existencias y movimientos autorizados.'),
  ('inventory.adjust', 'Ajustar inventario', 'inventory', 'Registrar ajustes autorizados de inventario.'),
  ('inventory.transfer', 'Trasladar inventario', 'inventory', 'Registrar traslados autorizados entre bodegas.'),
  ('inventory.receive', 'Recibir inventario', 'inventory', 'Registrar recepciones autorizadas.'),
  ('sales.read', 'Consultar ventas', 'sales', 'Consultar ventas autorizadas.'),
  ('sales.create', 'Crear ventas', 'sales', 'Crear borradores de ventas autorizados.'),
  ('sales.confirm', 'Confirmar ventas', 'sales', 'Confirmar ventas autorizadas.'),
  ('sales.cancel', 'Anular ventas', 'sales', 'Anular ventas con autorización.'),
  ('sales.return', 'Gestionar devoluciones de ventas', 'sales', 'Gestionar devoluciones autorizadas.'),
  ('purchases.read', 'Consultar compras', 'purchases', 'Consultar compras autorizadas.'),
  ('purchases.create', 'Crear compras', 'purchases', 'Crear órdenes de compra autorizadas.'),
  ('purchases.confirm', 'Confirmar compras', 'purchases', 'Confirmar órdenes de compra autorizadas.'),
  ('purchases.receive', 'Registrar recepciones', 'purchases', 'Registrar recepciones de compras autorizadas.'),
  ('purchases.cancel', 'Cancelar compras', 'purchases', 'Cancelar operaciones de compra permitidas.'),
  ('purchases.return', 'Gestionar devoluciones a proveedores', 'purchases', 'Gestionar devoluciones autorizadas a proveedores.'),
  ('reports.read', 'Consultar reportes', 'reports', 'Consultar reportes operativos autorizados.'),
  ('audit.read', 'Consultar auditoría', 'audit', 'Consultar los registros de auditoría.'),
  ('settings.manage', 'Administrar configuración', 'settings', 'Administrar configuraciones esenciales del sistema.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  module = VALUES(module),
  description = VALUES(description);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
CROSS JOIN permissions AS p
WHERE r.code = 'administrator'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
JOIN permissions AS p ON p.code IN (
  'dashboard.read', 'profile.read', 'profile.update', 'products.read',
  'customers.read', 'customers.manage', 'warehouses.read', 'inventory.read',
  'sales.read', 'sales.create', 'sales.confirm'
)
WHERE r.code = 'seller'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
JOIN permissions AS p ON p.code IN (
  'dashboard.read', 'profile.read', 'profile.update', 'products.read',
  'warehouses.read', 'warehouses.manage', 'inventory.read', 'inventory.adjust',
  'inventory.transfer', 'inventory.receive', 'purchases.read', 'purchases.receive'
)
WHERE r.code = 'warehouse'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles AS r
JOIN permissions AS p ON p.code IN (
  'dashboard.read', 'profile.read', 'products.read', 'customers.read',
  'suppliers.read', 'warehouses.read', 'inventory.read', 'sales.read',
  'purchases.read', 'reports.read', 'audit.read'
)
WHERE r.code = 'auditor'
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id);
