import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIntegrationTestEnvironment,
  dispatchAccountAccessMode,
  executeAccountAccessMode,
  getAccountAccessE2EConfig,
} from "./account-access-email-e2e-runner.js";
import * as accountAccessRunner from "./account-access-email-e2e-runner.js";

const runId = "20261119040000_aaaaaaaa";
const attemptId = "20261119040001_bbbbbbbb";
const schema = `sigecom_e2e_tmp_${runId}`;

test("frontend preflight resolves the matching release candidate worktree", () => {
  const resolveFrontendDirectory =
    accountAccessRunner.resolveAccountAccessFrontendDirectory;
  assert.equal(typeof resolveFrontendDirectory, "function");
  const backendDirectory = "C:\\project\\worktrees\\backend-release-candidate";
  const frontendDirectory = resolveFrontendDirectory(
    backendDirectory,
    (candidate) =>
      candidate ===
      "C:\\project\\worktrees\\frontend-release-candidate\\vite.config.js",
  );

  assert.equal(
    frontendDirectory,
    "C:\\project\\worktrees\\frontend-release-candidate",
  );
});

function approvedEnv(overrides = {}) {
  return {
    SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
    SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: "app-secret-".padEnd(40, "a"),
    SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD: "migrator-secret-".padEnd(
      40,
      "b",
    ),
    SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD: "fixture-secret-".padEnd(40, "c"),
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "provisioner-secret-".padEnd(
      40,
      "d",
    ),
    ...overrides,
  };
}

test("PRE-FLIGHT does not require or infer any SQL target or credentials", () => {
  assert.deepEqual(getAccountAccessE2EConfig("PRE-FLIGHT", {}), {
    mode: "PRE-FLIGHT",
    runId: null,
    attemptId: null,
    schema: null,
    credentials: null,
  });
});

test("PRE-FLIGHT child receives no SQL credentials or target identifiers", () => {
  const config = getAccountAccessE2EConfig("PRE-FLIGHT", {
    SIGECOM_ACCOUNT_ACCESS_MODE: "PRE-FLIGHT",
    SIGECOM_ACCOUNT_ACCESS_RUN_ID: "invalid",
    SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: "invalid",
  });
  const childEnvironment = createIntegrationTestEnvironment(config, {
    PATH: "safe-path",
    SystemRoot: "safe-system-root",
    NODE_ENV: "test",
    DB_ROOT_PASSWORD: "must-not-be-forwarded",
    MYSQL_PWD: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_MODE: "PRE-FLIGHT",
    SIGECOM_ACCOUNT_ACCESS_RUN_ID: "invalid",
    SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: "invalid",
    SIGECOM_ACCOUNT_ACCESS_ADMIN_PASSWORD: "must-not-be-forwarded",
  });

  assert.deepEqual(childEnvironment, {
    PATH: "safe-path",
    SystemRoot: "safe-system-root",
    NODE_ENV: "test",
    SIGECOM_ACCOUNT_ACCESS_MODE: "PRE-FLIGHT",
  });
});

test("RUN child receives only APP and fixture credentials with exact authorization", () => {
  const config = getAccountAccessE2EConfig(
    "RUN",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
    }),
  );
  const childEnvironment = createIntegrationTestEnvironment(config, {
    PATH: "safe-path",
    USERPROFILE: "safe-profile",
    NODE_ENV: "test",
    MYSQL_PWD: "must-not-be-forwarded",
    DB_ROOT_PASSWORD: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_ADMIN_PASSWORD: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: "stale-provision-auth",
  });

  assert.equal(childEnvironment.PATH, "safe-path");
  assert.equal(childEnvironment.USERPROFILE, "safe-profile");
  assert.equal(childEnvironment.NODE_ENV, "test");
  assert.equal(childEnvironment.SIGECOM_ACCOUNT_ACCESS_MODE, "RUN");
  assert.equal(childEnvironment.SIGECOM_ACCOUNT_ACCESS_RUN_ID, runId);
  assert.equal(childEnvironment.SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID, attemptId);
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA,
    schema,
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD,
    approvedEnv().SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD,
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD,
    approvedEnv().SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD,
  );
  for (const key of [
    "MYSQL_PWD",
    "DB_ROOT_PASSWORD",
    "SIGECOM_ACCOUNT_ACCESS_ADMIN_PASSWORD",
    "SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID",
    "SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD",
    "SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER",
    "SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD",
  ]) {
    assert.equal(Object.hasOwn(childEnvironment, key), false);
  }
});

