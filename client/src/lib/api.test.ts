import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLatestChat, listSkills } from "./api";

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses /api base path for skills endpoint", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [] }),
    } as Response);

    await listSkills();

    expect(fetchMock).toHaveBeenCalledWith("/api/skills", {
      cache: "no-store",
      credentials: "include",
    });
  });

  it("builds latest chat URL with agent ID", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: null, messages: [] }),
    } as Response);

    await getLatestChat("agent-123");

    expect(fetchMock).toHaveBeenCalledWith("/api/agent-chat/agent-123/latest", {
      cache: "no-store",
      credentials: "include",
    });
  });
});
