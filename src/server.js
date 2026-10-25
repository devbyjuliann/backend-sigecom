import { createServer } from "node:http";
import { createApp } from "./app.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT debe ser un número entre 1 y 65535.");
}

const server = createServer(createApp());

server.listen(port, host, () => {
  console.log(`API SIGECOM escuchando en http://${host}:${port}`);
});

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(`Error al cerrar el servidor (${signal}):`, error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