test("PROVISION requires distinct explicit IDs, credentials, and exact approval", () => {
  assert.throws(
    () => getAccountAccessE2EConfig("PROVISION", approvedEnv()),
    /aprobación.*PROVISION/i,
  );

  const config = getAccountAccessE2EConfig(
    "PROVISION",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
    }),
  );
  assert.equal(config.schema, schema);
  assert.equal(config.runId, runId);
  assert.equal(config.attemptId, attemptId);

  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "PROVISION",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: runId,
        }),
      ),
    /RUN_ID.*ATTEMPT_ID.*distintos/i,
  );
  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "PROVISION",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: "",
        }),
      ),
    /credenciales aisladas/i,
  );
});

test("PROVISION requires an explicit non-root provisioner identity and secret", () => {
  const baseEnvironment = approvedEnv({
    SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
  });

  for (const overrides of [
    {
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: undefined,
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: undefined,
    },
    {
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "root",
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "provisioner-secret-".padEnd(
        40,
        "d",
      ),
    },
    {
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "ROOT",
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "provisioner-secret-".padEnd(
        40,
        "d",
      ),
    },
    {
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "short",
    },
    {
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD:
        approvedEnv().SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD,
    },
  ]) {
    assert.throws(
      () =>
        getAccountAccessE2EConfig("PROVISION", {
          ...baseEnvironment,
          ...overrides,
        }),
      /identidad.*aprovisionamiento|provisioner/i,
    );
  }

  const config = getAccountAccessE2EConfig("PROVISION", {
    ...baseEnvironment,
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "provisioner-secret-".padEnd(
      40,
      "d",
    ),
  });
  assert.equal(config.provisioner.user, "sigecom_e2e_provisioner");
});

test("RECOVER requires exact approval for the existing partial RUN_ID", () => {
  const environment = approvedEnv({
    SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID: runId,
  });
  const config = getAccountAccessE2EConfig("RECOVER", environment);

  assert.equal(config.mode, "RECOVER");
  assert.equal(config.runId, runId);
  assert.equal(config.schema, schema);
  assert.throws(
    () =>
      getAccountAccessE2EConfig("RECOVER", {
        ...environment,
        SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID:
          "20261119040002_cccccccc",
      }),
    /aprobaci[oó]n.*RECOVER/i,
  );
});

test("RECOVER dispatches through the existing integration-test entry point", async () => {
  const config = getAccountAccessE2EConfig(
    "RECOVER",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID: runId,
    }),
  );
  const result = await dispatchAccountAccessMode(
    config,
    async (selectedConfig) => `${selectedConfig.mode}:dispatched`,
  );

  assert.equal(result, "RECOVER:dispatched");
});

test("PROVISION forwards only its explicit provisioner credentials to its child", () => {
  const environment = approvedEnv({
    SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "provisioner-secret-".padEnd(
      40,
      "d",
    ),
  });
  const config = getAccountAccessE2EConfig("PROVISION", environment);
  const childEnvironment = createIntegrationTestEnvironment(config, {
    PATH: "safe-path",
    NODE_ENV: "test",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "sigecom_e2e_provisioner",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD:
      environment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD,
    MYSQL_PWD: "must-not-be-forwarded",
    DB_ROOT_PASSWORD: "must-not-be-forwarded",
  });

  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER,
    "sigecom_e2e_provisioner",
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD,
    environment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD,
  );
  assert.equal(Object.hasOwn(childEnvironment, "DB_ROOT_PASSWORD"), false);
  assert.equal(Object.hasOwn(childEnvironment, "MYSQL_PWD"), false);
});

