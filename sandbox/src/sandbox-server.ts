import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";

import {
  GoalSessionManager,
  SessionBusyError,
} from "./goal-session-manager.js";
import { jailPath, sanitizeRelativePath } from "./path-utils.js";
import { createPiSession } from "./session.js";
import type { AgentModelSelection } from "./session.js";
import { streamPiAgent } from "./stream.js";
import { createSandboxTools } from "./tools.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.SANDBOX_PORT || 8888);
const WORKSPACE_ROOT = path.resolve(
  process.env.SANDBOX_WORKSPACE_DIR || "/workspace",
);
const SYSTEM_MUTATION_FLAG_PATH = path.join(
  WORKSPACE_ROOT,
  ".mines",
  "system-mutation-flag.json",
);
const LEGACY_SYSTEM_MUTATION_FLAG_PATH = path.join(
  WORKSPACE_ROOT,
  ".mines-ai",
  "boot-disk-customized",
);
const MAX_WORKSPACE_SIZE = 50 * 1024 * 1024;
const CREDENTIAL_BOOTSTRAP_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.SANDBOX_CREDENTIAL_BOOTSTRAP_RETRY_ATTEMPTS || 20),
);
const CREDENTIAL_BOOTSTRAP_RETRY_DELAY_MS = Math.max(
  100,
  Number(process.env.SANDBOX_CREDENTIAL_BOOTSTRAP_RETRY_DELAY_MS || 1_000),
);
const CHAT_HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.SANDBOX_CHAT_HEARTBEAT_INTERVAL_MS || 15_000),
);
const CHAT_STREAM_MAX_PENDING_BYTES = Math.max(
  64 * 1024,
  Number(process.env.SANDBOX_CHAT_STREAM_MAX_PENDING_BYTES || 1 * 1024 * 1024),
);
const INTERNAL_HIDDEN_ENTRY_NAMES = new Set([
  "skills",
  "venv",
  ".venv",
  ".pi",
  "node_modules",
]);

function isLocalSandboxMode(): boolean {
  return (process.env.SANDBOX_MODE || "").trim().toLowerCase() === "local";
}

function normalizeCallbackUrl(value: string | null | undefined): string {
  return (value || "").trim().replace(/\/+$/, "");
}

function resolveApiCallbackUrl(): string {
  if (isLocalSandboxMode()) {
    const localOverride = normalizeCallbackUrl(
      process.env.SANDBOX_LOCAL_API_CALLBACK_URL,
    );
    return localOverride || "http://127.0.0.1:3001";
  }
  return normalizeCallbackUrl(process.env.API_CALLBACK_URL);
}

function resolveAgentModelSelection(model: unknown): AgentModelSelection {
  if (
    model === "gemini-3.1-pro" ||
    model === "sonnet-4.6" ||
    model === "opus-4.6" ||
    model === "gpt-5.2"
  ) {
    return model;
  }
  return "sonnet-4.6";
}

function listApiCallbackCandidates(): string[] {
  if (isLocalSandboxMode()) {
    return [resolveApiCallbackUrl()];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const normalized = normalizeCallbackUrl(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(process.env.API_CALLBACK_URL);
  pushCandidate(process.env.SANDBOX_API_BASE_URL);

  const liteProxyUrl = (process.env.LITELLM_PROXY_URL || "").trim();
  if (liteProxyUrl) {
    try {
      pushCandidate(new URL(liteProxyUrl).origin);
    } catch {
      // Ignore malformed proxy URLs.
    }
  }

  return candidates;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

type BufferedSseWriter = {
  sendData: (event: unknown) => boolean;
  sendComment: (comment?: string) => boolean;
  close: () => void;
  isClosed: () => boolean;
};

function createBufferedSseWriter(
  res: Response,
  options?: { maxPendingBytes?: number },
): BufferedSseWriter {
  const maxPendingBytes =
    options?.maxPendingBytes ?? CHAT_STREAM_MAX_PENDING_BYTES;
  let closed = false;
  let writing = false;
  let pendingBytes = 0;
  const queue: Array<{ frame: string; bytes: number }> = [];

  const markClosed = () => {
    closed = true;
  };
  res.on("close", markClosed);
  res.on("error", markClosed);

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (closed || res.writableEnded || res.destroyed) {
        resolve();
        return;
      }
      const cleanup = () => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      res.once("drain", onDrain);
      res.once("close", onClose);
      res.once("error", onClose);
    });

  const flush = async () => {
    if (writing || closed) return;
    writing = true;
    try {
      while (!closed && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        pendingBytes = Math.max(0, pendingBytes - next.bytes);

        if (res.writableEnded || res.destroyed) {
          closed = true;
          break;
        }

        let wrote = false;
        try {
          wrote = res.write(next.frame);
        } catch {
          closed = true;
          break;
        }

        if (!wrote) {
          await waitForDrain();
        }
      }
    } finally {
      writing = false;
      if (!closed && queue.length > 0) {
        void flush();
      }
    }
  };

  const enqueue = (frame: string): boolean => {
    if (closed || res.writableEnded || res.destroyed) return false;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (pendingBytes + bytes > maxPendingBytes) {
      closed = true;
      try {
        res.end();
      } catch {
        // ignore close errors
      }
      return false;
    }
    queue.push({ frame, bytes });
    pendingBytes += bytes;
    void flush();
    return true;
  };

  return {
    sendData: (event: unknown) => enqueue(`data: ${JSON.stringify(event)}\n\n`),
    sendComment: (comment = "ping") => enqueue(`: ${comment}\n\n`),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        res.end();
      } catch {
        // ignore close errors
      }
    },
    isClosed: () => closed || res.writableEnded || res.destroyed,
  };
}

