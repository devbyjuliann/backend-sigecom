import pino from "pino";

const redactPaths = [
  "req.headers.cookie",
  "req.headers.authorization",
  "res.headers.set-cookie",
  "cookie",
  "set-cookie",
  "authorization",
  "password",
  "password_hash",
  "passwordHash",
  "temporaryPassword",
  "token",
  "jwt",
  "csrfToken",
  "csrf_token",
  "tokenHash",
  "token_hash",
  "recoveryToken",
  "recoveryUrl",
  "recoveryLink",
  "resetUrl",
  "*.password",
  "*.password_hash",
  "*.passwordHash",
  "*.temporaryPassword",
  "*.token",
  "*.jwt",
  "*.cookie",
  "*.tokenHash",
  "*.token_hash",
  "*.recoveryToken",
  "*.recoveryUrl",
  "*.recoveryLink",
  "*.resetUrl",
];

export function createLogger({
  level = process.env.LOG_LEVEL || "info",
  destination,
} = {}) {
  const options = {
    level,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

export function requestLogger(logger) {
  return (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.on("finish", () => {
      logger.info(
        {
          requestId: request.requestId,
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        },
        "http request",
      );
    });
    next();
  };
}
