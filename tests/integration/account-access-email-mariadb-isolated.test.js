import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir } from "node:fs/promises";
import * as http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import request from "supertest";
import { getMigrations } from "../../src/db/migrations.js";
import { createApp } from "../../src/app.js";
import { getAuthConfig } from "../../src/modules/auth/auth-config.js";
import { createSimulatedMailTransport } from "../../src/modules/auth/mail-transport.js";
import {
  executeAccountAccessMode,
  getAccountAccessE2EConfig,
  resolveAccountAccessFrontendDirectory,
} from "../../scripts/account-access-email-e2e-runner.js";
import {
  claimResourceOwnershipAttempt,
  createResourceOwnershipLedger,
  defaultResourceOwnershipDirectory,
  readResourceOwnershipLedger,
} from "../../scripts/account-access-email-resource-ledger.js";
import {
  assertProvisionerIdentity,
  provisionIsolatedDatabaseResources,
} from "../../scripts/account-access-email-provisioning.js";
import { applyLegacyCompatibleMigrations } from "../support/account-access-migration-plan.js";

const EXPECTED_DATABASE_VERSION = "10.4.32-MariaDB";
const EXPECTED_HOSTNAME = "DESKTOP-8MEFFV0";
const EXPECTED_DATADIR = "C:\\xampp\\mysql\\data\\";
const HOST = "127.0.0.1";
const PORT = 3306;
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const BROWSER_API_PORT = 39101;
const BROWSER_PROXY_PORT = 39102;
const BROWSER_FRONTEND_PORT = 39173;
const BROWSER_ORIGIN = `http://127.0.0.1:${BROWSER_FRONTEND_PORT}`;
const suiteDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(suiteDirectory, "../..");
const frontendDirectory =
  resolveAccountAccessFrontendDirectory(backendDirectory);
const frontendRequire = createRequire(
  path.join(frontendDirectory, "package.json"),
);
const runnerConfig = getAccountAccessE2EConfig(
  process.env.SIGECOM_ACCOUNT_ACCESS_MODE,
);
const { runId, attemptId } = runnerConfig;
// Vite validates the isolated target even in PRE-FLIGHT; this sentinel is never
// used as a database connection target.
const schemaName =
  runnerConfig.schema ?? "sigecom_e2e_tmp_00000000000000_00000000";
const appUser = runId ? `sgapp_${runId}` : null;
const migratorUser = runId ? `sgmig_${runId}` : null;
const provisionerUser = runnerConfig.provisioner?.user ?? null;
const appPassword = runnerConfig.credentials?.appPassword;
const migratorPassword = runnerConfig.credentials?.migratorPassword;
const fixturePassword = runnerConfig.credentials?.fixturePassword;
const provisionerPassword = runnerConfig.provisioner?.password;
const browserArtifactsDirectory = path.join(
  process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || "C:\\Users\\User", "AppData", "Local"),
  "Temp",
  "opencode",
  `sigecom-increment-1d-${runnerConfig.mode.toLowerCase()}-${runId || "unassigned"}-${attemptId || "no-attempt"}`,
);
const PROTECTED_SCHEMAS = [
  "sigecom_dev",
  "sigecom_test",
  "sigecom_h2_concurrency",
];
const migrationVersions = Array.from({ length: 19 }, (_, index) =>
  String(index + 1).padStart(4, "0"),
);
const recoveryPurpose = "password_recovery";

const resources = {
  schema: runnerConfig.schema,
  appUser,
  migratorUser,
  runId,
  attemptId,
  databaseVersion: null,
  appliedMigrations: [],
};

let provisionerConnection = null;
let resourceOwnershipLedger = null;
let resourceOwnershipRecord = null;
let migratorConnection;
let appPool;
let legacyUser;
let migrationLegacyUser;
let warehouseId;
let inactiveUser;
let pendingUser;
let concurrentUser;
let expiryUser;
let mailFailureUser;
let browserUser;
let browserExpiryUser;
let apiProxyServer;
let browserApiServer;
let browserApp;
let viteProcess;
let browser;
let browserContext;
let browserPage;
let releasePreflightAuthMe;
const allLogs = [];
const allRecoveryResponses = [];
const allPublicRequestResponses = [];
const sensitiveValues = new Set();
for (const credential of [
  appPassword,
  migratorPassword,
  fixturePassword,
  provisionerPassword,
]) {
  if (credential) sensitiveValues.add(credential);
}
const browserMailbox = [];
const browserVisualFiles = [];
const browserDiagnostics = {
  startupOrder: [],
  apiHealthStatus: null,
  proxyHealthStatus: null,
  frontendHtmlStatus: null,
  loginStatus: null,
  chromiumLaunchMs: null,
  loginReadyMs: null,
  preflightPageErrors: 0,
  preflightConsoleErrors: 0,
  preflightExpectedAuthProbeConsoleErrors: 0,
  preflightConsoleErrorPaths: [],
  preflightAuthMeStatus: null,
  preflightFailedRequestPaths: [],
  preflightResponseStatuses: [],
  navigationErrorName: null,
  navigationMs: null,
  documentReadyState: null,
  preflightRootText: null,
  preflightFailureScreenshot: null,
  preflightControlVisibility: null,
  preflightErrorName: null,
};

function makePassword() {
  const password = `Aa1-${randomBytes(24).toString("hex")}`;
  sensitiveValues.add(password);
  return password;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function migrationTableSql() {
  return `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version CHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      name VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPortsAvailable() {
  for (const port of [
    BROWSER_API_PORT,
    BROWSER_PROXY_PORT,
    BROWSER_FRONTEND_PORT,
  ]) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function browserPortsAreAvailable() {
  try {
    await assertPortsAvailable();
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE") return false;
    throw error;
  }
}

function listenOnLoopback(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function sanitizedFrontendEnvironment() {
  const allowed = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "OS",
    "PROCESSOR_ARCHITECTURE",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key)),
  );
  env.NODE_ENV = "test";
  env.NO_COLOR = "1";
  env.SIGECOM_API_TARGET = `http://127.0.0.1:${BROWSER_PROXY_PORT}`;
  env.SIGECOM_ACCOUNT_ACCESS_E2E_TARGET = schemaName;
  env.SIGECOM_ACCOUNT_ACCESS_CACHE_DIR = path.join(
    browserArtifactsDirectory,
    "vite-cache",
  );
  return env;
}

function createApiProxy() {
  return http.createServer((incoming, outgoing) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: BROWSER_API_PORT,
        method: incoming.method,
        path: incoming.url,
        headers: {
          ...incoming.headers,
          host: `127.0.0.1:${BROWSER_API_PORT}`,
        },
      },
      (response) => {
        outgoing.once("close", () => {
          if (!response.complete) response.destroy();
        });
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      },
    );

    upstream.once("error", () => {
      if (outgoing.destroyed) return;
      outgoing.writeHead(502, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      outgoing.end("API de prueba no disponible.");
    });
    incoming.pipe(upstream);
  });
}

async function waitForFrontend() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (viteProcess?.exitCode !== null && viteProcess?.exitCode !== undefined) {
      throw new Error("Vite de prueba terminó durante el preflight.");
    }
    try {
      const response = await fetch(`${BROWSER_ORIGIN}/ingresar`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) {
        const html = await response.text();
        if (html.includes('<div id="root">')) {
          browserDiagnostics.frontendHtmlStatus = response.status;
          return;
        }
      }
    } catch {
      // El servidor local aún puede estar iniciando.
    }
    await wait(100);
  }
  throw new Error("La interfaz aislada no inició en el puerto reservado.");
}

async function startBrowserInfrastructure() {
  await mkdir(browserArtifactsDirectory, { recursive: true });
  apiProxyServer = createApiProxy();
  await listenOnLoopback(apiProxyServer, BROWSER_PROXY_PORT);
  browserDiagnostics.startupOrder.push("proxy");

  const vitePath = path.join(
    frontendDirectory,
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  viteProcess = spawn(
    process.execPath,
    [
      vitePath,
      "--host",
      "127.0.0.1",
      "--port",
      String(BROWSER_FRONTEND_PORT),
      "--strictPort",
      "--mode",
      "account-access-email-e2e",
    ],
    {
      cwd: frontendDirectory,
      env: sanitizedFrontendEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    },
  );
  viteProcess.once("error", () => {
    browserDiagnostics.viteSpawnError = true;
  });
  browserDiagnostics.startupOrder.push("vite");
  await waitForFrontend();
}

async function startBrowserPreflightApiServer() {
  process.env.NODE_ENV = "test";
  const authConfig = getAuthConfig({
    NODE_ENV: "test",
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN: BROWSER_ORIGIN,
    PUBLIC_APP_ORIGIN: BROWSER_ORIGIN,
    COOKIE_SECURE: "false",
  });
  const preflightApp = createApp({
    dbPool: new Proxy(
      {},
      {
        get() {
          throw new Error(
            "El preflight sin SQL no puede usar la base de datos.",
          );
        },
      },
    ),
    authConfig,
    mailTransport: createSimulatedMailTransport(),
    logger: createTestLogger(),
  });
  const authMeGate = new Promise((resolve) => {
    releasePreflightAuthMe = resolve;
  });
  browserApiServer = http.createServer((incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/api/v1/auth/me") {
      void authMeGate.then(() => preflightApp(incoming, outgoing));
      return;
    }
    preflightApp(incoming, outgoing);
  });
  await listenOnLoopback(browserApiServer, BROWSER_API_PORT);
  browserDiagnostics.startupOrder.push("express");
}

function safeBrowserPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "invalid-url";
  }
}

function browserPreflightFailure(stage, startedAt, status = null) {
  return new Error(
    `Preflight de navegador falló (etapa=${stage}, error=${browserDiagnostics.preflightErrorName ?? "Error"}, duraciónMs=${Date.now() - startedAt}, status=${status ?? "sin-respuesta"}, viteExit=${viteProcess?.exitCode ?? "activo"}, documentReady=${browserDiagnostics.documentReadyState ?? "sin-estado"}, erroresPagina=${browserDiagnostics.preflightPageErrors}, erroresConsola=${browserDiagnostics.preflightConsoleErrors}, rutasConsola=${browserDiagnostics.preflightConsoleErrorPaths.join(",") || "ninguna"}, rutasFallidas=${browserDiagnostics.preflightFailedRequestPaths.join(",") || "ninguna"}, respuestas=${browserDiagnostics.preflightResponseStatuses.map(({ path, status: responseStatus }) => `${path}:${responseStatus}`).join(",") || "ninguna"}, controles=${JSON.stringify(browserDiagnostics.preflightControlVisibility ?? {})}, textoRaiz=${browserDiagnostics.preflightRootText ?? "sin-texto"}, navegacionError=${browserDiagnostics.navigationErrorName ?? "ninguno"}).`,
  );
}

async function readBrowserControlVisibility(locator) {
  try {
    return await locator.isVisible();
  } catch (error) {
    return `error-${error?.name || "Error"}`;
  }
}

