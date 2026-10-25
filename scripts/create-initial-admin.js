import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createDatabasePool } from "../src/db/pool.js";
import {
  hashTemporaryPassword,
  normalizeAdminEmail,
  validateTemporaryPassword,
} from "../src/modules/users/admin-credentials.js";

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
  prompt.close();

  const temporaryPassword = await askHidden(
    "Contraseña temporal aleatoria (mínimo 24 caracteres, máximo 72 bytes; entrada oculta): ",
  );
  const confirmation = await askHidden(
    "Confirma la contraseña temporal (entrada oculta): ",
  );
  validateTemporaryPassword(temporaryPassword, confirmation);
  const passwordHash = await hashTemporaryPassword(temporaryPassword);

  pool = createDatabasePool("development");
  const connection = await pool.getConnection();
  const lockName = "sigecom:initial-admin:sigecom_dev";
  let lockAcquired = false;

  try {
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName],
    );
    if (lock.acquired !== 1)
      throw new Error("No se pudo reservar el alta inicial del administrador.");
    lockAcquired = true;
    await connection.beginTransaction();

    const [existingAdmin] = await connection.execute(
      `SELECT u.id FROM users AS u JOIN roles AS r ON r.id = u.role_id
       WHERE r.code = 'administrator' LIMIT 1 FOR UPDATE`,
    );
    if (existingAdmin.length)
      throw new Error(
        "Ya existe una cuenta administradora; no se modificó ninguna cuenta.",
      );

    const [existingEmail] = await connection.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    if (existingEmail.length)
      throw new Error(
        "El correo indicado ya está registrado; no se modificó ninguna cuenta.",
      );

    const [roleRows] = await connection.execute(
      "SELECT id FROM roles WHERE code = 'administrator'",
    );
    if (!roleRows.length)
      throw new Error(
        "Aplique las migraciones y semillas antes de crear el administrador.",
      );

    const [userResult] = await connection.execute(
      `INSERT INTO users (role_id, email, password_hash, is_active, password_change_required)
       VALUES (?, ?, ?, 1, 1)`,
      [roleRows[0].id, email, passwordHash],
    );
    await connection.execute(
      `INSERT INTO audit_events (user_id, action, module, entity_type, entity_id, details)
       VALUES (?, 'initial_admin.created', 'users', 'users', ?, ?)`,
      [
        userResult.insertId,
        String(userResult.insertId),
        JSON.stringify({
          role: "administrator",
          password_change_required: true,
        }),
      ],
    );

    await connection.commit();
    console.log(
      `Administrador ${email} creado. La contraseña temporal no se mostró ni se guardó en texto plano; el cambio será obligatorio en el primer acceso.`,
    );
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    if (lockAcquired)
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    connection.release();
  }
} catch (error) {
  prompt.close();
  console.error(`No se creó el administrador: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
