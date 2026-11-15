export function redactSqlGrantSecrets(grant) {
  return String(grant).replace(
    /(\bIDENTIFIED\s+BY\s+PASSWORD\s+)'[^']*'/gi,
    "$1'[REDACTED]'",
  );
}
