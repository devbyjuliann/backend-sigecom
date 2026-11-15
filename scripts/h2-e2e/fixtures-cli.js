import process from "node:process";
import { cleanupH2E2EFixtures, setupH2E2EFixtures } from "./fixtures.js";

const action = process.argv[2];
try {
  if (action === "setup") {
    const fixtures = await setupH2E2EFixtures();
    process.stdout.write(`${JSON.stringify(fixtures)}\n`);
  } else if (action === "cleanup") {
    await cleanupH2E2EFixtures();
    process.stdout.write(
      "H2 E2E fixtures cleaned and residue preflight passed.\n",
    );
  } else {
    throw new Error("Unsupported fixture action.");
  }
} catch (error) {
  const stage = error.h2CleanupStage ? ` at ${error.h2CleanupStage}` : "";
  const detail = error.h2CleanupDetail ? `: ${error.h2CleanupDetail}` : "";
  console.error(
    `H2 E2E fixture action failed (${error.code || "FIXTURES"})${stage}${detail}.`,
  );
  process.exitCode = 1;
}
