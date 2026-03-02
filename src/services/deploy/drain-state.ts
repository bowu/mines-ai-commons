import { existsSync } from "node:fs";

const DEFAULT_PROD_DRAIN_FLAG_FILE = "/opt/mines-ai/shared/.deploy-draining";
const CACHE_TTL_MS = 1000;

let cachedValue: boolean | null = null;
let cachedAtMs = 0;

function resolveDrainFlagPath(): string {
  const explicit = (process.env.DEPLOY_DRAIN_FLAG_FILE || "").trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === "production"
    ? DEFAULT_PROD_DRAIN_FLAG_FILE
    : "";
}

export function isDeployDraining(): boolean {
  const flagPath = resolveDrainFlagPath();
  if (!flagPath) return false;

  const now = Date.now();
  if (cachedValue !== null && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedValue;
  }

  const present = existsSync(flagPath);
  cachedValue = present;
  cachedAtMs = now;
  return present;
}
