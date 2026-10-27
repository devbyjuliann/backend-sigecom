import mysql from "mysql2/promise";
import { getDatabaseConfig } from "./config.js";

export function createDatabasePool(target, role = "APP") {
  const pool = mysql.createPool({
    ...getDatabaseConfig(target, process.env, role),
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

  return pool;
}
