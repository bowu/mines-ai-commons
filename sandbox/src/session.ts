import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type Api, type Model, getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionResult,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";

const STATE_DIR = path.resolve(
  process.env.SANDBOX_STATE_DIR || path.join(process.cwd(), ".sandbox-state"),
);
const AGENTS_DIR = path.join(STATE_DIR, "agents");
const WORKSPACE_DIR = path.resolve(
  process.env.SANDBOX_WORKSPACE_DIR || "/workspace",
);
const WORKSPACE_VENV_BIN = path.join(WORKSPACE_DIR, ".venv", "bin");
const WORKSPACE_NPM_PREFIX = path.join(WORKSPACE_DIR, ".npm-global");
const WORKSPACE_NPM_BIN = path.join(WORKSPACE_NPM_PREFIX, "bin");
const WORKSPACE_PYTHON_USERBASE = path.join(WORKSPACE_DIR, ".py-user");
const WORKSPACE_PYTHON_USER_BIN = path.join(WORKSPACE_PYTHON_USERBASE, "bin");
const WORKSPACE_CACHE_DIR = path.join(WORKSPACE_DIR, ".cache");
const WORKSPACE_PIP_CACHE = path.join(WORKSPACE_DIR, ".cache", "pip");
const WORKSPACE_RISK_DIR = path.join(WORKSPACE_DIR, ".mines");
const WORKSPACE_RISK_LOG = path.join(
  WORKSPACE_RISK_DIR,
  "system-install-risk.log",
);
const WORKSPACE_RISK_MARKER = path.join(
  WORKSPACE_RISK_DIR,
  "system-mutation-flag.json",
);
const SANITIZED_CHILD_ENV_KEYS = [
  "GEMINI_API_KEY",
  "BRAVE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "LITELLM_PROXY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "VM_BOOTSTRAP_SECRET",
  "VM_TOKEN_SECRET",
  "AGENT_ID",
  "API_CALLBACK_URL",
];
const DEFAULT_LITELLM_PROXY_URL = "http://127.0.0.1:4000/v1";
const DEFAULT_LITELLM_MODEL_GEMINI = "gemini-3.1-pro";
const DEFAULT_LITELLM_MODEL_SONNET = "sonnet-4.6";
const DEFAULT_LITELLM_MODEL_OPUS = "opus-4.6";
const DEFAULT_LITELLM_MODEL_GPT = "gpt-5.2";
const DEFAULT_LOCAL_GEMINI_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_LOCAL_SONNET_MODEL = "global.anthropic.claude-sonnet-4-6";
const DEFAULT_LOCAL_OPUS_MODEL = "global.anthropic.claude-opus-4-6-v1";
const DEFAULT_LOCAL_GPT_MODEL = "gpt-5.2";

export interface ChatHistoryEntry {
  role: string;
  content: string;
}

export type AgentModelSelection =
  | "gemini-3.1-pro"
  | "sonnet-4.6"
  | "opus-4.6"
  | "gpt-5.2";

