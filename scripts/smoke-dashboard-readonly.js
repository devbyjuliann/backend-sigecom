import mysql from "mysql2/promise";
import { createDashboardService } from "../src/modules/dashboard/dashboard-service.js";
import { redactSqlGrantSecrets } from "./redact-sql-grants.js";

const database = process.env.SIGECOM_H2_DATABASE;
const user = process.env.SIGECOM_H2_USER;
const password = process.env.SIGECOM_H2_PASSWORD;

if (
  database !== "sigecom_h2_concurrency" ||
  user !== "sigecom_h2_runner" ||
  !password
) {
  throw new Error(
    "La validación Dashboard requiere únicamente el destino H2 aislado autorizado.",
  );
}

const connection = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3306,
  database,
  user,
  password,
  charset: "utf8mb4",
  timezone: "Z",
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectTimeout: 5000,
});

const readOnlyPool = {
  async execute(sql, values = []) {
    const statement = sql.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
    if (!/^SELECT\b/i.test(statement)) {
      throw new Error("Dashboard smoke solo permite sentencias SELECT.");
    }
    return connection.execute(sql, values);
  },
};

try {
  const [[server]] = await readOnlyPool.execute(
    "SELECT DATABASE() AS database_name, VERSION() AS version",
  );
  if (server.database_name !== "sigecom_h2_concurrency") {
    throw new Error("La conexión no quedó en el esquema aislado esperado.");
  }
  const grantRows = await connection.query("SHOW GRANTS FOR CURRENT_USER");
  const grants = grantRows[0].map((row) =>
    redactSqlGrantSecrets(String(Object.values(row)[0])),
  );
  console.log(`H2 runner grants: ${grants.join(" | ")}`);
  const service = createDashboardService({ dbPool: readOnlyPool });
  const summary = await service.getSummary({
    userId: "0",
    permissions: new Set([
      "sales.read",
      "purchases.read",
      "inventory.read",
      "warehouses.read",
    ]),
  });
  const commercial = summary.commercial;
  for (const key of [
    "salesNet",
    "purchasesReceived",
    "stockedProducts",
    "lowStockProducts",
    "pendingReceipts",
    "salesTrend",
    "topProducts",
    "inventoryByWarehouse",
    "recentActivity",
  ]) {
    if (commercial[key]?.available !== true) {
      throw new Error(`La consulta Dashboard ${key} no quedó disponible.`);
    }
  }
  console.log(
    `Dashboard read-only MariaDB validation passed (${server.version}).`,
  );
} finally {
  await connection.end();
}
