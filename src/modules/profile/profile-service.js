import { HttpError } from "../../shared/http-error.js";

function auditMetadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

export function createProfileService({ dbPool }) {
  async function getOwnProfile(userId) {
    const [rows] = await dbPool.execute(
      `SELECT u.id, u.email, u.display_name, r.code AS role_code
       FROM users AS u JOIN roles AS r ON r.id = u.role_id
       WHERE u.id = ? AND u.is_active = 1 LIMIT 1`,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      throw new HttpError(
        404,
        "PROFILE_NOT_FOUND",
        "No se encontró el perfil.",
      );
    }
    return {
      id: String(row.id),
      email: row.email,
      displayName: row.display_name,
      role: row.role_code,
    };
  }

  async function updateOwnProfile({ userId, displayName, request }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id FROM users WHERE id = ? AND is_active = 1 FOR UPDATE`,
        [userId],
      );
      if (!rows[0]) {
        await connection.rollback();
        throw new HttpError(
          404,
          "PROFILE_NOT_FOUND",
          "No se encontró el perfil.",
        );
      }

      await connection.execute(
        "UPDATE users SET display_name = ? WHERE id = ?",
        [displayName, userId],
      );
      const { ipAddress, userAgent } = auditMetadata(request);
      await connection.execute(
        `INSERT INTO audit_events
          (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
         VALUES (?, 'profile.updated', 'profile', 'user', ?, ?, ?, ?)`,
        [
          userId,
          String(userId),
          JSON.stringify({ fields: ["displayName"] }),
          ipAddress,
          userAgent,
        ],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return getOwnProfile(userId);
  }

  return { getOwnProfile, updateOwnProfile };
}