async function preflightBrowserInfrastructure() {
  const startedAt = Date.now();
  let stage = "puertos";
  let loginStatus = null;
  try {
    await assertPortsAvailable();
    stage = "express";
    await startBrowserPreflightApiServer();
    const directHealth = await fetch(
      `http://127.0.0.1:${BROWSER_API_PORT}/api/v1/health`,
      { signal: AbortSignal.timeout(5000) },
    );
    browserDiagnostics.apiHealthStatus = directHealth.status;
    assert.equal(directHealth.status, 200);
    assert.deepEqual(await directHealth.json(), {
      status: "ok",
      service: "sigecom-backend",
    });

    stage = "proxy-y-vite";
    await startBrowserInfrastructure();
    const proxiedHealth = await fetch(`${BROWSER_ORIGIN}/api/v1/health`, {
      signal: AbortSignal.timeout(5000),
    });
    browserDiagnostics.proxyHealthStatus = proxiedHealth.status;
    assert.equal(proxiedHealth.status, 200);
    assert.deepEqual(await proxiedHealth.json(), {
      status: "ok",
      service: "sigecom-backend",
    });

    stage = "chromium";
    const { chromium } = frontendRequire("@playwright/test");
    const chromiumStartedAt = Date.now();
    browser = await chromium.launch({ headless: true });
    browserDiagnostics.chromiumLaunchMs = Date.now() - chromiumStartedAt;
    browserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    browserPage = await browserContext.newPage();
    browserPage.on("pageerror", () => {
      browserDiagnostics.preflightPageErrors += 1;
    });
    browserPage.on("console", (message) => {
      if (message.type() === "error") {
        const pathName = safeBrowserPath(message.location().url);
        if (browserDiagnostics.preflightConsoleErrorPaths.length < 10) {
          browserDiagnostics.preflightConsoleErrorPaths.push(pathName);
        }
        if (pathName === "/api/v1/auth/me") {
          browserDiagnostics.preflightExpectedAuthProbeConsoleErrors += 1;
        } else {
          browserDiagnostics.preflightConsoleErrors += 1;
        }
      }
    });
    browserPage.on("requestfailed", (browserRequest) => {
      if (browserDiagnostics.preflightFailedRequestPaths.length < 20) {
        browserDiagnostics.preflightFailedRequestPaths.push(
          safeBrowserPath(browserRequest.url()),
        );
      }
    });
    browserPage.on("response", (response) => {
      if (browserDiagnostics.preflightResponseStatuses.length < 40) {
        if (safeBrowserPath(response.url()) === "/api/v1/auth/me") {
          browserDiagnostics.preflightAuthMeStatus = response.status();
        }
        browserDiagnostics.preflightResponseStatuses.push({
          path: safeBrowserPath(response.url()),
          status: response.status(),
        });
      }
    });
    browserDiagnostics.startupOrder.push("chromium");

    stage = "navegacion-login";
    const authMeRequestPromise = browserPage.waitForRequest(
      (request) =>
        safeBrowserPath(request.url()) === "/api/v1/auth/me" &&
        request.method() === "GET",
      { timeout: 30_000 },
    );
    void authMeRequestPromise.catch(() => {});
    const authMeResponsePromise = browserPage.waitForResponse(
      (response) =>
        safeBrowserPath(response.url()) === "/api/v1/auth/me" &&
        response.request().method() === "GET",
      { timeout: 0 },
    );
    void authMeResponsePromise.catch(() => {});
    const navigationStartedAt = Date.now();
    let navigation;
    try {
      navigation = await browserPage.goto(`${BROWSER_ORIGIN}/ingresar`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (error) {
      browserDiagnostics.navigationErrorName = error?.name || "Error";
      browserDiagnostics.navigationMs = Date.now() - navigationStartedAt;
      browserDiagnostics.documentReadyState = await browserPage
        .evaluate(() => document.readyState)
        .catch(() => "unavailable");
      throw error;
    }
    browserDiagnostics.navigationMs = Date.now() - navigationStartedAt;
    browserDiagnostics.documentReadyState = await browserPage.evaluate(
      () => document.readyState,
    );
    loginStatus = navigation?.status() ?? null;
    browserDiagnostics.loginStatus = loginStatus;
    assert.equal(loginStatus, 200);

    stage = "consulta-de-sesion";
    await authMeRequestPromise;
    assert.equal(
      browserDiagnostics.preflightAuthMeStatus,
      null,
      "el preflight debe mantener pendiente /auth/me hasta después de navegar",
    );
    releasePreflightAuthMe();
    const authMeResponse = await authMeResponsePromise;
    browserDiagnostics.preflightAuthMeStatus = authMeResponse.status();
    assert.equal(browserDiagnostics.preflightAuthMeStatus, 401);

    stage = "controles-login";
    const loginStartedAt = Date.now();
    try {
      await browserPage
        .getByRole("heading", { name: "Iniciar sesión" })
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      browserDiagnostics.preflightRootText = await browserPage
        .locator("#root")
        .innerText({ timeout: 1000 })
        .catch(() => "no-disponible");
      const screenshotPath = path.join(
        browserArtifactsDirectory,
        "preflight-login-failure.png",
      );
      await browserPage.screenshot({ path: screenshotPath }).catch(() => {});
      browserDiagnostics.preflightFailureScreenshot = screenshotPath;
      throw new Error("Controles de Login no visibles.");
    }
    browserDiagnostics.preflightControlVisibility = {
      heading: await readBrowserControlVisibility(
        browserPage.getByRole("heading", { name: "Iniciar sesión" }),
      ),
      email: await readBrowserControlVisibility(
        browserPage.getByLabel("Correo electrónico"),
      ),
      password: await readBrowserControlVisibility(
        browserPage.getByLabel("Contraseña", { exact: true }),
      ),
      recoveryLink: await readBrowserControlVisibility(
        browserPage.getByRole("link", {
          name: "¿Olvidaste tu contraseña?",
        }),
      ),
    };
    if (
      Object.values(browserDiagnostics.preflightControlVisibility).some(
        (visible) => visible !== true,
      )
    ) {
      browserDiagnostics.preflightRootText = await browserPage
        .locator("#root")
        .innerText({ timeout: 1000 })
        .catch(() => "no-disponible");
      const screenshotPath = path.join(
        browserArtifactsDirectory,
        "preflight-login-failure.png",
      );
      await browserPage.screenshot({ path: screenshotPath }).catch(() => {});
      browserDiagnostics.preflightFailureScreenshot = screenshotPath;
      throw new Error("Faltan controles visibles en Login.");
    }
    browserDiagnostics.loginReadyMs = Date.now() - loginStartedAt;
    assert.equal(browserDiagnostics.preflightPageErrors, 0);
    assert.equal(browserDiagnostics.preflightConsoleErrors, 0);
    browserPage.removeAllListeners("pageerror");
    browserPage.removeAllListeners("console");
    browserPage.removeAllListeners("requestfailed");
    browserPage.removeAllListeners("response");
    return;
  } catch (error) {
    browserDiagnostics.preflightErrorName = error?.name || "Error";
    throw browserPreflightFailure(stage, startedAt, loginStatus);
  } finally {
    releasePreflightAuthMe?.();
  }
}

async function requireUniqueControl(locator) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.count(), 1, "el control accesible debe ser único");
  assert.equal(await locator.isEnabled(), true);
  return locator;
}

async function observeDisabledSubmit(page, label) {
  await page.evaluate((buttonLabel) => {
    window.__sigecomSubmitObserver?.disconnect();
    window.__sigecomDisabledSubmitSeen = false;
    const inspect = () => {
      const submitting = [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent.trim() === buttonLabel && button.disabled,
      );
      if (submitting) {
        window.__sigecomDisabledSubmitSeen = true;
        window.__sigecomSubmitObserver.disconnect();
      }
    };
    window.__sigecomSubmitObserver = new MutationObserver(inspect);
    window.__sigecomSubmitObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    inspect();
  }, label);
}

async function assertDisabledSubmitWasObserved(page) {
  const observed = await page.evaluate(() => {
    window.__sigecomSubmitObserver?.disconnect();
    return window.__sigecomDisabledSubmitSeen;
  });
  assert.equal(observed, true, "el envío debe mostrar el botón deshabilitado");
}

async function preflightRecoveryControls() {
  // Solo este preflight intercepta respuestas: la aceptación integral utiliza Express y MariaDB.
  const page = browserPage;
  const email = "preflight@example.invalid";
  const token = randomBytes(32).toString("base64url");
  const password = makePassword();
  sensitiveValues.add(token);
  let releaseRequest;
  let releaseCompletion;
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  let completionAttempts = 0;
  let recoveryRequests = 0;
  try {
    await page.route("**/api/v1/auth/password-recovery", async (route) => {
      assert.equal(route.request().method(), "POST");
      recoveryRequests += 1;
      await requestGate;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
    });
    await page.route(
      "**/api/v1/auth/password-recovery/complete",
      async (route) => {
        assert.equal(route.request().method(), "POST");
        completionAttempts += 1;
        const body = route.request().postDataJSON();
        assert.deepEqual(Object.keys(body).sort(), [
          "confirmPassword",
          "newPassword",
          "token",
        ]);
        assert.equal(
          body.token === token,
          true,
          "token de preflight incorrecto",
        );
        assert.equal(
          body.newPassword === password && body.confirmPassword === password,
          true,
          "los campos de contraseña deben coincidir",
        );
        if (completionAttempts === 1) {
          await completionGate;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ changed: true }),
          });
        } else {
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "PASSWORD_RECOVERY_LINK_INVALID",
                message: "El enlace no está disponible.",
              },
            }),
          });
        }
      },
    );
    await page.route("**/api/v1/auth/login", async (route) => {
      assert.equal(route.request().method(), "POST");
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Credenciales incorrectas.",
          },
        }),
      });
    });

    await (
      await requireUniqueControl(
        page.getByRole("link", {
          name: "¿Olvidaste tu contraseña?",
          exact: true,
        }),
      )
    ).click();
    await requireUniqueControl(
      page.getByRole("heading", { name: "Recuperar contraseña", exact: true }),
    );
    const recoveryEmail = await requireUniqueControl(
      page.getByLabel("Correo electrónico", { exact: true }),
    );
    const requestButton = await requireUniqueControl(
      page.getByRole("button", { name: "Enviar instrucciones", exact: true }),
    );
    await recoveryEmail.fill("correo-no-valido");
    await recoveryEmail.press("Tab");
    await requireUniqueControl(
      page.getByText("Escribe un correo válido.", { exact: true }),
    );
    assert.equal(await recoveryEmail.getAttribute("aria-invalid"), "true");
    await recoveryEmail.fill(email);
    const requestObserved = page.waitForRequest(
      (request) =>
        safeBrowserPath(request.url()) === "/api/v1/auth/password-recovery" &&
        request.method() === "POST",
    );
    const requestResponse = responseForPost(
      page,
      "/api/v1/auth/password-recovery",
    );
    await observeDisabledSubmit(page, "Enviando solicitud…");
    await requestButton.click();
    await requestObserved;
    const sending = page.getByRole("button", {
      name: "Enviando solicitud…",
      exact: true,
    });
    await sending.waitFor({ state: "visible" });
    assert.equal(await sending.count(), 1);
    assert.equal(await sending.isDisabled(), true);
    releaseRequest();
    assert.equal((await requestResponse).status(), 202);
    await assertDisabledSubmitWasObserved(page);
    await requireUniqueControl(
      page.getByRole("heading", { name: "Revisa tu correo", exact: true }),
    );
    const publicStatus = await requireUniqueControl(page.getByRole("status"));
    assert.match(await publicStatus.innerText(), /Si la cuenta está activa/);
    assert.equal(recoveryRequests, 1);

    const recoveryLink = `${BROWSER_ORIGIN}/restablecer-contrasena#token=${token}`;
    sensitiveValues.add(recoveryLink);
    await navigateToSensitiveRecoveryLink(page, recoveryLink);
    await requireUniqueControl(
      page.getByRole("heading", { name: "Establecer contraseña", exact: true }),
    );
    assert.equal(await page.evaluate(() => window.location.hash), "");
    const newPassword = await requireUniqueControl(
      page.getByLabel("Nueva contraseña", { exact: true }),
    );
    const confirmPassword = await requireUniqueControl(
      page.getByLabel("Confirmar nueva contraseña", { exact: true }),
    );
    const saveButton = await requireUniqueControl(
      page.getByRole("button", { name: "Guardar contraseña", exact: true }),
    );
    await newPassword.fill("weak");
    await confirmPassword.fill("weak");
    await saveButton.click();
    await requireUniqueControl(
      page.getByText("Usa al menos 12 caracteres.", { exact: true }),
    );
    assert.equal(await newPassword.getAttribute("aria-invalid"), "true");
    assert.equal(completionAttempts, 0);
    await newPassword.fill(password);
    await confirmPassword.fill(makePassword());
    await saveButton.click();
    await requireUniqueControl(
      page.getByText("La confirmación no coincide con la nueva contraseña.", {
        exact: true,
      }),
    );
    assert.equal(await confirmPassword.getAttribute("aria-invalid"), "true");
    assert.equal(completionAttempts, 0);
    await confirmPassword.fill(password);
    const completionObserved = page.waitForRequest(
      (request) =>
        safeBrowserPath(request.url()) ===
          "/api/v1/auth/password-recovery/complete" &&
        request.method() === "POST",
    );
    const completionResponse = responseForPost(
      page,
      "/api/v1/auth/password-recovery/complete",
    );
    await saveButton.click();
    await completionObserved;
    const updating = page.getByRole("button", {
      name: "Actualizando contraseña…",
      exact: true,
    });
    await updating.waitFor({ state: "visible" });
    assert.equal(await updating.count(), 1);
    assert.equal(await updating.isDisabled(), true);
    releaseCompletion();
    assert.equal((await completionResponse).status(), 200);
    await requireUniqueControl(
      page.getByRole("heading", {
        name: "Contraseña actualizada",
        exact: true,
      }),
    );
    assert.match(
      await (await requireUniqueControl(page.getByRole("status"))).innerText(),
      /las sesiones anteriores se cerraron/i,
    );
    assert.equal(completionAttempts, 1);

    await (
      await requireUniqueControl(
        page.getByRole("link", {
          name: "Volver a iniciar sesión",
          exact: true,
        }),
      )
    ).click();
    await requireUniqueControl(
      page.getByRole("heading", { name: "Iniciar sesión", exact: true }),
    );
    await (
      await requireUniqueControl(
        page.getByLabel("Correo electrónico", { exact: true }),
      )
    ).fill(email);
    await (
      await requireUniqueControl(page.getByLabel("Contraseña", { exact: true }))
    ).fill(password);
    const loginResponse = responseForPost(page, "/api/v1/auth/login");
    await (
      await requireUniqueControl(
        page.getByRole("button", { name: "Ingresar", exact: true }),
      )
    ).click();
    assert.equal((await loginResponse).status(), 401);
    await requireUniqueControl(
      page.getByRole("alert").getByText("Credenciales incorrectas.", {
        exact: true,
      }),
    );

    await navigateToSensitiveRecoveryLink(page, recoveryLink);
    await requireUniqueControl(
      page.getByRole("heading", { name: "Establecer contraseña", exact: true }),
    );
    assert.equal(await page.evaluate(() => window.location.hash), "");
    await (
      await requireUniqueControl(
        page.getByLabel("Nueva contraseña", { exact: true }),
      )
    ).fill(password);
    await (
      await requireUniqueControl(
        page.getByLabel("Confirmar nueva contraseña", { exact: true }),
      )
    ).fill(password);
    const reuseResponse = responseForPost(
      page,
      "/api/v1/auth/password-recovery/complete",
    );
    await (
      await requireUniqueControl(
        page.getByRole("button", { name: "Guardar contraseña", exact: true }),
      )
    ).click();
    assert.equal((await reuseResponse).status(), 400);
    await requireUniqueControl(
      page.getByRole("heading", {
        name: "Solicita un enlace nuevo",
        exact: true,
      }),
    );
    await requireUniqueControl(page.getByRole("alert"));
    assert.equal(completionAttempts, 2);
    browserDiagnostics.preflightRecoveryControls = {
      complete: true,
      requestStatus: 202,
      completionStatus: 200,
      loginErrorStatus: 401,
      reusedLinkStatus: 400,
      uniqueAccessibleControls: true,
      databaseAccess: false,
    };
  } finally {
    releaseRequest();
    releaseCompletion();
    await page.unroute("**/api/v1/auth/password-recovery");
    await page.unroute("**/api/v1/auth/password-recovery/complete");
    await page.unroute("**/api/v1/auth/login");
  }
}

