import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxTools } from "./tools.js";

describe("sandbox tools registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes document and presentation tools", () => {
    const tools = createSandboxTools({
      agentId: "agent-test",
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => null,
    });

    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("read_docx")).toBe(true);
    expect(names.has("create_docx")).toBe(true);
    expect(names.has("read_xlsx")).toBe(true);
    expect(names.has("create_xlsx")).toBe(true);
    expect(names.has("create_pptx")).toBe(true);
  });

  it("includes complete_goal only when goal callbacks are provided", () => {
    const baseTools = createSandboxTools({
      agentId: "agent-test",
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => null,
    });
    expect(baseTools.some((tool) => tool.name === "complete_goal")).toBe(false);

    const goalTools = createSandboxTools({
      agentId: "agent-test",
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => null,
      getActiveGoalId: () => "goal-1",
      completeGoal: async () => ({ ok: true }),
    });
    expect(goalTools.some((tool) => tool.name === "complete_goal")).toBe(true);
  });

  it("retries web search once after refreshing VM token on 401", async () => {
    let token = "stale-token";
    const refreshVmToken = vi.fn(async () => {
      token = "fresh-token";
      return token;
    });
    const ensureVmToken = vi.fn(async () => token);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Invalid VM token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ provider: "brave", results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const tools = createSandboxTools({
      agentId: "agent-test",
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => token,
      ensureVmToken,
      refreshVmToken,
    });
    const webSearch = tools.find((tool) => tool.name === "web_search");
    expect(webSearch).toBeDefined();

    const result = await webSearch!.execute(
      "tool-call-1",
      { query: "mines ai" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(refreshVmToken).toHaveBeenCalledTimes(1);
    expect(ensureVmToken).not.toHaveBeenCalled();
    const firstContent = result.content[0];
    const payload =
      firstContent?.type === "text" ? JSON.parse(firstContent.text) : {};
    expect(payload).toEqual({
      provider: "brave",
      results: [],
    });
  });

  it("ensures VM token before web search when token is missing", async () => {
    let token: string | null = null;
    const ensureVmToken = vi.fn(async () => {
      token = "issued-token";
      return token;
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ provider: "brave", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tools = createSandboxTools({
      agentId: "agent-test",
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => token,
      ensureVmToken,
    });
    const webSearch = tools.find((tool) => tool.name === "web_search");
    expect(webSearch).toBeDefined();

    await webSearch!.execute(
      "tool-call-2",
      { query: "mines ai" },
      undefined,
      undefined,
      {} as never,
    );

    expect(ensureVmToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
