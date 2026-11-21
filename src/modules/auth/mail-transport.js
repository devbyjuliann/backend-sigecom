export class MailDeliveryError extends Error {
  constructor() {
    super("No fue posible entregar el mensaje.");
    this.name = "MailDeliveryError";
  }
}

const resendEndpoint = "https://api.resend.com/emails";
const retryableStatuses = new Set([408, 429]);
const emailPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function validateVerifiedDomain(value) {
  if (typeof value !== "string") {
    throw new Error("RESEND_VERIFIED_DOMAIN debe ser el dominio verificado.");
  }
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error("RESEND_VERIFIED_DOMAIN no es un dominio válido.");
  }
  return domain;
}

function validateSender(from, verifiedDomain) {
  if (typeof from !== "string" || !from.trim() || /[\r\n]/.test(from)) {
    throw new Error("RESEND_FROM debe ser un remitente válido.");
  }

  const value = from.trim();
  const angleAddress = /<([^<>]+)>$/.exec(value);
  const address = angleAddress ? angleAddress[1].trim() : value;
  if (
    (angleAddress && /[<>]/.test(value.slice(0, angleAddress.index))) ||
    (!angleAddress && /[<>]/.test(value)) ||
    !emailPattern.test(address)
  ) {
    throw new Error(
      "RESEND_FROM debe contener una dirección de correo válida.",
    );
  }

  const senderDomain = address
    .slice(address.lastIndexOf("@") + 1)
    .toLowerCase();
  if (senderDomain !== verifiedDomain) {
    throw new Error(
      "El dominio de RESEND_FROM debe coincidir con RESEND_VERIFIED_DOMAIN.",
    );
  }

  return value;
}

function validateApiKey(apiKey) {
  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!normalizedApiKey || !/^re_[A-Za-z0-9_-]+$/.test(normalizedApiKey)) {
    throw new Error("RESEND_API_KEY debe ser una clave de Resend válida.");
  }
  return normalizedApiKey;
}

function validateIdempotencyKey(idempotencyKey) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 256 ||
    /[\r\n]/.test(idempotencyKey)
  ) {
    throw new TypeError("El envío requiere una clave de idempotencia válida.");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createSimulatedMailTransport({ capture } = {}) {
  return {
    type: "simulated",
    async send(message) {
      if (capture) await capture(message);
      return { accepted: true, simulated: true };
    },
  };
}

export function createResendMailTransport({
  apiKey,
  from,
  verifiedDomain,
  fetchImplementation = globalThis.fetch,
  timeoutMs = 10_000,
  maxAttempts = 3,
  retryDelayMs = 200,
  sleep = delay,
}) {
  apiKey = validateApiKey(apiKey);
  const normalizedDomain = validateVerifiedDomain(verifiedDomain);
  from = validateSender(from, normalizedDomain);
  if (typeof fetchImplementation !== "function") {
    throw new Error(
      "El transporte de Resend requiere una implementación fetch.",
    );
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 3 ||
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 2_000 ||
    typeof sleep !== "function"
  ) {
    throw new Error("La política de reintento de Resend no es válida.");
  }

  return {
    type: "resend",
    async send(message, { idempotencyKey } = {}) {
      validateIdempotencyKey(idempotencyKey);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response;
        try {
          response = await fetchImplementation(resendEndpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
              html: message.html,
            }),
          });
        } catch {
          if (attempt === maxAttempts) throw new MailDeliveryError();
          await sleep(retryDelayMs * 2 ** (attempt - 1));
          continue;
        }

        if (response.ok) return { accepted: true, simulated: false };
        if (!retryableStatuses.has(response.status) && response.status < 500) {
          throw new MailDeliveryError();
        }
        if (attempt === maxAttempts) throw new MailDeliveryError();
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }

      throw new MailDeliveryError();
    },
  };
}

export function createConfiguredMailTransport(env = process.env, options = {}) {
  const production = env.NODE_ENV === "production";
  const mode = env.MAIL_TRANSPORT || (production ? "" : "simulated");
  if (!production) {
    if (mode === "simulated") return createSimulatedMailTransport();
    if (mode === "resend") {
      throw new Error(
        "Resend real solo puede habilitarse en el entorno de producción.",
      );
    }
    throw new Error("MAIL_TRANSPORT debe ser simulated fuera de producción.");
  }
  if (mode !== "resend") {
    throw new Error("MAIL_TRANSPORT=resend es obligatorio en producción.");
  }

  return createResendMailTransport({
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM,
    verifiedDomain: env.RESEND_VERIFIED_DOMAIN,
    ...options,
  });
}
