import { createServer } from "node:http";
import { createApp } from "./app.js";
import { createDatabasePool } from "./db/pool.js";
import { getAuthConfig } from "./modules/auth/auth-config.js";
import { createLogger } from "./shared/logger.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const logger = createLogger();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT debe ser un número entre 1 y 65535.");
}

const authConfig = getAuthConfig(process.env);
const dbPool = createDatabasePool("development");
let server;

try {
  await dbPool.query("SELECT 1");
  server = createServer(createApp({ dbPool, authConfig, logger }));
  server.listen(port, host, () => {
    logger.info({ host, port }, "SIGECOM API listening");
  });
} catch (error) {
  logger.error(
    { code: error.code || "STARTUP_ERROR" },
    "SIGECOM API failed to start",
  );
  await dbPool.end();
  process.exitCode = 1;
}

async function shutdown() {
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  await dbPool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
