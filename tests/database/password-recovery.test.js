import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import bcrypt from "bcrypt";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createPasswordRecoveryService } from "../../src/modules/auth/password-recovery-service.js";

const now = new Date("2026-11-18T12:00:00.000Z");
const nextPassword = "Nueva-Clave-Segura-2026";
const oldPasswordHash = bcrypt.hashSync("Old-Password-2025", 4);

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createHarness({
  user = {
    id: "41",
    email: "ana@sigecom.co",
    display_name: "Ana Gómez",
    password_hash: oldPasswordHash,
    is_active: 1,
    credential_state: "active",
    password_change_required: 0,
  },
  sendError = null,
} = {}) {
  const state = {
    user: structuredClone(user),
    sessions: [
      { id: "501", user_id: user?.id, revoked_at: null },
      { id: "502", user_id: user?.id, revoked_at: null },
    ],
    tokens: [],
    audits: [],
    mail: [],
    mailOptions: [],
    statements: [],
  };

  function execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    state.statements.push({ sql: normalized, params });

    if (normalized.includes("FROM users") && normalized.includes("email = ?")) {
      return [
        [
          state.user?.email === params[0] ? { ...state.user } : undefined,
        ].filter(Boolean),
      ];
    }

    if (
      normalized.includes("FROM users") &&
      normalized.includes("id = ?") &&
      normalized.includes("FOR UPDATE")
    ) {
      return [
        [
          state.user?.id === String(params[0]) ? { ...state.user } : undefined,
        ].filter(Boolean),
      ];
    }

    if (normalized.startsWith("SELECT id, user_id, purpose")) {
      const [hash, purpose] = params;
      const token = state.tokens.find(
        (item) =>
          item.token_hash === hash &&
          item.purpose === purpose &&
          !item.consumed_at &&
          !item.revoked_at &&
          item.expires_at > now,
      );
      return [[token ? { ...token } : undefined].filter(Boolean)];
    }

    if (normalized.startsWith("SELECT user_id FROM account_access_tokens")) {
      const [hash] = params;
      const token = state.tokens.find((item) => item.token_hash === hash);
      return [[token ? { user_id: token.user_id } : undefined].filter(Boolean)];
    }

    if (normalized.startsWith("INSERT INTO account_access_tokens")) {
      const [userId, hash, purpose] = params;
      state.tokens.push({
        id: String(state.tokens.length + 1),
        user_id: String(userId),
        token_hash: hash,
        purpose,
        expires_at: new Date(now.getTime() + 30 * 60 * 1000),
        consumed_at: null,
        revoked_at: null,
      });
      return [{ insertId: state.tokens.length, affectedRows: 1 }];
    }

    if (normalized.startsWith("UPDATE account_access_tokens")) {
      if (normalized.includes("SET consumed_at")) {
        const [tokenId, userId, hash, purpose] = params;
        const token = state.tokens.find(
          (item) =>
            item.id === String(tokenId) &&
            item.user_id === String(userId) &&
            item.token_hash === hash &&
            item.purpose === purpose &&
            !item.consumed_at &&
            !item.revoked_at &&
            item.expires_at > now,
        );
        if (!token) return [{ affectedRows: 0 }];
        token.consumed_at = now;
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET revoked_at")) {
        const tokenSpecific = normalized.includes("WHERE token_hash = ?");
        const [first, second, exceptHash] = params;
        let affectedRows = 0;
        for (const token of state.tokens) {
          if (
            (tokenSpecific
              ? token.token_hash === first && token.purpose === second
              : token.user_id === String(first) &&
                (second === undefined || token.purpose === second) &&
                token.token_hash !== exceptHash) &&
            !token.consumed_at &&
            !token.revoked_at
          ) {
            token.revoked_at = now;
            affectedRows += 1;
          }
        }
        return [{ affectedRows }];
      }
    }

    if (normalized.startsWith("UPDATE users SET password_hash")) {
      const [passwordHash, userId] = params;
      if (state.user?.id === String(userId)) {
        state.user.password_hash = passwordHash;
        state.user.password_change_required = 0;
        state.user.credential_state = "active";
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }

    if (normalized.startsWith("UPDATE user_sessions")) {
      const [userId] = params;
      let affectedRows = 0;
      for (const session of state.sessions) {
        if (session.user_id === String(userId) && !session.revoked_at) {
          session.revoked_at = now;
          affectedRows += 1;
        }
      }
      return [{ affectedRows }];
    }

    if (normalized.startsWith("INSERT INTO audit_events")) {
      state.audits.push({ sql: normalized, params });
      return [{ insertId: state.audits.length, affectedRows: 1 }];
    }

    throw new Error(`SQL mock did not recognize: ${normalized}`);
  }

  const dbPool = {
    execute,
    async getConnection() {
      return {
        beginTransaction: async () => {},
        execute,
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      };
    },
  };
  const mailTransport = {
    async send(message, options) {
      state.mail.push(message);
      state.mailOptions.push(options);
      if (sendError) throw sendError;
      return { accepted: true };
    },
  };
  const logger = {
    warn(fields, message) {
      state.statements.push({ log: { ...fields }, message });
    },
    error(fields, message) {
      state.statements.push({ log: { ...fields }, message });
    },
  };

  return {
    state,
    dbPool,
    service: createPasswordRecoveryService({
      dbPool,
      mailTransport,
      logger,
      publicAppOrigin: "https://sigecom.example",
      now: () => new Date(now),
    }),
  };
}

