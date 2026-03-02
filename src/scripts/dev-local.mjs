import { spawn } from "node:child_process";
import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

// Local app development defaults to auth bypass.
// Use DEV_AUTH_PROVIDER=magic|oidc to test auth flows locally.
const devAuthProvider = (process.env.DEV_AUTH_PROVIDER || "").trim();
process.env.AUTH_PROVIDER = devAuthProvider || "none";
process.env.SANDBOX_MODE = "local";
// Always use a local callback target in pnpm dev unless explicitly overridden
// via DEV_LOCAL_API_CALLBACK_URL. This avoids accidental use of production
// callback URLs loaded from .env.
process.env.API_CALLBACK_URL =
  (process.env.DEV_LOCAL_API_CALLBACK_URL || "http://127.0.0.1:3001").trim() ||
  "http://127.0.0.1:3001";
if (!(process.env.SESSION_SECRET || "").trim()) {
  process.env.SESSION_SECRET = "dev-session-secret";
}
if (!(process.env.VM_TOKEN_SECRET || "").trim()) {
  process.env.VM_TOKEN_SECRET = process.env.SESSION_SECRET;
}
process.env.SANDBOX_PORT =
  (process.env.SANDBOX_PORT || "8888").trim() || "8888";
if (!(process.env.SANDBOX_LOCAL_URL || "").trim()) {
  process.env.SANDBOX_LOCAL_URL = `http://127.0.0.1:${process.env.SANDBOX_PORT}`;
}
if (!(process.env.SANDBOX_WORKSPACE_DIR || "").trim()) {
  process.env.SANDBOX_WORKSPACE_DIR = "data/sandbox-workspace";
}

const child = spawn("pnpm", ["run", "dev:serve:local"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
