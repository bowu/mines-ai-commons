/**
 * Pi-coding-agent session management.
 * Creates and manages agent sessions with AuthStorage, ModelRegistry, etc.
 */

import fsSync from "node:fs";
import path from "path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type BashSpawnContext,
  type CreateAgentSessionResult,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import fs from "fs/promises";
import { config } from "../../config.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const AGENTS_DIR = path.join(DATA_DIR, "agents");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const SESSION_ABORT_TIMEOUT_MS = 4_000;
const DEFAULT_LITELLM_PROXY_URL = "http://127.0.0.1:4000/v1";
const DEFAULT_LITELLM_MODEL_GEMINI = "gemini-3.1-pro";
const DEFAULT_LITELLM_MODEL_SONNET = "sonnet-4.6";
const DEFAULT_LITELLM_MODEL_OPUS = "opus-4.6";
const DEFAULT_LITELLM_MODEL_GPT = "gpt-5.2";

function mergePathSegments(
  currentPath: string | undefined,
  segments: string[],
): string {
  const existing = (currentPath || process.env.PATH || "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const segment of [...segments, ...existing]) {
    if (!segment || merged.includes(segment)) continue;
    merged.push(segment);
  }
  return merged.join(":");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function detectBootDiskRisk(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return null;

  if (/\bsudo\s+apt(-get)?\b.*\binstall\b/.test(normalized)) {
    return "sudo_apt_install";
  }

  if (/\bsudo\s+(pip|pip3|python\s+-m\s+pip)\b.*\binstall\b/.test(normalized)) {
    return "sudo_pip_install";
  }

  if (
    /\bsudo\s+npm\b.*(\s-g\b|\s--global\b)/.test(normalized) ||
    /\bsudo\s+npm\b.*\binstall\b.*(\s-g\b|\s--global\b)/.test(normalized)
  ) {
    return "sudo_npm_global_install";
  }

  return null;
}

function wrapRiskTracking(
  workspaceDir: string,
  command: string,
  riskType: string,
): string {
  const riskDir = path.join(workspaceDir, ".mines");
  const riskLog = path.join(riskDir, "system-install-risk.log");
  const riskMarker = path.join(riskDir, "system-mutation-flag.json");
  const quotedRiskDir = shellSingleQuote(riskDir);
  const quotedRiskLog = shellSingleQuote(riskLog);
  const quotedMarker = shellSingleQuote(riskMarker);
  const markerPayloadBase64 = shellSingleQuote(
    Buffer.from(
      JSON.stringify({
        detected: true,
        riskType,
        command,
        detectedAt: new Date().toISOString(),
      }),
      "utf8",
    ).toString("base64"),
  );
  const quotedLogPayloadBase64 = shellSingleQuote(
    Buffer.from(
      `${new Date().toISOString()}\t${riskType}\t${command}\n`,
      "utf8",
    ).toString("base64"),
  );

  return `
(mkdir -p ${quotedRiskDir} && printf '%s' ${quotedLogPayloadBase64} | base64 --decode >> ${quotedRiskLog} && printf '%s' ${markerPayloadBase64} | base64 --decode > ${quotedMarker}
) >/dev/null 2>&1 || true
${command}
`.trim();
}

function buildBashSpawnHook(workspaceDir: string) {
  const venvBin = path.join(workspaceDir, ".venv", "bin");
  const npmPrefix = path.join(workspaceDir, ".npm-global");
  const npmBin = path.join(npmPrefix, "bin");
  const pythonUserBase = path.join(workspaceDir, ".py-user");
  const pythonUserBin = path.join(pythonUserBase, "bin");
  const xdgCacheHome = path.join(workspaceDir, ".cache");
  const pipCacheDir = path.join(workspaceDir, ".cache", "pip");

  return ({ command, cwd, env }: BashSpawnContext): BashSpawnContext => {
    const pathSegments = [npmBin, pythonUserBin];
    if (fsSync.existsSync(venvBin)) {
      pathSegments.unshift(venvBin);
    }
    const mergedPath = mergePathSegments(env.PATH, pathSegments);
    const riskType = detectBootDiskRisk(command);

    return {
      command: riskType
        ? wrapRiskTracking(workspaceDir, command, riskType)
        : command,
      cwd,
      env: {
        ...env,
        HOME: workspaceDir,
        PATH: mergedPath,
        NPM_CONFIG_PREFIX: npmPrefix,
        PYTHONUSERBASE: pythonUserBase,
        XDG_CACHE_HOME: xdgCacheHome,
        PIP_CACHE_DIR: pipCacheDir,
      },
    };
  };
}

function resolveLiteLlmOpenAiBaseUrl(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  const base = (trimmed || DEFAULT_LITELLM_PROXY_URL).replace(/\/+$/, "");
  if (base.endsWith("/v1")) {
    return base;
  }
  return `${base}/v1`;
}

function resolveLiteLlmAnthropicBaseUrl(raw: string | undefined): string {
  const openAiBase = resolveLiteLlmOpenAiBaseUrl(raw);
  return openAiBase.replace(/\/v1$/i, "");
}

function isAnthropicSelection(modelSelection: AgentModelSelection): boolean {
  return modelSelection === "sonnet-4.6" || modelSelection === "opus-4.6";
}

function resolveProxyModelId(modelSelection: AgentModelSelection): string {
  switch (modelSelection) {
    case "sonnet-4.6":
      return config.litellmModelSonnet || DEFAULT_LITELLM_MODEL_SONNET;
    case "opus-4.6":
      return config.litellmModelOpus || DEFAULT_LITELLM_MODEL_OPUS;
    case "gpt-5.2":
      return config.litellmModelGpt || DEFAULT_LITELLM_MODEL_GPT;
    default:
      return config.litellmModelGemini || DEFAULT_LITELLM_MODEL_GEMINI;
  }
}

function buildProxyModel(modelSelection: AgentModelSelection): Model<Api> {
  const modelId = resolveProxyModelId(modelSelection);
  const isAnthropic = isAnthropicSelection(modelSelection);
  const baseUrl = isAnthropic
    ? resolveLiteLlmAnthropicBaseUrl(config.litellmProxyUrl)
    : resolveLiteLlmOpenAiBaseUrl(config.litellmProxyUrl);

  if (isAnthropic) {
    // Use LiteLLM's Anthropic-compatible endpoint so Sonnet thinking + tools
    // preserve thinking blocks/signatures across turns.
    return {
      id: modelId,
      name:
        modelSelection === "opus-4.6"
          ? "Opus 4.6 (LiteLLM Anthropic)"
          : "Sonnet 4.6 (LiteLLM Anthropic)",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 64000,
    };
  }

  return {
    id: modelId,
    name: "Gemini 3.1 Pro (LiteLLM)",
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };
}

// Cache sessions per agent to maintain conversation history
interface CachedSession {
  result: CreateAgentSessionResult;
  promptHash: string; // detect config changes
  toolNames: string[]; // detect tool changes
}
const sessionCache = new Map<string, CachedSession>();

function getSessionCacheKey(
  orgId: string,
  agentId: string,
  sessionId: string,
): string {
  return `${orgId}:${agentId}:${sessionId}`;
}

async function abortSessionWithTimeout(
  session: CreateAgentSessionResult["session"],
  timeoutMs = SESSION_ABORT_TIMEOUT_MS,
): Promise<boolean> {
  const timed = await Promise.race([
    session
      .abort()
      .then(() => false)
      .catch(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), timeoutMs),
    ),
  ]);
  return !timed;
}