function tokenFromHarness(state) {
  const message = state.mail[0];
  assert.ok(
    message,
    "expected the controlled mail transport to capture a message",
  );
  const match = /#token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match, "expected the recovery token in the in-memory test message");
  return match[1];
}

test("recovery requests are generic and persist only a token hash", async () => {
  const existing = createHarness();
  const missing = createHarness({ user: null });

  const [existingResult, missingResult] = await Promise.all([
    existing.service.requestRecovery({
      email: "ana@sigecom.co",
      request: { ip: "127.0.0.1" },
    }),
    missing.service.requestRecovery({
      email: "ana@sigecom.co",
      request: { ip: "127.0.0.1" },
    }),
  ]);

  assert.deepEqual(existingResult, missingResult);
  assert.equal(existing.state.mail.length, 1);
  assert.equal(missing.state.mail.length, 0);
  const token = tokenFromHarness(existing.state);
  assert.equal(existing.state.tokens.length, 1);
  assert.equal(existing.state.tokens[0].token_hash, tokenHash(token));
  assert.equal(existing.state.tokens[0].token_hash.includes(token), false);
  assert.equal(
    existing.state.sessions.every((session) => !session.revoked_at),
    true,
  );
  assert.equal(existing.state.user.password_hash, oldPasswordHash);
  assert.equal(existing.state.audits.length, 1);
  assert.doesNotMatch(JSON.stringify(existing.state.audits), new RegExp(token));
});

test("recovery delivery uses a stable idempotency key derived from the token hash", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);

  assert.equal(
    harness.state.mailOptions[0].idempotencyKey,
    `password-recovery/${tokenHash(token)}`,
  );
  assert.doesNotMatch(
    harness.state.mailOptions[0].idempotencyKey,
    new RegExp(token),
  );
});

test("recovery does not send links to inactive or invitation-pending accounts", async () => {
  for (const user of [
    { is_active: 0, credential_state: "active" },
    { is_active: 1, credential_state: "pending_invitation" },
  ]) {
    const harness = createHarness({
      user: {
        id: "41",
        email: "ana@sigecom.co",
        display_name: "Ana Gómez",
        password_hash: oldPasswordHash,
        password_change_required: 0,
        ...user,
      },
    });

    await harness.service.requestRecovery({ email: "ana@sigecom.co" });

    assert.equal(harness.state.mail.length, 0);
    assert.equal(harness.state.tokens.length, 0);
    assert.equal(harness.state.user.password_hash, oldPasswordHash);
    assert.equal(
      harness.state.sessions.every((session) => !session.revoked_at),
      true,
    );
  }
});

test("a token issued before deactivation cannot change credentials or activate the account", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);
  harness.state.user.is_active = 0;

  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    }),
    { code: "PASSWORD_RECOVERY_LINK_INVALID" },
  );

  assert.equal(harness.state.user.is_active, 0);
  assert.equal(harness.state.user.password_hash, oldPasswordHash);
  assert.equal(
    harness.state.sessions.every((session) => !session.revoked_at),
    true,
  );
});

