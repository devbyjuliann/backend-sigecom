import { createHash } from "node:crypto";
import bcrypt from "bcrypt";
import { HttpError } from "../../shared/http-error.js";
import { createAccountAccessTokenService } from "./account-access-token-service.js";
import { passwordRecoveryCompletionSchema } from "./password-policy.js";

const TOKEN_PURPOSE = "password_recovery";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function requestMetadata(request) {
  const userAgent =
    request?.get?.("user-agent") || request?.headers?.["user-agent"];
  return {
    ipAddress: request?.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null,
  };
}

function invalidRecoveryLink() {
  return new HttpError(
    400,
    "PASSWORD_RECOVERY_LINK_INVALID",
    "El enlace no es válido, venció o ya fue utilizado. Solicita uno nuevo.",
  );
}

function invalidPassword(message) {
  return new HttpError(400, "INVALID_PASSWORD_CHANGE", message);
}

async function withTransaction(dbPool, work) {
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
        // Preserve the operation error; connection cleanup is handled below.
      }
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
  { userId = null, action, request, details },
) {
  const { ipAddress, userAgent } = requestMetadata(request);
  await connection.execute(
    `INSERT INTO audit_events
       (user_id, action, module, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, 'auth', 'credential_recovery', ?, ?, ?, ?)`,
    [
      userId,
      action,
      userId === null ? null : String(userId),
      JSON.stringify(details),
      ipAddress,
      userAgent,
    ],
  );
}

export function createPasswordRecoveryService({
  dbPool,
  mailTransport,
  logger,
  publicAppOrigin,
}) {
  if (!dbPool || !mailTransport || typeof mailTransport.send !== "function") {
    throw new TypeError(
      "El servicio de recuperación requiere base de datos y transporte de correo.",
    );
  }
  let parsedPublicAppOrigin;
  try {
    parsedPublicAppOrigin = new URL(publicAppOrigin);
  } catch {
    parsedPublicAppOrigin = null;
  }
  if (
    !parsedPublicAppOrigin ||
    !["http:", "https:"].includes(parsedPublicAppOrigin.protocol) ||
    parsedPublicAppOrigin.pathname !== "/" ||
    parsedPublicAppOrigin.search ||
    parsedPublicAppOrigin.hash ||
    parsedPublicAppOrigin.username ||
    parsedPublicAppOrigin.password
  ) {
    throw new TypeError("PUBLIC_APP_ORIGIN no es un origen válido.");
  }
  publicAppOrigin = parsedPublicAppOrigin.origin;
  const accessTokens = createAccountAccessTokenService({
    dbPool,
    mailTransport,
    logger,
    publicAppOrigin,
  });

  async function requestRecovery({ email, request }) {
    const normalizedEmail = email.trim().toLowerCase();
    let delivery = null;

    await withTransaction(dbPool, async (connection) => {
      const [users] = await connection.execute(
        `SELECT id, email, display_name, is_active, credential_state
         FROM users WHERE email = ? LIMIT 1 FOR UPDATE`,
        [normalizedEmail],
      );
      const user = users[0];

      if (
        user &&
        Boolean(user.is_active) &&
        user.credential_state === "active"
      ) {
        delivery = await accessTokens.prepare(connection, {
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          purpose: TOKEN_PURPOSE,
        });
      }

      await writeAudit(connection, {
        action: "auth.password_recovery_requested",
        request,
        details: { accepted: true, purpose: TOKEN_PURPOSE },
      });
    });

    if (delivery) await accessTokens.deliver(delivery);

    return { accepted: true };
  }

  async function completeCredential({
    token,
    newPassword,
    confirmPassword,
    request,
    purpose,
  }) {
    const parsed = passwordRecoveryCompletionSchema.safeParse({
      token,
      newPassword,
      confirmPassword,
    });
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === "token")) {
        throw invalidRecoveryLink();
      }
      throw invalidPassword(parsed.error.issues[0]?.message);
    }
    if (!tokenPattern.test(parsed.data.token)) throw invalidRecoveryLink();

    const tokenHash = hashToken(parsed.data.token);
    const [tokenRows] = await dbPool.execute(
      `SELECT id, user_id, purpose
       FROM account_access_tokens
       WHERE token_hash = ? AND purpose = ?
         AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > UTC_TIMESTAMP(3)
       LIMIT 1`,
      [tokenHash, purpose],
    );
    const tokenRecord = tokenRows[0];
    if (!tokenRecord) throw invalidRecoveryLink();

    const newPasswordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    const result = await withTransaction(dbPool, async (connection) => {
      const [users] = await connection.execute(
        `SELECT id, password_hash, is_active, credential_state
         FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
        [tokenRecord.user_id],
      );
      const user = users[0];
      const requiredCredentialState = {
        password_recovery: "active",
        account_invitation: "pending_invitation",
        admin_password_reset: "pending_admin_reset",
      }[purpose];
      if (
        !requiredCredentialState ||
        !user ||
        user.is_active !== 1 ||
        user.credential_state !== requiredCredentialState
      ) {
        throw invalidRecoveryLink();
      }

      if (
        purpose === TOKEN_PURPOSE &&
        (await bcrypt.compare(parsed.data.newPassword, user.password_hash))
      ) {
        throw invalidPassword(
          "La nueva contraseña debe ser diferente de la actual.",
        );
      }

      const [consumed] = await connection.execute(
        `UPDATE account_access_tokens
         SET consumed_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND user_id = ? AND token_hash = ? AND purpose = ?
           AND consumed_at IS NULL AND revoked_at IS NULL
           AND expires_at > UTC_TIMESTAMP(3)`,
        [tokenRecord.id, tokenRecord.user_id, tokenHash, purpose],
      );
      if (consumed.affectedRows !== 1) throw invalidRecoveryLink();

      await connection.execute(
        `UPDATE users
         SET password_hash = ?, password_change_required = 0,
             credential_state = 'active'
         WHERE id = ? AND is_active = 1 AND credential_state = ?`,
        [newPasswordHash, user.id, requiredCredentialState],
      );
      const [revokedSessions] = await connection.execute(
        `UPDATE user_sessions
         SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND revoked_at IS NULL`,
        [user.id],
      );
      await connection.execute(
        `UPDATE account_access_tokens
         SET revoked_at = UTC_TIMESTAMP(3)
         WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
        [user.id],
      );
      await writeAudit(connection, {
        userId: user.id,
        action: {
          password_recovery: "auth.password_recovery_completed",
          account_invitation: "auth.invitation_accepted",
          admin_password_reset: "auth.admin_password_reset_completed",
        }[purpose],
        request,
        details: {
          purpose,
          revokedSessions: revokedSessions.affectedRows,
        },
      });

      return {
        changed: true,
        revokedSessions: revokedSessions.affectedRows,
      };
    });

    return result;
  }

  return {
    requestRecovery,
    completeRecovery: (input) =>
      completeCredential({ ...input, purpose: TOKEN_PURPOSE }),
    completeInvitation: (input) =>
      completeCredential({ ...input, purpose: "account_invitation" }),
    completeAdminPasswordReset: (input) =>
      completeCredential({ ...input, purpose: "admin_password_reset" }),
  };
}
