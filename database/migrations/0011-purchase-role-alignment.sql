DELETE role_permission
FROM role_permissions AS role_permission
JOIN roles AS role ON role.id = role_permission.role_id
JOIN permissions AS permission ON permission.id = role_permission.permission_id
WHERE role.code = 'warehouse'
  AND permission.code = 'purchases.receive';
