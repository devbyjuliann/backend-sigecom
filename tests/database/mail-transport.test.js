import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResendMailTransport,
  createSimulatedMailTransport,
  MailDeliveryError,
} from "../../src/modules/auth/mail-transport.js";
import * as mailTransportModule from "../../src/modules/auth/mail-transport.js";
import { createPasswordRecoveryMessage } from "../../src/modules/auth/password-recovery-email.js";

test("the simulated transport exposes messages only to an injected in-memory test sink", async () => {
  const messages = [];
  const transport = createSimulatedMailTransport({
    capture: async (message) => messages.push(message),
  });
  const message = {
    to: "ana@sigecom.invalid",
    subject: "Recuperación",
    text: "Enlace de prueba",
    html: "<p>Prueba</p>",
  };

  await assert.deepEqual(await transport.send(message), {
    accepted: true,
    simulated: true,
  });
  assert.deepEqual(messages, [message]);
});

test("the Resend adapter can be verified with a stub and hides provider error bodies", async () => {
  const calls = [];
  const transport = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "SIGECOM pruebas <noreply@mail.example.com>",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200 };
    },
  });

  await transport.send(
    {
      to: "ana@sigecom.invalid",
      subject: "Recuperación",
      text: "Mensaje plano",
      html: "<p>Mensaje</p>",
    },
    { idempotencyKey: "password-recovery/0123456789abcdef" },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.resend.com/emails");
  assert.equal(calls[0][1].method, "POST");
  assert.match(calls[0][1].headers.Authorization, /^Bearer re_test_/);
  assert.equal(
    calls[0][1].headers["Idempotency-Key"],
    "password-recovery/0123456789abcdef",
  );
  assert.deepEqual(JSON.parse(calls[0][1].body).to, ["ana@sigecom.invalid"]);

  const failed = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "noreply@mail.example.com",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async () => ({
      ok: false,
      status: 500,
      text: async () => "provider-secret-detail",
    }),
    sleep: async () => {},
  });
  await assert.rejects(
    failed.send(
      { to: "x@example.invalid" },
      { idempotencyKey: "password-recovery/provider-error" },
    ),
    (error) => {
      assert.ok(error instanceof MailDeliveryError);
      assert.doesNotMatch(error.message, /provider-secret-detail/);
      return true;
    },
  );
});

test("Resend trims configuration whitespace before sending credentials", async () => {
  let authorization;
  let sentFrom;
  const transport = createResendMailTransport({
    apiKey: "  re_test_never_a_real_api_key  ",
    from: " SIGECOM <no-reply@mail.example.com> ",
    verifiedDomain: " mail.example.com ",
    fetchImplementation: async (_url, options) => {
      authorization = options.headers.Authorization;
      sentFrom = JSON.parse(options.body).from;
      return { ok: true, status: 200 };
    },
  });

  await transport.send(
    { to: "ana@sigecom.invalid", subject: "Recuperación" },
    { idempotencyKey: "password-recovery/trimmed-config" },
  );

  assert.equal(authorization, "Bearer re_test_never_a_real_api_key");
  assert.equal(sentFrom, "SIGECOM <no-reply@mail.example.com>");
});

test("Resend retries transient outcomes with one stable idempotency key", async () => {
  const calls = [];
  const delays = [];
  const responses = [
    { ok: false, status: 503 },
    { ok: false, status: 429 },
    { ok: true, status: 200 },
  ];
  const transport = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "SIGECOM <no-reply@mail.example.com>",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleep: async (delay) => delays.push(delay),
  });

  const result = await transport.send(
    {
      to: "ana@sigecom.invalid",
      subject: "Recuperación",
      text: "Mensaje plano",
      html: "<p>Mensaje</p>",
    },
    { idempotencyKey: "password-recovery/abcdef0123456789" },
  );

  assert.deepEqual(result, { accepted: true, simulated: false });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ options }) => options.headers["Idempotency-Key"]),
    Array(3).fill("password-recovery/abcdef0123456789"),
  );
  assert.deepEqual(delays, [200, 400]);
  assert.ok(
    calls.every(({ options }) => options.signal instanceof AbortSignal),
  );
});

