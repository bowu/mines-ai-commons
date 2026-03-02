import { describe, expect, it, vi } from "vitest";

const envKeys = [
  "NODE_ENV",
  "SANDBOX_MODE",
  "DEV_GCE_ALLOW_PROVIDER_KEYS",
  "LITELLM_PROXY_URL",
  "LITELLM_PROXY_API_KEY",
  "LITELLM_MODEL_GEMINI",
  "LITELLM_MODEL_SONNET",
  "LITELLM_MODEL_OPUS",
  "LITELLM_MODEL_GPT",
  "GEMINI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
];

function restore(previous: Record<string, string | undefined>) {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) {
      process.env[key] = undefined;
    } else {
      process.env[key] = value;
    }
  }
}

describe("internal vm credential payload", () => {
  it("keeps GCE payload proxy-only by default", async () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of envKeys) previous[key] = process.env[key];

    process.env.NODE_ENV = "development";
    process.env.SANDBOX_MODE = "gce";
    process.env.DEV_GCE_ALLOW_PROVIDER_KEYS = undefined;
    process.env.LITELLM_PROXY_URL = "https://proxy.example.com/v1";
    process.env.LITELLM_PROXY_API_KEY = "proxy-key";
    process.env.LITELLM_MODEL_GEMINI = "gemini-proxy";
    process.env.LITELLM_MODEL_SONNET = "sonnet-proxy";
    process.env.LITELLM_MODEL_OPUS = "opus-proxy";
    process.env.LITELLM_MODEL_GPT = "gpt-proxy";
    process.env.GEMINI_API_KEY = "gemini-dev-key";
    process.env.AWS_ACCESS_KEY_ID = "aws-dev-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-dev-secret";
    process.env.AWS_REGION = "us-west-2";

    vi.resetModules();
    const { _testOnly } = await import("./internal.js");

    const payload = _testOnly.vmCredentialPayload("token", "expires");
    expect(payload.runtimeEnv).toMatchObject({
      LITELLM_PROXY_URL: "https://proxy.example.com/v1",
      LITELLM_MODEL_GEMINI: "gemini-proxy",
      LITELLM_MODEL_SONNET: "sonnet-proxy",
      LITELLM_MODEL_OPUS: "opus-proxy",
      LITELLM_MODEL_GPT: "gpt-proxy",
      LITELLM_PROXY_API_KEY: "proxy-key",
    });
    expect(payload.runtimeEnv.GEMINI_API_KEY).toBeUndefined();
    expect(payload.runtimeEnv.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(payload.runtimeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(payload.runtimeEnv.AWS_REGION).toBeUndefined();
    expect(payload.providerEnv).toEqual(payload.runtimeEnv);

    restore(previous);
    vi.resetModules();
  });

  it("allows provider key fallback only with explicit dev flag", async () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of envKeys) previous[key] = process.env[key];

    process.env.NODE_ENV = "development";
    process.env.SANDBOX_MODE = "gce";
    process.env.DEV_GCE_ALLOW_PROVIDER_KEYS = "true";
    process.env.LITELLM_PROXY_URL = "https://proxy.example.com/v1";
    process.env.LITELLM_PROXY_API_KEY = "proxy-key";
    process.env.LITELLM_MODEL_GEMINI = "gemini-proxy";
    process.env.LITELLM_MODEL_SONNET = "sonnet-proxy";
    process.env.LITELLM_MODEL_OPUS = "opus-proxy";
    process.env.LITELLM_MODEL_GPT = "gpt-proxy";
    process.env.GEMINI_API_KEY = "gemini-dev-key";
    process.env.AWS_ACCESS_KEY_ID = "aws-dev-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-dev-secret";
    process.env.AWS_REGION = "us-west-2";

    vi.resetModules();
    const { _testOnly } = await import("./internal.js");

    const payload = _testOnly.vmCredentialPayload("token", "expires");
    expect(payload.runtimeEnv.GEMINI_API_KEY).toBe("gemini-dev-key");
    expect(payload.runtimeEnv.AWS_ACCESS_KEY_ID).toBe("aws-dev-key");
    expect(payload.runtimeEnv.AWS_SECRET_ACCESS_KEY).toBe("aws-dev-secret");
    expect(payload.runtimeEnv.AWS_REGION).toBe("us-west-2");

    restore(previous);
    vi.resetModules();
  });
});
