import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsProvider, useAgents } from "./AgentsContext";

const listAgentsMock = vi.fn();
const createAgentMock = vi.fn();
const deleteAgentMock = vi.fn();

vi.mock("@/lib/api", () => ({
  listAgents: (...args: unknown[]) => listAgentsMock(...args),
  createAgent: (...args: unknown[]) => createAgentMock(...args),
  deleteAgent: (...args: unknown[]) => deleteAgentMock(...args),
}));

function TestHarness() {
  const {
    agents,
    busyAgentIds,
    markBusy,
    clearBusy,
    createAgent,
    deleteAgent,
  } = useAgents();
  const [createdId, setCreatedId] = useState("");

  return (
    <div>
      <div data-testid="count">{agents.length}</div>
      <div data-testid="ids">{agents.map((agent) => agent.id).join(",")}</div>
      <div data-testid="busy">{Array.from(busyAgentIds).join(",")}</div>
      <div data-testid="created">{createdId}</div>

      <button
        type="button"
        onClick={() => {
          markBusy("a1");
        }}
      >
        Mark busy
      </button>
      <button
        type="button"
        onClick={() => {
          clearBusy("a1");
        }}
      >
        Clear busy
      </button>
      <button
        type="button"
        onClick={async () => {
          const created = await createAgent("New Agent");
          setCreatedId(created.id);
        }}
      >
        Create
      </button>
      <button
        type="button"
        onClick={async () => {
          await deleteAgent("a1");
        }}
      >
        Delete
      </button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <MemoryRouter>
      <AgentsProvider>
        <TestHarness />
      </AgentsProvider>
    </MemoryRouter>,
  );
}

describe("AgentsContext", () => {
  beforeEach(() => {
    listAgentsMock.mockReset();
    createAgentMock.mockReset();
    deleteAgentMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("loads agents on mount", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        name: "Agent 1",
        description: "",
        icon: "🤖",
        system_prompt: "",
        created_at: "",
        updated_at: "",
      },
    ]);

    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1"),
    );
    expect(listAgentsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ids").textContent).toBe("a1");
  });

  it("createAgent appends and returns the created agent", async () => {
    listAgentsMock.mockResolvedValue([]);
    createAgentMock.mockResolvedValue({
      id: "a2",
      name: "New Agent",
      description: "",
      icon: "🧪",
      system_prompt: "",
      created_at: "",
      updated_at: "",
    });

    const user = userEvent.setup();
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("0"),
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createAgentMock).toHaveBeenCalledWith({ name: "New Agent" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1"),
    );
    expect(screen.getByTestId("created").textContent).toBe("a2");
  });

  it("deleteAgent removes the deleted item", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        name: "Agent 1",
        description: "",
        icon: "🤖",
        system_prompt: "",
        created_at: "",
        updated_at: "",
      },
      {
        id: "a2",
        name: "Agent 2",
        description: "",
        icon: "🧪",
        system_prompt: "",
        created_at: "",
        updated_at: "",
      },
    ]);
    deleteAgentMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2"),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteAgentMock).toHaveBeenCalledWith("a1"));
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1"),
    );
    expect(screen.getByTestId("ids").textContent).toBe("a2");
  });

  it("markBusy and clearBusy update busy ids", async () => {
    listAgentsMock.mockResolvedValue([]);

    const user = userEvent.setup();
    renderWithProvider();

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("0"),
    );
    await user.click(screen.getByRole("button", { name: "Mark busy" }));
    expect(screen.getByTestId("busy").textContent).toBe("a1");

    await user.click(screen.getByRole("button", { name: "Clear busy" }));
    expect(screen.getByTestId("busy").textContent).toBe("");
  });
});
