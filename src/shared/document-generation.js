export async function generateDocumentBestEffort({
  generate,
  logger,
  entityType,
  entityId,
}) {
  try {
    await generate();
  } catch (error) {
    try {
      logger?.warn?.(
        { err: error, entityType, entityId },
        "No fue posible generar el PDF después de confirmar la operación.",
      );
    } catch {
      // Logging is best-effort too; it must not affect the committed operation.
    }
  }
}