test("RECOVER forwards only its approved target and isolated recovery credentials", () => {
  const environment = approvedEnv({
    SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID: runId,
  });
  const config = getAccountAccessE2EConfig("RECOVER", environment);
  const childEnvironment = createIntegrationTestEnvironment(config, {
    PATH: "safe-path",
    NODE_ENV: "test",
    SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: "must-not-forward",
    MYSQL_PWD: "must-not-forward",
  });

  assert.equal(childEnvironment.SIGECOM_ACCOUNT_ACCESS_MODE, "RECOVER");
  assert.equal(childEnvironment.SIGECOM_ACCOUNT_ACCESS_RUN_ID, runId);
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_RECOVERY_APPROVED_RUN_ID,
    runId,
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD,
    environment.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD,
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD,
    environment.SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD,
  );
  assert.equal(
    Object.hasOwn(
      childEnvironment,
      "SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID",
    ),
    false,
  );
  assert.equal(Object.hasOwn(childEnvironment, "MYSQL_PWD"), false);
});

test("RUN does not require or forward provisioner or migrator credentials", () => {
  const config = getAccountAccessE2EConfig(
    "RUN",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD: undefined,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "must-not-be-forwarded",
      SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "must-not-be-forwarded",
    }),
  );
  const childEnvironment = createIntegrationTestEnvironment(config, {
    PATH: "safe-path",
    NODE_ENV: "test",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "must-not-be-forwarded",
  });

  assert.equal(config.credentials.migratorPassword, undefined);
  assert.equal(
    Object.hasOwn(childEnvironment, "SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      childEnvironment,
      "SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD",
    ),
    false,
  );
  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "RUN",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: undefined,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
        }),
      ),
    /credenciales aisladas/i,
  );
});

test("DDL-CHECK requires a separate exact approval and only a migrator credential", () => {
  const ddlConfig = getAccountAccessE2EConfig("DDL-CHECK", {
    SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
    SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD: "migrator-secret-".padEnd(
      40,
      "b",
    ),
    SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID: attemptId,
    SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA: schema,
  });

  assert.equal(ddlConfig.schema, schema);
  assert.equal(ddlConfig.credentials.appPassword, undefined);
  assert.equal(
    ddlConfig.credentials.migratorPassword,
    "migrator-secret-".padEnd(40, "b"),
  );
  assert.equal(ddlConfig.credentials.fixturePassword, undefined);
  assert.throws(
    () =>
      getAccountAccessE2EConfig("DDL-CHECK", {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
        SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD: "migrator-secret-".padEnd(
          40,
          "b",
        ),
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID: attemptId,
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA: "sigecom_test",
      }),
    /aprobaci[oó]n.*DDL|DDL.*aprobaci[oó]n/i,
  );
  assert.throws(
    () =>
      getAccountAccessE2EConfig("DDL-CHECK", {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_ATTEMPT_ID: attemptId,
        SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA: schema,
      }),
    /credenciales aisladas/i,
  );

  const childEnvironment = createIntegrationTestEnvironment(ddlConfig, {
    PATH: "safe-path",
    NODE_ENV: "test",
    SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD: "must-not-be-forwarded",
    SIGECOM_ACCOUNT_ACCESS_PROVISIONER_PASSWORD: "must-not-be-forwarded",
  });
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD,
    "migrator-secret-".padEnd(40, "b"),
  );
  assert.equal(
    childEnvironment.SIGECOM_ACCOUNT_ACCESS_DDL_APPROVED_SCHEMA,
    schema,
  );
  assert.equal(
    Object.hasOwn(childEnvironment, "SIGECOM_ACCOUNT_ACCESS_APP_PASSWORD"),
    false,
  );
  assert.equal(
    Object.hasOwn(childEnvironment, "SIGECOM_ACCOUNT_ACCESS_FIXTURE_PASSWORD"),
    false,
  );
});