function assertBrowserInfrastructureReady() {
  assert.equal(browserApiServer?.listening, true);
  assert.equal(apiProxyServer?.listening, true);
  assert.ok(viteProcess);
  assert.equal(viteProcess.exitCode, null);
  assert.equal(browser?.isConnected(), true);
  assert.ok(browserPage);
  assert.deepEqual(browserDiagnostics.preflightControlVisibility, {
    heading: true,
    email: true,
    password: true,
    recoveryLink: true,
  });
  assert.equal(browserDiagnostics.preflightAuthMeStatus, 401);
}

async function stopBrowserApiServer() {
  if (!browserApiServer?.listening) {
    browserApiServer = null;
    return;
  }
  const server = browserApiServer;
  browserApiServer = null;
  await new Promise((resolve) => server.close(resolve));
}

async function startBrowserApiServer() {
  await stopBrowserApiServer();
  if (!browserApp) {
    const authConfig = getAuthConfig({
      NODE_ENV: "test",
      JWT_SECRET: randomBytes(48).toString("base64url"),
      FRONTEND_ORIGIN: BROWSER_ORIGIN,
      PUBLIC_APP_ORIGIN: BROWSER_ORIGIN,
      COOKIE_SECURE: "false",
      AUTH_RATE_LIMIT_MAX: "10",
      AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "10",
    });
    browserApp = createApp({
      dbPool: appPool,
      authConfig,
      mailTransport: createSimulatedMailTransport({
        capture: async (message) => browserMailbox.push(message),
      }),
      logger: createTestLogger(),
    });
  }
  browserApiServer = http.createServer(browserApp);
  await listenOnLoopback(browserApiServer, BROWSER_API_PORT);
}

async function stopVite() {
  if (!viteProcess || viteProcess.exitCode !== null) {
    viteProcess = null;
    return;
  }
  const child = viteProcess;
  viteProcess = null;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

async function closeBrowserInfrastructure() {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  await stopBrowserApiServer();
  if (apiProxyServer?.listening) {
    const server = apiProxyServer;
    apiProxyServer = null;
    await new Promise((resolve) => server.close(resolve));
  } else {
    apiProxyServer = null;
  }
  await stopVite();
}

function safeSqlError(error, operation) {
  return new Error(
    `${operation} falló en el esquema aislado (código SQL: ${error.code || error.errno || "desconocido"}).`,
  );
}

async function verifyServerIdentity(connection, expectedIdentity) {
  const [[identity]] = await connection.query(`
    SELECT VERSION() AS version,
           @@hostname AS hostname,
           @@port AS port,
           @@datadir AS datadir,
           DATABASE() AS selected_database,
           CURRENT_USER() AS current_identity
  `);

  assert.match(identity.version, /^10\.4\.32-MariaDB/);
  assert.equal(identity.hostname, EXPECTED_HOSTNAME);
  assert.equal(Number(identity.port), PORT);
  assert.equal(identity.datadir.toLowerCase(), EXPECTED_DATADIR.toLowerCase());
  assert.equal(identity.selected_database, schemaName);
  assert.equal(identity.current_identity, expectedIdentity);
  resources.databaseVersion = identity.version;
}

async function verifyScopedGrants(
  connection,
  privileges,
  tablePrivileges = [],
) {
  const [grantRows] = await connection.query("SHOW GRANTS");
  const grants = grantRows.map((row) => Object.values(row)[0]);
  const scopedGrants = grants.filter(
    (grant) => !/^GRANT USAGE ON \*\.\*/i.test(grant),
  );

  assert.equal(scopedGrants.length, 1 + tablePrivileges.length);
  const schemaGrant = new RegExp(
    `^GRANT (.+) ON \`${schemaName}\`\\.\\* TO `,
    "i",
  );
  const schemaGrantText = scopedGrants.find((grant) => schemaGrant.test(grant));
  assert.ok(schemaGrantText);
  const schemaGrantMatch = schemaGrant.exec(schemaGrantText);
  assert.deepEqual(
    schemaGrantMatch[1].split(", ").sort(),
    [...privileges].sort(),
  );
  const actualTablePrivileges = scopedGrants
    .filter((grant) => grant !== schemaGrantText)
    .map((grant) => {
      const match = new RegExp(
        `^GRANT (.+) ON \`${schemaName}\`\\.\`([a-z0-9_]+)\` TO `,
        "i",
      ).exec(grant);
      assert.ok(
        match,
        "cada permiso adicional debe estar limitado a una tabla",
      );
      return {
        table: match[2],
        privileges: match[1].split(", ").sort(),
      };
    })
    .sort((first, second) => first.table.localeCompare(second.table));
  assert.deepEqual(
    actualTablePrivileges,
    tablePrivileges
      .map(({ table, privileges: tableGrant }) => ({
        table,
        privileges: [...tableGrant].sort(),
      }))
      .sort((first, second) => first.table.localeCompare(second.table)),
  );
  assert.doesNotMatch(scopedGrants.join("\n"), /WITH GRANT OPTION/i);
  assert.doesNotMatch(scopedGrants.join("\n"), /\bON\s+\*\.\*/i);
  for (const protectedSchema of PROTECTED_SCHEMAS) {
    assert.doesNotMatch(
      scopedGrants.join("\n").toLowerCase(),
      new RegExp(protectedSchema),
    );
  }
  return grants;
}

async function verifyProtectedSchemasDenied(connection) {
  for (const protectedSchema of PROTECTED_SCHEMAS) {
    let denial;
    try {
      await connection.query(`USE \`${protectedSchema}\``);
    } catch (error) {
      denial = error;
    }

    assert.ok(
      denial,
      `la cuenta de prueba no debe poder seleccionar ${protectedSchema}`,
    );
    assert.ok(
      [1044, 1045].includes(Number(denial.errno)) ||
        ["ER_DBACCESS_DENIED_ERROR", "ER_ACCESS_DENIED_ERROR"].includes(
          denial.code,
        ),
    );
    const [[selected]] = await connection.query(
      "SELECT DATABASE() AS selected_database",
    );
    assert.equal(selected.selected_database, schemaName);
  }
}

async function connectAs(user, password, { multipleStatements = false } = {}) {
  const connection = await mysql.createConnection({
    host: HOST,
    port: PORT,
    database: schemaName,
    user,
    password,
    charset: "utf8mb4",
    timezone: "Z",
    connectTimeout: 5000,
    multipleStatements,
  });
  return connection;
}

async function provisionIsolatedResources() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("El runner aislado rechaza NODE_ENV=production.");
  }
  assert.equal(runnerConfig.mode, "PROVISION");
  assert.match(schemaName, /^sigecom_e2e_tmp_\d{14}_[a-f0-9]{8}$/);
  assert.doesNotMatch(
    schemaName.toLowerCase(),
    /^(?:sigecom_dev|sigecom_test|sigecom_h2_concurrency)$/,
  );
  const migrations = await getMigrations();
  assert.deepEqual(
    migrations.map(({ version }) => version),
    migrationVersions,
  );
  for (const migration of migrations) {
    assert.doesNotMatch(
      migration.sql,
      /(?:^|;)\s*(?:USE\b|CREATE\s+(?:DATABASE|SCHEMA|USER)\b|DROP\s+(?:DATABASE|SCHEMA|USER)\b|GRANT\b|REVOKE\b)/im,
    );
    assert.doesNotMatch(
      migration.sql,
      /\bsigecom_(?:dev|test|h2_concurrency)\b/i,
    );
  }
  assertBrowserInfrastructureReady();
  await access(
    path.join(frontendDirectory, "node_modules", "vite", "bin", "vite.js"),
  );
  const { chromium } = frontendRequire("@playwright/test");
  await access(chromium.executablePath());

  resourceOwnershipLedger = await createResourceOwnershipLedger({
    directory: defaultResourceOwnershipDirectory(),
    runId,
    attemptId,
    schema: schemaName,
    appUser,
    migratorUser,
  });

  try {
    provisionerConnection = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: provisionerUser,
      password: provisionerPassword,
      charset: "utf8mb4",
      connectTimeout: 5000,
      multipleStatements: false,
    });
    const [[identity]] = await provisionerConnection.query(`
      SELECT VERSION() AS version,
             @@hostname AS hostname,
             @@port AS port,
             @@datadir AS datadir,
             DATABASE() AS selected_database,
             CURRENT_USER() AS current_identity,
             @@skip_networking AS skip_networking
    `);

    assert.equal(identity.version, EXPECTED_DATABASE_VERSION);
    assert.equal(identity.hostname, EXPECTED_HOSTNAME);
    assert.equal(Number(identity.port), PORT);
    assert.equal(
      identity.datadir.toLowerCase(),
      EXPECTED_DATADIR.toLowerCase(),
    );
    assert.equal(identity.selected_database, null);
    assertProvisionerIdentity(identity.current_identity, provisionerUser);
    assert.equal(Number(identity.skip_networking), 0);
    resources.databaseVersion = identity.version;

    assert.match(schemaName, /^sigecom_e2e_tmp_[a-z0-9_]+$/);
    assert.match(appUser, /^sgapp_[a-z0-9_]+$/);
    assert.match(migratorUser, /^sgmig_[a-z0-9_]+$/);

    await provisionIsolatedDatabaseResources({
      connection: provisionerConnection,
      ledger: resourceOwnershipLedger,
      runId,
      schema: schemaName,
      appUser,
      migratorUser,
      appPassword,
      migratorPassword,
    });
  } catch (error) {
    throw safeSqlError(error, "Preflight/provisión aislada");
  } finally {
    if (provisionerConnection) {
      await provisionerConnection.end().catch(() => {});
      provisionerConnection = null;
    }
  }

  process.env.NODE_ENV = "test";
  migratorConnection = await connectAs(migratorUser, migratorPassword, {
    multipleStatements: true,
  });
  appPool = mysql.createPool({
    host: HOST,
    port: PORT,
    database: schemaName,
    user: appUser,
    password: appPassword,
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: 8,
    connectTimeout: 5000,
    multipleStatements: false,
  });

  await verifyServerIdentity(migratorConnection, `${migratorUser}@localhost`);
  await verifyScopedGrants(migratorConnection, [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "ALTER",
    "DROP",
    "INDEX",
    "REFERENCES",
    "TRIGGER",
  ]);
  await verifyProtectedSchemasDenied(migratorConnection);

  const appConnection = await connectAs(appUser, appPassword);
  try {
    await verifyServerIdentity(appConnection, `${appUser}@localhost`);
    await verifyScopedGrants(
      appConnection,
      ["SELECT", "INSERT", "UPDATE"],
      [
        { table: "user_warehouses", privileges: ["DELETE"] },
        { table: "role_permissions", privileges: ["DELETE"] },
      ],
    );
    await verifyProtectedSchemasDenied(appConnection);
  } finally {
    await appConnection.end();
  }

  await resourceOwnershipLedger.recordStep("migrations.table", () =>
    migratorConnection.query(migrationTableSql()),
  );
  await applyLegacyCompatibleMigrations({
    migrations,
    applyMigration: applyIsolatedMigration,
    seedLegacyFixtures: () =>
      resourceOwnershipLedger.recordStep("fixtures.legacy", async () => {
        const [warehouse] = await appPool.execute(
          `INSERT INTO warehouses (code, name, is_active)
           VALUES (?, 'Bodega de aceptación SIGECOM', 1)`,
          [`E2E-${runId.toUpperCase()}`],
        );
        warehouseId = String(warehouse.insertId);
        migrationLegacyUser = await seedUser({
          email: `migration-legacy.${attemptId}@example.invalid`,
          displayName: "Cuenta de prueba existente",
          password: fixturePassword,
          isActive: 1,
          roleCode: "seller",
        });
      }),
    verifyLegacyState: async () => {
      const [[legacyState]] = await appPool.execute(
        "SELECT is_active, credential_state FROM users WHERE id = ?",
        [migrationLegacyUser.id],
      );
      assert.equal(Number(legacyState.is_active), 1);
      assert.equal(legacyState.credential_state, "active");
    },
  });

  const [migrationRows] = await migratorConnection.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  assert.deepEqual(
    migrationRows.map(({ version }) => version),
    migrationVersions,
  );
  for (let index = 0; index < migrations.length; index += 1) {
    assert.equal(migrationRows[index].name, migrations[index].name);
    assert.equal(migrationRows[index].checksum, migrations[index].checksum);
  }

  await verifyMigration0019Schema();
  await resourceOwnershipLedger.recordStep(
    "fixtures.account-access",
    async () => {},
  );
  await resourceOwnershipLedger.markReady();
  resourceOwnershipRecord = resourceOwnershipLedger.snapshot();
}

