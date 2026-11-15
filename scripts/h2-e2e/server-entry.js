import { startH2E2EApi } from "./server.js";

let active;
try {
  active = await startH2E2EApi();
  console.log("H2 E2E API listening on the authorized loopback port.");
} catch (error) {
  console.error(`H2 E2E API refused startup (${error.code || "PREFLIGHT"}).`);
  process.exitCode = 1;
}

async function shutdown() {
  if (active) await active.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
