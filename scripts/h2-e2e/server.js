import { createServer } from "node:http";
import mysql from "mysql2/promise";
import { createApp } from "../../src/app.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createLogger } from "../../src/shared/logger.js";
import { getH2E2EConfig, verifyH2E2EConnection } from "./preflight.js";

const LOCK_NAME = "sigecom_h2_concurrency_h2_e2e";

export async function startH2E2EApi(env = process.env) {
  const config = getH2E2EConfig(env);
  const lockConnection = await mysql.createConnection({
    host: config.sqlHost,
    port: config.sqlPort,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: 5000,
    timezone: "Z",
  });
  let pool;
  let locked = false;
  try {
    await verifyH2E2EConnection(lockConnection, config, {
      checkCollisions: false,
    });
    const [[lock]] = await lockConnection.execute(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [LOCK_NAME],
    );
    locked = Number(lock.acquired) === 1;
    if (!locked)
      throw new Error("H2 E2E no puede adquirir el candado de esquema.");

    pool = mysql.createPool({
      host: config.sqlHost,
      port: config.sqlPort,
      database: config.database,
      user: config.user,
      password: config.password,
      charset: "utf8mb4",
      timezone: "Z",
      connectTimeout: 5000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
    pool.on("connection", (connection) => {
      connection.query(
        `SET SESSION sql_mode = CONCAT_WS(',', @@session.sql_mode,
          'STRICT_TRANS_TABLES', 'ERROR_FOR_DIVISION_BY_ZERO')`,
        (error) => {
          if (error) connection.destroy();
        },
      );
      connection.query("SET time_zone = '+00:00'", (error) => {
        if (error) connection.destroy();
      });
    });
    await pool.query("SELECT 1");

    const authConfig = getAuthConfig({
      NODE_ENV: "test",
      JWT_SECRET: config.jwtSecret,
      JWT_ISSUER: `sigecom-h2-e2e-${config.runId}`,
      JWT_AUDIENCE: `sigecom-h2-e2e-api-${config.runId}`,
      JWT_TTL_SECONDS: "900",
      COOKIE_SECURE: "false",
      FRONTEND_ORIGIN: config.frontendOrigin,
      AUTH_RATE_LIMIT_MAX: "20",
      AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "20",
    });
    const app = createApp({
      dbPool: pool,
      authConfig,
      logger: createLogger({ level: "silent" }),
    });
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        { host: "127.0.0.1", port: config.apiPort, exclusive: true },
        resolve,
      );
    });
    return {
      server,
      pool,
      async close() {
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
        await lockConnection.execute("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
        await lockConnection.end();
      },
    };
  } catch (error) {
    await pool?.end();
    if (locked)
      await lockConnection.execute("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    await lockConnection.end();
    throw error;
  }
}