async function reuseAuthorizedResources() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("El runner aislado rechaza NODE_ENV=production.");
  }
  assert.equal(runnerConfig.mode, "RUN");
  resourceOwnershipRecord = await readResourceOwnershipLedger({
    directory: defaultResourceOwnershipDirectory(),
    runId,
    attemptId,
    schema: schemaName,
    expectedState: "ready",
  });
  resourceOwnershipRecord = await claimResourceOwnershipAttempt({
    directory: defaultResourceOwnershipDirectory(),
    runId,
    attemptId,
    schema: schemaName,
  });
  process.env.NODE_ENV = "test";
  const appConnection = await connectAs(appUser, appPassword);
  try {
    await verifyServerIdentity(appConnection, `${appUser}@localhost`);
    await verifyScopedGrants(
      appConnection,
      ["SELECT", "INSERT", "UPDATE"],
      [
        { table: "user_warehouses", privileges: ["DELETE"] },
        { table: "role_permissions", privileges: ["DELETE"] },
      ],
    );
    await verifyProtectedSchemasDenied(appConnection);
  } finally {
    await appConnection.end();
  }
  appPool = mysql.createPool({
    host: HOST,
    port: PORT,
    database: schemaName,
    user: appUser,
    password: appPassword,
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: 8,
    connectTimeout: 5000,
    multipleStatements: false,
  });

  const migrations = await getMigrations();
  assert.deepEqual(
    migrations.map(({ version }) => version),
    migrationVersions,
  );
  const [migrationRows] = await appPool.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  assert.deepEqual(
    migrationRows.map(({ version }) => version),
    migrationVersions,
  );
  for (let index = 0; index < migrations.length; index += 1) {
    assert.equal(migrationRows[index].name, migrations[index].name);
    assert.equal(migrationRows[index].checksum, migrations[index].checksum);
  }
  resources.appliedMigrations = migrationVersions;
  await verifyMigration0019Schema();

  async function loadFixtureUser(
    role,
    { fixtureAttemptId = attemptId, isActive = 1, credentialState } = {},
  ) {
    const email = `${role}.${fixtureAttemptId}@example.invalid`;
    const [rows] = await appPool.execute(
      `SELECT id, email, password_hash, is_active, credential_state
         FROM users WHERE email = ?`,
      [email],
    );
    assert.equal(rows.length, 1, `fixture ${role} debe existir una sola vez`);
    const [row] = rows;
    assert.equal(Number(row.is_active), isActive);
    if (credentialState) {
      assert.equal(row.credential_state, credentialState);
    } else {
      assert.equal(row.credential_state, "active");
    }
    assert.equal(
      await bcrypt.compare(fixturePassword, row.password_hash),
      true,
      `fixture ${role} debe conservar la contraseña autorizada`,
    );
    sensitiveValues.add(email);
    return {
      id: String(row.id),
      email,
      password: fixturePassword,
      passwordHash: row.password_hash,
    };
  }

  migrationLegacyUser = await loadFixtureUser("migration-legacy", {
    fixtureAttemptId: resourceOwnershipRecord.owner.attemptId,
  });
  const attemptFixtureRoles = [
    "legacy",
    "inactive",
    "browser",
    "pending",
    "concurrent",
    "expiry",
    "browser-expiry",
    "mail-failure",
  ];
  const attemptFixtureEmails = attemptFixtureRoles.map(
    (role) => `${role}.${attemptId}@example.invalid`,
  );
  const [existingAttemptFixtures] = await appPool.execute(
    `SELECT email FROM users WHERE email IN (${attemptFixtureEmails.map(() => "?").join(", ")})`,
    attemptFixtureEmails,
  );
  assert.deepEqual(
    existingAttemptFixtures,
    [],
    "ATTEMPT_ID nuevo requiere fixtures aislados aún no utilizados",
  );

  legacyUser = await seedUser({
    email: `legacy.${attemptId}@example.invalid`,
    displayName: "Cuenta de recuperación aislada",
    password: fixturePassword,
    isActive: 1,
    roleCode: "seller",
  });
  inactiveUser = await seedUser({
    email: `inactive.${attemptId}@example.invalid`,
    displayName: "Cuenta inactiva de prueba",
    password: fixturePassword,
    isActive: 0,
    roleCode: "seller",
  });
  browserUser = await seedUser({
    email: `browser.${attemptId}@example.invalid`,
    displayName: "Cuenta legacy para navegador",
    password: fixturePassword,
    isActive: 1,
  });
  pendingUser = await seedUser({
    email: `pending.${attemptId}@example.invalid`,
    displayName: "Invitación pendiente de prueba",
    password: fixturePassword,
    isActive: 1,
    credentialState: "pending_invitation",
    roleCode: "seller",
  });
  concurrentUser = await seedUser({
    email: `concurrent.${attemptId}@example.invalid`,
    displayName: "Cuenta concurrente de prueba",
    password: fixturePassword,
    isActive: 1,
    roleCode: "seller",
  });
  expiryUser = await seedUser({
    email: `expiry.${attemptId}@example.invalid`,
    displayName: "Cuenta de expiración de prueba",
    password: fixturePassword,
    isActive: 1,
    roleCode: "seller",
  });
  browserExpiryUser = await seedUser({
    email: `browser-expiry.${attemptId}@example.invalid`,
    displayName: "Cuenta de expiración para navegador",
    password: fixturePassword,
    isActive: 1,
    roleCode: "seller",
  });
  const [[activeWarehouse]] = await appPool.execute(
    "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY id LIMIT 1",
  );
  assert.ok(activeWarehouse, "el RUN autorizado requiere una bodega activa");
  warehouseId = String(activeWarehouse.id);
  await appPool.execute(
    `INSERT INTO user_warehouses (user_id, warehouse_id, assigned_by)
     VALUES (?, ?, NULL)`,
    [browserExpiryUser.id, warehouseId],
  );
  mailFailureUser = await seedUser({
    email: `mail-failure.${attemptId}@example.invalid`,
    displayName: "Cuenta de entrega simulada",
    password: fixturePassword,
    isActive: 1,
    roleCode: "seller",
  });
}

async function applyIsolatedMigration(migration) {
  return resourceOwnershipLedger.recordStep(
    `migration.${migration.version}`,
    async () => {
      await verifyServerIdentity(
        migratorConnection,
        `${migratorUser}@localhost`,
      );
      await migratorConnection.query(migration.sql);
      await migratorConnection.execute(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
        [migration.version, migration.name, migration.checksum],
      );
      resources.appliedMigrations.push(migration.version);
    },
  );
}

async function runPartialDdlCapabilityProbe() {
  const markerTable = `partial_ddl_${runId}`;
  let ddlFailure;
  try {
    await migratorConnection.query(`
      CREATE TABLE \`${markerTable}\` (
        id INT NOT NULL PRIMARY KEY
      ) ENGINE=InnoDB;
      ALTER TABLE \`missing_${runId}\` ADD COLUMN probe INT NULL;
    `);
  } catch (error) {
    ddlFailure = error;
  }

  const [tables] = await migratorConnection.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schemaName, markerTable],
  );
  try {
    assert.ok(
      ddlFailure &&
        (ddlFailure.code === "ER_NO_SUCH_TABLE" ||
          Number(ddlFailure.errno) === 1146),
      "la sonda debe fallar en el ALTER de una tabla ausente",
    );
    assert.equal(tables.length, 1);
    const [history] = await migratorConnection.execute(
      "SELECT version FROM schema_migrations WHERE version = '9999'",
    );
    assert.equal(history.length, 0);
  } finally {
    if (tables.length === 1) {
      await migratorConnection.query(`DROP TABLE \`${markerTable}\``);
    }
  }
}

async function runTriggerCapabilityProbe() {
  const triggerName = `ddl_probe_${runId}`;
  let created = false;
  try {
    await migratorConnection.query(`
      CREATE TRIGGER \`${triggerName}\`
      BEFORE INSERT ON schema_migrations
      FOR EACH ROW SET @sigecom_ddl_probe = 1
    `);
    created = true;
    const [triggers] = await migratorConnection.execute(
      `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?`,
      [schemaName, triggerName],
    );
    assert.equal(triggers.length, 1);
  } finally {
    if (created) {
      await migratorConnection.query(`DROP TRIGGER \`${triggerName}\``);
    }
  }
}

async function runAuthorizedDdlChecks() {
  assert.equal(runnerConfig.mode, "DDL-CHECK");
  resourceOwnershipRecord = await readResourceOwnershipLedger({
    directory: defaultResourceOwnershipDirectory(),
    runId,
    attemptId,
    schema: schemaName,
    expectedState: "ready",
  });
  resources.appliedMigrations = Object.keys(resourceOwnershipRecord.steps)
    .filter((step) => /^migration\.\d{4}$/.test(step))
    .filter(
      (step) => resourceOwnershipRecord.steps[step].status === "succeeded",
    )
    .map((step) => step.slice("migration.".length));

  migratorConnection = await connectAs(migratorUser, migratorPassword, {
    multipleStatements: true,
  });
  try {
    await verifyServerIdentity(migratorConnection, `${migratorUser}@localhost`);
    await verifyScopedGrants(migratorConnection, [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "ALTER",
      "DROP",
      "INDEX",
      "REFERENCES",
      "TRIGGER",
    ]);
    await verifyProtectedSchemasDenied(migratorConnection);
    await runPartialDdlCapabilityProbe();
    await runTriggerCapabilityProbe();
  } catch (error) {
    throw safeSqlError(error, "Chequeo DDL autorizado");
  } finally {
    await closeConnections();
  }
}

async function seedUser({
  email,
  displayName,
  password,
  isActive,
  credentialState,
  roleCode = "administrator",
}) {
  const passwordHash = await bcrypt.hash(password, 12);
  let result;
  if (credentialState) {
    [result] = await appPool.execute(
      `INSERT INTO users
         (role_id, email, display_name, password_hash, is_active,
          password_change_required, credential_state)
        SELECT id, ?, ?, ?, ?, 0, ?
        FROM roles WHERE code = ?`,
      [email, displayName, passwordHash, isActive, credentialState, roleCode],
    );
  } else {
    [result] = await appPool.execute(
      `INSERT INTO users
         (role_id, email, display_name, password_hash, is_active,
          password_change_required)
        SELECT id, ?, ?, ?, ?, 0
        FROM roles WHERE code = ?`,
      [email, displayName, passwordHash, isActive, roleCode],
    );
  }

  assert.equal(result.affectedRows, 1);
  sensitiveValues.add(email);
  return { id: String(result.insertId), email, password, passwordHash };
}

