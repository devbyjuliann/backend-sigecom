import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { HttpError } from "../../shared/http-error.js";

const requiredAdminPermissions = [
  "users.read",
  "users.manage",
  "roles.manage",
  "permissions.manage",
  "warehouses.read",
];
const roleNames = {
  administrator: "Administrador",
  seller: "Vendedor",
  warehouse: "Bodega",
  auditor: "Auditor",
};

const failure = (status, code, message) => new HttpError(status, code, message);

function userRevision(user, assignments) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: String(user.id),
        roleId: String(user.role_id),
        roleCode: user.role_code,
        email: user.email,
        displayName: user.display_name,
        isActive: Boolean(user.is_active),
        passwordChangeRequired: Boolean(user.password_change_required),
        credentialRevision: user.password_hash,
        updatedAt: user.updated_at,
        assignments: assignments.map((item) => ({
          warehouseId: String(item.warehouse_id),
          assignedBy:
            item.assigned_by === null ? null : String(item.assigned_by),
          createdAt: item.created_at,
        })),
      }),
    )
    .digest("base64url");
}

function rowUser(
  row,
  revision,
  { visibleWarehouseCount, totalWarehouseCount },
) {
  return {
    id: String(row.id),
    email: row.email,
    displayName: row.display_name,
    roleCode: row.role_code,
    roleName: roleNames[row.role_code] || row.role_name,
    isActive: Boolean(row.is_active),
    passwordChangeRequired: Boolean(row.password_change_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    warehouseCount: Number(totalWarehouseCount ?? row.warehouse_count ?? 0),
    visibleWarehouseCount: Number(
      visibleWarehouseCount ?? row.visible_warehouse_count ?? 0,
    ),
    canManage:
      Number(totalWarehouseCount ?? row.warehouse_count ?? 0) ===
      Number(visibleWarehouseCount ?? row.visible_warehouse_count ?? 0),
    revision,
  };
}

function auditMetadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

export function createUserService({ dbPool }) {
  async function readState(connection, id) {
    const [users] = await connection.execute(
      `SELECT u.id, u.role_id, u.email, u.display_name, u.is_active,
               u.password_change_required,
               u.password_hash,
              DATE_FORMAT(u.updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at,
              r.code AS role_code, r.name AS role_name
        FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1 FOR UPDATE`,
      [id],
    );
    if (!users[0]) return null;
    const [assignments] = await connection.execute(
      `SELECT uw.warehouse_id, uw.assigned_by,
              DATE_FORMAT(uw.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at
        FROM user_warehouses uw WHERE uw.user_id = ? ORDER BY uw.warehouse_id FOR UPDATE`,
      [id],
    );
    return {
      user: users[0],
      assignments,
      revision: userRevision(users[0], assignments),
    };
  }

  async function readVisibleAssignments(connection, userId, actorId) {
    const [rows] = await connection.execute(
      `SELECT w.id, w.code, w.name, w.is_active, uw.assigned_by,
              DATE_FORMAT(uw.created_at, '%Y-%m-%d %H:%i:%s.%f') AS assigned_at
       FROM user_warehouses uw
       JOIN warehouses w ON w.id = uw.warehouse_id
       JOIN user_warehouses actor_access
         ON actor_access.warehouse_id = w.id AND actor_access.user_id = ?
       WHERE uw.user_id = ? ORDER BY w.name, w.id`,
      [actorId, userId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      code: row.code,
      name: row.name,
      isActive: Boolean(row.is_active),
      assignedBy: row.assigned_by === null ? null : String(row.assigned_by),
      assignedAt: row.assigned_at,
    }));
  }

  async function assertRolePermissions(connection, roleId, required) {
    const [rows] = await connection.execute(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ? AND p.code IN (${required.map(() => "?").join(",")})
        FOR UPDATE`,
      [roleId, ...required],
    );
    const granted = new Set(rows.map((row) => row.code));
    return required.every((code) => granted.has(code));
  }

  async function lockActor(connection, actor) {
    const [rows] = await connection.execute(
      `SELECT u.id, u.role_id, u.is_active, u.password_change_required,
              r.code AS role_code
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
      `SELECT id FROM user_sessions
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL
         AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`,
      [actor.sessionId, actor.user.id],
    );
    if (!sessions[0]) {
      throw failure(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    }
    const [warehouses] = await connection.execute(
      `SELECT warehouse_id FROM user_warehouses
       WHERE user_id = ? ORDER BY warehouse_id`,
      [actor.user.id],
    );
    return {
      id: String(row.id),
      roleId: row.role_id,
      warehouseIds: new Set(
        warehouses.map((item) => String(item.warehouse_id)),
      ),
    };
  }

  async function lockAdministratorRole(connection) {
    const [roles] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator' FOR UPDATE",
    );
    if (!roles[0])
      throw new Error("Falta el rol de Administrador del sistema.");
  }

  async function assertActorSessionPermissions(connection, actor, permissions) {
    const actorState = await lockActor(connection, actor);
    if (
      !(await assertRolePermissions(connection, actorState.roleId, permissions))
    ) {
      throw failure(
        403,
        "PERMISSION_DENIED",
        "No tienes permiso para esta operación.",
      );
    }
    return actorState;
  }

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
        await connection.rollback();
        if (
          !commitStarted &&
          attempt < 2 &&
          ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)
        ) {
          continue;
        }
        throw error;
      } finally {
        connection.release();
      }
    }
  }

  async function writeAudit(
    connection,
    { actorId, targetId, action, details, request },
  ) {
    const { ipAddress, userAgent } = auditMetadata(request);
    await connection.execute(
      `INSERT INTO audit_events
       (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
       VALUES (?, ?, 'users', 'user', ?, ?, ?, ?)`,
      [
        actorId,
        action,
        String(targetId),
        JSON.stringify(details),
        ipAddress,
        userAgent,
      ],
    );
  }

  async function checkTargetScope(connection, targetId, actor) {
    const [assignments] = await connection.execute(
      `SELECT uw.warehouse_id FROM user_warehouses uw
       WHERE uw.user_id = ? ORDER BY uw.warehouse_id FOR UPDATE`,
      [targetId],
    );
    const outOfScope = assignments
      .map((row) => String(row.warehouse_id))
      .filter((warehouseId) => !actor.warehouseIds.has(warehouseId));
    if (outOfScope.length) {
      throw failure(
        403,
        "USER_WAREHOUSE_SCOPE_REQUIRED",
        "Esta cuenta tiene bodegas fuera de tu alcance. Solicita la intervención de un Administrador autorizado para todas sus bodegas.",
      );
    }
    return assignments;
  }

  async function checkRequestedWarehouses(connection, ids, actor) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw failure(
        400,
        "INVALID_WAREHOUSE_ASSIGNMENTS",
        "No repitas bodegas en la solicitud.",
      );
    }
    if (!uniqueIds.length) return [];
    const sorted = [...uniqueIds].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );
    const [warehouses] = await connection.execute(
      `SELECT id, is_active FROM warehouses WHERE id IN (${sorted.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`,
      sorted,
    );
    if (warehouses.length !== uniqueIds.length) {
      throw failure(
        400,
        "INVALID_WAREHOUSE_ASSIGNMENTS",
        "Una o más bodegas ya no están disponibles.",
      );
    }
    for (const warehouse of warehouses) {
      const id = String(warehouse.id);
      if (!actor.warehouseIds.has(id) || !warehouse.is_active) {
        throw failure(
          403,
          "WAREHOUSE_ASSIGNMENT_DENIED",
          "Solo puedes asignar bodegas activas que también estén autorizadas para tu cuenta.",
        );
      }
    }
    return warehouses;
  }

  async function assertActiveAccountHasWarehouse(connection, targetId) {
    const [[row]] = await connection.execute(
      `SELECT EXISTS(
         SELECT 1 FROM users u JOIN user_warehouses uw ON uw.user_id = u.id
         JOIN warehouses w ON w.id = uw.warehouse_id
         WHERE u.id = ? AND w.is_active = 1
       ) AS has_active_warehouse`,
      [targetId],
    );
    if (!row.has_active_warehouse) {
      throw failure(
        409,
        "ACTIVE_USER_REQUIRES_WAREHOUSE",
        "Una cuenta activa debe tener al menos una bodega activa asignada.",
      );
    }
  }

  async function assertAdministratorContinuity(connection) {
    const [roles] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    const roleId = roles[0]?.id;
    if (
      !roleId ||
      !(await assertRolePermissions(
        connection,
        roleId,
        requiredAdminPermissions,
      ))
    ) {
      throw failure(
        409,
        "ADMINISTRATOR_ACCESS_REQUIRED",
        "El rol Administrador debe conservar los permisos indispensables para gestionar accesos.",
      );
    }
    const [rows] = await connection.execute(
      `SELECT id FROM users
       WHERE role_id = ? AND is_active = 1 AND password_change_required = 0
       ORDER BY id LIMIT 1 FOR UPDATE`,
      [roleId],
    );
    if (!rows.length) {
      throw failure(
        409,
        "LAST_ADMINISTRATOR_REQUIRED",
        "No se puede completar el cambio porque debe permanecer al menos un Administrador operativo.",
      );
    }
  }

  async function list({
    page,
    pageSize,
    q,
    roleCode,
    status,
    sortBy,
    sortOrder,
    actorId,
  }) {
    const conditions = [];
    const values = [actorId];
    if (q) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      conditions.push(
        "(u.email LIKE ? ESCAPE '\\\\' OR u.display_name LIKE ? ESCAPE '\\\\')",
      );
      values.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (roleCode !== "all") {
      conditions.push("r.code = ?");
      values.push(roleCode);
    }
    if (status !== "all") {
      conditions.push("u.is_active = ?");
      values.push(status === "active" ? 1 : 0);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const [[count]] = await dbPool.execute(
      `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${where}`,
      values.slice(1),
    );
    const columns = {
      name: "u.display_name",
      email: "u.email",
      role: "r.name",
      status: "u.is_active",
      updatedAt: "u.updated_at",
    };
    const direction = sortOrder === "desc" ? "DESC" : "ASC";
    const offset = (page - 1) * pageSize;
    const [rows] = await dbPool.execute(
      `SELECT u.id, u.email, u.display_name, u.is_active, u.password_change_required,
              u.created_at, u.updated_at, r.code AS role_code, r.name AS role_name,
              (SELECT COUNT(*) FROM user_warehouses uw WHERE uw.user_id = u.id) AS warehouse_count,
              (SELECT COUNT(*) FROM user_warehouses uw JOIN user_warehouses own
                 ON own.warehouse_id = uw.warehouse_id AND own.user_id = ?
               WHERE uw.user_id = u.id) AS visible_warehouse_count
       FROM users u JOIN roles r ON r.id = u.role_id ${where}
       ORDER BY ${columns[sortBy]} ${direction}, u.id ASC LIMIT ? OFFSET ?`,
      [actorId, ...values.slice(1), pageSize, offset],
    );
    const total = Number(count.total);
    return {
      items: rows.map((row) => rowUser(row, undefined, {})),
      pagination: {
        page,
        pageSize,
        total,
        pageCount: Math.ceil(total / pageSize),
      },
    };
  }

  async function roles() {
    const [rows] = await dbPool.execute(
      `SELECT code, name, description FROM roles
       WHERE code IN ('administrator', 'seller', 'warehouse', 'auditor')
       ORDER BY FIELD(code, 'administrator', 'seller', 'warehouse', 'auditor')`,
    );
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      description: row.description,
    }));
  }

  async function getById(id, actorId) {
    const connection = await dbPool.getConnection();
    let state;
    let assignments;
    try {
      await connection.beginTransaction();
      state = await readState(connection, id);
      assignments = await readVisibleAssignments(connection, id, actorId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (!state)
      throw failure(
        404,
        "USER_NOT_FOUND",
        "No se encontró la cuenta solicitada.",
      );
    const user = rowUser(state.user, state.revision, {
      totalWarehouseCount: state.assignments.length,
      visibleWarehouseCount: assignments.length,
    });
    return {
      ...user,
      assignedWarehouses: assignments,
      hasOutOfScopeWarehouses: assignments.length !== state.assignments.length,
    };
  }

  async function create({ input, actor: auth, request }) {
    const temporaryPassword = randomBytes(32).toString("base64url");
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const userId = await withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const actor = await assertActorSessionPermissions(connection, auth, [
        "users.read",
        "users.manage",
        "roles.manage",
        "warehouses.read",
      ]);
      const [rolesFound] = await connection.execute(
        `SELECT id, code FROM roles WHERE code = ? AND code IN ('administrator','seller','warehouse','auditor')`,
        [input.roleCode],
      );
      if (!rolesFound[0])
        throw failure(
          400,
          "INVALID_USER_ROLE",
          "Selecciona uno de los cuatro roles existentes.",
        );
      if (!input.warehouseIds.length)
        throw failure(
          400,
          "INVALID_WAREHOUSE_ASSIGNMENTS",
          "Asigna al menos una bodega activa a la cuenta.",
        );
      await checkRequestedWarehouses(connection, input.warehouseIds, actor);
      let result;
      try {
        [result] = await connection.execute(
          `INSERT INTO users (role_id, email, display_name, password_hash, is_active,
                              password_change_required, created_by)
           VALUES (?, ?, ?, ?, 1, 1, ?)`,
          [
            rolesFound[0].id,
            input.email,
            input.displayName,
            passwordHash,
            actor.id,
          ],
        );
      } catch (error) {
        if (
          error.code === "ER_DUP_ENTRY" &&
          String(error.message).includes("uq_users_email")
        ) {
          throw failure(
            409,
            "USER_EMAIL_TAKEN",
            "Ya existe una cuenta con ese correo.",
          );
        }
        throw error;
      }
      const id = String(result.insertId);
      for (const warehouseId of [...input.warehouseIds].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      )) {
        await connection.execute(
          "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
          [id, warehouseId, actor.id],
        );
      }
      await writeAudit(connection, {
        actorId: actor.id,
        targetId: id,
        action: "users.created",
        details: {
          email: input.email,
          roleCode: rolesFound[0].code,
          warehouseIds: input.warehouseIds,
        },
        request,
      });
      await assertAdministratorContinuity(connection);
      return id;
    });
    return { user: await getById(userId, auth.user.id), temporaryPassword };
  }

  async function update({ id, input, actor: auth, request }) {
    const result = await withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const actor = await assertActorSessionPermissions(connection, auth, [
        "users.read",
        "users.manage",
      ]);
      const [targetLocks] = await connection.execute(
        "SELECT id FROM users WHERE id = ? FOR UPDATE",
        [id],
      );
      if (!targetLocks[0])
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      const assignments = await checkTargetScope(connection, id, actor);
      const state = await readState(connection, id);
      if (!state)
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      if (state.revision !== input.expectedRevision)
        throw failure(
          409,
          "USER_REVISION_CONFLICT",
          "La cuenta cambió. Actualiza sus datos antes de guardar.",
        );
      if (
        String(id) === actor.id &&
        input.roleCode &&
        input.roleCode !== state.user.role_code
      ) {
        throw failure(
          409,
          "OWN_ROLE_CHANGE_DENIED",
          "Otro Administrador debe cambiar tu rol.",
        );
      }

      const currentIds = assignments.map((row) => String(row.warehouse_id));
      const addIds = input.warehouseChanges?.addIds || [];
      const removeIds = input.warehouseChanges?.removeIds || [];
      const changes = new Set();
      if (
        input.displayName !== undefined &&
        input.displayName !== state.user.display_name
      )
        changes.add("displayName");
      if (input.email !== undefined && input.email !== state.user.email)
        changes.add("email");
      if (
        input.roleCode !== undefined &&
        input.roleCode !== state.user.role_code
      )
        changes.add("roleCode");
      if (
        [...addIds, ...removeIds].length &&
        !(await assertRolePermissions(connection, actor.roleId, [
          "warehouses.read",
        ]))
      ) {
        throw failure(
          403,
          "PERMISSION_DENIED",
          "No tienes permiso para gestionar bodegas asignadas.",
        );
      }
      if (
        input.roleCode !== undefined &&
        input.roleCode !== state.user.role_code &&
        !(await assertRolePermissions(connection, actor.roleId, [
          "roles.manage",
        ]))
      ) {
        throw failure(
          403,
          "PERMISSION_DENIED",
          "No tienes permiso para asignar roles.",
        );
      }
      if (addIds.some((warehouseId) => removeIds.includes(warehouseId))) {
        throw failure(
          400,
          "INVALID_WAREHOUSE_ASSIGNMENTS",
          "No puedes añadir y retirar la misma bodega en una solicitud.",
        );
      }
      if (
        new Set(addIds).size !== addIds.length ||
        new Set(removeIds).size !== removeIds.length
      ) {
        throw failure(
          400,
          "INVALID_WAREHOUSE_ASSIGNMENTS",
          "No repitas bodegas en la solicitud.",
        );
      }
      for (const warehouseId of removeIds) {
        if (!currentIds.includes(warehouseId))
          throw failure(
            400,
            "INVALID_WAREHOUSE_ASSIGNMENTS",
            "Solo puedes retirar bodegas actualmente asignadas.",
          );
      }
      for (const warehouseId of addIds) {
        if (currentIds.includes(warehouseId))
          throw failure(
            400,
            "INVALID_WAREHOUSE_ASSIGNMENTS",
            "La bodega ya está asignada a esta cuenta.",
          );
      }
      await checkRequestedWarehouses(connection, addIds, actor);
      const nextIds = currentIds
        .filter((warehouseId) => !removeIds.includes(warehouseId))
        .concat(addIds);
      const isActive = Boolean(state.user.is_active);
      if (isActive) {
        const [activeRows] = nextIds.length
          ? await connection.execute(
              `SELECT id FROM warehouses WHERE is_active = 1 AND id IN (${nextIds.map(() => "?").join(",")})`,
              nextIds,
            )
          : [[]];
        if (!activeRows.length)
          throw failure(
            409,
            "ACTIVE_USER_REQUIRES_WAREHOUSE",
            "Una cuenta activa debe conservar al menos una bodega activa asignada.",
          );
      }
      let roleId = state.user.role_id;
      let roleCode = state.user.role_code;
      if (input.roleCode !== undefined) {
        const [rolesFound] = await connection.execute(
          `SELECT id, code FROM roles WHERE code = ? AND code IN ('administrator','seller','warehouse','auditor')`,
          [input.roleCode],
        );
        if (!rolesFound[0])
          throw failure(
            400,
            "INVALID_USER_ROLE",
            "Selecciona uno de los cuatro roles existentes.",
          );
        roleId = rolesFound[0].id;
        roleCode = rolesFound[0].code;
      }
      if (
        input.displayName !== undefined &&
        input.displayName !== state.user.display_name
      ) {
        await connection.execute(
          "UPDATE users SET display_name = ? WHERE id = ?",
          [input.displayName, id],
        );
      }
      if (input.email !== undefined && input.email !== state.user.email) {
        try {
          await connection.execute("UPDATE users SET email = ? WHERE id = ?", [
            input.email,
            id,
          ]);
        } catch (error) {
          if (
            error.code === "ER_DUP_ENTRY" &&
            String(error.message).includes("uq_users_email")
          )
            throw failure(
              409,
              "USER_EMAIL_TAKEN",
              "Ya existe una cuenta con ese correo.",
            );
          throw error;
        }
      }
      if (roleCode !== state.user.role_code)
        await connection.execute("UPDATE users SET role_id = ? WHERE id = ?", [
          roleId,
          id,
        ]);
      for (const warehouseId of removeIds)
        await connection.execute(
          "DELETE FROM user_warehouses WHERE user_id = ? AND warehouse_id = ?",
          [id, warehouseId],
        );
      for (const warehouseId of addIds)
        await connection.execute(
          "INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)",
          [id, warehouseId, actor.id],
        );

      const accessChanged =
        changes.has("email") ||
        changes.has("roleCode") ||
        addIds.length > 0 ||
        removeIds.length > 0;
      if (!changes.size && !addIds.length && !removeIds.length) {
        return { id: String(id), actorId: auth.user.id };
      }
      if (accessChanged)
        await connection.execute(
          "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
          [id],
        );
      const details = {
        fields: [...changes],
        ...(changes.has("email")
          ? { email: { previous: state.user.email, current: input.email } }
          : {}),
        ...(changes.has("roleCode")
          ? { roleCode: { previous: state.user.role_code, current: roleCode } }
          : {}),
        ...(addIds.length ? { addedWarehouseIds: addIds } : {}),
        ...(removeIds.length ? { removedWarehouseIds: removeIds } : {}),
      };
      await writeAudit(connection, {
        actorId: actor.id,
        targetId: id,
        action: "users.updated",
        details,
        request,
      });
      await assertAdministratorContinuity(connection);
      return { id: String(id), actorId: auth.user.id };
    });
    return typeof result === "object" && result.id
      ? getById(result.id, result.actorId)
      : result;
  }

  async function setStatus({ id, input, actor: auth, request }) {
    const result = await withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const actor = await assertActorSessionPermissions(connection, auth, [
        "users.read",
        "users.manage",
      ]);
      const [targetLocks] = await connection.execute(
        "SELECT id FROM users WHERE id = ? FOR UPDATE",
        [id],
      );
      if (!targetLocks[0])
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      await checkTargetScope(connection, id, actor);
      const state = await readState(connection, id);
      if (!state)
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      if (state.revision !== input.expectedRevision)
        throw failure(
          409,
          "USER_REVISION_CONFLICT",
          "La cuenta cambió. Actualiza sus datos antes de guardar.",
        );
      if (String(id) === actor.id && !input.isActive)
        throw failure(
          409,
          "OWN_ACCOUNT_DEACTIVATION_DENIED",
          "No puedes desactivar tu propia cuenta.",
        );
      if (Boolean(state.user.is_active) === input.isActive)
        return { id: String(id), actorId: auth.user.id };
      if (input.isActive) await assertActiveAccountHasWarehouse(connection, id);
      await connection.execute("UPDATE users SET is_active = ? WHERE id = ?", [
        input.isActive ? 1 : 0,
        id,
      ]);
      await connection.execute(
        "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL",
        [id],
      );
      await writeAudit(connection, {
        actorId: actor.id,
        targetId: id,
        action: input.isActive ? "users.activated" : "users.deactivated",
        details: { isActive: input.isActive },
        request,
      });
      await assertAdministratorContinuity(connection);
      return { id: String(id), actorId: auth.user.id };
    });
    return getById(result.id, result.actorId);
  }

  async function resetPassword({ id, input, actor: auth, request }) {
    if (String(id) === String(auth.user.id))
      throw failure(
        409,
        "OWN_PASSWORD_RESET_DENIED",
        "No puedes restablecer tu propia contraseña desde la administración.",
      );

    const temporaryPassword = randomBytes(32).toString("base64url");
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const result = await withTransaction(async (connection) => {
      await lockAdministratorRole(connection);
      const actor = await assertActorSessionPermissions(
        connection,
        auth,
        requiredAdminPermissions,
      );
      const [targetLocks] = await connection.execute(
        "SELECT id FROM users WHERE id = ? FOR UPDATE",
        [id],
      );
      if (!targetLocks[0])
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      const assignments = await checkTargetScope(connection, id, actor);
      const state = await readState(connection, id);
      if (!state)
        throw failure(
          404,
          "USER_NOT_FOUND",
          "No se encontró la cuenta solicitada.",
        );
      if (state.revision !== input.expectedRevision)
        throw failure(
          409,
          "USER_REVISION_CONFLICT",
          "La cuenta cambió. Actualiza sus datos antes de restablecer la contraseña.",
        );
      if (!state.user.is_active)
        throw failure(
          409,
          "INACTIVE_USER_PASSWORD_RESET_DENIED",
          "Activa la cuenta antes de restablecer su contraseña.",
        );

      await connection.execute(
        `UPDATE users SET password_hash = ?, password_change_required = 1
         WHERE id = ?`,
        [passwordHash, id],
      );
      const [revoked] = await connection.execute(
        `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [id],
      );
      await assertAdministratorContinuity(connection);
      await writeAudit(connection, {
        actorId: actor.id,
        targetId: id,
        action: "users.password_reset",
        details: {
          revokedSessions: revoked.affectedRows,
          passwordChangeRequired: true,
        },
        request,
      });
      const updated = await readState(connection, id);
      const user = rowUser(updated.user, updated.revision, {
        totalWarehouseCount: assignments.length,
        visibleWarehouseCount: assignments.length,
      });
      return { user, revokedSessions: revoked.affectedRows };
    });
    return { ...result, temporaryPassword };
  }

  return { list, roles, getById, create, update, setStatus, resetPassword };
}
