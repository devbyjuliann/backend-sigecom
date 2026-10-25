import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { HttpError } from "../../shared/http-error.js";

const dummyPasswordHash = bcrypt.hash(
  randomBytes(48).toString("base64url"),
  12,
);
const invalidCredentials = () =>
  new HttpError(401, "INVALID_CREDENTIALS", "Correo o contraseña incorrectos.");
const invalidSession = () =>
  new HttpError(401, "SESSION_INVALID", "La sesión no es válida o ha vencido.");

function safeUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role_code,
    passwordChangeRequired: Boolean(row.password_change_required),
  };
}

function auditMetadata(request) {
  const userAgent = request?.get("user-agent");
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

async function writeAudit(
  connection,
  { userId = null, action, entityId = null, details = null, request },
) {
  const { ipAddress, userAgent } = auditMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
      (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'auth', ?, ?, ?, ?, ?)`,
    [
      userId,
      action,
      entityId === null ? null : "user_session",
      entityId,
      details === null ? null : JSON.stringify(details),
      ipAddress,
      userAgent,
    ],
  );
}

async function recordFailedLogin(dbPool, userId, request) {
  await writeAudit(dbPool, {
    userId: userId || null,
    action: "auth.login_failed",
    request,
  });
}

function tokenHash(jti) {
  return createHash("sha256").update(jti).digest("hex");
}

function verifySessionToken(token, config, { allowExpired = false } = {}) {
  if (typeof token !== "string" || token.length > 4096) return null;

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      ignoreExpiration: allowExpired,
    });
  } catch {
    return null;
  }

  if (
    typeof claims !== "object" ||
    typeof claims.sub !== "string" ||
    !/^[1-9]\d{0,19}$/.test(claims.sub) ||
    typeof claims.jti !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(claims.jti) ||
    !Number.isInteger(claims.exp)
  ) {
    return null;
  }

  return claims;
}

export function createAuthService({ dbPool, config }) {
  async function login({ email, password, request }) {
    const [userRows] = await dbPool.execute(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.is_active,
              u.password_change_required, r.code AS role_code
       FROM users AS u JOIN roles AS r ON r.id = u.role_id
       WHERE u.email = ? LIMIT 1`,
      [email],
    );
    const user = userRows[0];
    const passwordHash = user?.password_hash || (await dummyPasswordHash);
    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!user || !passwordMatches || !user.is_active) {
      await recordFailedLogin(dbPool, user?.id, request);
      throw invalidCredentials();
    }

    const jti = randomUUID();
    const claims = {
      sub: String(user.id),
      jti,
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
    };
    const token = jwt.sign(claims, config.jwtSecret, {
      algorithm: "HS256",
      expiresIn: config.ttlSeconds,
    });
    const decoded = jwt.decode(token);
    const connection = await dbPool.getConnection();
    let rejected = false;

    try {
      await connection.beginTransaction();
      const [currentRows] = await connection.execute(
        "SELECT password_hash, is_active FROM users WHERE id = ? FOR UPDATE",
        [user.id],
      );
      const current = currentRows[0];

      if (
        !current ||
        !current.is_active ||
        current.password_hash !== user.password_hash
      ) {
        await connection.rollback();
        rejected = true;
      } else {
        const [sessionResult] = await connection.execute(
          `INSERT INTO user_sessions (user_id, token_hash, expires_at)
           VALUES (?, ?, ?)`,
          [user.id, tokenHash(jti), new Date(decoded.exp * 1000)],
        );
        await writeAudit(connection, {
          userId: user.id,
          action: "auth.login_succeeded",
          entityId: String(sessionResult.insertId),
          details: { method: "password" },
          request,
        });
        await connection.commit();
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    if (rejected) {
      await recordFailedLogin(dbPool, user.id, request);
      throw invalidCredentials();
    }

    return { token, user: safeUser(user) };
  }

  async function authenticateToken(token) {
    const claims = verifySessionToken(token, config);
    if (!claims) throw invalidSession();

    const hash = tokenHash(claims.jti);
    const [rows] = await dbPool.execute(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name,
              u.password_change_required, r.id AS role_id, r.code AS role_code
       FROM user_sessions AS s
       JOIN users AS u ON u.id = s.user_id
       JOIN roles AS r ON r.id = u.role_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL
         AND s.expires_at > UTC_TIMESTAMP(3) AND u.is_active = 1
       LIMIT 1`,
      [hash],
    );
    const row = rows[0];
    if (!row) throw invalidSession();

    const [[permissionRows], [warehouseRows]] = await Promise.all([
      dbPool.execute(
        `SELECT p.code FROM role_permissions AS rp
         JOIN permissions AS p ON p.id = rp.permission_id
         WHERE rp.role_id = ? ORDER BY p.code`,
        [row.role_id],
      ),
      dbPool.execute(
        `SELECT uw.warehouse_id FROM user_warehouses AS uw
         JOIN warehouses AS w ON w.id = uw.warehouse_id
         WHERE uw.user_id = ? AND w.is_active = 1 ORDER BY uw.warehouse_id`,
        [row.id],
      ),
    ]);

    return {
      user: safeUser(row),
      sessionId: String(row.session_id),
      permissions: new Set(permissionRows.map(({ code }) => code)),
      warehouseIds: new Set(
        warehouseRows.map(({ warehouse_id }) => String(warehouse_id)),
      ),
    };
  }

  async function logout(token, request) {
    const claims = verifySessionToken(token, config, { allowExpired: true });
    if (!claims) return false;

    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, user_id FROM user_sessions
         WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1 FOR UPDATE`,
        [tokenHash(claims.jti)],
      );
      const session = rows[0];
      if (!session) {
        await connection.rollback();
        return false;
      }

      await connection.execute(
        "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL",
        [session.id],
      );
      await writeAudit(connection, {
        userId: session.user_id,
        action: "auth.logout",
        entityId: String(session.id),
        request,
      });
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return { login, authenticateToken, logout };
}

export async function revokeUserSessions(dbPool, userId) {
  const [result] = await dbPool.execute(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(3)
     WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );
  return result.affectedRows;
}
