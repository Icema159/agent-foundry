import { run } from "node:test";
import { spec } from "node:test/reporters";

const suites = {
  "identity": "FOUNDRY_TEST_DATABASE_URL",
  "external-registry": "FOUNDRY_11B_TEST_DATABASE_URL",
  "invocation": "FOUNDRY_11C_TEST_DATABASE_URL",
  "external-api": "FOUNDRY_11D_TEST_DATABASE_URL",
  "resource-authorization": "FOUNDRY_112A_TEST_DATABASE_URL",
  "executor-protocol": "FOUNDRY_112B_TEST_DATABASE_URL",
  "executor-start": "FOUNDRY_112C_TEST_DATABASE_URL",
  "executor-reconciliation": "FOUNDRY_112D_TEST_DATABASE_URL",
  "external-write": "FOUNDRY_113_TEST_DATABASE_URL",
};

const missing = Object.values(suites).filter(name => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Required isolated PostgreSQL test settings are missing: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  const tests = run({
    files: Object.keys(suites).map(name => `dist/tests/${name}-postgres.test.js`),
    concurrency: 1,
  });
  tests.on("test:fail", () => { process.exitCode = 1; });
  tests.on("test:summary", ({ counts }) => {
    if (counts.skipped || counts.todo) {
      console.error("Mandatory PostgreSQL integration tests must run without skips or TODOs.");
      process.exitCode = 1;
    }
  });
  tests.compose(spec).pipe(process.stdout);
}