test("mail transport failures do not reveal account existence or leave a usable token", async () => {
  const harness = createHarness({
    sendError: new Error("secret provider response"),
  });

  const result = await harness.service.requestRecovery({
    email: "ana@sigecom.co",
    request: { ip: "127.0.0.1" },
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(harness.state.tokens[0].revoked_at instanceof Date, true);
  assert.equal(harness.state.user.password_hash, oldPasswordHash);
  assert.equal(
    harness.state.sessions.every((session) => !session.revoked_at),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(harness.state.statements),
    /secret provider response/,
  );
  assert.doesNotMatch(JSON.stringify(harness.state.statements), /#token=/);
});

test("a valid token changes the password, revokes sessions and invalidates other tokens", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);
  harness.state.tokens.push({
    id: "99",
    user_id: "41",
    token_hash: tokenHash("older-token"),
    purpose: "password_recovery",
    expires_at: new Date(now.getTime() + 60_000),
    consumed_at: null,
    revoked_at: null,
  });
  const response = await harness.service.completeRecovery({
    token,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
    request: { ip: "127.0.0.1" },
  });

  assert.deepEqual(response, { changed: true, revokedSessions: 2 });
  assert.equal(
    await bcrypt.compare(nextPassword, harness.state.user.password_hash),
    true,
  );
  assert.equal(harness.state.user.password_change_required, 0);
  assert.equal(
    harness.state.sessions.every((session) => session.revoked_at),
    true,
  );
  assert.equal(
    harness.state.tokens.every((item) => item.consumed_at || item.revoked_at),
    true,
  );
  assert.equal(harness.state.audits.length, 2);
  assert.doesNotMatch(
    JSON.stringify(harness.state.audits),
    /ana@sigecom\.co|Nueva-Clave-Segura-2026/,
  );
});

test("an invitation token activates the account and establishes its first password", async () => {
  const harness = createHarness({
    user: {
      id: "41",
      email: "ana@sigecom.co",
      display_name: "Ana Gómez",
      password_hash: oldPasswordHash,
      is_active: 1,
      credential_state: "pending_invitation",
      password_change_required: 1,
    },
  });
  const token = "I".repeat(43);
  harness.state.tokens.push({
    id: "1",
    user_id: "41",
    token_hash: tokenHash(token),
    purpose: "account_invitation",
    expires_at: new Date(now.getTime() + 60_000),
    consumed_at: null,
    revoked_at: null,
  });

  const result = await harness.service.completeInvitation({
    token,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
  });

  assert.deepEqual(result, { changed: true, revokedSessions: 2 });
  assert.equal(harness.state.user.credential_state, "active");
  assert.equal(harness.state.user.password_change_required, 0);
  assert.equal(
    await bcrypt.compare(nextPassword, harness.state.user.password_hash),
    true,
  );
  assert.ok(harness.state.tokens[0].consumed_at);
  assert.ok(harness.state.sessions.every((session) => session.revoked_at));
  assert.equal(
    harness.state.audits.at(-1).params[1],
    "auth.invitation_accepted",
  );
});

test("an administrative reset token unlocks the account only after a new password is set", async () => {
  const harness = createHarness({
    user: {
      id: "41",
      email: "ana@sigecom.co",
      display_name: "Ana Gómez",
      password_hash: oldPasswordHash,
      is_active: 1,
      credential_state: "pending_admin_reset",
      password_change_required: 1,
    },
  });
  const token = "R".repeat(43);
  harness.state.tokens.push({
    id: "1",
    user_id: "41",
    token_hash: tokenHash(token),
    purpose: "admin_password_reset",
    expires_at: new Date(now.getTime() + 60_000),
    consumed_at: null,
    revoked_at: null,
  });

  const result = await harness.service.completeAdminPasswordReset({
    token,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
  });

  assert.deepEqual(result, { changed: true, revokedSessions: 2 });
  assert.equal(harness.state.user.credential_state, "active");
  assert.equal(harness.state.user.password_change_required, 0);
  assert.equal(
    await bcrypt.compare(nextPassword, harness.state.user.password_hash),
    true,
  );
  assert.equal(
    harness.state.audits.at(-1).params[1],
    "auth.admin_password_reset_completed",
  );
});

test("invalid, expired, wrong-purpose and reused tokens are rejected uniformly", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);
  const recovery = harness.state.tokens[0];
  const cases = ["invalid-token", "missing-token"];

  for (const candidate of cases) {
    await assert.rejects(
      harness.service.completeRecovery({
        token: candidate,
        newPassword: nextPassword,
        confirmPassword: nextPassword,
      }),
      { code: "PASSWORD_RECOVERY_LINK_INVALID" },
    );
  }

  recovery.expires_at = new Date(now.getTime() - 1);
  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    }),
    { code: "PASSWORD_RECOVERY_LINK_INVALID" },
  );

  recovery.expires_at = new Date(now.getTime() + 60_000);
  recovery.purpose = "account_invitation";
  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    }),
    { code: "PASSWORD_RECOVERY_LINK_INVALID" },
  );

  recovery.purpose = "password_recovery";
  await harness.service.completeRecovery({
    token,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
  });
  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    }),
    { code: "PASSWORD_RECOVERY_LINK_INVALID" },
  );
});

