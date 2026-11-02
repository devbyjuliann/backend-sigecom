import { createHash } from "node:crypto";
import { HttpError } from "../../shared/http-error.js";
import {
  classifyPermission,
  POLICY_VERSION,
  ROLE_CODES,
  validatePermissionSet,
} from "./role-permissions-policy.js";

const administratorPermissions = [
  "users.read",
  "users.manage",
  "roles.manage",
  "permissions.manage",
  "warehouses.read",
];
const failure = (status, code, message) => new HttpError(status, code, message);

function revision(role, assignments) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: POLICY_VERSION,
        role: {
          id: String(role.id),
          code: role.code,
          updatedAt: role.updated_at,
        },
        assignments: assignments.map((row) => ({
          id: String(row.id),
          permissionId: String(row.permission_id),
          code: row.code,
          createdAt: row.created_at,
        })),
      }),
    )
    .digest("base64url");
}

function metadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ip: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

export function createRoleService({ dbPool }) {
  async function withTransaction(work) {
    for (let attempt = 0; ; attempt += 1) {
      const connection = await dbPool.getConnection();
      let commitStarted = false;
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        commitStarted = true;
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          /* preserve original error */
        }
        if (
          !commitStarted &&
          attempt < 2 &&
          ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)
        )
          continue;
        throw error;
      } finally {
        connection.release();
      }
    }
  }

  async function lockAdministratorRole(connection) {
    const [rows] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator' FOR UPDATE",
    );
    if (!rows[0]) throw new Error("Falta el rol Administrador del sistema.");
    return rows[0].id;
  }

  async function lockAndAuthorizeActor(connection, actor) {
    const [rows] = await connection.execute(
      `SELECT u.id, u.role_id, u.is_active, u.password_change_required, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE`,
      [actor.user.id],
    );
    const row = rows[0];
    if (!row || !row.is_active || row.role_code !== "administrator") {
      throw failure(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    }
    if (row.password_change_required) {
      throw failure(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Debes cambiar tu contraseña antes de continuar.",
      );
    }
    const [sessions] = await connection.execute(
      `SELECT id FROM user_sessions WHERE id = ? AND user_id = ?
       AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`,
      [actor.sessionId, actor.user.id],
    );
    if (!sessions[0])
      throw failure(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    const [permissions] = await connection.execute(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.code FOR UPDATE`,
      [row.role_id],
    );
    const granted = new Set(permissions.map(({ code }) => code));
    if (!administratorPermissions.every((code) => granted.has(code))) {
      throw failure(
        403,
        "PERMISSION_DENIED",
        "No tienes permisos administrativos suficientes.",
      );
    }
    const [warehouses] = await connection.execute(
      "SELECT warehouse_id FROM user_warehouses WHERE user_id = ? ORDER BY warehouse_id",
      [row.id],
    );
    return {
      id: String(row.id),
      roleId: row.role_id,
      warehouseIds: new Set(
        warehouses.map((item) => String(item.warehouse_id)),
      ),
    };
  }

  async function readRole(connection, roleCode, { forUpdate = false } = {}) {
    const [roles] = await connection.execute(
      `SELECT id, code, name, description,
              DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
       FROM roles WHERE code = ? AND code IN ('administrator','seller','warehouse','auditor')${forUpdate ? " FOR UPDATE" : ""}`,
      [roleCode],
    );
    if (!roles[0])
      throw failure(404, "ROLE_NOT_FOUND", "No se encontró el rol solicitado.");
    const [assignments] = await connection.execute(
      `SELECT rp.permission_id AS id, rp.permission_id, p.code,
              DATE_FORMAT(rp.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.code, rp.permission_id${forUpdate ? " FOR UPDATE" : ""}`,
      [roles[0].id],
    );
    return { role: roles[0], assignments };
  }

  async function scopeForRole(
    connection,
    roleId,
    actorWarehouseIds,
    { lock = false } = {},
  ) {
    const [users] = await connection.execute(
      `SELECT id FROM users WHERE role_id = ? ORDER BY id${lock ? " FOR UPDATE" : ""}`,
      [roleId],
    );
    if (!users.length) return { accountCount: 0, covered: true };
    const ids = users.map((row) => String(row.id));
    const placeholders = ids.map(() => "?").join(",");
    const [assignments] = await connection.execute(
      `SELECT user_id, warehouse_id FROM user_warehouses
       WHERE user_id IN (${placeholders}) ORDER BY user_id, warehouse_id${lock ? " FOR UPDATE" : ""}`,
      ids,
    );
    const covered = assignments.every((row) =>
      actorWarehouseIds.has(String(row.warehouse_id)),
    );
    return { accountCount: users.length, covered };
  }

  async function roles() {
    const [rows] = await dbPool.execute(
      `SELECT r.id, r.code, r.name, r.description,
              COUNT(rp.permission_id) AS assigned_count,
              (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS account_count
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.code IN ('administrator','seller','warehouse','auditor')
       GROUP BY r.id, r.code, r.name, r.description
       ORDER BY FIELD(r.code, 'administrator','seller','warehouse','auditor')`,
    );
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      description: row.description,
      assignedPermissionCount: Number(row.assigned_count),
      affectedAccountCount: Number(row.account_count),
    }));
  }

  async function permissions() {
    const [rows] = await dbPool.execute(
      "SELECT code, name, module, description FROM permissions ORDER BY module, code",
    );
    return rows;
  }

  async function getPermissions(roleCode, actor) {
    if (!ROLE_CODES.includes(roleCode))
      throw failure(404, "ROLE_NOT_FOUND", "No se encontró el rol solicitado.");
    return withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const authorized = await lockAndAuthorizeActor(connection, actor);
      const { role, assignments } = await readRole(connection, roleCode);
      const scope = await scopeForRole(
        connection,
        role.id,
        authorized.warehouseIds,
      );
      const [catalog] = await connection.execute(
        "SELECT id, code, name, module, description FROM permissions ORDER BY module, code",
      );
      const granted = new Set(assignments.map((item) => item.code));
      const items = catalog.map((permission) => {
        const policy = classifyPermission(roleCode, permission.code);
        return {
          ...permission,
          assigned: granted.has(permission.code),
          category: policy.category,
          compatible: policy.compatible,
          dependencies: policy.dependencies,
          reason: policy.reason,
        };
      });
      return {
        role: {
          code: role.code,
          name: role.name,
          description: role.description,
        },
        policyVersion: POLICY_VERSION,
        revision: revision(role, assignments),
        permissions: items,
        configurablePermissionCodes: items
          .filter((item) => item.category === "configurable" && item.assigned)
          .map((item) => item.code)
          .sort(),
        affectedAccountCount: scope.accountCount,
        canEdit: scope.covered,
        editBlockedReason: scope.covered
          ? null
          : "Tu cuenta no cubre todas las bodegas asignadas a los usuarios de este rol.",
      };
    });
  }

  async function assertAdministratorContinuity(connection) {
    const [rows] = await connection.execute(
      `SELECT id FROM roles WHERE code = 'administrator'`,
    );
    const id = rows[0]?.id;
    if (!id)
      throw failure(
        409,
        "ADMINISTRATOR_ACCESS_REQUIRED",
        "No se puede conservar el acceso administrativo.",
      );
    const [permissions] = await connection.execute(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? FOR UPDATE`,
      [id],
    );
    const granted = new Set(permissions.map((item) => item.code));
    if (!administratorPermissions.every((code) => granted.has(code))) {
      throw failure(
        409,
        "ADMINISTRATOR_ACCESS_REQUIRED",
        "El rol Administrador debe conservar los cinco permisos indispensables para gestionar accesos.",
      );
    }
    const [active] = await connection.execute(
      `SELECT id FROM users WHERE role_id = ? AND is_active = 1 AND password_change_required = 0 ORDER BY id LIMIT 1 FOR UPDATE`,
      [id],
    );
    if (!active.length)
      throw failure(
        409,
        "LAST_ADMINISTRATOR_REQUIRED",
        "Debe permanecer al menos un Administrador operativo.",
      );
  }

  async function updatePermissions(roleCode, input, actor, request) {
    if (!ROLE_CODES.includes(roleCode))
      throw failure(404, "ROLE_NOT_FOUND", "No se encontró el rol solicitado.");
    return withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const authorized = await lockAndAuthorizeActor(connection, actor);
      const { role } = await readRole(connection, roleCode, {
        forUpdate: true,
      });
      const scope = await scopeForRole(
        connection,
        role.id,
        authorized.warehouseIds,
        { lock: true },
      );
      if (!scope.covered)
        throw failure(
          403,
          "ROLE_WAREHOUSE_SCOPE_REQUIRED",
          "Tu cuenta no cubre todas las bodegas asignadas a los usuarios de este rol.",
        );
      const { assignments } = await readRole(connection, roleCode);
      const currentRevision = revision(role, assignments);
      if (currentRevision !== input.expectedRevision) {
        throw failure(
          409,
          "ROLE_PERMISSION_REVISION_CONFLICT",
          "Los permisos de este rol cambiaron. Actualiza la información y revisa de nuevo.",
        );
      }
      validatePermissionSet(roleCode, input.configurablePermissionCodes);
      const currentConfigurable = assignments
        .map((item) => item.code)
        .filter(
          (code) =>
            classifyPermission(roleCode, code).category === "configurable",
        )
        .sort();
      const desired = [...input.configurablePermissionCodes].sort();
      const desiredSet = new Set(desired);
      const currentSet = new Set(currentConfigurable);
      const added = desired.filter((code) => !currentSet.has(code));
      const removed = currentConfigurable.filter(
        (code) => !desiredSet.has(code),
      );
      if (!added.length && !removed.length) {
        return {
          changed: false,
          revision: currentRevision,
          addedPermissionCodes: [],
          removedPermissionCodes: [],
          affectedAccountCount: scope.accountCount,
          revokedSessionCount: 0,
          reauthenticationRequired: false,
        };
      }

      const permissionByCode = new Map(
        assignments.map((item) => [item.code, item.permission_id]),
      );
      if (added.length) {
        const [permissionRows] = await connection.execute(
          `SELECT id, code FROM permissions WHERE code IN (${added.map(() => "?").join(",")}) ORDER BY code FOR UPDATE`,
          added,
        );
        if (permissionRows.length !== added.length)
          throw failure(
            400,
            "ROLE_PERMISSION_UNKNOWN",
            "Uno o más permisos no existen.",
          );
        for (const permission of permissionRows)
          permissionByCode.set(permission.code, permission.id);
      }
      for (const code of added) {
        await connection.execute(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [role.id, permissionByCode.get(code)],
        );
      }
      for (const code of removed) {
        await connection.execute(
          "DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?",
          [role.id, permissionByCode.get(code)],
        );
      }
      await connection.execute(
        `UPDATE roles SET updated_at = DATE_ADD(GREATEST(updated_at, UTC_TIMESTAMP(3)), INTERVAL 1000 MICROSECOND)
         WHERE id = ?`,
        [role.id],
      );
      const [revoked] = await connection.execute(
        `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
         WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE role_id = ?)
           AND (expires_at > UTC_TIMESTAMP(3) OR expires_at IS NULL)`,
        [role.id],
      );
      await assertAdministratorContinuity(connection);
      const { ip, userAgent } = metadata(request);
      await connection.execute(
        `INSERT INTO audit_events
         (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
         VALUES (?, 'roles.permissions_updated', 'roles', 'role', ?, ?, ?, ?)`,
        [
          authorized.id,
          String(role.id),
          JSON.stringify({
            roleCode,
            addedPermissionCodes: added,
            removedPermissionCodes: removed,
            previousRevision: currentRevision,
            policyVersion: POLICY_VERSION,
            affectedAccountCount: scope.accountCount,
            revokedSessionCount: Number(revoked.affectedRows),
          }),
          ip,
          userAgent,
        ],
      );
      const { role: updatedRole, assignments: updatedAssignments } =
        await readRole(connection, roleCode);
      return {
        changed: true,
        revision: revision(updatedRole, updatedAssignments),
        addedPermissionCodes: added,
        removedPermissionCodes: removed,
        affectedAccountCount: scope.accountCount,
        revokedSessionCount: Number(revoked.affectedRows),
        reauthenticationRequired:
          roleCode === "administrator" &&
          String(actor.user.id) === authorized.id,
      };
    });
  }

  return { roles, permissions, getPermissions, updatePermissions };
}