test("reserved PRE-FLIGHT identifiers fail closed in PROVISION and RUN", () => {
  const reservedId = "00000000000000_00000000";
  const cases = [
    {
      mode: "PROVISION",
      idOverrides: {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: reservedId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
      },
      authorization: {
        SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: reservedId,
      },
    },
    {
      mode: "RUN",
      idOverrides: {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: reservedId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: attemptId,
      },
      authorization: {
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: reservedId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA:
          "sigecom_e2e_tmp_00000000000000_00000000",
      },
    },
    {
      mode: "PROVISION",
      idOverrides: {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: reservedId,
      },
      authorization: {
        SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
      },
    },
    {
      mode: "RUN",
      idOverrides: {
        SIGECOM_ACCOUNT_ACCESS_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: reservedId,
      },
      authorization: {
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: reservedId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
      },
    },
  ];
  const dispatched = [];

  for (const scenario of cases) {
    assert.throws(() => {
      const config = getAccountAccessE2EConfig(scenario.mode, {
        ...approvedEnv(scenario.idOverrides),
        ...scenario.authorization,
      });
      return executeAccountAccessMode(config, {
        [scenario.mode]: () => dispatched.push(scenario.mode),
      });
    }, /reservado.*PRE-FLIGHT/i);
  }

  assert.deepEqual(dispatched, []);
});

test("conflicting explicit and environment modes are rejected", () => {
  assert.throws(
    () =>
      getAccountAccessE2EConfig("PRE-FLIGHT", {
        SIGECOM_ACCOUNT_ACCESS_MODE: "RUN",
      }),
    /modo.*conflict|conflict.*modo/i,
  );
});

test("missing environment records are rejected with a clear validation error", () => {
  assert.throws(
    () => getAccountAccessE2EConfig("PRE-FLIGHT", null),
    /entorno.*v[aá]lido/i,
  );

  const config = getAccountAccessE2EConfig("PRE-FLIGHT", {});
  assert.throws(
    () => createIntegrationTestEnvironment(config, null),
    /entorno.*v[aá]lido/i,
  );
});

test("mode-specific approvals cannot be mixed", () => {
  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "PROVISION",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
        }),
      ),
    /autorizaci[oó]n.*RUN.*PROVISION|RUN.*PROVISION/i,
  );

  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "RUN",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
          SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
        }),
      ),
    /autorizaci[oó]n.*PROVISION.*RUN|PROVISION.*RUN/i,
  );
});

test("PROVISION and RUN reject production before action dispatch", () => {
  const provisionEnv = approvedEnv({
    NODE_ENV: "production",
    SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
  });
  const runEnv = approvedEnv({
    NODE_ENV: "production",
    SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
    SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
    SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
  });

  assert.throws(
    () => getAccountAccessE2EConfig("PROVISION", provisionEnv),
    /NODE_ENV=production/i,
  );
  assert.throws(
    () => getAccountAccessE2EConfig("RUN", runEnv),
    /NODE_ENV=production/i,
  );
});

test("RUN requires exact authorization for an existing schema and never dispatches PROVISION", async () => {
  const calls = [];
  const actions = {
    "PRE-FLIGHT": () => calls.push("preflight"),
    PROVISION: () => calls.push("provision"),
    RUN: (config) => calls.push(`run:${config.schema}`),
  };
  const config = getAccountAccessE2EConfig(
    "RUN",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
      SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
    }),
  );

  await executeAccountAccessMode(config, actions);
  assert.deepEqual(calls, [`run:${schema}`]);

  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "RUN",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: attemptId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: "sigecom_test",
        }),
      ),
    /esquema.*autorizado/i,
  );
  assert.throws(
    () =>
      getAccountAccessE2EConfig(
        "RUN",
        approvedEnv({
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: runId,
          SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
          SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: runId,
        }),
      ),
    /RUN_ID.*ATTEMPT_ID.*distintos/i,
  );
});

