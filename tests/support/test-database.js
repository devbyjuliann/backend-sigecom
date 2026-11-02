import mysql from "mysql2/promise";
import { getDatabaseConfig } from "../../src/db/config.js";

export async function connectTestDatabase(role = "MIGRATOR") {
  const connection = await mysql.createConnection(
    getDatabaseConfig("test", process.env, role),
  );
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [[identity]] = await connection.query(
      "SELECT DATABASE() AS name, @@session.time_zone AS timeZone",
    );
    if (identity.name !== "sigecom_test" || identity.timeZone !== "+00:00") {
      throw new Error("Conexión auxiliar no anclada a sigecom_test en UTC.");
    }
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
}

export async function connectAdminTestDatabase() {
  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3306,
    user: process.env.XAMPP_ADMIN_USER || "root",
    password: process.env.XAMPP_ADMIN_PASSWORD || "",
    database: "sigecom_test",
    timezone: "Z",
  });
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [[identity]] = await connection.query(
      "SELECT DATABASE() AS name, @@session.time_zone AS timeZone",
    );
    if (identity.name !== "sigecom_test" || identity.timeZone !== "+00:00") {
      throw new Error(
        "Conexión administrativa no anclada a sigecom_test en UTC.",
      );
    }
    return connection;
  } catch (error) {
    await connection.end();
    throw error;
  }
}