async function verifyMigration0019Schema() {
  const metadataConnection = migratorConnection ?? appPool;
  const [columns] = await metadataConnection.execute(
    `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'credential_state'`,
    [schemaName],
  );
  assert.equal(columns.length, 1);
  assert.equal(
    columns[0].COLUMN_TYPE,
    "enum('active','pending_invitation','pending_admin_reset')",
  );
  assert.equal(columns[0].IS_NULLABLE, "NO");
  assert.equal(columns[0].COLUMN_DEFAULT, "'active'");

  const [indexRows] = await metadataConnection.execute(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'
        AND INDEX_NAME = 'idx_users_credentials_active'
      ORDER BY SEQ_IN_INDEX`,
    [schemaName],
  );
  assert.deepEqual(
    indexRows.map(({ COLUMN_NAME }) => COLUMN_NAME),
    ["is_active", "credential_state", "id"],
  );
  const [tokenIndexes] = await metadataConnection.execute(
    `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'account_access_tokens'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [schemaName],
  );
  assert.ok(
    tokenIndexes.some(
      ({ INDEX_NAME, NON_UNIQUE, COLUMN_NAME }) =>
        INDEX_NAME === "uq_account_access_tokens_hash" &&
        Number(NON_UNIQUE) === 0 &&
        COLUMN_NAME === "token_hash",
    ),
  );
  assert.deepEqual(
    tokenIndexes
      .filter(
        ({ INDEX_NAME }) =>
          INDEX_NAME === "idx_account_access_tokens_user_state",
      )
      .map(({ COLUMN_NAME }) => COLUMN_NAME),
    ["user_id", "purpose", "consumed_at", "revoked_at", "expires_at"],
  );

  const [tableRows] = await metadataConnection.execute(
    `SELECT ENGINE
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'account_access_tokens'`,
    [schemaName],
  );
  assert.equal(tableRows[0]?.ENGINE, "InnoDB");

  const [tokenColumns] = await metadataConnection.execute(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'account_access_tokens'
      ORDER BY ORDINAL_POSITION`,
    [schemaName],
  );
  assert.ok(tokenColumns.some((column) => column.COLUMN_NAME === "token_hash"));
  assert.equal(
    tokenColumns.some((column) =>
      ["token", "recovery_url", "recovery_link"].includes(
        column.COLUMN_NAME.toLowerCase(),
      ),
    ),
    false,
  );
  assert.equal(
    tokenColumns.find((column) => column.COLUMN_NAME === "token_hash")
      ?.COLUMN_TYPE,
    "char(64)",
  );
  assert.equal(
    tokenColumns.find((column) => column.COLUMN_NAME === "purpose")
      ?.COLUMN_DEFAULT,
    null,
  );
  assert.ok(
    tokenColumns.some(
      (column) =>
        column.COLUMN_NAME === "created_at" &&
        column.COLUMN_DEFAULT === "current_timestamp(3)",
    ),
  );

  const [constraints] = await metadataConnection.execute(
    `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'account_access_tokens'`,
    [schemaName],
  );
  const constraintNames = constraints.map(({ CONSTRAINT_NAME }) =>
    CONSTRAINT_NAME.toLowerCase(),
  );
  for (const expected of [
    "fk_account_access_tokens_user",
    "chk_account_access_tokens_purpose",
    "chk_account_access_tokens_hash",
    "chk_account_access_tokens_state",
  ]) {
    assert.ok(constraintNames.includes(expected));
  }

  const [[tokenOwner]] = await metadataConnection.execute(
    "SELECT id FROM users ORDER BY id LIMIT 1",
  );
  assert.ok(
    tokenOwner,
    "la verificación de token requiere una cuenta de prueba",
  );
  await assert.rejects(
    appPool.execute(
      `INSERT INTO account_access_tokens
         (user_id, token_hash, purpose, expires_at)
       VALUES (?, ?, 'unsupported_purpose',
         DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
      [tokenOwner.id, randomBytes(32).toString("hex")],
    ),
    (error) =>
      Number(error.errno) === 4025 ||
      error.code === "ER_CONSTRAINT_FAILED" ||
      error.code === "ER_CHECK_CONSTRAINT_VIOLATED",
  );

  const [[foreignKey]] = await metadataConnection.execute(
    `SELECT REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'account_access_tokens'
        AND CONSTRAINT_NAME = 'fk_account_access_tokens_user'`,
    [schemaName],
  );
  assert.equal(foreignKey.REFERENCED_TABLE_NAME, "users");
  assert.equal(foreignKey.REFERENCED_COLUMN_NAME, "id");
}

function createTestLogger() {
  return {
    info(fields, message) {
      allLogs.push({ level: "info", fields, message });
    },
    warn(fields, message) {
      allLogs.push({ level: "warn", fields, message });
    },
    error(fields, message) {
      allLogs.push({ level: "error", fields, message });
    },
  };
}

function createHttpHarness({ failMail = false } = {}) {
  const mailbox = [];
  const logger = createTestLogger();
  const simulatedTransport = createSimulatedMailTransport({
    capture: async (message) => {
      mailbox.push(message);
      if (failMail) throw new Error("simulated provider failure secret");
    },
  });
  const authConfig = getAuthConfig({
    NODE_ENV: "test",
    JWT_SECRET: randomBytes(48).toString("base64url"),
    FRONTEND_ORIGIN,
    COOKIE_SECURE: "false",
    AUTH_RATE_LIMIT_MAX: "10",
    AUTH_LOGIN_ACCOUNT_RATE_LIMIT_MAX: "10",
  });
  const app = createApp({
    dbPool: appPool,
    authConfig,
    mailTransport: simulatedTransport,
    logger,
  });
  return { app, mailbox };
}

async function csrfContext(app) {
  const response = await request(app).get("/api/v1/auth/csrf").expect(200);
  const csrfCookie = response.headers["set-cookie"]
    .find((cookie) => cookie.startsWith("sigecom_csrf="))
    .split(";", 1)[0];
  return { csrfToken: response.body.csrfToken, csrfCookie };
}

async function postRecovery(app, email, csrf, { includeOrigin = true } = {}) {
  sensitiveValues.add(email);
  let call = request(app)
    .post("/api/v1/auth/password-recovery")
    .send({ email });
  if (includeOrigin) call = call.set("Origin", FRONTEND_ORIGIN);
  if (csrf) {
    call = call
      .set("Cookie", csrf.csrfCookie)
      .set("X-CSRF-Token", csrf.csrfToken);
  }
  return call;
}

async function postCompletion(app, payload, csrf) {
  return request(app)
    .post("/api/v1/auth/password-recovery/complete")
    .set("Origin", FRONTEND_ORIGIN)
    .set("Cookie", csrf.csrfCookie)
    .set("X-CSRF-Token", csrf.csrfToken)
    .send(payload);
}

function readTokenFromEmail(message) {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(message.text);
  assert.ok(match, "el correo simulado debe contener un token de prueba");
  sensitiveValues.add(match[1]);
  return match[1];
}

function validCompletionPayload(token) {
  sensitiveValues.add(token);
  const password = makePassword();
  return {
    token,
    newPassword: password,
    confirmPassword: password,
  };
}

async function waitForRecoveryAuditCount(expectedCount) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [[row]] = await appPool.execute(
      `SELECT COUNT(*) AS total
         FROM audit_events
        WHERE action = 'auth.password_recovery_requested'`,
    );
    if (Number(row.total) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "la solicitud diferida no registró su auditoría en el esquema aislado",
  );
}

async function waitForCondition(readValue, expectedValue, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await readValue()) >= expectedValue) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`tiempo agotado esperando ${description}`);
}

async function waitForMailbox(harness, expectedCount) {
  await waitForCondition(
    async () => harness.mailbox.length,
    expectedCount,
    "el transportador simulado",
  );
}

async function snapshotUserAuthorization(userId) {
  const [[user]] = await appPool.execute(
    `SELECT role_id, is_active, credential_state, password_change_required
       FROM users WHERE id = ?`,
    [userId],
  );
  const [roles] = await appPool.execute(
    "SELECT id, code, is_system FROM roles ORDER BY id",
  );
  const [permissions] = await appPool.execute(
    "SELECT id, code, module FROM permissions ORDER BY id",
  );
  const [rolePermissions] = await appPool.execute(
    "SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id",
  );
  const [warehouseAssignments] = await appPool.execute(
    `SELECT user_id, warehouse_id FROM user_warehouses
      WHERE user_id = ? ORDER BY warehouse_id`,
    [userId],
  );
  return {
    user: {
      roleId: String(user.role_id),
      isActive: Number(user.is_active),
      credentialState: user.credential_state,
      passwordChangeRequired: Number(user.password_change_required),
    },
    roles,
    permissions,
    rolePermissions,
    warehouseAssignments,
  };
}

async function assertNoHorizontalOverflow(page, width, height) {
  await page.setViewportSize({ width, height });
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(
    dimensions.document <= dimensions.viewport &&
      dimensions.body <= dimensions.viewport,
    true,
    `la página debe ajustarse a ${width}x${height} sin desbordamiento horizontal`,
  );
}

async function captureSafeScreenshot(page, filename) {
  const screenshotPath = path.join(browserArtifactsDirectory, filename);
  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  browserVisualFiles.push(filename);
}

async function responseForPost(page, route) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === route &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
}

