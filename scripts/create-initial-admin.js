import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabasePool } from "../src/db/pool.js";
import {
  hashTemporaryPassword,
  normalizeAdminEmail,
  validateTemporaryPassword,
} from "../src/modules/users/admin-credentials.js";
import { createInitialAdmin } from "../src/modules/users/initial-admin-bootstrap.js";

function askHidden(label) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(
      "El alta requiere una terminal interactiva; no se aceptan contraseñas por argumentos ni variables de entorno.",
    );
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Alta cancelada."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function parseEmailArgument() {
  const emailIndex = process.argv.indexOf("--email");
  return emailIndex === -1 ? undefined : process.argv[emailIndex + 1];
}

const prompt = createInterface({ input: stdin, output: stdout });
let pool;

try {
  const emailInput =
    parseEmailArgument() ||
    (await prompt.question("Correo del administrador: "));
  const email = normalizeAdminEmail(emailInput);
  const displayName = (
    await prompt.question("Nombre visible del administrador: ")
  ).trim();
  if (!displayName || displayName.length > 120) {
    throw new Error("El nombre debe tener entre 1 y 120 caracteres.");
  }
  prompt.close();

  const temporaryPassword = await askHidden(
    "Contraseña inicial aleatoria (mínimo 24 caracteres, máximo 72 bytes; entrada oculta): ",
  );
  const confirmation = await askHidden(
    "Confirma la contraseña inicial (entrada oculta): ",
  );
  validateTemporaryPassword(temporaryPassword, confirmation);
  const passwordHash = await hashTemporaryPassword(temporaryPassword);

  pool = createDatabasePool("development");
  const created = await createInitialAdmin({
    dbPool: pool,
    email,
    displayName,
    passwordHash,
  });
  console.log(
    `Administrador ${created.email} creado con acceso a ${created.warehouseIds.length} bodega(s) activa(s). La contraseña inicial no se mostró ni se guardó en texto plano; el cambio será obligatorio en el primer acceso.`,
  );
} catch (error) {
  prompt.close();
  console.error(`No se creó el administrador: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
