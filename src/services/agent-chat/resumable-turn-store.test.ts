import { afterEach, describe, expect, it } from "vitest";
import { InMemoryResumableTurnStore } from "./resumable-turn-store.js";

const stores: InMemoryResumableTurnStore[] = [];

afterEach(() => {
  for (const store of stores) {
    store.shutdown();
  }
  stores.length = 0;
});

function createStore(maxEventBytes: number): InMemoryResumableTurnStore {
  const store = new InMemoryResumableTurnStore({
    maxEventBytes,
    maxEventsPerTurn: 100,
    maxTurnBytes: 1_000_000,
    maxActiveTurns: 10,
    ttlAfterCloseMs: 60_000,
  });
  stores.push(store);
  return store;
}

describe("InMemoryResumableTurnStore", () => {
  it("preserves tool_result metadata when payload is truncated", () => {
    const store = createStore(256);
    const created = store.createTurn("session-1");
    expect(created.ok).toBe(true);
    const turnId = created.turnId;
    expect(turnId).toBeTruthy();

    const hugeResult = {
      content: [
        {
          type: "text",
          text: "x".repeat(10_000),
        },
      ],
    };

    const appended = store.appendEvent(String(turnId), {
      type: "tool_result",
      data: {
        name: "web_search",
        result: hugeResult,
        error: false,
      },
    });

    expect(appended).toBeTruthy();
    expect(appended?.truncated).toBe(true);

    const replay = store.readFromSeq("session-1", String(turnId), 1);
    expect(replay.status).toBe("ok");
    expect(replay.events).toHaveLength(1);

    const replayed = replay.events[0];
    expect(replayed.type).toBe("tool_result");
    expect(replayed.data).toMatchObject({
      name: "web_search",
      error: false,
      result_truncated: true,
    });
  });
});