function updateControlPlaneState(
  connected: boolean,
  details?: { error?: string | null },
): void {
  const wasConnected = controlPlaneConnected;
  controlPlaneConnected = connected;
  if (connected) {
    lastControlPlaneError = null;
    lastControlPlaneSuccessAt = new Date().toISOString();
    // Stop any fast disconnect-retry loop now that we're reconnected.
    if (credentialDisconnectRetryTimer) {
      clearTimeout(credentialDisconnectRetryTimer);
      credentialDisconnectRetryTimer = null;
    }
    credentialDisconnectRetryDelayMs = 5_000;
    return;
  }
  if (details && typeof details.error === "string" && details.error.trim()) {
    lastControlPlaneError = details.error.trim().slice(0, 500);
  }
  // Start a fast retry loop on the first transition to disconnected.
  if (wasConnected && !credentialDisconnectRetryTimer && credentialRefresher) {
    scheduleDisconnectRetry();
  }
}

function scheduleDisconnectRetry(): void {
  if (credentialDisconnectRetryTimer) return;
  const refresher = credentialRefresher;
  if (!refresher) return;
  credentialDisconnectRetryTimer = setTimeout(() => {
    credentialDisconnectRetryTimer = null;
    if (controlPlaneConnected) return; // already recovered
    void refresher()
      .then(() => {
        // On success updateControlPlaneState(true) will clear the retry.
      })
      .catch(() => {
        // Backoff: double the delay up to 60 s, then retry again.
        credentialDisconnectRetryDelayMs = Math.min(
          credentialDisconnectRetryDelayMs * 2,
          60_000,
        );
        if (!controlPlaneConnected) scheduleDisconnectRetry();
      });
  }, credentialDisconnectRetryDelayMs);
}

