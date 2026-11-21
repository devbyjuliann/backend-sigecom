import assert from "node:assert/strict";
import { test } from "node:test";
import bcrypt from "bcrypt";
import { createUserService } from "../../src/modules/users/user-service.js";

const actor = { user: { id: "5" }, sessionId: "501" };
const adminPermissions = [
  "users.read",
  "users.manage",
  "roles.manage",
  "permissions.manage",
  "warehouses.read",
];
const oldTargetPassword = bcrypt.hashSync("Old-Target-Password-2026", 4);

function createHarness({ sendError = null } = {}) {
  const state = {
    users: [
      {
        id: "5",
        role_id: 1,
        email: "admin@sigecom.co",
        display_name: "Administradora",
        password_hash: bcrypt.hashSync("Admin-Password-2026!", 4),
        is_active: 1,
        password_change_required: 0,
        credential_state: "active",
        updated_at: "2026-11-19 10:00:00.000000",
      },
      {
        id: "6",
        role_id: 2,
        email: "ana@sigecom.co",
        display_name: "Ana Gómez",
        password_hash: oldTargetPassword,
        is_active: 1,
        password_change_required: 0,
        credential_state: "active",
        updated_at: "2026-11-19 10:00:00.000000",
      },
    ],
    roles: [
      { id: 1, code: "administrator", name: "Administrador" },
      { id: 2, code: "seller", name: "Vendedor" },
    ],
    warehouses: [
      { id: "3", code: "CENTRAL", name: "Bodega Central", is_active: 1 },
    ],
    assignments: [
      {
        user_id: "5",
        warehouse_id: "3",
        assigned_by: null,
        created_at: "2026-11-19 10:00:00.000000",
      },
      {
        user_id: "6",
        warehouse_id: "3",
        assigned_by: "5",
        created_at: "2026-11-19 10:00:00.000000",
      },
    ],
    sessions: [
      { id: "501", user_id: "5", revoked_at: null },
      { id: "601", user_id: "6", revoked_at: null },
    ],
    tokens: [],
    audits: [],
    mail: [],
    mailOptions: [],
    nextId: 7,
  };

  function execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (
      normalized.startsWith("SELECT id FROM roles WHERE code = 'administrator'")
    ) {
      return [[{ id: 1 }]];
    }
    if (normalized.startsWith("SELECT u.id, u.role_id, u.is_active")) {
      const user = state.users.find((item) => item.id === String(params[0]));
      if (!user) return [[]];
      const role = state.roles.find((item) => item.id === user.role_id);
      return [
        [
          {
            id: user.id,
            role_id: user.role_id,
            is_active: user.is_active,
            password_change_required: user.password_change_required,
            role_code: role.code,
          },
        ],
      ];
    }
    if (normalized.startsWith("SELECT id FROM user_sessions")) {
      const session = state.sessions.find(
        (item) =>
          item.id === String(params[0]) &&
          item.user_id === String(params[1]) &&
          !item.revoked_at,
      );
      return [[session ? { id: session.id } : undefined].filter(Boolean)];
    }
    if (
      normalized.startsWith("SELECT warehouse_id FROM user_warehouses") ||
      normalized.startsWith("SELECT uw.warehouse_id FROM user_warehouses") ||
      normalized.startsWith("SELECT uw.warehouse_id, uw.assigned_by")
    ) {
      return [
        state.assignments
          .filter((item) => item.user_id === String(params[0]))
          .map((item) => ({
            warehouse_id: item.warehouse_id,
            assigned_by: item.assigned_by,
            created_at: item.created_at,
          })),
      ];
    }
    if (normalized.startsWith("SELECT p.code FROM role_permissions")) {
      return [
        adminPermissions
          .filter((code) => params.slice(1).includes(code))
          .map((code) => ({ code })),
      ];
    }
    if (normalized.startsWith("SELECT id FROM users WHERE role_id = ?")) {
      return [
        state.users
          .filter(
            (user) =>
              user.role_id === params[0] &&
              user.is_active === 1 &&
              user.password_change_required === 0,
          )
          .map((user) => ({ id: user.id })),
      ];
    }
    if (normalized.startsWith("SELECT id, code FROM roles WHERE code = ?")) {
      const role = state.roles.find((item) => item.code === params[0]);
      return [
        [role ? { id: role.id, code: role.code } : undefined].filter(Boolean),
      ];
    }
    if (normalized.startsWith("SELECT id, is_active FROM warehouses")) {
      return [
        state.warehouses
          .filter((warehouse) => params.includes(warehouse.id))
          .map(({ id, is_active }) => ({ id, is_active })),
      ];
    }
    if (normalized.startsWith("SELECT id FROM users WHERE id = ? FOR UPDATE")) {
      const user = state.users.find((item) => item.id === String(params[0]));
      return [[user ? { id: user.id } : undefined].filter(Boolean)];
    }
    if (
      normalized.includes("FROM user_warehouses uw") &&
      normalized.includes("actor_access")
    ) {
      const [actorId, targetId] = params;
      return [
        state.assignments
          .filter(
            (item) =>
              item.user_id === String(targetId) &&
              state.assignments.some(
                (own) =>
                  own.user_id === String(actorId) &&
                  own.warehouse_id === item.warehouse_id,
              ),
          )
          .map((item) => {
            const warehouse = state.warehouses.find(
              (entry) => entry.id === item.warehouse_id,
            );
            return {
              id: warehouse.id,
              code: warehouse.code,
              name: warehouse.name,
              is_active: warehouse.is_active,
              assigned_by: item.assigned_by,
              assigned_at: item.created_at,
            };
          }),
      ];
    }
    if (
      normalized.startsWith("SELECT u.id, u.role_id, u.email") &&
      normalized.includes("FROM users u JOIN roles r")
    ) {
      const user = state.users.find((item) => item.id === String(params[0]));
      if (!user) return [[]];
      const role = state.roles.find((item) => item.id === user.role_id);
      return [
        [
          {
            id: user.id,
            role_id: user.role_id,
            email: user.email,
            display_name: user.display_name,
            is_active: user.is_active,
            password_change_required: user.password_change_required,
            credential_state: user.credential_state,
            password_hash: user.password_hash,
            updated_at: user.updated_at,
            role_code: role.code,
            role_name: role.name,
          },
        ],
      ];
    }
    if (normalized.startsWith("INSERT INTO users")) {
      const [roleId, email, displayName, passwordHash, createdBy] = params;
      const id = String(state.nextId++);
      state.users.push({
        id,
        role_id: roleId,
        email,
        display_name: displayName,
        password_hash: passwordHash,
        is_active: 1,
        password_change_required: 1,
        credential_state: "pending_invitation",
        created_by: createdBy,
        updated_at: "2026-11-19 10:01:00.000000",
      });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO user_warehouses")) {
      const [userId, warehouseId, assignedBy] = params;
      state.assignments.push({
        user_id: String(userId),
        warehouse_id: String(warehouseId),
        assigned_by: assignedBy,
        created_at: "2026-11-19 10:01:00.000000",
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE account_access_tokens")) {
      const byHash = normalized.includes("WHERE token_hash = ?");
      const [userOrHash, purpose] = params;
      let affectedRows = 0;
      for (const token of state.tokens) {
        if (
          (byHash
            ? token.token_hash === userOrHash
            : token.user_id === String(userOrHash)) &&
          (!purpose || token.purpose === purpose) &&
          !token.consumed_at &&
          !token.revoked_at
        ) {
          token.revoked_at = new Date();
          affectedRows += 1;
        }
      }
      return [{ affectedRows }];
    }
    if (normalized.startsWith("INSERT INTO account_access_tokens")) {
      const [userId, tokenHash, purpose] = params;
      state.tokens.push({
        id: String(state.tokens.length + 1),
        user_id: String(userId),
        token_hash: tokenHash,
        purpose,
        consumed_at: null,
        revoked_at: null,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO audit_events")) {
      state.audits.push({ sql: normalized, params });
      return [{ insertId: state.audits.length, affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE user_sessions")) {
      const [userId] = params;
      let affectedRows = 0;
      for (const session of state.sessions) {
        if (session.user_id === String(userId) && !session.revoked_at) {
          session.revoked_at = new Date();
          affectedRows += 1;
        }
      }
      return [{ affectedRows }];
    }
    if (normalized.startsWith("UPDATE users")) {
      const restoreReset = normalized.includes(
        "WHERE id = ? AND password_hash = ?",
      );
      const userId = String(restoreReset ? params[3] : params.at(-1));
      const user = state.users.find((item) => item.id === userId);
      if (!user) return [{ affectedRows: 0 }];
      if (
        normalized.includes(
          "SET password_hash = ?, password_change_required = 1",
        )
      ) {
        user.password_hash = params[0];
        user.password_change_required = 1;
        user.credential_state = "pending_admin_reset";
        return [{ affectedRows: 1 }];
      }
      if (normalized.includes("credential_state = 'pending_admin_reset'")) {
        if (user.password_hash !== params[4]) return [{ affectedRows: 0 }];
        user.password_hash = params[0];
        user.password_change_required = params[1];
        user.credential_state = params[2];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unrecognized user update: ${normalized}`);
    }
    throw new Error(`Unrecognized SQL: ${normalized}`);
  }

  const dbPool = {
    async getConnection() {
      return {
        execute,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
  const mailTransport = {
    async send(message, options) {
      state.mail.push(message);
      state.mailOptions.push(options);
      if (sendError) throw sendError;
      return { accepted: true, simulated: true };
    },
  };
  const service = createUserService({
    dbPool,
    authConfig: { publicAppOrigin: "https://sigecom.example" },
    mailTransport,
    logger: { warn: () => {} },
  });
  return { state, service };
}

test("creating an account sends an invitation and never returns a password or raw token", async () => {
  const { state, service } = createHarness();
  const result = await service.create({
    input: {
      email: "lucia@sigecom.co",
      displayName: "Lucía Pérez",
      roleCode: "seller",
      warehouseIds: ["3"],
    },
    actor,
  });

  assert.equal(result.user.credentialState, "pending_invitation");
  assert.equal(result.invitation.deliveryStatus, "simulated");
  assert.equal("temporaryPassword" in result, false);
  assert.equal(state.mail.length, 1);
  assert.match(state.mail[0].text, /\/aceptar-invitacion#token=/);
  assert.equal(state.tokens[0].purpose, "account_invitation");
  assert.equal(state.tokens[0].token_hash.length, 64);
  assert.equal(
    await bcrypt.compare(
      state.mail[0].text.match(/token=([A-Za-z0-9_-]+)/)[1],
      state.users.find((user) => user.email === "lucia@sigecom.co")
        .password_hash,
    ),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /token|password_hash|temporaryPassword/i,
  );
});

test("resending an invitation requires the current revision and invalidates its prior token", async () => {
  const { state, service } = createHarness();
  const created = await service.create({
    input: {
      email: "lucia@sigecom.co",
      displayName: "Lucía Pérez",
      roleCode: "seller",
      warehouseIds: ["3"],
    },
    actor,
  });
  const firstToken = state.tokens[0].token_hash;

  const result = await service.resendInvitation({
    id: created.user.id,
    input: { expectedRevision: created.user.revision },
    actor,
  });

  assert.equal(result.invitation.deliveryStatus, "simulated");
  assert.equal(state.tokens[0].token_hash, firstToken);
  assert.ok(state.tokens[0].revoked_at);
  assert.equal(state.tokens[1].purpose, "account_invitation");
  assert.equal(state.mail.length, 2);
});

test("failed administrative reset delivery restores the prior credential and keeps sessions revoked", async () => {
  const { state, service } = createHarness({
    sendError: new Error("private provider response"),
  });
  const target = await service.getById("6", actor.user.id);

  const result = await service.resetPassword({
    id: "6",
    input: { expectedRevision: target.revision },
    actor,
  });

  assert.equal(result.deliveryStatus, "failed");
  assert.equal(result.credentialRestored, true);
  assert.equal(result.user.credentialState, "active");
  assert.equal(result.user.passwordChangeRequired, false);
  assert.equal(
    state.users.find((user) => user.id === "6").password_hash,
    oldTargetPassword,
  );
  assert.ok(state.sessions.find((session) => session.id === "601").revoked_at);
  assert.ok(state.tokens[0].revoked_at);
  assert.doesNotMatch(
    JSON.stringify(result),
    /temporaryPassword|token|password_hash/i,
  );
  assert.doesNotMatch(
    JSON.stringify(state.audits),
    /private provider response|#token=/,
  );
});
