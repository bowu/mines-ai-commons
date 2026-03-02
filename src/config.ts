import "dotenv/config";

const DEFAULT_PORT = 3001;
const DEFAULT_MAX_AGENT_RUNTIME_MS = 5 * 60 * 60 * 1000;
const DEFAULT_READINESS_DB_TIMEOUT_MS = 3_000;
const DEFAULT_DB_POOL_MAX = 20;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_ORG_SLUG = "mines";
const DEFAULT_PUBLIC_URL = "http://localhost:5173";
const DEFAULT_USER_EMAIL = "admin@mines.edu";
const DEFAULT_USER_NAME = "Default Admin";
const DEFAULT_AUTH_PROVIDER = "none";
const DEFAULT_MAGIC_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_MODE = "local";
const DEFAULT_SANDBOX_LOCAL_URL = "http://127.0.0.1:8888";
const DEFAULT_API_CALLBACK_URL = "http://localhost:3001";
const DEFAULT_GCE_IMAGE_PROJECT = "ubuntu-os-cloud";
const DEFAULT_GCE_IMAGE_FAMILY = "ubuntu-2204-lts";
const DEFAULT_GCE_MACHINE_TYPE = "e2-medium";
const DEFAULT_GCE_GPU_MACHINE_TYPE = "n1-standard-4";
const DEFAULT_GCE_GPU_TYPE = "nvidia-tesla-t4";
const DEFAULT_GCE_NETWORK = "default";
const DEFAULT_GCE_BOOT_DISK_SIZE_GB = 30;
const DEFAULT_GCE_DATA_DISK_SIZE_GB = 50;
const DEFAULT_SANDBOX_HEALTH_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SANDBOX_READY_RETRY_AFTER_MS = 5_000;
const DEFAULT_SANDBOX_IDLE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SANDBOX_IDLE_CPU_MS = 15 * 60_000;
const DEFAULT_SANDBOX_IDLE_GPU_MS = 15 * 60_000;
const DEFAULT_SANDBOX_ACTIVITY_TOUCH_MIN_INTERVAL_MS = 15_000;
const DEFAULT_SANDBOX_STREAM_LEASE_REFRESH_MS = 30_000;
const DEFAULT_SANDBOX_STREAM_LEASE_TTL_MS = 90_000;
const DEFAULT_SANDBOX_RECONCILE_DB_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_SANDBOX_GCE_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_SANDBOX_STARTUP_GRACE_MS = 5 * 60_000;
const DEFAULT_SANDBOX_STARTUP_GRACE_MS_DEV_GCE = 5 * 60_000;
const DEFAULT_GCE_ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SANDBOX_ORPHAN_SWEEP_DELETE_ENABLED = false;
const DEFAULT_SANDBOX_WAKE_TRACE_LOGS = false;
const DEFAULT_SANDBOX_WAKE_TRACE_FILE_PATH = "data/logs/wake-trace.ndjson";
const DEFAULT_SANDBOX_WAKE_TRACE_CONSOLE = false;
const DEFAULT_SANDBOX_EXPECTED_RUNTIME_VERSION = "";
const DEFAULT_AUTH_MAGIC_REQUEST_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_MAGIC_REQUEST_RATE_LIMIT_MAX = 5;
const DEFAULT_AUTH_MAGIC_VERIFY_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_MAGIC_VERIFY_RATE_LIMIT_MAX = 30;
const DEFAULT_AUTH_MAGIC_RESEND_COOLDOWN_MS = 30_000;
const DEFAULT_AGENT_CREATE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const DEFAULT_AGENT_CREATE_RATE_LIMIT_MAX = 10;
const DEFAULT_AGENT_CHAT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AGENT_CHAT_RATE_LIMIT_MAX = 120;
const DEFAULT_CHAT_RESUMABLE_STREAM = true;
const DEFAULT_CHAT_RESUMABLE_MAX_EVENT_BYTES = 8 * 1024;
const DEFAULT_CHAT_RESUMABLE_MAX_EVENTS_PER_TURN = 500;
const DEFAULT_CHAT_RESUMABLE_MAX_TURN_BYTES = 4 * 1024 * 1024;
const DEFAULT_CHAT_RESUMABLE_MAX_ACTIVE_TURNS = 50;
const DEFAULT_CHAT_RESUMABLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LITELLM_PROXY_URL = "http://127.0.0.1:4000/v1";
const DEFAULT_LITELLM_MODEL_GEMINI = "gemini-3.1-pro";
const DEFAULT_LITELLM_MODEL_SONNET = "sonnet-4.6";
const DEFAULT_LITELLM_MODEL_OPUS = "opus-4.6";
const DEFAULT_LITELLM_MODEL_GPT = "gpt-5.2";

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function optionalPositiveInteger(name: string, fallback: number): number {
  const value = optional(name, "").trim();
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = optional(name, "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeUrlHost(value: string): string {
  try {
    return new URL(normalizeOrigin(value)).host.toLowerCase();
  } catch {
    return "";
  }
}

function parseCorsAllowlist(publicUrl: string, extraOrigins: string): string[] {
  const set = new Set<string>();
  const normalizedPublic = normalizeOrigin(publicUrl);
  if (normalizedPublic) {
    set.add(normalizedPublic);
  }
  for (const rawOrigin of extraOrigins.split(",")) {
    const normalized = normalizeOrigin(rawOrigin);
    if (!normalized) continue;
    set.add(normalized);
  }
  return Array.from(set);
}

const configuredPort = optionalPositiveInteger("PORT", DEFAULT_PORT);
const configuredNodeEnv = optional("NODE_ENV", "development").trim();
const configuredPublicUrl = normalizeOrigin(
  optional("PUBLIC_URL", DEFAULT_PUBLIC_URL),
);
const configuredApiCallbackUrl = normalizeOrigin(
  optional("API_CALLBACK_URL", DEFAULT_API_CALLBACK_URL),
);
const allowApiCallbackHostMismatch = optionalBoolean(
  "ALLOW_API_CALLBACK_HOST_MISMATCH",
  false,
);
const configuredCorsOrigins = optional("CORS_ORIGINS", "");
const authProviderRaw = optional("AUTH_PROVIDER", DEFAULT_AUTH_PROVIDER).trim();
const authProvider =
  authProviderRaw === "oidc"
    ? "oidc"
    : authProviderRaw === "magic"
      ? "magic"
      : "none";
const sandboxModeRaw = optional("SANDBOX_MODE", DEFAULT_SANDBOX_MODE)
  .trim()
  .toLowerCase();
const sandboxMode = sandboxModeRaw === "gce" ? "gce" : "local";
const defaultStartupGraceMs =
  sandboxMode === "gce" && configuredNodeEnv !== "production"
    ? DEFAULT_SANDBOX_STARTUP_GRACE_MS_DEV_GCE
    : DEFAULT_SANDBOX_STARTUP_GRACE_MS;

const effectiveApiCallbackUrl = (() => {
  const callbackUrl = configuredApiCallbackUrl || configuredPublicUrl;
  if (!callbackUrl) {
    return DEFAULT_API_CALLBACK_URL;
  }

  if (
    configuredNodeEnv !== "production" ||
    allowApiCallbackHostMismatch ||
    !configuredPublicUrl
  ) {
    return callbackUrl;
  }

  const callbackHost = normalizeUrlHost(callbackUrl);
  const publicHost = normalizeUrlHost(configuredPublicUrl);
  const publicUsesHttps = configuredPublicUrl
    .toLowerCase()
    .startsWith("https://");
  if (callbackHost && publicHost && callbackHost !== publicHost) {
    if (!publicUsesHttps) {
      console.warn(
        `[config] API_CALLBACK_URL host '${callbackHost}' does not match PUBLIC_URL host '${publicHost}' in production; PUBLIC_URL is not https, so keeping API_CALLBACK_URL.`,
      );
      return callbackUrl;
    }
    console.warn(
      `[config] API_CALLBACK_URL host '${callbackHost}' does not match PUBLIC_URL host '${publicHost}' in production; using PUBLIC_URL for sandbox callbacks.`,
    );
    return configuredPublicUrl;
  }

  return callbackUrl;
})();

export const config = {
  nodeEnv: configuredNodeEnv,
  port: configuredPort,
  authProvider,
  sessionSecret: optional("SESSION_SECRET", "").trim(),
  publicUrl: configuredPublicUrl,
  corsOrigins: configuredCorsOrigins,
  corsAllowedOrigins: parseCorsAllowlist(
    configuredPublicUrl,
    configuredCorsOrigins,
  ),
  oidcIssuerUrl: optional("OIDC_ISSUER_URL", "").trim(),
  oidcClientId: optional("OIDC_CLIENT_ID", "").trim(),
  oidcClientSecret: optional("OIDC_CLIENT_SECRET", "").trim(),
  oidcCallbackUrl: optional("OIDC_CALLBACK_URL", "").trim(),
  sendgridApiKey: optional("SENDGRID_API_KEY", "").trim(),
  authMagicFromEmail: optional("AUTH_MAGIC_FROM_EMAIL", "").trim(),
  authMagicLinkTtlMs: optionalPositiveInteger(
    "AUTH_MAGIC_LINK_TTL_MS",
    DEFAULT_MAGIC_LINK_TTL_MS,
  ),
  authMagicLinkSecret: optional("AUTH_MAGIC_LINK_SECRET", "").trim(),
  authMagicRequestRateLimitWindowMs: optionalPositiveInteger(
    "AUTH_MAGIC_REQUEST_RATE_LIMIT_WINDOW_MS",
    DEFAULT_AUTH_MAGIC_REQUEST_RATE_LIMIT_WINDOW_MS,
  ),
  authMagicRequestRateLimitMax: optionalPositiveInteger(
    "AUTH_MAGIC_REQUEST_RATE_LIMIT_MAX",
    DEFAULT_AUTH_MAGIC_REQUEST_RATE_LIMIT_MAX,
  ),
  authMagicVerifyRateLimitWindowMs: optionalPositiveInteger(
    "AUTH_MAGIC_VERIFY_RATE_LIMIT_WINDOW_MS",
    DEFAULT_AUTH_MAGIC_VERIFY_RATE_LIMIT_WINDOW_MS,
  ),
  authMagicVerifyRateLimitMax: optionalPositiveInteger(
    "AUTH_MAGIC_VERIFY_RATE_LIMIT_MAX",
    DEFAULT_AUTH_MAGIC_VERIFY_RATE_LIMIT_MAX,
  ),
  authMagicResendCooldownMs: optionalPositiveInteger(
    "AUTH_MAGIC_RESEND_COOLDOWN_MS",
    DEFAULT_AUTH_MAGIC_RESEND_COOLDOWN_MS,
  ),
  defaultUserEmail: optional("DEFAULT_USER_EMAIL", DEFAULT_USER_EMAIL)
    .trim()
    .toLowerCase(),
  defaultUserName: optional("DEFAULT_USER_NAME", DEFAULT_USER_NAME).trim(),
  databaseUrl: required("DATABASE_URL"),
  appDatabaseUrl: optional("APP_DATABASE_URL", "").trim(),
  vmInternalDatabaseUrl: optional("VM_INTERNAL_DATABASE_URL", "").trim(),
  authBootstrapDatabaseUrl: optional("AUTH_BOOTSTRAP_DATABASE_URL", "").trim(),
  defaultOrgSlug: optional("DEFAULT_ORG_SLUG", DEFAULT_ORG_SLUG).trim(),
  geminiApiKey: optional("GEMINI_API_KEY", "").trim(),
  awsAccessKeyId: optional("AWS_ACCESS_KEY_ID", "").trim(),
  awsSecretAccessKey: optional("AWS_SECRET_ACCESS_KEY", "").trim(),
  awsSessionToken: optional("AWS_SESSION_TOKEN", "").trim(),
  awsRegion: optional("AWS_REGION", "").trim(),
  litellmProxyUrl: optional("LITELLM_PROXY_URL", DEFAULT_LITELLM_PROXY_URL)
    .trim()
    .replace(/\/+$/, ""),
  litellmProxyApiKey: optional("LITELLM_PROXY_API_KEY", "").trim(),
  devGceAllowProviderKeys: optionalBoolean(
    "DEV_GCE_ALLOW_PROVIDER_KEYS",
    false,
  ),
  devGceForceRuntimeBundle: optionalBoolean(
    "DEV_GCE_FORCE_RUNTIME_BUNDLE",
    false,
  ),
  litellmModelGemini: optional(
    "LITELLM_MODEL_GEMINI",
    DEFAULT_LITELLM_MODEL_GEMINI,
  ).trim(),
  litellmModelSonnet: optional(
    "LITELLM_MODEL_SONNET",
    DEFAULT_LITELLM_MODEL_SONNET,
  ).trim(),
  litellmModelOpus: optional(
    "LITELLM_MODEL_OPUS",
    DEFAULT_LITELLM_MODEL_OPUS,
  ).trim(),
  litellmModelGpt: optional(
    "LITELLM_MODEL_GPT",
    DEFAULT_LITELLM_MODEL_GPT,
  ).trim(),
  piAgentMaxRuntimeMs: optionalPositiveInteger(
    "PI_AGENT_MAX_RUNTIME_MS",
    DEFAULT_MAX_AGENT_RUNTIME_MS,
  ),
  braveApiKey: optional("BRAVE_API_KEY", "").trim(),
  readinessDbTimeoutMs: optionalPositiveInteger(
    "READINESS_DB_TIMEOUT_MS",
    DEFAULT_READINESS_DB_TIMEOUT_MS,
  ),
  dbPoolMax: optionalPositiveInteger("DB_POOL_MAX", DEFAULT_DB_POOL_MAX),
  dbPoolIdleTimeoutMs: optionalPositiveInteger(
    "DB_POOL_IDLE_TIMEOUT_MS",
    DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
  ),
  dbPoolConnectionTimeoutMs: optionalPositiveInteger(
    "DB_POOL_CONNECTION_TIMEOUT_MS",
    DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS,
  ),
  sandboxMode,
  sandboxLocalUrl: optional("SANDBOX_LOCAL_URL", DEFAULT_SANDBOX_LOCAL_URL)
    .trim()
    .replace(/\/+$/, ""),
  apiCallbackUrl: effectiveApiCallbackUrl,
  gcpProjectId: optional("GCP_PROJECT_ID", "").trim(),
  gcpZone: optional("GCP_ZONE", "us-central1-f").trim(),
  gcpServiceAccountKey: (() => {
    const raw = optional("GCP_SERVICE_ACCOUNT_KEY", "").trim();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("GCP_SERVICE_ACCOUNT_KEY is not valid JSON");
    }
  })(),
  gceImageProject: optional(
    "GCE_IMAGE_PROJECT",
    DEFAULT_GCE_IMAGE_PROJECT,
  ).trim(),
  gceImageFamily: optional("GCE_IMAGE_FAMILY", DEFAULT_GCE_IMAGE_FAMILY).trim(),
  gceMachineType: optional("GCE_MACHINE_TYPE", DEFAULT_GCE_MACHINE_TYPE).trim(),
  gceGpuMachineType: optional(
    "GCE_GPU_MACHINE_TYPE",
    DEFAULT_GCE_GPU_MACHINE_TYPE,
  ).trim(),
  gceGpuType: optional("GCE_GPU_TYPE", DEFAULT_GCE_GPU_TYPE).trim(),
  gceNetwork: optional("GCE_NETWORK", DEFAULT_GCE_NETWORK).trim(),
  gceSubnetwork: optional("GCE_SUBNETWORK", "").trim(),
  gceBootDiskSizeGb: optionalPositiveInteger(
    "GCE_BOOT_DISK_SIZE_GB",
    DEFAULT_GCE_BOOT_DISK_SIZE_GB,
  ),
  gceDataDiskSizeGb: optionalPositiveInteger(
    "GCE_DATA_DISK_SIZE_GB",
    DEFAULT_GCE_DATA_DISK_SIZE_GB,
  ),
  gceUseExternalIp: optionalBoolean("GCE_USE_EXTERNAL_IP", true),
  sandboxHealthProbeTimeoutMs: optionalPositiveInteger(
    "SANDBOX_HEALTH_PROBE_TIMEOUT_MS",
    DEFAULT_SANDBOX_HEALTH_PROBE_TIMEOUT_MS,
  ),
  sandboxReadyRetryAfterMs: optionalPositiveInteger(
    "SANDBOX_READY_RETRY_AFTER_MS",
    DEFAULT_SANDBOX_READY_RETRY_AFTER_MS,
  ),
  sandboxIdlePollIntervalMs: optionalPositiveInteger(
    "SANDBOX_IDLE_POLL_INTERVAL_MS",
    DEFAULT_SANDBOX_IDLE_POLL_INTERVAL_MS,
  ),
  sandboxIdleCpuMs: optionalPositiveInteger(
    "SANDBOX_IDLE_CPU_MS",
    DEFAULT_SANDBOX_IDLE_CPU_MS,
  ),
  sandboxIdleGpuMs: optionalPositiveInteger(
    "SANDBOX_IDLE_GPU_MS",
    DEFAULT_SANDBOX_IDLE_GPU_MS,
  ),
  sandboxActivityTouchMinIntervalMs: optionalPositiveInteger(
    "SANDBOX_ACTIVITY_TOUCH_MIN_INTERVAL_MS",
    DEFAULT_SANDBOX_ACTIVITY_TOUCH_MIN_INTERVAL_MS,
  ),
  sandboxStreamLeaseRefreshMs: optionalPositiveInteger(
    "SANDBOX_STREAM_LEASE_REFRESH_MS",
    DEFAULT_SANDBOX_STREAM_LEASE_REFRESH_MS,
  ),
  sandboxStreamLeaseTtlMs: optionalPositiveInteger(
    "SANDBOX_STREAM_LEASE_TTL_MS",
    DEFAULT_SANDBOX_STREAM_LEASE_TTL_MS,
  ),
  sandboxReconcileDbQueryTimeoutMs: optionalPositiveInteger(
    "SANDBOX_RECONCILE_DB_QUERY_TIMEOUT_MS",
    DEFAULT_SANDBOX_RECONCILE_DB_QUERY_TIMEOUT_MS,
  ),
  sandboxGceOperationTimeoutMs: optionalPositiveInteger(
    "SANDBOX_GCE_OPERATION_TIMEOUT_MS",
    DEFAULT_SANDBOX_GCE_OPERATION_TIMEOUT_MS,
  ),
  sandboxStartupGraceMs: optionalPositiveInteger(
    "SANDBOX_STARTUP_GRACE_MS",
    defaultStartupGraceMs,
  ),
  sandboxWakeTraceLogs: optionalBoolean(
    "SANDBOX_WAKE_TRACE_LOGS",
    DEFAULT_SANDBOX_WAKE_TRACE_LOGS,
  ),
  sandboxWakeTraceFilePath: optional(
    "SANDBOX_WAKE_TRACE_FILE_PATH",
    DEFAULT_SANDBOX_WAKE_TRACE_FILE_PATH,
  ).trim(),
  sandboxWakeTraceConsole: optionalBoolean(
    "SANDBOX_WAKE_TRACE_CONSOLE",
    DEFAULT_SANDBOX_WAKE_TRACE_CONSOLE,
  ),
  sandboxWakeTraceAgentIds: optional("SANDBOX_WAKE_TRACE_AGENT_IDS", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  sandboxExpectedRuntimeVersion: optional(
    "SANDBOX_EXPECTED_RUNTIME_VERSION",
    DEFAULT_SANDBOX_EXPECTED_RUNTIME_VERSION,
  ).trim(),
  gceOrphanMaxAgeMs: optionalPositiveInteger(
    "GCE_ORPHAN_MAX_AGE_MS",
    DEFAULT_GCE_ORPHAN_MAX_AGE_MS,
  ),
  sandboxOrphanSweepDeleteEnabled: optionalBoolean(
    "SANDBOX_ORPHAN_SWEEP_DELETE_ENABLED",
    DEFAULT_SANDBOX_ORPHAN_SWEEP_DELETE_ENABLED,
  ),
  vmTokenSecret: optional("VM_TOKEN_SECRET", "").trim(),
  vmBootstrapSecret: optional("VM_BOOTSTRAP_SECRET", "").trim(),
  vmServiceAccountEmail: optional("VM_SERVICE_ACCOUNT_EMAIL", "").trim(),
  bedrockRoleArn: optional("BEDROCK_ROLE_ARN", "").trim(),
  authEmailWhitelist: new Set(
    optional("AUTH_EMAIL_WHITELIST", "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
  agentCreateRateLimitWindowMs: optionalPositiveInteger(
    "AGENT_CREATE_RATE_LIMIT_WINDOW_MS",
    DEFAULT_AGENT_CREATE_RATE_LIMIT_WINDOW_MS,
  ),
  agentCreateRateLimitMax: optionalPositiveInteger(
    "AGENT_CREATE_RATE_LIMIT_MAX",
    DEFAULT_AGENT_CREATE_RATE_LIMIT_MAX,
  ),
  agentChatRateLimitWindowMs: optionalPositiveInteger(
    "AGENT_CHAT_RATE_LIMIT_WINDOW_MS",
    DEFAULT_AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
  ),
  agentChatRateLimitMax: optionalPositiveInteger(
    "AGENT_CHAT_RATE_LIMIT_MAX",
    DEFAULT_AGENT_CHAT_RATE_LIMIT_MAX,
  ),
  chatResumableStream: optionalBoolean(
    "CHAT_RESUMABLE_STREAM",
    DEFAULT_CHAT_RESUMABLE_STREAM,
  ),
  chatResumableMaxEventBytes: optionalPositiveInteger(
    "CHAT_RESUMABLE_MAX_EVENT_BYTES",
    DEFAULT_CHAT_RESUMABLE_MAX_EVENT_BYTES,
  ),
  chatResumableMaxEventsPerTurn: optionalPositiveInteger(
    "CHAT_RESUMABLE_MAX_EVENTS_PER_TURN",
    DEFAULT_CHAT_RESUMABLE_MAX_EVENTS_PER_TURN,
  ),
  chatResumableMaxTurnBytes: optionalPositiveInteger(
    "CHAT_RESUMABLE_MAX_TURN_BYTES",
    DEFAULT_CHAT_RESUMABLE_MAX_TURN_BYTES,
  ),
  chatResumableMaxActiveTurns: optionalPositiveInteger(
    "CHAT_RESUMABLE_MAX_ACTIVE_TURNS",
    DEFAULT_CHAT_RESUMABLE_MAX_ACTIVE_TURNS,
  ),
  chatResumableTtlMs: optionalPositiveInteger(
    "CHAT_RESUMABLE_TTL_MS",
    DEFAULT_CHAT_RESUMABLE_TTL_MS,
  ),
};