function resolveRuntimeVersion(): string | null {
  const explicit = (process.env.SANDBOX_RUNTIME_VERSION || "").trim();
  if (explicit) return explicit;

  const versionFile = (
    process.env.SANDBOX_RUNTIME_VERSION_FILE ||
    "/opt/mines-ai/sandbox/runtime-version"
  ).trim();
  if (!versionFile) return null;

  try {
    const content = fsSync.readFileSync(versionFile, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

const SANDBOX_RUNTIME_VERSION = resolveRuntimeVersion();

function readUpgradeRiskStatus(): {
  upgradeRiskDetected: boolean;
  upgradeRiskMessage: string | null;
} {
  try {
    if (!fsSync.existsSync(SYSTEM_MUTATION_FLAG_PATH)) {
      if (fsSync.existsSync(LEGACY_SYSTEM_MUTATION_FLAG_PATH)) {
        return {
          upgradeRiskDetected: true,
          upgradeRiskMessage:
            "System-level packages were installed outside /workspace.",
        };
      }
      return { upgradeRiskDetected: false, upgradeRiskMessage: null };
    }

    const raw = fsSync.readFileSync(SYSTEM_MUTATION_FLAG_PATH, "utf8").trim();
    if (!raw) {
      return { upgradeRiskDetected: true, upgradeRiskMessage: null };
    }

    const parsed = JSON.parse(raw) as {
      detected?: unknown;
      riskType?: unknown;
      command?: unknown;
      detectedAt?: unknown;
    };
    const detected = parsed.detected !== false;
    if (!detected) {
      return { upgradeRiskDetected: false, upgradeRiskMessage: null };
    }
    const riskType =
      typeof parsed.riskType === "string" ? parsed.riskType.trim() : "";
    const command =
      typeof parsed.command === "string" ? parsed.command.trim() : "";
    const detectedAt =
      typeof parsed.detectedAt === "string" ? parsed.detectedAt.trim() : "";
    const details = [riskType, command].filter(Boolean).join(" | ");
    const suffix = detectedAt ? ` @ ${detectedAt}` : "";
    const message =
      details || suffix
        ? `Boot-disk customization detected${details ? `: ${details}` : ""}${suffix}`
        : "Boot-disk customization detected";
    return { upgradeRiskDetected: true, upgradeRiskMessage: message };
  } catch {
    return {
      upgradeRiskDetected: true,
      upgradeRiskMessage: "Boot-disk customization marker could not be parsed.",
    };
  }
}

let vmToken: string | null = null;
let credentialRefreshTimer: NodeJS.Timeout | null = null;
let credentialBootstrapRetryTimer: NodeJS.Timeout | null = null;
let credentialDisconnectRetryTimer: NodeJS.Timeout | null = null;
let credentialDisconnectRetryDelayMs = 5_000;

// Set by maybeBootstrapCredentials after a successful bootstrap so that
// updateControlPlaneState(false) can immediately schedule a fast retry.
let credentialRefresher: (() => Promise<void>) | null = null;
let controlPlaneConnected = isLocalSandboxMode();
let lastControlPlaneError: string | null = null;
let lastControlPlaneSuccessAt: string | null = isLocalSandboxMode()
  ? new Date().toISOString()
  : null;
let goalSessionManager: GoalSessionManager | null = null;
const goalSessionManagersByAgent = new Map<string, GoalSessionManager>();
const agentVmCredentials = new Map<
  string,
  { token: string; expiresAtMs: number | null }
>();
const busySessions = new Set<string>();
const activeSessions = new Set<string>();
const jailWorkspacePath = (inputPath: string) =>
  jailPath(WORKSPACE_ROOT, inputPath);

function applyRuntimeEnv(
  runtimeEnv: Record<string, string | null | undefined> | undefined,
): void {
  if (!runtimeEnv) return;
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value === "string" && value.trim()) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

function getQueryParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

async function buildFileTree(
  dirPath: string,
  relativePath = "",
  options: { recursive?: boolean } = {},
): Promise<any[]> {
  const recursive = options.recursive !== false;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: any[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const isHidden =
      entry.name.startsWith(".") || INTERNAL_HIDDEN_ENTRY_NAMES.has(entry.name);
    if (isHidden) {
      continue;
    }

    const entryRelPath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      const node: Record<string, unknown> = {
        name: entry.name,
        path: entryRelPath,
        type: "directory",
      };
      if (recursive) {
        node.children = await buildFileTree(
          path.join(dirPath, entry.name),
          entryRelPath,
          {
            recursive: true,
          },
        );
      }
      result.push(node);
    } else {
      const stat = await fs.stat(path.join(dirPath, entry.name));
      result.push({
        name: entry.name,
        path: entryRelPath,
        type: "file",
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function getDirSize(
  dirPath: string,
): Promise<{ totalSize: number; fileCount: number }> {
  let totalSize = 0;
  let fileCount = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await getDirSize(fullPath);
        totalSize += sub.totalSize;
        fileCount += sub.fileCount;
      } else {
        const stat = await fs.stat(fullPath);
        totalSize += stat.size;
        fileCount++;
      }
    }
  } catch {
    // Directory may not exist yet.
  }

  return { totalSize, fileCount };
}

async function moveWithFallback(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error: any) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  const sourceStat = await fs.stat(sourcePath);
  if (sourceStat.isDirectory()) {
    await fs.rm(sourcePath, { recursive: true });
  } else {
    await fs.unlink(sourcePath);
  }
}

async function fetchGceIdentityToken(audience: string): Promise<string | null> {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
  const url = `${metadataUrl}?audience=${encodeURIComponent(audience)}&format=full`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const token = (await response.text()).trim();
    return token || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function maybeBootstrapCredentials(options?: {
  attempts?: number;
}): Promise<boolean> {
  const agentId = (process.env.AGENT_ID || "").trim();
  if (!agentId) {
    return false;
  }
  const attempts = Math.max(
    1,
    options?.attempts ?? CREDENTIAL_BOOTSTRAP_RETRY_ATTEMPTS,
  );

  interface VmCredentialPayload {
    vmToken?: string;
    expiresAt?: string;
    runtimeEnv?: Record<string, string | null>;
  }

  const bootstrapSecret = (process.env.VM_BOOTSTRAP_SECRET || "").trim();

  const requestBootstrapCredentials = async (
    requestAgentId: string,
  ): Promise<{ payload: VmCredentialPayload; callbackUrl: string } | null> => {
    const candidates = listApiCallbackCandidates();
    if (candidates.length === 0) {
      updateControlPlaneState(false, {
        error: "No API callback URL candidates available",
      });
      return null;
    }

    let lastError: string | null = null;
    for (const callbackUrl of candidates) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (bootstrapSecret) {
        headers["x-sandbox-bootstrap-secret"] = bootstrapSecret;
      }

      const identityToken = await fetchGceIdentityToken(callbackUrl);
      if (identityToken) {
        headers.Authorization = `Bearer ${identityToken}`;
      }

      let response: globalThis.Response;
      try {
        response = await fetch(
          `${callbackUrl}/api/internal/agents/${requestAgentId}/bootstrap-credentials`,
          {
            method: "POST",
            headers,
          },
        );
      } catch (error) {
        lastError = summarizeError(error);
        console.warn(
          `Sandbox bootstrap request failed via ${callbackUrl}:`,
          error,
        );
        continue;
      }

      if (!response.ok) {
        lastError = `Bootstrap failed via ${callbackUrl}: ${response.status} ${response.statusText}`;
        continue;
      }

      const payload = (await response.json()) as VmCredentialPayload;
      applyRuntimeEnv(payload.runtimeEnv);
      const resolvedAfterApply = resolveApiCallbackUrl();
      if (resolvedAfterApply && resolvedAfterApply !== callbackUrl) {
        console.log(
          `Sandbox callback URL updated after bootstrap: ${callbackUrl} -> ${resolvedAfterApply}`,
        );
      }
      updateControlPlaneState(true);
      return { payload, callbackUrl };
    }

    updateControlPlaneState(false, { error: lastError });
    return null;
  };

  const applyBootstrapPayload = (
    requestAgentId: string,
    payload: VmCredentialPayload,
    fallbackToken: string | null,
  ): string | null => {
    applyRuntimeEnv(payload.runtimeEnv);
    const nextToken = (payload.vmToken || fallbackToken || "").trim() || null;
    if (!nextToken) return null;

    const expiresAtMs = payload.expiresAt
      ? Number(new Date(payload.expiresAt).getTime()) || null
      : null;
    agentVmCredentials.set(requestAgentId, {
      token: nextToken,
      expiresAtMs,
    });
    return nextToken;
  };

  const bootstrap = async (): Promise<boolean> => {
    const bootstrapped = await requestBootstrapCredentials(agentId);
    if (!bootstrapped) return false;
    vmToken = applyBootstrapPayload(agentId, bootstrapped.payload, vmToken);
    return Boolean(vmToken);
  };

  const refresh = async () => {
    if (!vmToken) {
      const bootstrapped = await bootstrap();
      if (!bootstrapped) {
        throw new Error("Credential bootstrap failed during refresh");
      }
      return;
    }

    const callbackUrl = resolveApiCallbackUrl();
    if (!callbackUrl) {
      const bootstrapped = await bootstrap();
      if (!bootstrapped) {
        throw new Error("No callback URL available for credential refresh");
      }
      return;
    }

    let response: globalThis.Response;
    try {
      response = await fetch(
        `${callbackUrl}/api/internal/agents/${agentId}/refresh-credentials`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${vmToken}`,
          },
        },
      );
    } catch (error) {
      updateControlPlaneState(false, { error: summarizeError(error) });
      const bootstrapped = await bootstrap();
      if (!bootstrapped) {
        throw error;
      }
      return;
    }

    if (response.status === 401) {
      const bootstrapped = await bootstrap();
      if (!bootstrapped) {
        throw new Error("Credential refresh rejected and bootstrap failed");
      }
      return;
    }

    if (!response.ok) {
      updateControlPlaneState(false, {
        error: `Refresh failed: ${response.status} ${response.statusText}`,
      });
      const bootstrapped = await bootstrap();
      if (!bootstrapped) {
        throw new Error(
          `Refresh failed: ${response.status} ${response.statusText}`,
        );
      }
      return;
    }

    const payload = (await response.json()) as VmCredentialPayload;
    vmToken = applyBootstrapPayload(agentId, payload, vmToken);
    updateControlPlaneState(true);
  };

  let bootstrapSucceeded = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const bootstrapped = await bootstrap();
    if (bootstrapped) {
      bootstrapSucceeded = true;
      break;
    }
    const attemptLabel = `${attempt}/${attempts}`;
    console.warn(
      `Sandbox credential bootstrap failed (${attemptLabel}): ${
        lastControlPlaneError || "unknown error"
      }`,
    );
    if (attempt < attempts) {
      await sleep(CREDENTIAL_BOOTSTRAP_RETRY_DELAY_MS);
    }
  }

  if (!bootstrapSucceeded) {
    updateControlPlaneState(false, {
      error:
        lastControlPlaneError || "Credential bootstrap failed after retries",
    });
    return false;
  }

  // Expose the refresher so disconnect-retry and expiry scheduling can use it.
  credentialRefresher = refresh;

  const scheduleNextRefresh = () => {
    if (credentialRefreshTimer) {
      clearTimeout(credentialRefreshTimer);
      credentialRefreshTimer = null;
    }
    const cred = agentVmCredentials.get(agentId);
    const REFRESH_SAFETY_WINDOW_MS = 5 * 60_000; // refresh 5 min before expiry
    const delay =
      cred?.expiresAtMs != null
        ? Math.max(0, cred.expiresAtMs - Date.now() - REFRESH_SAFETY_WINDOW_MS)
        : 50 * 60_000; // fallback: 50 min if server didn't send expiry
    credentialRefreshTimer = setTimeout(() => {
      credentialRefreshTimer = null;
      void refresh()
        .then(() => scheduleNextRefresh())
        .catch((error) => {
          console.warn("Sandbox credential refresh failed:", error);
          // Retry after a short back-off; disconnect retry loop may also fire.
          credentialRefreshTimer = setTimeout(() => {
            credentialRefreshTimer = null;
            scheduleNextRefresh();
          }, 5 * 60_000);
        });
    }, delay);
  };

  scheduleNextRefresh();
  return true;
}

async function bootstrapCredentialsForAgent(
  agentId: string,
): Promise<{ token: string; expiresAtMs: number | null } | null> {
  if (!agentId) {
    return null;
  }

  const bootstrapSecret = (process.env.VM_BOOTSTRAP_SECRET || "").trim();
  const candidates = listApiCallbackCandidates();
  if (candidates.length === 0) {
    updateControlPlaneState(false, {
      error: "No API callback URL candidates available",
    });
    return null;
  }

  let lastError: string | null = null;
  for (const callbackUrl of candidates) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (bootstrapSecret) {
      headers["x-sandbox-bootstrap-secret"] = bootstrapSecret;
    }
    const identityToken = await fetchGceIdentityToken(callbackUrl);
    if (identityToken) {
      headers.Authorization = `Bearer ${identityToken}`;
    }

    let response: globalThis.Response;
    try {
      response = await fetch(
        `${callbackUrl}/api/internal/agents/${agentId}/bootstrap-credentials`,
        {
          method: "POST",
          headers,
        },
      );
    } catch (error) {
      lastError = summarizeError(error);
      console.warn(
        `Sandbox per-agent bootstrap request failed via ${callbackUrl}:`,
        error,
      );
      continue;
    }
    if (!response.ok) {
      lastError = `Bootstrap failed via ${callbackUrl}: ${response.status} ${response.statusText}`;
      continue;
    }
    const payload = (await response.json()) as {
      vmToken?: string;
      expiresAt?: string;
      runtimeEnv?: Record<string, string | null>;
    };
    applyRuntimeEnv(payload.runtimeEnv);

    const token = (payload.vmToken || "").trim();
    if (!token) {
      lastError = `Bootstrap response via ${callbackUrl} missing vmToken`;
      continue;
    }

    const expiresAtMs = payload.expiresAt
      ? Number(new Date(payload.expiresAt).getTime()) || null
      : null;
    updateControlPlaneState(true);
    return { token, expiresAtMs };
  }

  updateControlPlaneState(false, { error: lastError });
  return null;
}

function cachedTokenStillValid(expiresAtMs: number | null): boolean {
  if (!expiresAtMs) return true;
  return Date.now() < expiresAtMs - 90_000;
}

async function ensureAgentVmToken(agentId: string): Promise<string | null> {
  if (!agentId) return null;

  const cached = agentVmCredentials.get(agentId);
  if (cached && cachedTokenStillValid(cached.expiresAtMs)) {
    return cached.token;
  }

  const staticAgentId = (process.env.AGENT_ID || "").trim();
  if (staticAgentId && staticAgentId === agentId && vmToken) {
    const staticCached = agentVmCredentials.get(agentId);
    if (!staticCached) {
      agentVmCredentials.set(agentId, { token: vmToken, expiresAtMs: null });
    }
    return vmToken;
  }

  const bootstrapped = await bootstrapCredentialsForAgent(agentId);
  if (!bootstrapped) {
    return null;
  }
  agentVmCredentials.set(agentId, bootstrapped);

  if (staticAgentId && staticAgentId === agentId) {
    vmToken = bootstrapped.token;
  }

  return bootstrapped.token;
}

async function refreshAgentVmToken(agentId: string): Promise<string | null> {
  if (!agentId) return null;
  const bootstrapped = await bootstrapCredentialsForAgent(agentId);
  if (!bootstrapped) {
    return null;
  }

  agentVmCredentials.set(agentId, bootstrapped);
  const staticAgentId = (process.env.AGENT_ID || "").trim();
  if (staticAgentId && staticAgentId === agentId) {
    vmToken = bootstrapped.token;
  }
  return bootstrapped.token;
}

async function ensureGoalSessionManagerForAgent(
  agentId: string,
): Promise<GoalSessionManager | null> {
  if (!agentId) return null;
  const existing = goalSessionManagersByAgent.get(agentId);
  if (existing) return existing;

  const apiCallbackUrl = resolveApiCallbackUrl();
  if (!apiCallbackUrl) return null;

  let token: string | null = null;
  try {
    token = await ensureAgentVmToken(agentId);
  } catch (error) {
    console.warn("Failed to ensure per-agent VM token:", error);
    return null;
  }
  if (!token) return null;

  const manager = new GoalSessionManager({
    agentId,
    apiBaseUrl: apiCallbackUrl,
    getVmToken: () => agentVmCredentials.get(agentId)?.token || null,
    ensureVmToken: () => ensureAgentVmToken(agentId),
    refreshVmToken: () => refreshAgentVmToken(agentId),
  });
  manager.start();
  goalSessionManagersByAgent.set(agentId, manager);
  return manager;
}

function collectManagerStatuses(): Array<{
  busy: boolean;
  activeSessions: number;
}> {
  return Array.from(goalSessionManagersByAgent.values()).map((manager) =>
    manager.getStatus(),
  );
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/status", (_req, res) => {
  const upgradeRisk = readUpgradeRiskStatus();
  const managerStatuses = collectManagerStatuses();
  const managerBusy = managerStatuses.some((status) => status.busy);
  const managerActiveSessions = managerStatuses.reduce(
    (sum, status) => sum + status.activeSessions,
    0,
  );
  res.json({
    busy: managerStatuses.length > 0 ? managerBusy : busySessions.size > 0,
    activeSessions:
      managerStatuses.length > 0 ? managerActiveSessions : activeSessions.size,
    runtimeVersion: SANDBOX_RUNTIME_VERSION,
    upgradeRiskDetected: upgradeRisk.upgradeRiskDetected,
    upgradeRiskMessage: upgradeRisk.upgradeRiskMessage,
    controlPlaneConnected,
    controlPlaneError: lastControlPlaneError,
    controlPlaneLastSuccessAt: lastControlPlaneSuccessAt,
  });
});

app.post("/chat", async (req: Request, res: Response) => {
  const { agentId, sessionId, message, systemPrompt, chatHistory, model } =
    req.body || {};

  if (typeof sessionId !== "string" || !sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  if (typeof agentId !== "string" || !agentId) {
    return res.status(400).json({ error: "agentId is required" });
  }

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const writer = createBufferedSseWriter(res, {
    maxPendingBytes: CHAT_STREAM_MAX_PENDING_BYTES,
  });
  let lastSseWriteAt = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const writeSseData = (event: unknown): boolean => {
    const wrote = writer.sendData(event);
    if (!wrote) return false;
    lastSseWriteAt = Date.now();
    return true;
  };
  const writeSseHeartbeat = (): boolean => {
    // SSE comment frame keeps upstream/body streams alive without affecting clients.
    const wrote = writer.sendComment("heartbeat");
    if (!wrote) return false;
    lastSseWriteAt = Date.now();
    return true;
  };
  const startHeartbeat = (): void => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastSseWriteAt < CHAT_HEARTBEAT_INTERVAL_MS) return;
      if (!writeSseHeartbeat()) {
        stopHeartbeat();
      }
    }, CHAT_HEARTBEAT_INTERVAL_MS);
  };
  const stopHeartbeat = (): void => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const selectedModel: AgentModelSelection = resolveAgentModelSelection(model);

  const manager = await ensureGoalSessionManagerForAgent(agentId);
  if (!manager) {
    if (!controlPlaneConnected || !vmToken) {
      console.warn(
        `Goal/session manager unavailable for agent ${agentId}; falling back to foreground-only mode (callback=${resolveApiCallbackUrl() || "<unset>"}, lastError=${lastControlPlaneError || "none"})`,
      );
    }
    if (busySessions.has(sessionId)) {
      return res
        .status(409)
        .json({ error: "Session is already processing a turn" });
    }
    busySessions.add(sessionId);
    activeSessions.add(sessionId);
    const tools = createSandboxTools({
      agentId,
      apiBaseUrl: resolveApiCallbackUrl() || "http://localhost:3001",
      getVmToken: () => vmToken,
      ensureVmToken: () => ensureAgentVmToken(agentId),
      refreshVmToken: () => refreshAgentVmToken(agentId),
    });
    try {
      const result = await createPiSession(
        agentId,
        sessionId,
        typeof systemPrompt === "string" ? systemPrompt : "",
        tools,
        Array.isArray(chatHistory) ? chatHistory : [],
        selectedModel,
      );
      startHeartbeat();
      for await (const event of streamPiAgent(
        result.session,
        message,
        typeof systemPrompt === "string" ? systemPrompt : "",
      )) {
        if (!writeSseData(event)) {
          break;
        }
      }
      result.session.dispose();
      writer.close();
      return;
    } catch (error) {
      console.error("Sandbox chat error:", error);
      writeSseData({ type: "error", data: "Sandbox chat failed" });
      writeSseData({ type: "done" });
      writer.close();
      return;
    } finally {
      stopHeartbeat();
      busySessions.delete(sessionId);
    }
  }

  let clientDisconnected = false;
  const handleClientDisconnect = () => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    void manager.cancelForegroundTurn(sessionId, "client_disconnect");
  };
  req.on("aborted", handleClientDisconnect);
  req.on("close", handleClientDisconnect);
  res.on("close", handleClientDisconnect);

  try {
    const stream = await manager.runForegroundTurn({
      sessionId,
      message,
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "",
      chatHistory: Array.isArray(chatHistory) ? chatHistory : [],
      model: selectedModel,
    });

    startHeartbeat();
    for await (const event of stream) {
      if (clientDisconnected) {
        break;
      }
      if (!writeSseData(event)) {
        break;
      }
    }
    if (!writer.isClosed()) {
      writer.close();
    }
    return;
  } catch (error) {
    if (error instanceof SessionBusyError) {
      return res.status(409).json({ error: error.message });
    }
    console.error("Sandbox chat error:", error);
    writeSseData({ type: "error", data: "Sandbox chat failed" });
    writeSseData({ type: "done" });
    writer.close();
    return;
  } finally {
    stopHeartbeat();
    req.off("aborted", handleClientDisconnect);
    req.off("close", handleClientDisconnect);
    res.off("close", handleClientDisconnect);
  }
});

app.get("/files", async (req: Request, res: Response) => {
  try {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

    const rawPath = getQueryParam(req.query.path);
    const sanitizedPath = rawPath ? sanitizeRelativePath(rawPath) : ".";
    const targetDir = jailWorkspacePath(sanitizedPath);
    const targetStat = await fs.stat(targetDir);
    if (!targetStat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    const recursive =
      getQueryParam(req.query.recursive).toLowerCase() !== "false";
    const includeStats =
      getQueryParam(req.query.includeStats).toLowerCase() === "true";
    const relativePath = sanitizedPath === "." ? "" : sanitizedPath;
    const files = await buildFileTree(targetDir, relativePath, { recursive });

    if (includeStats) {
      const stats = await getDirSize(WORKSPACE_ROOT);
      return res.json({
        files,
        stats: {
          totalSize: stats.totalSize,
          fileCount: stats.fileCount,
          maxSize: MAX_WORKSPACE_SIZE,
        },
      });
    }

    return res.json({ files });
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return res.status(404).json({ error: "Directory not found" });
    }
    console.error("List files error:", error);
    return res.status(500).json({ error: "Failed to list files" });
  }
});

app.get("/stats", async (_req: Request, res: Response) => {
  try {
    const stats = await getDirSize(WORKSPACE_ROOT);
    return res.json({
      totalSize: stats.totalSize,
      fileCount: stats.fileCount,
      maxSize: MAX_WORKSPACE_SIZE,
    });
  } catch (error) {
    console.error("Stats error:", error);
    return res.status(500).json({ error: "Failed to get stats" });
  }
});

app.get("/file", async (req: Request, res: Response) => {
  try {
    const filePath = getQueryParam(req.query.path);
    if (!filePath) {
      return res.status(400).json({ error: "Path is required" });
    }

    const sanitized = sanitizeRelativePath(filePath);
    const fullPath = jailWorkspacePath(sanitized);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory" });
    }

    if (req.query.download === "true") {
      return res.download(fullPath);
    }

    if (req.query.raw === "true") {
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".ico": "image/x-icon",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".html": "text/html",
        ".htm": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
      };
      const contentType = mimeTypes[ext] || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stat.size);
      const fileBuffer = await fs.readFile(fullPath);
      return res.send(fileBuffer);
    }

    if (path.extname(fullPath).toLowerCase() === ".docx") {
      try {
        const mammoth = await import("mammoth");
        const buffer = await fs.readFile(fullPath);
        const result = await mammoth.extractRawText({ buffer });
        return res.json({
          path: sanitized,
          content: result.value || "(No text content found)",
          size: stat.size,
          modified: stat.mtime.toISOString(),
          fileType: "docx",
        });
      } catch {
        return res.json({
          path: sanitized,
          content: "(Failed to extract Word document text)",
          size: stat.size,
          modified: stat.mtime.toISOString(),
          fileType: "docx",
        });
      }
    }

    if (path.extname(fullPath).toLowerCase() === ".xlsx") {
      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(fullPath);
        const lines: string[] = [];
        for (const ws of workbook.worksheets) {
          lines.push(`=== ${ws.name} ===`);
          ws.eachRow({ includeEmpty: false }, (row) => {
            const cells = (row.values as any[]).slice(1).map((v) => {
              if (v === null || v === undefined) return "";
              if (typeof v === "object" && "result" in v)
                return String(v.result);
              if (typeof v === "object" && "text" in v) return String(v.text);
              return String(v);
            });
            lines.push(cells.join("\t"));
          });
          lines.push("");
        }

        return res.json({
          path: sanitized,
          content: lines.join("\n"),
          size: stat.size,
          modified: stat.mtime.toISOString(),
          fileType: "xlsx",
        });
      } catch {
        return res.json({
          path: sanitized,
          content: "(Failed to extract Excel data)",
          size: stat.size,
          modified: stat.mtime.toISOString(),
          fileType: "xlsx",
        });
      }
    }

    const content = await fs.readFile(fullPath, "utf-8");
    return res.json({
      path: sanitized,
      content,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to read file",
    });
  }
});

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const pathValue = typeof req.body?.path === "string" ? req.body.path : "";
      const relativeDir = pathValue ? sanitizeRelativePath(pathValue) : ".";
      const destDir = jailWorkspacePath(relativeDir);

      await fs.mkdir(destDir, { recursive: true });

      const fullPath = jailWorkspacePath(
        path.join(relativeDir, file.originalname),
      );
      await fs.writeFile(fullPath, file.buffer);

      const stats = await getDirSize(WORKSPACE_ROOT);
      if (stats.totalSize > MAX_WORKSPACE_SIZE) {
        await fs.unlink(fullPath).catch(() => {});
        return res.status(413).json({ error: "Workspace size limit exceeded" });
      }

      return res.status(201).json({
        path: path.relative(WORKSPACE_ROOT, fullPath),
        size: file.size,
        name: file.originalname,
      });
    } catch (error) {
      console.error("Upload error:", error);
      return res.status(500).json({ error: "Failed to upload file" });
    }
  },
);

app.post("/mkdir", async (req: Request, res: Response) => {
  try {
    const dirPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!dirPath) {
      return res.status(400).json({ error: "Path is required" });
    }

    const sanitized = sanitizeRelativePath(dirPath);
    const fullPath = jailWorkspacePath(sanitized);
    await fs.mkdir(fullPath, { recursive: true });
    return res.status(201).json({ path: sanitized });
  } catch (error) {
    console.error("mkdir error:", error);
    return res.status(500).json({ error: "Failed to create directory" });
  }
});

app.post("/move", async (req: Request, res: Response) => {
  try {
    const fromPath = typeof req.body?.from === "string" ? req.body.from : "";
    const toPath = typeof req.body?.to === "string" ? req.body.to : "";

    if (!fromPath || !toPath) {
      return res.status(400).json({ error: "Both from and to are required" });
    }

    const sourceRel = sanitizeRelativePath(fromPath);
    const targetRelDir = sanitizeRelativePath(toPath);
    if (sourceRel === ".") {
      return res.status(400).json({ error: "Cannot move workspace root" });
    }

    const sourcePath = jailWorkspacePath(sourceRel);
    const targetDirPath = jailWorkspacePath(
      targetRelDir === "." ? "" : targetRelDir,
    );

    const sourceStat = await fs.stat(sourcePath);
    const targetStat = await fs.stat(targetDirPath);

    if (!targetStat.isDirectory()) {
      return res.status(400).json({ error: "Target must be a directory" });
    }

    const targetPath = jailWorkspacePath(
      path.join(targetRelDir, path.basename(sourceRel)),
    );
    if (targetPath === sourcePath) {
      return res
        .status(400)
        .json({ error: "Source and destination are the same" });
    }

    if (
      sourceStat.isDirectory() &&
      targetPath.startsWith(`${sourcePath}${path.sep}`)
    ) {
      return res
        .status(400)
        .json({ error: "Cannot move a folder into itself" });
    }

    try {
      await fs.access(targetPath);
      return res.status(409).json({ error: "Destination already exists" });
    } catch {
      // destination does not exist.
    }

    await moveWithFallback(sourcePath, targetPath);
    return res.json({
      from: sourceRel,
      to: path.relative(WORKSPACE_ROOT, targetPath),
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "Source or destination not found" });
    }
    console.error("move error:", error);
    return res.status(500).json({ error: "Failed to move file" });
  }
});

app.delete("/file", async (req: Request, res: Response) => {
  try {
    const filePath = getQueryParam(req.query.path);
    if (!filePath) {
      return res.status(400).json({ error: "Path is required" });
    }

    const sanitized = sanitizeRelativePath(filePath);
    const fullPath = jailWorkspacePath(sanitized);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }

    return res.json({ deleted: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    console.error("Delete error:", error);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

async function start() {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await maybeBootstrapCredentials();
  const agentId = (process.env.AGENT_ID || "").trim();

  const tryStartGoalSessionManager = (): boolean => {
    const apiCallbackUrl = resolveApiCallbackUrl();
    if (goalSessionManager) return true;
    if (!agentId || !apiCallbackUrl || !vmToken) return false;
    goalSessionManager = new GoalSessionManager({
      agentId,
      apiBaseUrl: apiCallbackUrl,
      getVmToken: () => vmToken,
      ensureVmToken: () => ensureAgentVmToken(agentId),
      refreshVmToken: () => refreshAgentVmToken(agentId),
    });
    goalSessionManager.start();
    goalSessionManagersByAgent.set(agentId, goalSessionManager);
    agentVmCredentials.set(agentId, { token: vmToken, expiresAtMs: null });
    return true;
  };

  if (!tryStartGoalSessionManager() && agentId && resolveApiCallbackUrl()) {
    console.warn(
      "Goal session manager disabled: VM credentials unavailable after bootstrap retries.",
    );
    credentialBootstrapRetryTimer = setInterval(
      () => {
        if (goalSessionManager) {
          if (credentialBootstrapRetryTimer) {
            clearInterval(credentialBootstrapRetryTimer);
            credentialBootstrapRetryTimer = null;
          }
          return;
        }
        void maybeBootstrapCredentials({ attempts: 1 })
          .then((bootstrapped) => {
            if (!bootstrapped) return;
            if (!tryStartGoalSessionManager()) return;
            if (credentialBootstrapRetryTimer) {
              clearInterval(credentialBootstrapRetryTimer);
              credentialBootstrapRetryTimer = null;
            }
            console.log("Goal session manager enabled after credential retry.");
          })
          .catch((error) => {
            console.warn("Sandbox credential retry failed:", error);
          });
      },
      Math.max(2_000, CREDENTIAL_BOOTSTRAP_RETRY_DELAY_MS * 5),
    );
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Sandbox server running on http://0.0.0.0:${PORT}`);

    const apiCallbackUrl = resolveApiCallbackUrl();
    if (!agentId || !apiCallbackUrl || !vmToken) {
      return;
    }

    try {
      const startedAt = Date.now();
      const response = await fetch(
        `${apiCallbackUrl}/api/internal/agents/${agentId}/vm-ready`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${vmToken}`,
          },
        },
      );
      console.log(
        `[wake_trace] ${JSON.stringify({
          ts: new Date().toISOString(),
          event: "sandbox.vm_ready_callback",
          agentId,
          status: response.status,
          ok: response.ok,
          elapsedMs: Date.now() - startedAt,
        })}`,
      );
    } catch (error) {
      console.warn(
        `[wake_trace] ${JSON.stringify({
          ts: new Date().toISOString(),
          event: "sandbox.vm_ready_callback_error",
          agentId,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
      console.warn("Sandbox vm-ready callback failed:", error);
    }
  });
}

void start();
