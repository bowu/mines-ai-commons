import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@mariozechner/pi-ai";
import { streamSimpleOpenAICompletions } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

interface ProxyRequestCapture {
  authorization: string | undefined;
  model: string;
}

async function startMockLiteLlmProxy(): Promise<{
  baseUrl: string;
  captures: ProxyRequestCapture[];
  close: () => Promise<void>;
}> {
  const captures: ProxyRequestCapture[] = [];

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    await once(req, "end");
    const body = JSON.parse(raw) as { model: string };

    captures.push({
      authorization: req.headers.authorization,
      model: body.model,
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { content: "proxy-ok" }, finish_reason: null },
        ],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    captures,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function createContext(): Context {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Say hi" }],
        timestamp: Date.now(),
      },
    ],
  };
}

function createModel(
  modelId: string,
  baseUrl: string,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  };
}

async function collectEventTypes(
  stream: ReturnType<typeof streamSimpleOpenAICompletions>,
): Promise<string[]> {
  const eventTypes: string[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
  }
  return eventTypes;
}

describe("LiteLLM proxy compatibility", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) {
        await close();
      }
    }
  });

  it.each([
    { selection: "gemini", modelId: "gemini-3.1-pro" },
    { selection: "sonnet", modelId: "sonnet-4.6" },
    { selection: "opus", modelId: "opus-4.6" },
    { selection: "gpt", modelId: "gpt-5.2" },
  ])("streams completion via proxy for $selection", async ({ modelId }) => {
    const proxy = await startMockLiteLlmProxy();
    closers.push(proxy.close);

    const stream = streamSimpleOpenAICompletions(
      createModel(modelId, proxy.baseUrl),
      createContext(),
      { apiKey: "proxy-test-key", maxTokens: 32 },
    );
    const eventTypes = await collectEventTypes(stream);

    expect(eventTypes.includes("done")).toBe(true);
    expect(proxy.captures).toHaveLength(1);
    expect(proxy.captures[0]?.model).toBe(modelId);
    expect(proxy.captures[0]?.authorization).toBe("Bearer proxy-test-key");
  });
});
