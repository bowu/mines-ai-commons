import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _testOnly } from "./session.js";

const WORKSPACE_DIR = path.resolve(
  process.env.SANDBOX_WORKSPACE_DIR || "/workspace",
);

describe("sandbox bash spawn hook helpers", () => {
  it("injects workspace-first PATH and env defaults", () => {
    const result = _testOnly.buildSpawnEnv({ PATH: "/usr/bin:/bin" });
    expect(result.env.HOME).toBe(WORKSPACE_DIR);
    expect(result.env.NPM_CONFIG_PREFIX).toBe(
      path.join(WORKSPACE_DIR, ".npm-global"),
    );
    expect(result.env.PYTHONUSERBASE).toBe(
      path.join(WORKSPACE_DIR, ".py-user"),
    );
    expect(result.env.XDG_CACHE_HOME).toBe(path.join(WORKSPACE_DIR, ".cache"));
    expect(
      result.path.includes(path.join(WORKSPACE_DIR, ".npm-global", "bin")),
    ).toBe(true);
    expect(result.path.includes("/usr/bin")).toBe(true);
  });

  it("strips sensitive credentials from child process env", () => {
    const result = _testOnly.buildSpawnEnv({
      GEMINI_API_KEY: "gemini-secret",
      BRAVE_API_KEY: "brave-secret",
      OPENAI_API_KEY: "openai-secret",
      LITELLM_PROXY_API_KEY: "litellm-secret",
      AWS_ACCESS_KEY_ID: "aws-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-token",
      PATH: "/usr/bin",
    });

    expect(result.env.GEMINI_API_KEY).toBeUndefined();
    expect(result.env.BRAVE_API_KEY).toBeUndefined();
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.LITELLM_PROXY_API_KEY).toBeUndefined();
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("prevents spawned shell commands from reading provider credentials", () => {
    const result = _testOnly.buildSpawnEnv({
      PATH: "/usr/bin:/bin",
      GEMINI_API_KEY: "gemini-secret",
      BRAVE_API_KEY: "brave-secret",
      OPENAI_API_KEY: "openai-secret",
      LITELLM_PROXY_API_KEY: "litellm-secret",
      AWS_ACCESS_KEY_ID: "aws-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-token",
    });

    const output = spawnSync(
      "bash",
      [
        "-lc",
        'echo -n "${GEMINI_API_KEY}|${BRAVE_API_KEY}|${OPENAI_API_KEY}|${LITELLM_PROXY_API_KEY}|${AWS_ACCESS_KEY_ID}|${AWS_SECRET_ACCESS_KEY}|${AWS_SESSION_TOKEN}"',
      ],
      { env: result.env, encoding: "utf8" },
    );

    expect(output.status).toBe(0);
    expect(output.stdout).toBe("||||||");
  });

  it("maps all model selections to LiteLLM proxy models", () => {
    const previousProxyUrl = process.env.LITELLM_PROXY_URL;
    const previousGemini = process.env.LITELLM_MODEL_GEMINI;
    const previousSonnet = process.env.LITELLM_MODEL_SONNET;
    const previousOpus = process.env.LITELLM_MODEL_OPUS;
    const previousGpt = process.env.LITELLM_MODEL_GPT;
    process.env.LITELLM_PROXY_URL = "http://proxy.local";
    process.env.LITELLM_MODEL_GEMINI = "gemini-proxy";
    process.env.LITELLM_MODEL_SONNET = "sonnet-proxy";
    process.env.LITELLM_MODEL_OPUS = "opus-proxy";
    process.env.LITELLM_MODEL_GPT = "gpt-proxy";

    try {
      const geminiModel = _testOnly.buildProxyModel("gemini-3.1-pro");
      const sonnetModel = _testOnly.buildProxyModel("sonnet-4.6");
      const opusModel = _testOnly.buildProxyModel("opus-4.6");
      const gptModel = _testOnly.buildProxyModel("gpt-5.2");

      expect(geminiModel.api).toBe("openai-completions");
      expect(geminiModel.provider).toBe("openai");
      expect(geminiModel.baseUrl).toBe("http://proxy.local/v1");
      expect(geminiModel.id).toBe("gemini-proxy");
      expect(geminiModel.reasoning).toBe(true);

      expect(sonnetModel.api).toBe("anthropic-messages");
      expect(sonnetModel.provider).toBe("anthropic");
      expect(sonnetModel.baseUrl).toBe("http://proxy.local");
      expect(sonnetModel.id).toBe("sonnet-proxy");
      expect(sonnetModel.reasoning).toBe(true);

      expect(opusModel.api).toBe("anthropic-messages");
      expect(opusModel.provider).toBe("anthropic");
      expect(opusModel.baseUrl).toBe("http://proxy.local");
      expect(opusModel.id).toBe("opus-proxy");
      expect(opusModel.reasoning).toBe(true);

      expect(gptModel.api).toBe("openai-completions");
      expect(gptModel.provider).toBe("openai");
      expect(gptModel.baseUrl).toBe("http://proxy.local/v1");
      expect(gptModel.id).toBe("gpt-proxy");
      expect(gptModel.reasoning).toBe(true);
    } finally {
      if (previousProxyUrl === undefined) {
        process.env.LITELLM_PROXY_URL = undefined;
      } else {
        process.env.LITELLM_PROXY_URL = previousProxyUrl;
      }
      if (previousGemini === undefined) {
        process.env.LITELLM_MODEL_GEMINI = undefined;
      } else {
        process.env.LITELLM_MODEL_GEMINI = previousGemini;
      }
      if (previousSonnet === undefined) {
        process.env.LITELLM_MODEL_SONNET = undefined;
      } else {
        process.env.LITELLM_MODEL_SONNET = previousSonnet;
      }
      if (previousOpus === undefined) {
        process.env.LITELLM_MODEL_OPUS = undefined;
      } else {
        process.env.LITELLM_MODEL_OPUS = previousOpus;
      }
      if (previousGpt === undefined) {
        process.env.LITELLM_MODEL_GPT = undefined;
      } else {
        process.env.LITELLM_MODEL_GPT = previousGpt;
      }
    }
  });

  it("uses direct provider models by default in SANDBOX_MODE=local", () => {
    const prevMode = process.env.SANDBOX_MODE;
    const prevFlag = process.env.LOCAL_USE_LITELLM_PROXY;
    const prevGemini = process.env.SANDBOX_LOCAL_GEMINI_MODEL_ID;
    const prevSonnet = process.env.SANDBOX_LOCAL_SONNET_MODEL_ID;
    const prevOpus = process.env.SANDBOX_LOCAL_OPUS_MODEL_ID;
    process.env.SANDBOX_MODE = "local";
    process.env.LOCAL_USE_LITELLM_PROXY = "false";
    process.env.SANDBOX_LOCAL_GEMINI_MODEL_ID = "gemini-3.1-pro-preview";
    process.env.SANDBOX_LOCAL_SONNET_MODEL_ID =
      "global.anthropic.claude-sonnet-4-6";
    process.env.SANDBOX_LOCAL_OPUS_MODEL_ID =
      "global.anthropic.claude-opus-4-6-v1";

    try {
      expect(_testOnly.shouldUseProxyForModel()).toBe(false);
      const gemini = _testOnly.buildDirectModel("gemini-3.1-pro");
      const sonnet = _testOnly.buildDirectModel("sonnet-4.6");
      const opus = _testOnly.buildDirectModel("opus-4.6");
      expect(gemini.provider).toBe("google");
      expect(gemini.api).toBe("google-generative-ai");
      expect(gemini.id).toBe("gemini-3.1-pro-preview");
      expect(sonnet.provider).toBe("amazon-bedrock");
      expect(sonnet.api).toBe("bedrock-converse-stream");
      expect(sonnet.id).toBe("global.anthropic.claude-sonnet-4-6");
      expect(opus.provider).toBe("amazon-bedrock");
      expect(opus.api).toBe("bedrock-converse-stream");
      expect(opus.id).toBe("global.anthropic.claude-opus-4-6-v1");
    } finally {
      if (prevMode === undefined) {
        process.env.SANDBOX_MODE = undefined;
      } else {
        process.env.SANDBOX_MODE = prevMode;
      }
      if (prevFlag === undefined) {
        process.env.LOCAL_USE_LITELLM_PROXY = undefined;
      } else {
        process.env.LOCAL_USE_LITELLM_PROXY = prevFlag;
      }
      if (prevGemini === undefined) {
        process.env.SANDBOX_LOCAL_GEMINI_MODEL_ID = undefined;
      } else {
        process.env.SANDBOX_LOCAL_GEMINI_MODEL_ID = prevGemini;
      }
      if (prevSonnet === undefined) {
        process.env.SANDBOX_LOCAL_SONNET_MODEL_ID = undefined;
      } else {
        process.env.SANDBOX_LOCAL_SONNET_MODEL_ID = prevSonnet;
      }
      if (prevOpus === undefined) {
        process.env.SANDBOX_LOCAL_OPUS_MODEL_ID = undefined;
      } else {
        process.env.SANDBOX_LOCAL_OPUS_MODEL_ID = prevOpus;
      }
    }
  });

  it("can force local sandbox to use LiteLLM proxy", () => {
    const prevMode = process.env.SANDBOX_MODE;
    const prevFlag = process.env.LOCAL_USE_LITELLM_PROXY;
    process.env.SANDBOX_MODE = "local";
    process.env.LOCAL_USE_LITELLM_PROXY = "true";

    try {
      expect(_testOnly.shouldUseProxyForModel()).toBe(true);
    } finally {
      if (prevMode === undefined) {
        process.env.SANDBOX_MODE = undefined;
      } else {
        process.env.SANDBOX_MODE = prevMode;
      }
      if (prevFlag === undefined) {
        process.env.LOCAL_USE_LITELLM_PROXY = undefined;
      } else {
        process.env.LOCAL_USE_LITELLM_PROXY = prevFlag;
      }
    }
  });

  it("detects risky sudo apt/pip/npm global install commands", () => {
    expect(_testOnly.detectBootDiskRisk("sudo apt-get install ripgrep")).toBe(
      "sudo_apt_install",
    );
    expect(_testOnly.detectBootDiskRisk("sudo pip install requests")).toBe(
      "sudo_pip_install",
    );
    expect(_testOnly.detectBootDiskRisk("sudo npm install -g typescript")).toBe(
      "sudo_npm_global_install",
    );
  });

  it("does not flag safe install commands", () => {
    expect(_testOnly.detectBootDiskRisk("pip install requests")).toBeNull();
    expect(
      _testOnly.detectBootDiskRisk("npm install -g typescript"),
    ).toBeNull();
    expect(_testOnly.detectBootDiskRisk("sudo apt update")).toBeNull();
  });

  it("wraps risky commands with marker/log write prelude", () => {
    const wrapped = _testOnly.wrapRiskTracking("sudo apt-get install jq", "x");
    expect(wrapped).toContain("system-install-risk.log");
    expect(wrapped).toContain(".mines");
    expect(wrapped).toContain("system-mutation-flag.json");
    expect(wrapped.endsWith("sudo apt-get install jq")).toBe(true);
  });
});