/** Simple hash for detecting config changes */
function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Ensure directories exist for an agent */
export async function ensureAgentDirs(
  orgId: string,
  agentId: string,
): Promise<{ agentDir: string; workspaceDir: string }> {
  const agentDir = path.join(AGENTS_DIR, orgId, agentId);
  const workspaceDir = path.join(WORKSPACES_DIR, orgId, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { agentDir, workspaceDir };
}

/** Remove directories for a deleted agent */
export async function removeAgentDirs(
  orgId: string,
  agentId: string,
): Promise<void> {
  const agentDir = path.join(AGENTS_DIR, orgId, agentId);
  const workspaceDir = path.join(WORKSPACES_DIR, orgId, agentId);
  await fs.rm(agentDir, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
  invalidateSession(orgId, agentId);
}

/** Get workspace directory path for an agent */
export function getWorkspaceDir(orgId: string, agentId: string): string {
  return path.join(WORKSPACES_DIR, orgId, agentId);
}

/** Set up auth for an agent session. */
async function ensureAuth(agentDir: string): Promise<AuthStorage> {
  const authPath = path.join(agentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  const litellmKey = (config.litellmProxyApiKey || "").trim();
  if (litellmKey && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = litellmKey;
  }
  if (litellmKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = litellmKey;
  }
  if (
    !(process.env.OPENAI_API_KEY || "").trim() ||
    !(process.env.ANTHROPIC_API_KEY || "").trim()
  ) {
    throw new Error(
      "LiteLLM proxy key is missing (set LITELLM_PROXY_API_KEY; it seeds OPENAI_API_KEY + ANTHROPIC_API_KEY)",
    );
  }

  return authStorage;
}

/** Invalidate all cached sessions for an agent (call when config changes) */
export function invalidateSession(orgId: string, agentId: string): void {
  const prefix = `${orgId}:${agentId}:`;
  for (const [key, cached] of sessionCache) {
    if (key.startsWith(prefix)) {
      cached.result.session.dispose();
      sessionCache.delete(key);
    }
  }
}

/** Chat history entry for injecting into new sessions */
export interface ChatHistoryEntry {
  role: string;
  content: string;
}

export type AgentModelSelection =
  | "gemini-3.1-pro"
  | "sonnet-4.6"
  | "opus-4.6"
  | "gpt-5.2";

export const _testOnly = {
  resolveLiteLlmOpenAiBaseUrl,
  resolveLiteLlmAnthropicBaseUrl,
  resolveProxyModelId,
  buildProxyModel,
};

/** Create or get a cached pi-coding-agent session for a conversation */
export async function getPiSession(
  orgId: string,
  agentId: string,
  sessionId: string,
  systemPrompt: string,
  customTools: ToolDefinition[] = [],
  chatHistory: ChatHistoryEntry[] = [],
  modelSelection: AgentModelSelection = "gemini-3.1-pro",
): Promise<CreateAgentSessionResult> {
  const promptHash = hashString(systemPrompt + modelSelection);
  const toolNames = customTools.map((t) => t.name).sort();
  const cacheKey = getSessionCacheKey(orgId, agentId, sessionId);

  // Check cache — reuse if config hasn't changed
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    // Recover from wedged sessions that never finished (e.g., hung tool process).
    if (cached.result.session.isStreaming) {
      await abortSessionWithTimeout(cached.result.session);
      if (cached.result.session.isStreaming) {
        cached.result.session.dispose();
      }
      sessionCache.delete(cacheKey);
    }

    const samePrompt = cached.promptHash === promptHash;
    const sameTools =
      JSON.stringify(cached.toolNames) === JSON.stringify(toolNames);
    if (samePrompt && sameTools && !cached.result.session.isStreaming) {
      return cached.result;
    }
    // Config changed — dispose old session
    cached.result.session.dispose();
    sessionCache.delete(cacheKey);
  }

  const { agentDir, workspaceDir } = await ensureAgentDirs(orgId, agentId);

  const authStorage = await ensureAuth(agentDir);
  const modelRegistry = new ModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
  );
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.create(workspaceDir, agentDir);

  const model = buildProxyModel(modelSelection);

  // Create coding tools scoped to workspace
  const tools = createCodingTools(workspaceDir, {
    bash: {
      spawnHook: buildBashSpawnHook(workspaceDir),
    },
  });

  // Use DefaultResourceLoader to properly set the system prompt
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir,
    settingsManager,
    systemPrompt: systemPrompt || undefined,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd: workspaceDir,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    tools,
    customTools,
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  // Inject previous chat history so the agent has context
  if (chatHistory.length > 0) {
    const agentMessages: any[] = [];
    const now = Date.now();
    const assistantModelId = resolveProxyModelId(modelSelection);
    for (const msg of chatHistory) {
      if (msg.role === "user") {
        agentMessages.push({
          role: "user",
          content: [{ type: "text", text: msg.content }],
          timestamp: now,
        });
      } else if (msg.role === "assistant" && msg.content) {
        const assistantBase = isAnthropicSelection(modelSelection)
          ? { api: "anthropic-messages", provider: "anthropic" }
          : { api: "openai-completions", provider: "openai" };
        agentMessages.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: assistantBase.api,
          provider: assistantBase.provider,
          model: assistantModelId,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "stop",
          timestamp: now,
        });
      }
    }
    if (agentMessages.length > 0) {
      result.session.agent.replaceMessages(agentMessages);
    }
  }

  // Cache for reuse
  sessionCache.set(cacheKey, { result, promptHash, toolNames });

  return result;
}