async function runBrowserCacheIsolation(page) {
  await page.goto(`${BROWSER_ORIGIN}/inicio`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("button", {
      name: "Menú de usuario: Cuenta legacy para navegador",
    })
    .waitFor();
  await page.goto(`${BROWSER_ORIGIN}/usuarios`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Usuarios", exact: true }).waitFor();
  const search = page.getByRole("searchbox", {
    name: "Buscar por nombre o correo",
  });
  await search.fill(browserExpiryUser.email);
  await search.press("Enter");
  await page.getByText(browserExpiryUser.email, { exact: true }).waitFor();

  await page.getByRole("button", { name: /Menú de usuario:/ }).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await page.waitForURL(`${BROWSER_ORIGIN}/ingresar`, { timeout: 20_000 });
  await page.getByLabel("Correo electrónico").fill(browserExpiryUser.email);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(browserExpiryUser.password);
  const secondIdentityLogin = responseForPost(page, "/api/v1/auth/login");
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  assert.equal((await secondIdentityLogin).status(), 200);
  await page.waitForURL(`${BROWSER_ORIGIN}/inicio`, { timeout: 20_000 });
  await page
    .getByRole("button", {
      name: "Menú de usuario: Cuenta de expiración para navegador",
    })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Usuarios", exact: true }).count(),
    0,
    "la navegación de administración no debe persistir entre identidades",
  );

  await page.goto(`${BROWSER_ORIGIN}/usuarios`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL(`${BROWSER_ORIGIN}/acceso-denegado`, {
    timeout: 20_000,
  });
  await page.getByRole("heading", { name: "Acceso denegado" }).waitFor();
  const sellerPageText = await page.locator("body").innerText();
  assert.equal(sellerPageText.includes(browserUser.email), false);
  assert.equal(sellerPageText.includes(browserExpiryUser.email), false);
  await page.goto(`${BROWSER_ORIGIN}/inicio`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: /Menú de usuario:/ }).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await page.waitForURL(`${BROWSER_ORIGIN}/ingresar`, { timeout: 20_000 });
}

async function navigateToSensitiveRecoveryLink(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch {
    throw new Error(
      "No fue posible abrir el enlace de recuperación en el navegador.",
    );
  }
}

async function runBrowserAcceptance() {
  const browserUserBefore = await snapshotUserAuthorization(browserUser.id);
  const browserExpiryAuthorizationBefore = await snapshotUserAuthorization(
    browserExpiryUser.id,
  );
  const browserExpiryHashBefore = await currentUserHash(browserExpiryUser.id);
  const baselineRecoveryAudits = await recoveryAuditCount();
  let completionRequestCount = 0;
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  let expectedAuthProbeConsoleErrorCount = 0;
  let expectedHttpConsoleErrorCount = 0;
  const unexpectedConsoleErrorPaths = [];
  const apiResponseStatuses = new Map();
  let authMeStatus = null;
  let publicPayloadForExisting;
  let activeConfirmation;
  let recoveryToken;
  let recoveryLink;
  let newPassword;

  await startBrowserApiServer();
  const page = browserPage;
  assert.ok(page, "el navegador debe conservar el contexto del preflight");
  page.on("pageerror", () => {
    pageErrorCount += 1;
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const pathName = safeBrowserPath(message.location().url);
    const responseStatus = apiResponseStatuses.get(pathName);
    if (
      pathName.startsWith("/api/v1/") &&
      responseStatus >= 400 &&
      responseStatus < 500
    ) {
      expectedHttpConsoleErrorCount += 1;
      if (pathName === "/api/v1/auth/me") {
        expectedAuthProbeConsoleErrorCount += 1;
      }
      return;
    }
    if (unexpectedConsoleErrorPaths.length < 20) {
      unexpectedConsoleErrorPaths.push(pathName);
    }
    consoleErrorCount += 1;
  });
  page.on("response", (response) => {
    const pathName = safeBrowserPath(response.url());
    if (pathName.startsWith("/api/v1/")) {
      apiResponseStatuses.set(pathName, response.status());
    }
    if (pathName === "/api/v1/auth/me") {
      authMeStatus = response.status();
      browserDiagnostics.acceptanceAuthMeStatus = authMeStatus;
    }
  });
  page.on("request", (browserRequest) => {
    if (
      browserRequest.method() === "POST" &&
      new URL(browserRequest.url()).pathname ===
        "/api/v1/auth/password-recovery/complete"
    ) {
      completionRequestCount += 1;
    }
  });

  const initialAuthMeResponsePromise = page.waitForResponse(
    (response) =>
      safeBrowserPath(response.url()) === "/api/v1/auth/me" &&
      response.request().method() === "GET",
    { timeout: 0 },
  );
  void initialAuthMeResponsePromise.catch(() => {});
  const loginResponse = await page.goto(`${BROWSER_ORIGIN}/ingresar`, {
    waitUntil: "domcontentloaded",
  });
  browserDiagnostics.acceptanceLoginStatus = loginResponse?.status() ?? null;
  assert.equal(browserDiagnostics.acceptanceLoginStatus, 200);
  const initialAuthMeResponse = await initialAuthMeResponsePromise;
  authMeStatus = initialAuthMeResponse.status();
  browserDiagnostics.acceptanceAuthMeStatus = authMeStatus;
  assert.equal(authMeStatus, 401);
  browserDiagnostics.acceptanceExpectedAuthProbeConsoleErrors =
    expectedAuthProbeConsoleErrorCount;
  await page.getByRole("heading", { name: "Iniciar sesión" }).waitFor();
  assert.ok(await page.getByLabel("Correo electrónico").isVisible());
  assert.ok(await page.getByLabel("Contraseña", { exact: true }).isVisible());
  assert.ok(
    await page
      .getByRole("link", { name: "¿Olvidaste tu contraseña?" })
      .isVisible(),
  );
  await page.evaluate(() => {
    window.__sigecomSpaNavigationProbe = true;
  });
  await captureSafeScreenshot(page, "login-desktop.png");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [768, 1024],
    [390, 844],
  ]) {
    await assertNoHorizontalOverflow(page, width, height);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click();
  await page.getByRole("heading", { name: "Recuperar contraseña" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__sigecomSpaNavigationProbe === true),
    true,
    "la navegación desde Login debe permanecer dentro de la SPA",
  );
  assert.ok(await page.getByLabel("Correo electrónico").isVisible());
  await captureSafeScreenshot(page, "recuperacion-movil.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureSafeScreenshot(page, "recuperacion-escritorio.png");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [768, 1024],
    [390, 844],
  ]) {
    await assertNoHorizontalOverflow(page, width, height);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const recoveryEmail = page.getByLabel("Correo electrónico");
  await recoveryEmail.fill("correo-no-valido");
  await recoveryEmail.press("Tab");
  await page.getByText("Escribe un correo válido.").waitFor({
    state: "visible",
  });
  assert.equal(
    await recoveryEmail.getAttribute("aria-invalid"),
    "true",
    "el error del correo debe asociarse al campo accesible",
  );
  await recoveryEmail.fill(browserUser.email);

  await stopBrowserApiServer();
  await page.getByRole("button", { name: "Enviar instrucciones" }).click();
  const unavailableError = page
    .getByRole("alert")
    .getByText(
      "No fue posible enviar la solicitud. Inténtalo de nuevo más tarde.",
      { exact: true },
    );
  await unavailableError.waitFor({ state: "visible" });
  assert.equal(await unavailableError.isVisible(), true);
  assert.equal(browserMailbox.length, 0);

  await startBrowserApiServer();
  const activeResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery",
  );
  await observeDisabledSubmit(page, "Enviando solicitud…");
  await page.getByRole("button", { name: "Enviar instrucciones" }).click();
  const activeResponse = await activeResponsePromise;
  await assertDisabledSubmitWasObserved(page);
  publicPayloadForExisting = await activeResponse.json();
  assert.equal(activeResponse.status(), 202);
  assert.equal(publicPayloadForExisting.accepted, true);
  await page.getByRole("status").waitFor({ state: "visible" });
  activeConfirmation = await page.getByRole("status").innerText();
  assert.match(activeConfirmation, /Si la cuenta está activa/);
  allPublicRequestResponses.push({
    status: activeResponse.status(),
    body: publicPayloadForExisting,
    cacheControl: activeResponse.headers()["cache-control"],
  });
  allRecoveryResponses.push(publicPayloadForExisting);
  await waitForMailbox({ mailbox: browserMailbox }, 1);
  recoveryToken = readTokenFromEmail(browserMailbox[0]);
  recoveryLink = `${BROWSER_ORIGIN}/restablecer-contrasena#token=${recoveryToken}`;
  sensitiveValues.add(recoveryLink);

  const csrfAuditBaseline = await recoveryAuditCount();
  const csrfMailboxBaseline = browserMailbox.length;
  const requestWithoutCsrf = await page.evaluate(async (email) => {
    const response = await fetch("/api/v1/auth/password-recovery", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return { status: response.status, body: await response.json() };
  }, browserUser.email);
  const completionWithoutCsrf = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/password-recovery/complete", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(requestWithoutCsrf.status, 403);
  assert.equal(requestWithoutCsrf.body.error.code, "CSRF_VALIDATION_FAILED");
  assert.equal(completionWithoutCsrf.status, 403);
  assert.equal(completionWithoutCsrf.body.error.code, "CSRF_VALIDATION_FAILED");
  assert.equal(await recoveryAuditCount(), csrfAuditBaseline);
  assert.equal(browserMailbox.length, csrfMailboxBaseline);
  allRecoveryResponses.push(
    requestWithoutCsrf.body,
    completionWithoutCsrf.body,
  );

  const authorizationBeforeReset = await snapshotUserAuthorization(
    browserUser.id,
  );
  assert.deepEqual(authorizationBeforeReset, browserUserBefore);
  const issuedTokenHash = hashToken(recoveryToken);
  const [[unconsumedToken]] = await appPool.execute(
    `SELECT consumed_at, revoked_at FROM account_access_tokens
      WHERE token_hash = ? AND purpose = ?`,
    [issuedTokenHash, recoveryPurpose],
  );
  assert.ok(unconsumedToken);
  assert.equal(unconsumedToken.consumed_at, null);
  assert.equal(unconsumedToken.revoked_at, null);

  await page.getByRole("link", { name: "Volver a iniciar sesión" }).click();
  await page.getByRole("heading", { name: "Iniciar sesión" }).waitFor();
  await page.getByLabel("Correo electrónico").fill(browserUser.email);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(browserUser.password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL(`${BROWSER_ORIGIN}/inicio`, { timeout: 20_000 });
  const sessionCookies = await browserContext.cookies(
    `${BROWSER_ORIGIN}/api/v1`,
  );
  const oldSessionCookie = sessionCookies.find(
    (cookie) => cookie.name === "sigecom_session",
  );
  assert.ok(oldSessionCookie);
  assert.equal(oldSessionCookie.httpOnly, true);
  assert.equal(oldSessionCookie.sameSite, "Strict");
  assert.equal(oldSessionCookie.path, "/api/v1");
  assert.equal(
    await page.evaluate(() => {
      const originalPath = window.location.pathname;
      window.history.pushState({}, "", "/api/v1/auth/me");
      const visible = document.cookie
        .split(";")
        .some((cookie) => cookie.trim().startsWith("sigecom_session="));
      window.history.replaceState({}, "", originalPath);
      return visible;
    }),
    false,
    "la cookie de sesión no debe ser legible por JavaScript",
  );
  const [[oldSessionRows]] = await appPool.execute(
    `SELECT COUNT(*) AS total FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL`,
    [browserUser.id],
  );
  assert.equal(Number(oldSessionRows.total), 1);
  const beforeCompletionSessionIds = await appPool.execute(
    `SELECT id FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY id`,
    [browserUser.id],
  );
  assert.equal(beforeCompletionSessionIds[0].length, 1);
  const oldSessionId = beforeCompletionSessionIds[0][0].id;

  await navigateToSensitiveRecoveryLink(page, recoveryLink);
  await page.getByRole("heading", { name: "Establecer contraseña" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.location.hash === ""),
    true,
    "el fragmento con el token debe desaparecer de la URL visible",
  );
  await captureSafeScreenshot(page, "restablecer-escritorio.png");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [768, 1024],
    [390, 844],
  ]) {
    await assertNoHorizontalOverflow(page, width, height);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const newPasswordField = page.getByLabel("Nueva contraseña", { exact: true });
  const confirmPasswordField = page.getByLabel("Confirmar nueva contraseña", {
    exact: true,
  });
  assert.ok(await newPasswordField.isVisible());
  assert.ok(await confirmPasswordField.isVisible());
  const completionRequestBaseline = completionRequestCount;
  await newPasswordField.fill("weak");
  await confirmPasswordField.fill("weak");
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await page.getByText("Usa al menos 12 caracteres.").waitFor({
    state: "visible",
  });
  assert.equal(await newPasswordField.getAttribute("aria-invalid"), "true");
  assert.equal(completionRequestCount, completionRequestBaseline);

  newPassword = makePassword();
  await newPasswordField.fill(newPassword);
  await confirmPasswordField.fill(newPassword);
  const completionResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery/complete",
  );
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  const completedResponse = await completionResponsePromise;
  const completionPayload = await completedResponse.json();
  assert.equal(completedResponse.status(), 200);
  assert.deepEqual(completionPayload, { changed: true });
  allRecoveryResponses.push(completionPayload);
  await page.getByRole("heading", { name: "Contraseña actualizada" }).waitFor();
  assert.match(
    await page.getByRole("status").innerText(),
    /las sesiones anteriores se cerraron/i,
  );
  await captureSafeScreenshot(page, "restablecimiento-completado.png");

  const cookiesAfterRecovery = await browserContext.cookies(
    `${BROWSER_ORIGIN}/api/v1`,
  );
  assert.equal(
    cookiesAfterRecovery.some(
      (cookie) =>
        cookie.name === "sigecom_session" || cookie.name === "sigecom_csrf",
    ),
    false,
  );
  const [oldSessionsAfterRecovery] = await appPool.execute(
    `SELECT id, revoked_at FROM user_sessions
      WHERE user_id = ? ORDER BY id`,
    [browserUser.id],
  );
  const oldSessionAfterRecovery = oldSessionsAfterRecovery.find(
    ({ id }) => String(id) === String(oldSessionId),
  );
  assert.ok(oldSessionAfterRecovery);
  assert.ok(oldSessionAfterRecovery.revoked_at);
  assert.equal(
    await bcrypt.compare(newPassword, await currentUserHash(browserUser.id)),
    true,
  );
  assert.equal(
    await bcrypt.compare(
      browserUser.password,
      await currentUserHash(browserUser.id),
    ),
    false,
  );
  assert.deepEqual(
    await snapshotUserAuthorization(browserUser.id),
    browserUserBefore,
  );
  const [[consumedToken]] = await appPool.execute(
    `SELECT consumed_at, revoked_at FROM account_access_tokens
      WHERE token_hash = ? AND purpose = ?`,
    [issuedTokenHash, recoveryPurpose],
  );
  assert.ok(consumedToken?.consumed_at);
  assert.equal(consumedToken.revoked_at, null);
  const [completionAudits] = await appPool.execute(
    `SELECT details FROM audit_events
      WHERE user_id = ? AND action = 'auth.password_recovery_completed'`,
    [browserUser.id],
  );
  const completionAuditText = JSON.stringify(completionAudits);
  for (const sensitive of [browserUser.password, newPassword, recoveryToken]) {
    assert.equal(completionAuditText.includes(sensitive), false);
  }

  await navigateToSensitiveRecoveryLink(page, recoveryLink);
  await page.getByRole("heading", { name: "Establecer contraseña" }).waitFor();
  assert.equal(await page.evaluate(() => window.location.hash === ""), true);
  const reusePassword = makePassword();
  await page
    .getByLabel("Nueva contraseña", { exact: true })
    .fill(reusePassword);
  await page
    .getByLabel("Confirmar nueva contraseña", { exact: true })
    .fill(reusePassword);
  const reuseResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery/complete",
  );
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  const reuseResponse = await reuseResponsePromise;
  const reusePayload = await reuseResponse.json();
  assert.equal(reuseResponse.status(), 400);
  assert.equal(reusePayload.error.code, "PASSWORD_RECOVERY_LINK_INVALID");
  assert.equal(JSON.stringify(reusePayload).includes(recoveryToken), false);
  allRecoveryResponses.push(reusePayload);
  await page
    .getByRole("heading", { name: "Solicita un enlace nuevo" })
    .waitFor();
  assert.ok(await page.getByRole("alert").isVisible());

  await page.getByRole("link", { name: "Volver a iniciar sesión" }).click();
  await page.getByRole("heading", { name: "Iniciar sesión" }).waitFor();
  await page.getByLabel("Correo electrónico").fill(browserUser.email);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill(browserUser.password);
  const oldPasswordResponsePromise = responseForPost(
    page,
    "/api/v1/auth/login",
  );
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  const oldPasswordResponse = await oldPasswordResponsePromise;
  const oldPasswordPayload = await oldPasswordResponse.json();
  assert.equal(oldPasswordResponse.status(), 401);
  assert.equal(oldPasswordPayload.error.code, "INVALID_CREDENTIALS");
  allRecoveryResponses.push(oldPasswordPayload);
  await page.getByRole("alert").waitFor({ state: "visible" });

  await page.getByLabel("Contraseña", { exact: true }).fill(newPassword);
  const newPasswordLoginResponsePromise = responseForPost(
    page,
    "/api/v1/auth/login",
  );
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  const newPasswordLoginResponse = await newPasswordLoginResponsePromise;
  assert.equal(newPasswordLoginResponse.status(), 200);
  assert.equal(
    await newPasswordLoginResponse
      .json()
      .then((payload) => Object.hasOwn(payload, "token")),
    false,
  );
  await page.waitForURL(`${BROWSER_ORIGIN}/inicio`, { timeout: 20_000 });
  const activeSessionsAfterNewLogin = await appPool.execute(
    `SELECT COUNT(*) AS total FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL`,
    [browserUser.id],
  );
  assert.equal(Number(activeSessionsAfterNewLogin[0][0].total), 1);

  const registrationProbe = await page.evaluate(async () => {
    const csrfResponse = await fetch("/api/v1/auth/csrf", {
      credentials: "include",
    });
    const csrfPayload = await csrfResponse.json();
    const response = await fetch("/api/v1/auth/register", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfPayload.csrfToken,
      },
      body: JSON.stringify({}),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(registrationProbe.status, 404);
  allRecoveryResponses.push(registrationProbe.body);

  const inactiveMailboxBaseline = browserMailbox.length;
  await page.goto(`${BROWSER_ORIGIN}/recuperar-contrasena`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Recuperar contraseña" }).waitFor();
  await page.getByLabel("Correo electrónico").fill(inactiveUser.email);
  const inactiveResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery",
  );
  await page.getByRole("button", { name: "Enviar instrucciones" }).click();
  const inactiveResponse = await inactiveResponsePromise;
  const inactivePayload = await inactiveResponse.json();
  assert.equal(inactiveResponse.status(), 202);
  assert.deepEqual(inactivePayload, publicPayloadForExisting);
  assert.equal(browserMailbox.length, inactiveMailboxBaseline);
  await page.getByRole("status").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("status").innerText(), activeConfirmation);
  allPublicRequestResponses.push({
    status: inactiveResponse.status(),
    body: inactivePayload,
    cacheControl: inactiveResponse.headers()["cache-control"],
  });
  allRecoveryResponses.push(inactivePayload);

  const missingEmail = `missing.${runId}@example.invalid`;
  sensitiveValues.add(missingEmail);
  await page.goto(`${BROWSER_ORIGIN}/recuperar-contrasena`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Correo electrónico").fill(missingEmail);
  const missingResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery",
  );
  await page.getByRole("button", { name: "Enviar instrucciones" }).click();
  const missingResponse = await missingResponsePromise;
  const missingPayload = await missingResponse.json();
  assert.equal(missingResponse.status(), 202);
  assert.deepEqual(missingPayload, publicPayloadForExisting);
  assert.equal(browserMailbox.length, inactiveMailboxBaseline);
  await page.getByRole("status").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("status").innerText(), activeConfirmation);
  allPublicRequestResponses.push({
    status: missingResponse.status(),
    body: missingPayload,
    cacheControl: missingResponse.headers()["cache-control"],
  });
  allRecoveryResponses.push(missingPayload);

  await page.goto(`${BROWSER_ORIGIN}/recuperar-contrasena`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Correo electrónico").fill(browserExpiryUser.email);
  const expiredIssueResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery",
  );
  await page.getByRole("button", { name: "Enviar instrucciones" }).click();
  const expiredIssueResponse = await expiredIssueResponsePromise;
  const expiredIssuePayload = await expiredIssueResponse.json();
  assert.equal(expiredIssueResponse.status(), 202);
  assert.deepEqual(expiredIssuePayload, publicPayloadForExisting);
  allPublicRequestResponses.push({
    status: expiredIssueResponse.status(),
    body: expiredIssuePayload,
    cacheControl: expiredIssueResponse.headers()["cache-control"],
  });
  allRecoveryResponses.push(expiredIssuePayload);
  await waitForMailbox({ mailbox: browserMailbox }, 2);
  const expiredToken = readTokenFromEmail(browserMailbox[1]);
  const expiredTokenHash = hashToken(expiredToken);
  sensitiveValues.add(
    `${BROWSER_ORIGIN}/restablecer-contrasena#token=${expiredToken}`,
  );
  const [expiryUpdate] = await appPool.execute(
    `UPDATE account_access_tokens
        SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL`,
    [expiredTokenHash, recoveryPurpose],
  );
  assert.equal(expiryUpdate.affectedRows, 1);
  await navigateToSensitiveRecoveryLink(
    page,
    `${BROWSER_ORIGIN}/restablecer-contrasena#token=${expiredToken}`,
  );
  await page.getByRole("heading", { name: "Establecer contraseña" }).waitFor();
  assert.equal(await page.evaluate(() => window.location.hash === ""), true);
  const expiredAttemptPassword = makePassword();
  await page
    .getByLabel("Nueva contraseña", { exact: true })
    .fill(expiredAttemptPassword);
  await page
    .getByLabel("Confirmar nueva contraseña", { exact: true })
    .fill(expiredAttemptPassword);
  const expiredCompletionResponsePromise = responseForPost(
    page,
    "/api/v1/auth/password-recovery/complete",
  );
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  const expiredCompletionResponse = await expiredCompletionResponsePromise;
  const expiredCompletionPayload = await expiredCompletionResponse.json();
  assert.equal(expiredCompletionResponse.status(), 400);
  assert.equal(
    expiredCompletionPayload.error.code,
    "PASSWORD_RECOVERY_LINK_INVALID",
  );
  assert.equal(
    JSON.stringify(expiredCompletionPayload).includes(expiredToken),
    false,
  );
  allRecoveryResponses.push(expiredCompletionPayload);
  await page
    .getByRole("heading", { name: "Solicita un enlace nuevo" })
    .waitFor();
  await page.getByRole("alert").waitFor({ state: "visible" });
  await captureSafeScreenshot(page, "enlace-vencido.png");
  assert.equal(
    await bcrypt.compare(
      browserExpiryUser.password,
      await currentUserHash(browserExpiryUser.id),
    ),
    true,
  );
  assert.equal(
    (await currentUserHash(browserExpiryUser.id)) === browserExpiryHashBefore,
    true,
  );
  assert.deepEqual(
    await snapshotUserAuthorization(browserExpiryUser.id),
    browserExpiryAuthorizationBefore,
  );
  await waitForRecoveryAuditCount(baselineRecoveryAudits + 4);
  await runBrowserCacheIsolation(page);

  assert.equal(
    pageErrorCount,
    0,
    "el recorrido del navegador no debe lanzar errores React",
  );
  assert.equal(
    consoleErrorCount,
    0,
    "el recorrido del navegador no debe emitir errores de consola",
  );
  browserDiagnostics.acceptanceExpectedHttpConsoleErrors =
    expectedHttpConsoleErrorCount;
  browserDiagnostics.acceptanceExpectedAuthProbeConsoleErrors =
    expectedAuthProbeConsoleErrorCount;
  browserDiagnostics.acceptanceUnexpectedConsoleErrorPaths =
    unexpectedConsoleErrorPaths;
  assert.ok(browserVisualFiles.length >= 5);
  browserMailbox.splice(0);
  sensitiveValues.add(recoveryToken);
  sensitiveValues.add(expiredToken);
}

