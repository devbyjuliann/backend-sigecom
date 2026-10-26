import bcrypt from "bcrypt";
import { HttpError } from "../../shared/http-error.js";

function metadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

export async function changePassword({
  dbPool,
  userId,
  currentPassword,
  newPassword,
  request,
}) {
  const newPasswordHash = await bcrypt.hash(newPassword, 12);
  const connection = await dbPool.getConnection();
  let currentPasswordValid;
  let result;

  try {
    await connection.beginTransaction();
    const [users] = await connection.execute(
      `SELECT password_hash, is_active FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    const user = users[0];
    if (!user || !user.is_active) {
      await connection.rollback();
      throw new HttpError(
        401,
        "SESSION_INVALID",
        "La sesión no es válida o ha vencido.",
      );
    }

    currentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password_hash,
    );
    if (!currentPasswordValid) {
      await connection.rollback();
    } else {
      await connection.execute(
        `UPDATE users SET password_hash = ?, password_change_required = 0
         WHERE id = ?`,
        [newPasswordHash, userId],
      );
      const [revoked] = await connection.execute(
        `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [userId],
      );
      const { ipAddress, userAgent } = metadata(request);
      await connection.execute(
        `INSERT INTO audit_events
          (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
         VALUES (?, 'auth.password_changed', 'auth', 'user', ?, ?, ?, ?)`,
        [
          userId,
          String(userId),
          JSON.stringify({ revokedSessions: revoked.affectedRows }),
          ipAddress,
          userAgent,
        ],
      );
      await connection.commit();
      result = { changed: true, revokedSessions: revoked.affectedRows };
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (!currentPasswordValid) {
    throw new HttpError(
      401,
      "CURRENT_PASSWORD_INCORRECT",
      "La contraseña actual no es correcta.",
    );
  }
  return result;
}
