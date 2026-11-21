import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createAccountAccessTokenService } from "../../src/modules/auth/account-access-token-service.js";

const now = new Date("2026-11-19T12:00:00.000Z");

function createHarness({
  sendError = null,
  sendResult = { accepted: true, simulated: true },
} = {}) {
  const state = { tokens: [], statements: [], mail: [], options: [] };
  const connection = {
    async execute(sql, params) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      state.statements.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE account_access_tokens")) {
        const tokenHash = normalized.includes("WHERE token_hash = ?");
        const [userOrHash, purpose] = params;
        for (const token of state.tokens) {
          if (
            (tokenHash
              ? token.token_hash === userOrHash
              : token.user_id === String(userOrHash)) &&
            token.purpose === purpose &&
            !token.consumed_at &&
            !token.revoked_at
          ) {
            token.revoked_at = now;
          }
        }
        return [{ affectedRows: 1 }];
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
        return [{ insertId: state.tokens.length, affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {},
  };
  const dbPool = {
    async getConnection() {
      return {
        ...connection,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
      };
    },
  };
  const mailTransport = {
    async send(message, options) {
      state.mail.push(message);
      state.options.push(options);
      if (sendError) throw sendError;
      return sendResult;
    },
  };
  const logger = {
    warn(fields) {
      state.statements.push({ log: fields });
    },
  };
  const service = createAccountAccessTokenService({
    dbPool,
    mailTransport,
    logger,
    publicAppOrigin: "https://sigecom.example",
    now: () => new Date(now),
  });
  return { state, service, connection };
}

test("prepares invitation emails with hashed one-time tokens and identifies simulated delivery", async () => {
  const { state, service, connection } = createHarness();
  const delivery = await service.prepare(connection, {
    userId: "41",
    email: "ana@sigecom.co",
    displayName: "Ana Gómez",
    purpose: "account_invitation",
  });

  assert.equal(state.tokens.length, 1);
  assert.equal(state.tokens[0].purpose, "account_invitation");
  assert.match(state.tokens[0].token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(state.tokens[0].token_hash, delivery.token);
  assert.equal(await service.deliver(delivery), "simulated");
  assert.equal(state.mail.length, 1);
  assert.match(
    state.mail[0].text,
    /https:\/\/sigecom\.example\/aceptar-invitacion#token=/,
  );
  assert.equal(
    state.options[0].idempotencyKey,
    `account-invitation/${state.tokens[0].token_hash}`,
  );
  assert.doesNotMatch(
    JSON.stringify(state.statements),
    new RegExp(delivery.token),
  );
});

test("reports accepted only when the configured mail provider accepted delivery", async () => {
  const { service, connection } = createHarness({
    sendResult: { accepted: true, simulated: false },
  });
  const delivery = await service.prepare(connection, {
    userId: "41",
    email: "ana@sigecom.co",
    displayName: "Ana Gómez",
    purpose: "account_invitation",
  });

  assert.equal(await service.deliver(delivery), "accepted");
});

test("failed delivery revokes its token and does not expose provider details", async () => {
  const { state, service, connection } = createHarness({
    sendError: new Error("private provider response"),
  });
  const delivery = await service.prepare(connection, {
    userId: "41",
    email: "ana@sigecom.co",
    displayName: "Ana Gómez",
    purpose: "admin_password_reset",
  });

  assert.equal(await service.deliver(delivery), "failed");
  assert.ok(state.tokens[0].revoked_at instanceof Date);
  assert.doesNotMatch(
    JSON.stringify(state.statements),
    /private provider response|#token=/,
  );
});

test("preparation revokes prior active tokens only for the same purpose", async () => {
  const { state, service, connection } = createHarness();
  state.tokens.push(
    {
      user_id: "41",
      token_hash: createHash("sha256").update("old-invitation").digest("hex"),
      purpose: "account_invitation",
      consumed_at: null,
      revoked_at: null,
    },
    {
      user_id: "41",
      token_hash: createHash("sha256").update("recovery").digest("hex"),
      purpose: "password_recovery",
      consumed_at: null,
      revoked_at: null,
    },
  );

  await service.prepare(connection, {
    userId: "41",
    email: "ana@sigecom.co",
    displayName: "Ana Gómez",
    purpose: "account_invitation",
  });

  assert.ok(state.tokens[0].revoked_at instanceof Date);
  assert.equal(state.tokens[1].revoked_at, null);
});