test("two fresh RUN attempts share one authorized schema without provisioning resources", async () => {
  const attemptIds = [attemptId, "20261119040002_cccccccc"];
  const dispatched = [];
  const childEnvironments = [];
  const actions = {
    RUN: async (config) => {
      dispatched.push({
        mode: config.mode,
        runId: config.runId,
        attemptId: config.attemptId,
        schema: config.schema,
      });
    },
    PROVISION: () => assert.fail("RUN must never provision resources"),
  };

  for (const currentAttemptId of attemptIds) {
    const config = getAccountAccessE2EConfig(
      "RUN",
      approvedEnv({
        SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID: currentAttemptId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_RUN_ID: runId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_ATTEMPT_ID: currentAttemptId,
        SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA: schema,
      }),
    );
    childEnvironments.push(createIntegrationTestEnvironment(config, {}));
    await executeAccountAccessMode(config, actions);
  }

  assert.deepEqual(dispatched, [
    { mode: "RUN", runId, attemptId: attemptIds[0], schema },
    { mode: "RUN", runId, attemptId: attemptIds[1], schema },
  ]);
  assert.equal(new Set(dispatched.map(({ attemptId: id }) => id)).size, 2);
  assert.deepEqual(
    childEnvironments.map((environment) => [
      environment.SIGECOM_ACCOUNT_ACCESS_RUN_ID,
      environment.SIGECOM_ACCOUNT_ACCESS_ATTEMPT_ID,
      environment.SIGECOM_ACCOUNT_ACCESS_AUTHORIZED_SCHEMA,
      environment.SIGECOM_ACCOUNT_ACCESS_MODE,
    ]),
    [
      [runId, attemptIds[0], schema, "RUN"],
      [runId, attemptIds[1], schema, "RUN"],
    ],
  );
  assert.ok(
    childEnvironments.every(
      (environment) =>
        !Object.hasOwn(
          environment,
          "SIGECOM_ACCOUNT_ACCESS_PROVISIONER_USER",
        ) &&
        !Object.hasOwn(environment, "SIGECOM_ACCOUNT_ACCESS_MIGRATOR_PASSWORD"),
    ),
  );
});

test("unvalidated or incomplete configs cannot dispatch an action", async () => {
  let called = false;

  await assert.rejects(
    executeAccountAccessMode(
      { mode: "RUN", schema },
      { RUN: () => (called = true) },
    ),
    /configuraci[oó]n.*validada/i,
  );
  assert.equal(called, false);
});

test("partial PROVISION failure stops without retry, RUN fallback, or cleanup", async () => {
  const config = getAccountAccessE2EConfig(
    "PROVISION",
    approvedEnv({
      SIGECOM_ACCOUNT_ACCESS_PROVISION_APPROVED_RUN_ID: runId,
    }),
  );
  const completedStages = [];
  const dispatchedActions = [];
  const actions = {
    PROVISION: async () => {
      dispatchedActions.push("PROVISION");
      completedStages.push("schema-created");
      completedStages.push("app-user-created");
      throw new Error("simulated grant failure");
    },
    RUN: async () => {
      dispatchedActions.push("RUN");
    },
    cleanup: async () => {
      dispatchedActions.push("cleanup");
    },
  };

  await assert.rejects(
    executeAccountAccessMode(config, actions),
    /simulated grant failure/i,
  );
  assert.deepEqual(completedStages, ["schema-created", "app-user-created"]);
  assert.deepEqual(dispatchedActions, ["PROVISION"]);
});

test("unknown modes fail closed before any action can run", async () => {
  let called = false;
  assert.throws(
    () => getAccountAccessE2EConfig("AUTOMATIC", approvedEnv()),
    /modo.*PRE-FLIGHT.*PROVISION.*DDL-CHECK.*RUN/i,
  );
  await assert.rejects(
    executeAccountAccessMode(
      { mode: "AUTOMATIC" },
      { AUTOMATIC: () => (called = true) },
    ),
    /modo E2E no permitido/i,
  );
  assert.equal(called, false);
});