test("Resend retries network failures with the same idempotency key", async () => {
  const calls = [];
  const delays = [];
  let attempt = 0;
  const transport = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "no-reply@mail.example.com",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async (_url, options) => {
      calls.push(options.headers["Idempotency-Key"]);
      attempt += 1;
      if (attempt === 1) throw new TypeError("connection reset");
      return { ok: true, status: 200 };
    },
    sleep: async (delay) => delays.push(delay),
  });

  await transport.send(
    { to: "ana@sigecom.invalid", subject: "Recuperación" },
    { idempotencyKey: "password-recovery/network-retry" },
  );

  assert.deepEqual(calls, [
    "password-recovery/network-retry",
    "password-recovery/network-retry",
  ]);
  assert.deepEqual(delays, [200]);
});

test("permanent Resend errors are not retried or exposed", async () => {
  let attempts = 0;
  const transport = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "no-reply@mail.example.com",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 400,
        text: async () => "secret provider detail",
      };
    },
    sleep: async () => {},
  });

  await assert.rejects(
    transport.send(
      { to: "ana@sigecom.invalid", subject: "Recuperación" },
      { idempotencyKey: "password-recovery/permanent-error" },
    ),
    (error) => {
      assert.ok(error instanceof MailDeliveryError);
      assert.doesNotMatch(error.message, /secret provider detail/);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("Resend refuses sends without a bounded idempotency key", async () => {
  let attempts = 0;
  const transport = createResendMailTransport({
    apiKey: "re_test_never_a_real_api_key",
    from: "no-reply@mail.example.com",
    verifiedDomain: "mail.example.com",
    fetchImplementation: async () => {
      attempts += 1;
      return { ok: true, status: 200 };
    },
  });

  await assert.rejects(
    transport.send({ to: "ana@sigecom.invalid", subject: "Recuperación" }),
    /idempotencia/i,
  );
  assert.equal(attempts, 0);
});

test("Resend accepts a sender only on the configured verified domain", () => {
  assert.throws(
    () =>
      createResendMailTransport({
        apiKey: "re_test_never_a_real_api_key",
        from: "SIGECOM <no-reply@attacker.example>",
        verifiedDomain: "mail.example.com",
      }),
    /RESEND_VERIFIED_DOMAIN/,
  );
});

test("configured transport keeps non-production on the simulated provider", async () => {
  assert.equal(
    typeof mailTransportModule.createConfiguredMailTransport,
    "function",
  );
  let fetchCalls = 0;
  const transport = mailTransportModule.createConfiguredMailTransport(
    {
      NODE_ENV: "test",
      MAIL_TRANSPORT: "simulated",
      RESEND_API_KEY: "re_test_never_a_real_api_key",
      RESEND_FROM: "SIGECOM <no-reply@mail.example.com>",
      RESEND_VERIFIED_DOMAIN: "mail.example.com",
    },
    { fetchImplementation: async () => (fetchCalls += 1) },
  );

  assert.equal(transport.type, "simulated");
  await transport.send({ to: "ana@sigecom.invalid", subject: "Recuperación" });
  assert.equal(fetchCalls, 0);
});

test("production Resend setup requires explicit mode and credentials", () => {
  assert.equal(
    typeof mailTransportModule.createConfiguredMailTransport,
    "function",
  );
  assert.throws(
    () =>
      mailTransportModule.createConfiguredMailTransport({
        NODE_ENV: "production",
        MAIL_TRANSPORT: "resend",
      }),
    /RESEND_API_KEY/,
  );
  assert.throws(
    () =>
      mailTransportModule.createConfiguredMailTransport({
        NODE_ENV: "production",
        MAIL_TRANSPORT: "simulated",
        RESEND_API_KEY: "re_test_never_a_real_api_key",
        RESEND_FROM: "SIGECOM <no-reply@mail.example.com>",
        RESEND_VERIFIED_DOMAIN: "mail.example.com",
      }),
    /MAIL_TRANSPORT=resend/,
  );
  const transport = mailTransportModule.createConfiguredMailTransport({
    NODE_ENV: "production",
    MAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "re_test_never_a_real_api_key",
    RESEND_FROM: "SIGECOM <no-reply@mail.example.com>",
    RESEND_VERIFIED_DOMAIN: "mail.example.com",
  });
  assert.equal(transport.type, "resend");
});

test("recovery templates escape account names and keep the reset token in the link only", () => {
  const message = createPasswordRecoveryMessage({
    displayName: "<Ana & equipo>",
    recoveryUrl: "https://sigecom.example/restablecer-contrasena#token=Abc_123",
  });

  assert.match(message.html, /&lt;Ana &amp; equipo&gt;/);
  assert.doesNotMatch(message.html, /<Ana & equipo>/);
  assert.match(message.html, /#token=Abc_123/);
  assert.match(message.text, /#token=Abc_123/);
  assert.match(message.text, /30 minutos/);
});