test("concurrent submissions consume the same recovery token exactly once", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);
  const attempts = await Promise.allSettled([
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    }),
    harness.service.completeRecovery({
      token,
      newPassword: "Otra-Clave-Segura-2026",
      confirmPassword: "Otra-Clave-Segura-2026",
    }),
  ]);

  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  assert.equal(
    harness.state.audits.filter(
      (event) => event.params[1] === "auth.password_recovery_completed",
    ).length,
    1,
  );
});

test("recovery enforces the existing password length, byte limit and composition rules", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);

  for (const password of [
    "Short-A1",
    "lowercase-password-2026",
    "UPPERCASE-PASSWORD-2026",
    "No-Digits-Password",
    `Aa1${"é".repeat(40)}`,
  ]) {
    await assert.rejects(
      harness.service.completeRecovery({
        token,
        newPassword: password,
        confirmPassword: password,
      }),
      { code: "INVALID_PASSWORD_CHANGE" },
    );
  }

  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: nextPassword,
      confirmPassword: `${nextPassword}!`,
    }),
    { code: "INVALID_PASSWORD_CHANGE" },
  );
  await assert.rejects(
    harness.service.completeRecovery({
      token,
      newPassword: "Old-Password-2025",
      confirmPassword: "Old-Password-2025",
    }),
    { code: "INVALID_PASSWORD_CHANGE" },
  );
  assert.equal(harness.state.user.password_hash, oldPasswordHash);
});

