function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function createAccountAccessMessage({
  displayName,
  action,
  buttonLabel,
  accessUrl,
  expiresIn,
  subject,
  reassurance,
}) {
  const name = displayName?.trim() || "usuario";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(accessUrl);

  return {
    subject,
    text: [
      `Hola ${name},`,
      "",
      action,
      `${buttonLabel}: ${accessUrl}`,
      "",
      `El enlace vence en ${expiresIn} y solo puede utilizarse una vez.`,
      reassurance,
      "",
      "Comercializadora S.A.S. · SIGECOM",
    ].join("\n"),
    html: `<!doctype html>
<html lang="es">
  <body style="margin:0;background:#f6f8fc;color:#172033;font-family:Arial,sans-serif">
    <main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:.08em">SIGECOM · COMERCIALIZADORA S.A.S.</p>
      <h1 style="margin:0 0 18px;color:#1f3a8a;font-size:24px">${buttonLabel}</h1>
      <p>Hola ${safeName}:</p>
      <p>${action}</p>
      <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#1f3a8a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">${buttonLabel}</a></p>
      <p>El enlace vence en ${expiresIn} y solo puede utilizarse una vez.</p>
      <p style="color:#64748b;font-size:13px">${reassurance}</p>
    </main>
  </body>
</html>`,
  };
}

export function createInvitationMessage({ displayName, invitationUrl }) {
  return createAccountAccessMessage({
    displayName,
    action:
      "Se creó una cuenta SIGECOM para ti. Define una contraseña segura para activar tu acceso.",
    buttonLabel: "Activar cuenta",
    accessUrl: invitationUrl,
    expiresIn: "24 horas",
    subject: "Invitación de acceso · SIGECOM",
    reassurance:
      "Si no esperabas esta invitación, contacta al Administrador de tu empresa.",
  });
}

export function createAdminPasswordResetMessage({ displayName, resetUrl }) {
  return createAccountAccessMessage({
    displayName,
    action:
      "Un Administrador solicitó restablecer el acceso a tu cuenta SIGECOM.",
    buttonLabel: "Establecer nueva contraseña",
    accessUrl: resetUrl,
    expiresIn: "30 minutos",
    subject: "Restablecimiento de contraseña · SIGECOM",
    reassurance:
      "Si no esperabas este cambio, contacta al Administrador de tu empresa. Las sesiones anteriores se cerraron.",
  });
}
