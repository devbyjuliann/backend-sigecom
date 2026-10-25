import bcrypt from "bcrypt";

export function normalizeAdminEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("El correo del administrador no tiene un formato válido.");
  }

  return email;
}

export function validateTemporaryPassword(password, confirmation) {
  if (password !== confirmation)
    throw new Error("Las contraseñas temporales no coinciden.");
  if (Buffer.byteLength(password, "utf8") < 24) {
    throw new Error("Use una contraseña aleatoria de al menos 24 caracteres.");
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("La contraseña no puede superar 72 bytes en UTF-8.");
  }

  return true;
}

export function hashTemporaryPassword(password) {
  return bcrypt.hash(password, 12);
}
