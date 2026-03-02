import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const apiPort = 3001;
const webPort = 5173;
const sandboxPort = 8888;
const playwrightArtifactsDir = path.join(os.tmpdir(), "mines-ai-playwright");
const sandboxWorkspaceDir = path.join(
  playwrightArtifactsDir,
  "sandbox-workspace",
);
const defaultDatabaseUrl =
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai";
const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ||
  process.env.DATABASE_URL ||
  defaultDatabaseUrl;

export default defineConfig({
  testDir: "./e2e",
  outputDir: path.join(playwrightArtifactsDir, "test-results"),
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["github"],
        [
          "html",
          {
            open: "never",
            outputFolder: path.join(playwrightArtifactsDir, "html-report"),
          },
        ],
      ]
    : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `SANDBOX_PORT=${sandboxPort} SANDBOX_WORKSPACE_DIR="${sandboxWorkspaceDir}" pnpm --filter sandbox dev`,
      url: `http://127.0.0.1:${sandboxPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm exec tsx src/index.ts",
      url: `http://127.0.0.1:${apiPort}/api/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTH_PROVIDER: "none",
        SANDBOX_MODE: "local",
        SANDBOX_LOCAL_URL: `http://127.0.0.1:${sandboxPort}`,
        DATABASE_URL: e2eDatabaseUrl,
        APP_DATABASE_URL: "",
        VM_INTERNAL_DATABASE_URL: "",
        AUTH_BOOTSTRAP_DATABASE_URL: "",
      },
    },
    {
      command:
        "pnpm --filter mines-ai-commons-client dev --host 127.0.0.1 --port 5173",
      url: `http://127.0.0.1:${webPort}/agents`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
