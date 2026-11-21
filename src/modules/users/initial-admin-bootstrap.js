export async function createInitialAdmin({
  dbPool,
  email,
  displayName,
  passwordHash,
  lockName = "sigecom:initial-admin:sigecom_dev",
}) {
  const normalizedName = String(displayName || "").trim();
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error(
      "El nombre del administrador debe tener entre 1 y 120 caracteres.",
    );
  }
  if (typeof passwordHash !== "string" || !passwordHash) {
    throw new Error(
      "La contraseña inicial debe recibirse únicamente como hash.",
    );
  }

  const connection = await dbPool.getConnection();
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName],
    );
    if (lock.acquired !== 1) {
      throw new Error("No se pudo reservar el alta inicial del administrador.");
    }
    lockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;

    const [existingAdmin] = await connection.execute(
      `SELECT u.id FROM users AS u JOIN roles AS r ON r.id = u.role_id
       WHERE r.code = 'administrator' LIMIT 1 FOR UPDATE`,
    );
    if (existingAdmin.length) {
      throw new Error(
        "Ya existe una cuenta administradora; no se modificó ninguna cuenta.",
      );
    }

    const [existingEmail] = await connection.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    if (existingEmail.length) {
      throw new Error(
        "El correo indicado ya está registrado; no se modificó ninguna cuenta.",
      );
    }

    const [roleRows] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    if (!roleRows.length) {
      throw new Error(
        "Aplique las migraciones y semillas antes de crear el administrador.",
      );
    }

    const [warehouses] = await connection.execute(
      `SELECT id FROM warehouses
       WHERE is_active = 1 ORDER BY id FOR UPDATE`,
    );
    if (!warehouses.length) {
      throw new Error(
        "Debe existir al menos una bodega activa antes de crear el Administrador inicial.",
      );
    }

    const [userResult] = await connection.execute(
      `INSERT INTO users
         (role_id, email, display_name, password_hash, is_active,
          credential_state, password_change_required)
       VALUES (?, ?, ?, ?, 1, 'active', 1)`,
      [roleRows[0].id, email, normalizedName, passwordHash],
    );
    const userId = String(userResult.insertId);
    const warehouseIds = warehouses.map((warehouse) => String(warehouse.id));
    for (const warehouseId of warehouseIds) {
      await connection.execute(
        `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by)
         VALUES (?, ?, NULL)`,
        [userId, warehouseId],
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (user_id, action, module, entity_type, entity_id, details)
       VALUES (?, 'initial_admin.created', 'users', 'users', ?, ?)`,
      [
        userId,
        userId,
        JSON.stringify({
          role: "administrator",
          password_change_required: true,
          warehouseIds,
        }),
      ],
    );

    await connection.commit();
    transactionStarted = false;
    return { id: userId, email, displayName: normalizedName, warehouseIds };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the bootstrap error; the connection is released below.
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      await connection
        .query("SELECT RELEASE_LOCK(?)", [lockName])
        .catch(() => {});
    }
    connection.release();
  }
}