export function getWorkspaceDir(): string {
  return WORKSPACE_DIR;
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

function parseBoolean(value: string | undefined, fallback = false): boolean {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isLocalSandboxMode(): boolean {
  return (process.env.SANDBOX_MODE || "").trim().toLowerCase() === "local";
}

function shouldUseProxyForModel(): boolean {
  if (!isLocalSandboxMode()) {
    return true;
  }
  return parseBoolean(process.env.LOCAL_USE_LITELLM_PROXY, false);
}

function isAnthropicSelection(modelSelection: AgentModelSelection): boolean {
  return modelSelection === "sonnet-4.6" || modelSelection === "opus-4.6";
}

function resolveProxyModelId(modelSelection: AgentModelSelection): string {
  switch (modelSelection) {
    case "sonnet-4.6":
      return (
        (process.env.LITELLM_MODEL_SONNET || "").trim() ||
        DEFAULT_LITELLM_MODEL_SONNET
      );
    case "opus-4.6":
      return (
        (process.env.LITELLM_MODEL_OPUS || "").trim() ||
        DEFAULT_LITELLM_MODEL_OPUS
      );
    case "gpt-5.2":
      return (
        (process.env.LITELLM_MODEL_GPT || "").trim() ||
        DEFAULT_LITELLM_MODEL_GPT
      );
    default:
      return (
        (process.env.LITELLM_MODEL_GEMINI || "").trim() ||
        DEFAULT_LITELLM_MODEL_GEMINI
      );
  }
}

function buildProxyModel(modelSelection: AgentModelSelection): Model<Api> {
  const modelId = resolveProxyModelId(modelSelection);
  const isAnthropic = isAnthropicSelection(modelSelection);
  const baseUrl = isAnthropic
    ? resolveLiteLlmAnthropicBaseUrl(process.env.LITELLM_PROXY_URL)
    : resolveLiteLlmOpenAiBaseUrl(process.env.LITELLM_PROXY_URL);

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

function resolveDirectModelId(modelSelection: AgentModelSelection): string {
  switch (modelSelection) {
    case "sonnet-4.6":
      return (
        (process.env.SANDBOX_LOCAL_SONNET_MODEL_ID || "").trim() ||
        DEFAULT_LOCAL_SONNET_MODEL
      );
    case "opus-4.6":
      return (
        (process.env.SANDBOX_LOCAL_OPUS_MODEL_ID || "").trim() ||
        DEFAULT_LOCAL_OPUS_MODEL
      );
    case "gpt-5.2":
      return (
        (process.env.SANDBOX_LOCAL_GPT_MODEL_ID || "").trim() ||
        DEFAULT_LOCAL_GPT_MODEL
      );
    default:
      return (
        (process.env.SANDBOX_LOCAL_GEMINI_MODEL_ID || "").trim() ||
        DEFAULT_LOCAL_GEMINI_MODEL
      );
  }
}

function buildDirectModel(modelSelection: AgentModelSelection): Model<any> {
  if (modelSelection === "gpt-5.2") {
    return getModel("openai", resolveDirectModelId(modelSelection) as any);
  }
  if (isAnthropicSelection(modelSelection)) {
    return getModel(
      "amazon-bedrock",
      resolveDirectModelId(modelSelection) as any,
    );
  }
  return getModel("google", resolveDirectModelId(modelSelection) as any);
}

function resolveAssistantModelMetadata(
  modelSelection: AgentModelSelection,
  useProxy: boolean,
): { api: string; provider: string; modelId: string } {
  if (useProxy) {
    if (isAnthropicSelection(modelSelection)) {
      return {
        api: "anthropic-messages",
        provider: "anthropic",
        modelId: resolveProxyModelId(modelSelection),
      };
    }
    return {
      api: "openai-completions",
      provider: "openai",
      modelId: resolveProxyModelId(modelSelection),
    };
  }

  const model = buildDirectModel(modelSelection);
  return {
    api: model.api,
    provider: model.provider,
    modelId: model.id,
  };
}

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

function wrapRiskTracking(command: string, riskType: string): string {
  const quotedLog = shellSingleQuote(WORKSPACE_RISK_LOG);
  const quotedMarker = shellSingleQuote(WORKSPACE_RISK_MARKER);
  const quotedDir = shellSingleQuote(WORKSPACE_RISK_DIR);
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
  const logPayloadBase64 = shellSingleQuote(
    Buffer.from(
      `${new Date().toISOString()}\t${riskType}\t${command}\n`,
      "utf8",
    ).toString("base64"),
  );

  return `
(mkdir -p ${quotedDir} && printf '%s' ${logPayloadBase64} | base64 --decode >> ${quotedLog} && printf '%s' ${markerPayloadBase64} | base64 --decode > ${quotedMarker}
) >/dev/null 2>&1 || true
${command}
`.trim();
}

function buildSpawnEnv(env: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  path: string;
} {
  const pathSegments = [WORKSPACE_NPM_BIN, WORKSPACE_PYTHON_USER_BIN];
  if (fsSync.existsSync(WORKSPACE_VENV_BIN)) {
    pathSegments.unshift(WORKSPACE_VENV_BIN);
  }
  const pathValue = mergePathSegments(env.PATH, pathSegments);

  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SANITIZED_CHILD_ENV_KEYS) {
    delete sanitizedEnv[key];
  }

  return {
    env: {
      ...sanitizedEnv,
      HOME: WORKSPACE_DIR,
      PATH: pathValue,
      NPM_CONFIG_PREFIX: WORKSPACE_NPM_PREFIX,
      PYTHONUSERBASE: WORKSPACE_PYTHON_USERBASE,
      XDG_CACHE_HOME: WORKSPACE_CACHE_DIR,
      PIP_CACHE_DIR: WORKSPACE_PIP_CACHE,
    },
    path: pathValue,
  };
}

export const _testOnly = {
  mergePathSegments,
  detectBootDiskRisk,
  wrapRiskTracking,
  buildSpawnEnv,
  parseBoolean,
  isLocalSandboxMode,
  shouldUseProxyForModel,
  resolveLiteLlmOpenAiBaseUrl,
  resolveLiteLlmAnthropicBaseUrl,
  resolveProxyModelId,
  buildProxyModel,
  resolveDirectModelId,
  buildDirectModel,
};

async function ensureAgentDir(agentId: string): Promise<string> {
  const agentDir = path.join(AGENTS_DIR, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  return agentDir;
}

async function ensureAuth(
  agentDir: string,
  modelSelection: AgentModelSelection,
  useProxy: boolean,
): Promise<AuthStorage> {
  const authPath = path.join(agentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);

  if (useProxy) {
    const litellmKey = (process.env.LITELLM_PROXY_API_KEY || "").trim();
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

  if (isAnthropicSelection(modelSelection)) {
    if (!(process.env.AWS_ACCESS_KEY_ID || "").trim()) {
      throw new Error("AWS_ACCESS_KEY_ID is required for local Bedrock mode");
    }
    if (!(process.env.AWS_SECRET_ACCESS_KEY || "").trim()) {
      throw new Error(
        "AWS_SECRET_ACCESS_KEY is required for local Bedrock mode",
      );
    }
    if (!(process.env.AWS_REGION || "").trim()) {
      throw new Error("AWS_REGION is required for local Bedrock mode");
    }
    return authStorage;
  }

  if (modelSelection === "gpt-5.2") {
    if (!(process.env.OPENAI_API_KEY || "").trim()) {
      throw new Error("OPENAI_API_KEY is required for local GPT mode");
    }
    return authStorage;
  }

  if (!(process.env.GEMINI_API_KEY || "").trim()) {
    throw new Error("GEMINI_API_KEY is required for local Gemini mode");
  }

  return authStorage;
}

export async function createPiSession(
  agentId: string,
  sessionId: string,
  systemPrompt: string,
  customTools: ToolDefinition[] = [],
  chatHistory: ChatHistoryEntry[] = [],
  modelSelection: AgentModelSelection = "gemini-3.1-pro",
  extensionFactories: ExtensionFactory[] = [],
): Promise<CreateAgentSessionResult> {
  const agentDir = await ensureAgentDir(agentId);
  const useProxy = shouldUseProxyForModel();
  const authStorage = await ensureAuth(agentDir, modelSelection, useProxy);
  const modelRegistry = new ModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
  );
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.create(WORKSPACE_DIR, agentDir);

  const model = useProxy
    ? buildProxyModel(modelSelection)
    : buildDirectModel(modelSelection);

  const tools = createCodingTools(WORKSPACE_DIR, {
    bash: {
      spawnHook: ({ command, cwd, env }) => {
        const merged = buildSpawnEnv(env);
        const riskType = detectBootDiskRisk(command);
        return {
          command: riskType ? wrapRiskTracking(command, riskType) : command,
          cwd,
          env: merged.env,
        };
      },
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: WORKSPACE_DIR,
    agentDir,
    settingsManager,
    systemPrompt: systemPrompt || undefined,
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd: WORKSPACE_DIR,
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

  if (chatHistory.length > 0) {
    const agentMessages: any[] = [];
    const now = Date.now();
    const assistantModel = resolveAssistantModelMetadata(
      modelSelection,
      useProxy,
    );
    for (const msg of chatHistory) {
      if (msg.role === "user") {
        agentMessages.push({
          role: "user",
          content: [{ type: "text", text: msg.content }],
          timestamp: now,
        });
      } else if (msg.role === "assistant" && msg.content) {
        agentMessages.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: assistantModel.api,
          provider: assistantModel.provider,
          model: assistantModel.modelId,
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

  // Keep a stable ID for debugging/logging.
  (result.session as any).__sandboxSessionId = sessionId;

  return result;
}
