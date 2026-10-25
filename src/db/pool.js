import mysql from "mysql2/promise";
import { getDatabaseConfig } from "./config.js";

export function createDatabasePool(target, role = "APP") {
  const pool = mysql.createPool({
    ...getDatabaseConfig(target, process.env, role),
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });

  pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });

  return pool;
}
