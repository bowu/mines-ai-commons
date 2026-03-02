import { describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { _testOnly } from "./session.js";

describe("pi-agent proxy model mapping", () => {
  it("uses LiteLLM proxy for all supported model selections", () => {
    const geminiModel = _testOnly.buildProxyModel("gemini-3.1-pro");
    const sonnetModel = _testOnly.buildProxyModel("sonnet-4.6");
    const opusModel = _testOnly.buildProxyModel("opus-4.6");
    const gptModel = _testOnly.buildProxyModel("gpt-5.2");

    expect(geminiModel.api).toBe("openai-completions");
    expect(geminiModel.provider).toBe("openai");
    expect(geminiModel.baseUrl).toBe(
      _testOnly.resolveLiteLlmOpenAiBaseUrl(config.litellmProxyUrl),
    );
    expect(geminiModel.id).toBe(
      _testOnly.resolveProxyModelId("gemini-3.1-pro"),
    );
    expect(geminiModel.reasoning).toBe(true);

    expect(sonnetModel.api).toBe("anthropic-messages");
    expect(sonnetModel.provider).toBe("anthropic");
    expect(sonnetModel.baseUrl).toBe(
      _testOnly.resolveLiteLlmAnthropicBaseUrl(config.litellmProxyUrl),
    );
    expect(sonnetModel.id).toBe(_testOnly.resolveProxyModelId("sonnet-4.6"));
    expect(sonnetModel.reasoning).toBe(true);

    expect(opusModel.api).toBe("anthropic-messages");
    expect(opusModel.provider).toBe("anthropic");
    expect(opusModel.baseUrl).toBe(
      _testOnly.resolveLiteLlmAnthropicBaseUrl(config.litellmProxyUrl),
    );
    expect(opusModel.id).toBe(_testOnly.resolveProxyModelId("opus-4.6"));
    expect(opusModel.reasoning).toBe(true);

    expect(gptModel.api).toBe("openai-completions");
    expect(gptModel.provider).toBe("openai");
    expect(gptModel.baseUrl).toBe(
      _testOnly.resolveLiteLlmOpenAiBaseUrl(config.litellmProxyUrl),
    );
    expect(gptModel.id).toBe(_testOnly.resolveProxyModelId("gpt-5.2"));
    expect(gptModel.reasoning).toBe(true);
  });
});