test("the public recovery request response does not disclose account existence", async () => {
  const existing = createHarness();
  const app = createApp({
    dbPool: existing.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "s".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const submit = (email) =>
    request(app)
      .post("/api/v1/auth/password-recovery")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({ email });
  const existingResponse = await submit("ana@sigecom.co").expect(202);
  const missingResponse = await submit("no-existe@sigecom.co").expect(202);

  assert.deepEqual(existingResponse.body, missingResponse.body);
  assert.equal(existingResponse.headers["cache-control"], "no-store");
  assert.doesNotMatch(
    JSON.stringify(existingResponse.body),
    /ana@sigecom\.co|no-existe/,
  );
});

test("the completion API consumes a token without returning it and clears both browser cookies", async () => {
  const harness = createHarness();
  await harness.service.requestRecovery({ email: "ana@sigecom.co" });
  const token = tokenFromHarness(harness.state);
  const app = createApp({
    dbPool: harness.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "c".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const payload = {
    token,
    newPassword: nextPassword,
    confirmPassword: nextPassword,
  };
  const response = await request(app)
    .post("/api/v1/auth/password-recovery/complete")
    .set("Origin", "http://127.0.0.1:5173")
    .set("Cookie", cookie)
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .send(payload)
    .expect(200);

  assert.deepEqual(response.body, { changed: true });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(token));
  assert.ok(
    response.headers["set-cookie"].some((value) =>
      value.startsWith("sigecom_session=;"),
    ),
  );
  assert.ok(
    response.headers["set-cookie"].some((value) =>
      value.startsWith("sigecom_csrf=;"),
    ),
  );
});

test("invitation and administrative reset links use purpose-specific completion routes", async () => {
  for (const flow of [
    {
      endpoint: "/api/v1/auth/invitations/complete",
      purpose: "account_invitation",
      credentialState: "pending_invitation",
      token: "I".repeat(43),
    },
    {
      endpoint: "/api/v1/auth/admin-password-reset/complete",
      purpose: "admin_password_reset",
      credentialState: "pending_admin_reset",
      token: "A".repeat(43),
    },
  ]) {
    const harness = createHarness({
      user: {
        id: "41",
        email: "ana@sigecom.co",
        display_name: "Ana Gómez",
        password_hash: oldPasswordHash,
        is_active: 1,
        credential_state: flow.credentialState,
        password_change_required: 1,
      },
    });
    harness.state.tokens.push({
      id: "1",
      user_id: "41",
      token_hash: tokenHash(flow.token),
      purpose: flow.purpose,
      expires_at: new Date(now.getTime() + 60_000),
      consumed_at: null,
      revoked_at: null,
    });
    const app = createApp({
      dbPool: harness.dbPool,
      authConfig: getAuthConfig({
        JWT_SECRET: "c".repeat(64),
        FRONTEND_ORIGIN: "http://127.0.0.1:5173",
      }),
      mailTransport: {
        send: async () => ({ accepted: true, simulated: true }),
      },
      logger: { warn: () => {}, error: () => {}, info: () => {} },
    });
    const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
    const cookie = csrf.headers["set-cookie"]
      .find((value) => value.startsWith("sigecom_csrf="))
      .split(";", 1)[0];
    const response = await request(app)
      .post(flow.endpoint)
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({
        token: flow.token,
        newPassword: nextPassword,
        confirmPassword: nextPassword,
      })
      .expect(200);

    assert.deepEqual(response.body, { changed: true });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(harness.state.user.credential_state, "active");
    assert.equal(harness.state.tokens[0].consumed_at instanceof Date, true);
    assert.ok(
      response.headers["set-cookie"].some((value) =>
        value.startsWith("sigecom_session=;"),
      ),
    );
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(flow.token));
  }
});

test("password recovery completion rejects missing CSRF before querying recovery state", async () => {
  const harness = createHarness();
  const app = createApp({
    dbPool: harness.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "c".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
      PUBLIC_APP_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });

  const response = await request(app)
    .post("/api/v1/auth/password-recovery/complete")
    .set("Origin", "http://127.0.0.1:5173")
    .send({
      token: "R".repeat(43),
      newPassword: nextPassword,
      confirmPassword: nextPassword,
    })
    .expect(403);

  assert.equal(response.body.error.code, "CSRF_VALIDATION_FAILED");
  assert.deepEqual(harness.state.statements, []);
  assert.deepEqual(harness.state.tokens, []);
  assert.deepEqual(harness.state.audits, []);
});

test("malformed credential requests are not cached before JSON parsing", async () => {
  const harness = createHarness();
  const app = createApp({
    dbPool: harness.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "n".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const response = await request(app)
    .post("/api/v1/auth/invitations/complete")
    .set("Origin", "http://127.0.0.1:5173")
    .set("Cookie", cookie)
    .set("X-CSRF-Token", csrf.body.csrfToken)
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);

  assert.equal(response.headers["cache-control"], "no-store");
});

test("recovery requests are rate limited by address and normalized account", async () => {
  const harness = createHarness();
  const app = createApp({
    dbPool: harness.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "r".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const submit = () =>
    request(app)
      .post("/api/v1/auth/password-recovery")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({ email: " ANA@SIGECOM.CO " });

  await submit().expect(202);
  await submit().expect(202);
  await submit().expect(202);
  const limited = await submit().expect(429);
  assert.equal(limited.body.error.code, "PASSWORD_RECOVERY_RATE_LIMITED");
  assert.doesNotMatch(JSON.stringify(limited.body), /SIGECOM|ana@/i);
});

test("completion attempts are rate limited before token verification and password hashing", async () => {
  const harness = createHarness();
  const app = createApp({
    dbPool: harness.dbPool,
    authConfig: getAuthConfig({
      JWT_SECRET: "l".repeat(64),
      FRONTEND_ORIGIN: "http://127.0.0.1:5173",
    }),
    mailTransport: { send: async () => ({ accepted: true, simulated: true }) },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const csrf = await request(app).get("/api/v1/auth/csrf").expect(200);
  const cookie = csrf.headers["set-cookie"]
    .find((value) => value.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  const submit = () =>
    request(app)
      .post("/api/v1/auth/password-recovery/complete")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf.body.csrfToken)
      .send({
        token: "Q".repeat(43),
        newPassword: nextPassword,
        confirmPassword: nextPassword,
      });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await submit().expect(400);
  }
  const limited = await submit().expect(429);
  assert.equal(limited.body.error.code, "PASSWORD_RECOVERY_RATE_LIMITED");
});
