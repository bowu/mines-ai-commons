import { defineConfig } from "vitest/config";

const defaultIntegrationDatabaseUrl =
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";
const integrationDatabaseUrl =
  process.env.INTEGRATION_DATABASE_URL || defaultIntegrationDatabaseUrl;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: "./src/test/setup-integration.ts",
    sequence: {
      concurrent: false,
    },
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    env: {
      NODE_ENV: "test",
      AUTH_PROVIDER: "none",
      INTEGRATION_DATABASE_URL: integrationDatabaseUrl,
      DATABASE_URL: integrationDatabaseUrl,
      // Pin idle thresholds so tests are independent of .env overrides.
      // CPU: 15 min (900 000 ms), GPU: 60 min (3 600 000 ms).
      SANDBOX_IDLE_CPU_MS: "900000",
      SANDBOX_IDLE_GPU_MS: "3600000",
      // Pin to local mode so SANDBOX_MODE=gce in .env cannot leak into test runs
      // and cause failures in tests that rely on local-mode behaviour (e.g. the
      // concurrent /ensure test that expects 503 + no DB update).
      SANDBOX_MODE: "local",
      // Port 1 is privileged (always ECONNREFUSED in non-root environments).
      // This makes the local-mode health probe fail deterministically so tests
      // that expect 503/starting are not flaky when port 8888 happens to be in use.
      SANDBOX_LOCAL_URL: "http://127.0.0.1:1",
    },
  },
});
