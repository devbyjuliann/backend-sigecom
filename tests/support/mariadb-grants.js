export function normalizeMariaDbGrantScope(grant) {
  if (typeof grant !== "string") {
    throw new TypeError("El grant de MariaDB debe ser texto.");
  }
  return grant.replace(/\\([_%])/g, "$1");
}
