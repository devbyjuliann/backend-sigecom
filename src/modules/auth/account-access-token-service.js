import { createHash, randomBytes } from "node:crypto";
import {
  createAdminPasswordResetMessage,
  createInvitationMessage,
} from "./account-access-email.js";
import { createPasswordRecoveryMessage } from "./password-recovery-email.js";

const purposeDetails = {
  password_recovery: {
    path: "/restablecer-contrasena",
    ttlMinutes: 30,
    createMessage: createPasswordRecoveryMessage,
    urlProperty: "recoveryUrl",
  },
  account_invitation: {
    path: "/aceptar-invitacion",
    ttlMinutes: 24 * 60,
    createMessage: createInvitationMessage,
    urlProperty: "invitationUrl",
  },
  admin_password_reset: {
    path: "/restablecer-contrasena?modo=administrativo",
    ttlMinutes: 30,
    createMessage: createAdminPasswordResetMessage,
    urlProperty: "resetUrl",
  },
};

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createAccountAccessTokenService({
  dbPool,
  mailTransport,
  logger,
  publicAppOrigin,
}) {
  if (!dbPool || !mailTransport || typeof mailTransport.send !== "function") {
    throw new TypeError(
      "El servicio de acceso requiere base de datos y transporte de correo.",
    );
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicAppOrigin);
  } catch {
    parsedOrigin = null;
  }
  if (
    !parsedOrigin ||
    !["http:", "https:"].includes(parsedOrigin.protocol) ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    throw new TypeError("PUBLIC_APP_ORIGIN no es un origen válido.");
  }
  const origin = parsedOrigin.origin;

  async function prepare(connection, { userId, email, displayName, purpose }) {
    const details = purposeDetails[purpose];
    if (!details) throw new TypeError("El propósito del enlace no es válido.");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);

    await connection.execute(
      `UPDATE account_access_tokens
       SET revoked_at = UTC_TIMESTAMP(3)
       WHERE user_id = ? AND purpose = ?
         AND consumed_at IS NULL AND revoked_at IS NULL`,
      [userId, purpose],
    );
    await connection.execute(
      `INSERT INTO account_access_tokens
         (user_id, token_hash, purpose, expires_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${details.ttlMinutes} MINUTE))`,
      [userId, tokenHash, purpose],
    );

    return {
      token,
      tokenHash,
      purpose,
      email,
      displayName,
      path: details.path,
    };
  }

  async function revokeFailedDelivery({ tokenHash, purpose }) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE account_access_tokens
         SET revoked_at = UTC_TIMESTAMP(3)
         WHERE token_hash = ? AND purpose = ?
           AND consumed_at IS NULL AND revoked_at IS NULL`,
        [tokenHash, purpose],
      );
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the delivery error; cleanup is best-effort and logged below.
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function deliver(delivery) {
    const details = purposeDetails[delivery.purpose];
    if (!details) throw new TypeError("El propósito del enlace no es válido.");
    const accessUrl = `${origin}${delivery.path}#token=${delivery.token}`;
    const message = details.createMessage({
      displayName: delivery.displayName,
      [details.urlProperty]: accessUrl,
    });
    try {
      const result = await mailTransport.send(
        { to: delivery.email, ...message },
        {
          idempotencyKey: `${delivery.purpose.replaceAll("_", "-")}/${delivery.tokenHash}`,
        },
      );
      if (result?.accepted !== true) throw new Error("delivery rejected");
      return result.simulated === true ? "simulated" : "accepted";
    } catch {
      try {
        await revokeFailedDelivery(delivery);
      } catch {
        logger?.warn(
          { event: "auth.account_access_delivery_cleanup_failed" },
          "account access delivery cleanup failed",
        );
      }
      logger?.warn(
        {
          event: "auth.account_access_delivery_failed",
          purpose: delivery.purpose,
        },
        "account access message delivery failed",
      );
      return "failed";
    }
  }

  return { prepare, deliver };
}