async function recoveryAuditCount() {
  const [[row]] = await appPool.execute(
    `SELECT COUNT(*) AS total
       FROM audit_events
      WHERE action = 'auth.password_recovery_requested'`,
  );
  return Number(row.total);
}

async function currentUserHash(userId) {
  const [[row]] = await appPool.execute(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId],
  );
  return row.password_hash;
}

async function seedWrongPurposeToken(userId) {
  const token = randomBytes(32).toString("base64url");
  sensitiveValues.add(token);
  const connection = await appPool.getConnection();
  try {
    await connection.query("SET SESSION check_constraint_checks = OFF");
    await connection.execute(
      `INSERT INTO account_access_tokens
         (user_id, token_hash, purpose, expires_at)
       VALUES (?, ?, 'account_invitation',
          DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
      [userId, hashToken(token)],
    );
  } finally {
    await connection
      .query("SET SESSION check_constraint_checks = ON")
      .catch(() => {});
    connection.release();
  }
  return token;
}

async function closeConnections() {
  if (provisionerConnection) {
    await provisionerConnection.end();
    provisionerConnection = null;
  }
  if (migratorConnection) {
    await migratorConnection.end();
    migratorConnection = null;
  }
  if (appPool) {
    try {
      if (runnerConfig.mode === "RUN") {
        const fixtureUserIds = [
          legacyUser,
          migrationLegacyUser,
          inactiveUser,
          pendingUser,
          concurrentUser,
          expiryUser,
          mailFailureUser,
          browserUser,
          browserExpiryUser,
        ]
          .filter(Boolean)
          .map(({ id }) => id);
        if (fixtureUserIds.length > 0) {
          await appPool.execute(
            `UPDATE user_sessions
                SET revoked_at = UTC_TIMESTAMP(3)
              WHERE revoked_at IS NULL
                AND user_id IN (${fixtureUserIds.map(() => "?").join(", ")})`,
            fixtureUserIds,
          );
        }
      }
    } finally {
      await appPool.end();
      appPool = null;
    }
  }
}

test(
  "Incremento 1D: recuperación y restablecimiento en navegador y MariaDB aislados",
  { concurrency: false },
  async (context) => {
    try {
      if (runnerConfig.mode === "DDL-CHECK") {
        await context.test(
          "chequeo DDL aislado y aprobado, separado del RUN funcional",
          runAuthorizedDdlChecks,
        );
        return;
      }

      let browserPrepared = false;
      await context.test(
        "preflight de Login y recuperación visual sin acceso SQL",
        async () => {
          await preflightBrowserInfrastructure();
          assertBrowserInfrastructureReady();
          await preflightRecoveryControls();
          assert.equal(
            browserDiagnostics.preflightRecoveryControls?.complete,
            true,
            "el preflight debe recorrer los controles de recuperación sin SQL",
          );
          browserPrepared = true;
        },
      );
      if (!browserPrepared) return;
      if (runnerConfig.mode === "PRE-FLIGHT") return;

      let prepared = false;
      await context.test(
        runnerConfig.mode === "PROVISION"
          ? "provisión explícita del esquema, permisos, migraciones y fixtures"
          : "reutilización de esquema autorizado sin provisionar ni migrar",
        async () => {
          await executeAccountAccessMode(runnerConfig, {
            PROVISION: provisionIsolatedResources,
            "DDL-CHECK": runAuthorizedDdlChecks,
            RUN: reuseAuthorizedResources,
          });
          prepared = true;
          assert.deepEqual(resources.appliedMigrations, migrationVersions);
        },
      );
      if (!prepared) return;
      if (runnerConfig.mode === "PROVISION") return;

      await context.test(
        "Login HTTP acepta una cuenta legacy migrada",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const response = await request(harness.app)
            .post("/api/v1/auth/login")
            .set("Origin", FRONTEND_ORIGIN)
            .set("Cookie", csrf.csrfCookie)
            .set("X-CSRF-Token", csrf.csrfToken)
            .send({
              email: migrationLegacyUser.email,
              password: migrationLegacyUser.password,
            })
            .expect(200);

          assert.equal(response.body.user.email, migrationLegacyUser.email);
          assert.equal(response.body.user.role, "seller");
          assert.equal(Object.hasOwn(response.body, "token"), false);
          const sessionCookie = response.headers["set-cookie"]
            .find((cookie) => cookie.startsWith("sigecom_session="))
            .split(";", 1)[0];
          const me = await request(harness.app)
            .get("/api/v1/auth/me")
            .set("Cookie", sessionCookie)
            .expect(200);
          assert.equal(me.body.user.email, migrationLegacyUser.email);
          await request(harness.app)
            .post("/api/v1/auth/logout")
            .set("Origin", FRONTEND_ORIGIN)
            .set(
              "Cookie",
              response.headers["set-cookie"]
                .map((cookie) => cookie.split(";", 1)[0])
                .join("; "),
            )
            .set("X-CSRF-Token", response.body.csrfToken)
            .expect(204);

          const attemptCsrf = await csrfContext(harness.app);
          const attemptLogin = await request(harness.app)
            .post("/api/v1/auth/login")
            .set("Origin", FRONTEND_ORIGIN)
            .set("Cookie", attemptCsrf.csrfCookie)
            .set("X-CSRF-Token", attemptCsrf.csrfToken)
            .send({ email: legacyUser.email, password: legacyUser.password })
            .expect(200);
          legacyUser.sessionCookie = attemptLogin.headers["set-cookie"]
            .find((cookie) => cookie.startsWith("sigecom_session="))
            .split(";", 1)[0];

          const [sessions] = await appPool.execute(
            "SELECT id, revoked_at FROM user_sessions WHERE user_id = ?",
            [legacyUser.id],
          );
          assert.equal(sessions.length, 1);
          assert.equal(sessions[0].revoked_at, null);
        },
      );

      await context.test(
        "solicitudes existente/inexistente tienen la misma respuesta HTTP",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const existing = await postRecovery(
            harness.app,
            legacyUser.email,
            csrf,
          );
          const missing = await postRecovery(
            harness.app,
            `missing.${runId}@example.invalid`,
            csrf,
          );
          await waitForRecoveryAuditCount(baseline + 2);
          await waitForMailbox(harness, 1);

          assert.equal(existing.status, 202);
          assert.equal(missing.status, 202);
          assert.deepEqual(existing.body, missing.body);
          assert.equal(existing.headers["cache-control"], "no-store");
          assert.equal(missing.headers["cache-control"], "no-store");
          assert.equal(harness.mailbox.length, 1);
          const token = readTokenFromEmail(harness.mailbox[0]);
          const [[tokenRow]] = await appPool.execute(
            `SELECT token_hash FROM account_access_tokens
              WHERE token_hash = ? AND purpose = ?`,
            [hashToken(token), recoveryPurpose],
          );
          assert.ok(tokenRow);
          assert.equal(tokenRow.token_hash === token, false);
          assert.equal(
            JSON.stringify(existing.body).includes(legacyUser.email),
            false,
          );
          allRecoveryResponses.push(existing.body, missing.body);
          allPublicRequestResponses.push(
            {
              status: existing.status,
              body: existing.body,
              cacheControl: existing.headers["cache-control"],
            },
            {
              status: missing.status,
              body: missing.body,
              cacheControl: missing.headers["cache-control"],
            },
          );

          const [[session]] = await appPool.execute(
            "SELECT revoked_at FROM user_sessions WHERE user_id = ?",
            [legacyUser.id],
          );
          assert.equal(session.revoked_at, null);
        },
      );

      await context.test(
        "cuentas inactivas e invitaciones pendientes no reciben correo",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const inactive = await postRecovery(
            harness.app,
            inactiveUser.email,
            csrf,
          );
          const pending = await postRecovery(
            harness.app,
            pendingUser.email,
            csrf,
          );
          await waitForRecoveryAuditCount(baseline + 2);

          assert.equal(inactive.status, 202);
          assert.equal(pending.status, 202);
          assert.deepEqual(inactive.body, pending.body);
          assert.equal(harness.mailbox.length, 0);
          allRecoveryResponses.push(inactive.body, pending.body);
          allPublicRequestResponses.push(
            {
              status: inactive.status,
              body: inactive.body,
              cacheControl: inactive.headers["cache-control"],
            },
            {
              status: pending.status,
              body: pending.body,
              cacheControl: pending.headers["cache-control"],
            },
          );
        },
      );

      await context.test(
        "repetir solicitudes emite hashes distintos sin revocar sesiones",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const first = await postRecovery(harness.app, legacyUser.email, csrf);
          const second = await postRecovery(
            harness.app,
            legacyUser.email,
            csrf,
          );
          await waitForRecoveryAuditCount(baseline + 2);
          await waitForMailbox(harness, 2);
          assert.equal(first.status, 202);
          assert.equal(second.status, 202);
          assert.deepEqual(first.body, second.body);
          assert.equal(harness.mailbox.length, 2);

          const tokens = harness.mailbox.map(readTokenFromEmail);
          assert.equal(tokens[0] === tokens[1], false);
          const [stored] = await appPool.execute(
            `SELECT token_hash, purpose, expires_at, consumed_at, revoked_at,
                    TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), expires_at) AS seconds_left
               FROM account_access_tokens
              WHERE user_id = ? AND purpose = ?
              ORDER BY id DESC LIMIT 2`,
            [legacyUser.id, recoveryPurpose],
          );
          assert.equal(stored.length, 2);
          assert.equal(
            JSON.stringify(
              stored.map(({ token_hash }) => token_hash).sort(),
            ) === JSON.stringify(tokens.map(hashToken).sort()),
            true,
          );
          assert.ok(
            stored.every(({ token_hash }) => !tokens.includes(token_hash)),
          );
          assert.ok(
            stored.every(
              ({ seconds_left, consumed_at, revoked_at }) =>
                Number(seconds_left) >= 1780 &&
                consumed_at === null &&
                revoked_at === null,
            ),
          );

          const [[session]] = await appPool.execute(
            "SELECT revoked_at FROM user_sessions WHERE user_id = ?",
            [legacyUser.id],
          );
          assert.equal(session.revoked_at, null);
          legacyUser.recoveryToken = tokens[1];
          allPublicRequestResponses.push(
            {
              status: first.status,
              body: first.body,
              cacheControl: first.headers["cache-control"],
            },
            {
              status: second.status,
              body: second.body,
              cacheControl: second.headers["cache-control"],
            },
          );
        },
      );

      await context.test(
        "CSRF protege las solicitudes antes de cualquier escritura de negocio",
        async () => {
          const harness = createHttpHarness();
          const baseline = await recoveryAuditCount();
          const response = await request(harness.app)
            .post("/api/v1/auth/password-recovery")
            .set("Origin", FRONTEND_ORIGIN)
            .send({ email: legacyUser.email })
            .expect(403);
          assert.equal(response.body.error.code, "CSRF_VALIDATION_FAILED");
          assert.equal(await recoveryAuditCount(), baseline);
          assert.equal(harness.mailbox.length, 0);
        },
      );

      await context.test(
        "política de contraseña rechaza valores débiles sin consumir el enlace",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const beforeHash = await currentUserHash(legacyUser.id);
          const weakPassword = "weak-password";
          sensitiveValues.add(weakPassword);
          const response = await postCompletion(
            harness.app,
            {
              token: legacyUser.recoveryToken,
              newPassword: weakPassword,
              confirmPassword: weakPassword,
            },
            csrf,
          );
          assert.equal(response.status, 400);
          assert.equal(
            await bcrypt.compare(
              legacyUser.password,
              await currentUserHash(legacyUser.id),
            ),
            true,
          );
          assert.equal(await currentUserHash(legacyUser.id), beforeHash);
          const [[tokenRow]] = await appPool.execute(
            "SELECT consumed_at FROM account_access_tokens WHERE token_hash = ?",
            [hashToken(legacyUser.recoveryToken)],
          );
          assert.equal(tokenRow.consumed_at, null);
          allRecoveryResponses.push(response.body);
          assert.equal(
            JSON.stringify(response.body).includes(legacyUser.recoveryToken),
            false,
          );
        },
      );

      await context.test(
        "la recuperación exitosa consume el enlace y revoca las sesiones",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const nextPassword = makePassword();

          const completed = await postCompletion(
            harness.app,
            {
              token: legacyUser.recoveryToken,
              newPassword: nextPassword,
              confirmPassword: nextPassword,
            },
            csrf,
          );
          assert.equal(completed.status, 200);
          assert.deepEqual(completed.body, { changed: true });
          assert.ok(
            completed.headers["set-cookie"].some((cookie) =>
              cookie.startsWith("sigecom_session=;"),
            ),
          );
          assert.ok(
            completed.headers["set-cookie"].some((cookie) =>
              cookie.startsWith("sigecom_csrf=;"),
            ),
          );
          assert.equal(
            await bcrypt.compare(
              nextPassword,
              await currentUserHash(legacyUser.id),
            ),
            true,
          );
          const [sessions] = await appPool.execute(
            "SELECT revoked_at FROM user_sessions WHERE user_id = ?",
            [legacyUser.id],
          );
          assert.ok(sessions.length > 0);
          assert.ok(sessions.every(({ revoked_at }) => revoked_at !== null));
          const [[consumedToken]] = await appPool.execute(
            `SELECT consumed_at, revoked_at FROM account_access_tokens
              WHERE token_hash = ?`,
            [hashToken(legacyUser.recoveryToken)],
          );
          assert.ok(consumedToken.consumed_at);
          assert.equal(consumedToken.revoked_at, null);

          const sessionCheck = await request(harness.app)
            .get("/api/v1/auth/me")
            .set("Cookie", legacyUser.sessionCookie);
          assert.equal(sessionCheck.status, 401);
          allRecoveryResponses.push(completed.body, sessionCheck.body);

          const reused = await postCompletion(
            harness.app,
            validCompletionPayload(legacyUser.recoveryToken),
            csrf,
          );
          assert.equal(reused.status, 400);
          assert.equal(
            reused.body.error.code,
            "PASSWORD_RECOVERY_LINK_INVALID",
          );
          allRecoveryResponses.push(reused.body);
        },
      );

      await context.test(
        "enlaces expirados, alterados y de otro propósito son rechazados",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const issued = await postRecovery(
            harness.app,
            expiryUser.email,
            csrf,
          );
          assert.equal(issued.status, 202);
          await waitForRecoveryAuditCount(baseline + 1);
          await waitForMailbox(harness, 1);
          const token = readTokenFromEmail(harness.mailbox[0]);

          const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
          const invalidToken = await postCompletion(
            harness.app,
            validCompletionPayload(altered),
            csrf,
          );
          assert.equal(invalidToken.status, 400);
          assert.equal(
            invalidToken.body.error.code,
            "PASSWORD_RECOVERY_LINK_INVALID",
          );

          await appPool.execute(
            `UPDATE account_access_tokens
                SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
              WHERE token_hash = ?`,
            [hashToken(token)],
          );
          const expired = await postCompletion(
            harness.app,
            validCompletionPayload(token),
            csrf,
          );
          assert.equal(expired.status, 400);
          assert.equal(
            expired.body.error.code,
            "PASSWORD_RECOVERY_LINK_INVALID",
          );

          const wrongPurposeToken = await seedWrongPurposeToken(expiryUser.id);
          const wrongPurpose = await postCompletion(
            harness.app,
            validCompletionPayload(wrongPurposeToken),
            csrf,
          );
          assert.equal(wrongPurpose.status, 400);
          assert.equal(
            wrongPurpose.body.error.code,
            "PASSWORD_RECOVERY_LINK_INVALID",
          );
          allRecoveryResponses.push(
            invalidToken.body,
            expired.body,
            wrongPurpose.body,
          );
        },
      );

      await context.test(
        "dos consumos simultáneos producen exactamente un éxito",
        async () => {
          const harness = createHttpHarness();
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const issued = await postRecovery(
            harness.app,
            concurrentUser.email,
            csrf,
          );
          assert.equal(issued.status, 202);
          await waitForRecoveryAuditCount(baseline + 1);
          await waitForMailbox(harness, 1);
          const token = readTokenFromEmail(harness.mailbox[0]);
          const passwords = [makePassword(), makePassword()];

          const responses = await Promise.all(
            passwords.map((password) =>
              postCompletion(
                harness.app,
                {
                  token,
                  newPassword: password,
                  confirmPassword: password,
                },
                csrf,
              ),
            ),
          );
          assert.deepEqual(
            responses.map(({ status }) => status).sort(),
            [200, 400],
          );
          const [[user]] = await appPool.execute(
            "SELECT password_hash FROM users WHERE id = ?",
            [concurrentUser.id],
          );
          assert.equal(
            passwords.some((password) =>
              bcrypt.compareSync(password, user.password_hash),
            ),
            true,
          );
          const [[completedCount]] = await appPool.execute(
            `SELECT COUNT(*) AS total FROM audit_events
              WHERE user_id = ? AND action = 'auth.password_recovery_completed'`,
            [concurrentUser.id],
          );
          assert.equal(Number(completedCount.total), 1);
          allRecoveryResponses.push(...responses.map(({ body }) => body));
        },
      );

      await context.test(
        "fallo del transportador simulado no filtra estado ni deja token utilizable",
        async () => {
          const harness = createHttpHarness({ failMail: true });
          const csrf = await csrfContext(harness.app);
          const baseline = await recoveryAuditCount();
          const response = await postRecovery(
            harness.app,
            mailFailureUser.email,
            csrf,
          );
          assert.equal(response.status, 202);
          assert.equal(response.body.accepted, true);
          await waitForRecoveryAuditCount(baseline + 1);
          await waitForMailbox(harness, 1);
          const token = readTokenFromEmail(harness.mailbox[0]);
          await waitForCondition(
            async () => {
              const [[row]] = await appPool.execute(
                `SELECT revoked_at FROM account_access_tokens
                  WHERE token_hash = ? AND purpose = ?`,
                [hashToken(token), recoveryPurpose],
              );
              return row?.revoked_at ? 1 : 0;
            },
            1,
            "la revocación tras el fallo de correo",
          );
          assert.equal(
            JSON.stringify(allLogs).includes(
              "simulated provider failure secret",
            ),
            false,
          );
          allPublicRequestResponses.push({
            status: response.status,
            body: response.body,
            cacheControl: response.headers["cache-control"],
          });
          allRecoveryResponses.push(response.body);
        },
      );

      await context.test(
        "recuperación completa en navegador real contra la API y MariaDB aisladas",
        async () => {
          await runBrowserAcceptance();
        },
      );

      await context.test(
        "respuestas y registros no contienen credenciales ni enlaces de recuperación",
        async () => {
          const serializedResponses = JSON.stringify(allRecoveryResponses);
          const serializedLogs = JSON.stringify(allLogs);
          for (const value of sensitiveValues) {
            assert.equal(serializedResponses.includes(value), false);
            assert.equal(serializedLogs.includes(value), false);
          }
          assert.equal(serializedResponses.includes("#token="), false);
          assert.equal(serializedLogs.includes("#token="), false);
          assert.equal(
            serializedLogs.includes("simulated provider failure secret"),
            false,
          );
          assert.ok(allPublicRequestResponses.length > 0);
          const baseline = allPublicRequestResponses[0];
          for (const response of allPublicRequestResponses) {
            assert.equal(response.status, baseline.status);
            assert.deepEqual(response.body, baseline.body);
            assert.equal(response.cacheControl, baseline.cacheControl);
          }
        },
      );
    } finally {
      await closeBrowserInfrastructure();
      browserDiagnostics.portsFreeAfterClose =
        runnerConfig.mode === "DDL-CHECK"
          ? true
          : await browserPortsAreAvailable();
      await closeConnections();
      console.log(
        JSON.stringify({
          isolatedResources: resources,
          resourceOwnership:
            resourceOwnershipRecord ??
            resourceOwnershipLedger?.snapshot() ??
            null,
          resourceOwnershipPath: resourceOwnershipLedger?.path ?? null,
          browserDiagnostics,
          provisionerConnectionClosed: provisionerConnection === null,
          cleanup:
            runnerConfig.mode === "PRE-FLIGHT"
              ? "preflight sin conexión SQL; no se crearon recursos"
              : runnerConfig.mode === "PROVISION"
                ? "provisión explícita; esquema, cuentas, migraciones y fixtures registrados y retenidos"
                : runnerConfig.mode === "DDL-CHECK"
                  ? "DDL-CHECK separado; sólo sondas explícitamente aprobadas en esquema existente"
                  : "RUN usa sólo APP con permisos DML; esquema retenido y sin operaciones DDL",
        }),
      );
      assert.equal(browserDiagnostics.portsFreeAfterClose, true);
    }
  },
);
