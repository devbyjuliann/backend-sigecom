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

export function createPasswordRecoveryMessage({
  displayName,
  recoveryUrl,
  expiresInMinutes = 30,
}) {
  const name = displayName?.trim() || "usuario";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(recoveryUrl);

  return {
    subject: "Recuperación de contraseña · SIGECOM",
    text: [
      `Hola ${name},`,
      "",
      "Recibimos una solicitud para cambiar la contraseña de tu cuenta SIGECOM.",
      `Usa este enlace para establecer una nueva contraseña: ${recoveryUrl}`,
      "",
      `El enlace vence en ${expiresInMinutes} minutos y solo puede utilizarse una vez.`,
      "Si no solicitaste este cambio, puedes ignorar este mensaje. Tu contraseña y tus sesiones no cambian por recibirlo.",
      "",
      "Comercializadora S.A.S. · SIGECOM",
    ].join("\n"),
    html: `<!doctype html>
<html lang="es">
  <body style="margin:0;background:#f6f8fc;color:#172033;font-family:Arial,sans-serif">
    <main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:.08em">SIGECOM · COMERCIALIZADORA S.A.S.</p>
      <h1 style="margin:0 0 18px;color:#1f3a8a;font-size:24px">Recupera tu acceso</h1>
      <p>Hola ${safeName}:</p>
      <p>Recibimos una solicitud para cambiar la contraseña de tu cuenta SIGECOM.</p>
      <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#1f3a8a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Establecer nueva contraseña</a></p>
      <p>El enlace vence en ${expiresInMinutes} minutos y solo puede utilizarse una vez.</p>
      <p style="color:#64748b;font-size:13px">Si no solicitaste este cambio, ignora este mensaje. Tu contraseña y tus sesiones no cambian por recibirlo.</p>
    </main>
  </body>
</html>`,
  };
}
