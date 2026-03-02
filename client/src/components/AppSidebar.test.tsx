import type { Agent } from "@/lib/api";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppSidebar } from "./AppSidebar";
import { SidebarProvider } from "./ui/sidebar";

const useAuthMock = vi.fn();
const useAgentsMock = vi.fn();

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock("@/contexts/AgentsContext", () => ({
  useAgents: () => useAgentsMock(),
}));

const authUser = {
  id: "user-1",
  orgId: "org-1",
  email: "admin@mines.edu",
  name: "Mines Admin",
  role: "admin",
};

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    icon: "🤖",
    system_prompt: "",
    created_at: "",
    updated_at: "",
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSidebar(initialPath = "/skills") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <AppSidebar />
        <LocationProbe />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe("AppSidebar", () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: authUser,
      logout: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders agents and highlights active route", () => {
    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1"), makeAgent("a2", "Agent 2")],
      busyAgentIds: new Set<string>(),
      sessions: new Map(),
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    renderSidebar("/agents/a1");

    expect(screen.getByText("Agent 1")).toBeTruthy();
    expect(screen.getByText("Agent 2")).toBeTruthy();
    // Agents are now CollapsibleTrigger buttons with data-sidebar="menu-button"
    const agentButtons = screen.getAllByRole("button", { name: /agent 1/i });
    const activeButton = agentButtons.find(
      (b) => b.getAttribute("data-sidebar") === "menu-button",
    );
    expect(activeButton).toBeTruthy();
    expect(activeButton!.getAttribute("data-active")).toBe("true");
  });

  it("clicking an agent navigates to its page", async () => {
    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1"), makeAgent("a2", "Agent 2")],
      busyAgentIds: new Set<string>(),
      sessions: new Map(),
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    const user = userEvent.setup();
    renderSidebar("/skills");

    // Should start on /skills
    expect(screen.getByTestId("location").textContent).toBe("/skills");

    // Click Agent 1
    const agentButtons = screen.getAllByRole("button", { name: /agent 1/i });
    const menuButton = agentButtons.find(
      (b) => b.getAttribute("data-sidebar") === "menu-button",
    );
    expect(menuButton).toBeTruthy();
    await user.click(menuButton!);

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/agents/a1"),
    );
  });

  it("clicking a conversation navigates to its session page", async () => {
    const sessionsMap = new Map([
      [
        "a1",
        [
          {
            id: "s1",
            title: "Research project",
            created_at: "2024-01-01",
            updated_at: "2024-01-01",
          },
          {
            id: "s2",
            title: "Code review",
            created_at: "2024-01-02",
            updated_at: "2024-01-02",
          },
        ],
      ],
    ]);

    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1")],
      busyAgentIds: new Set<string>(),
      sessions: sessionsMap,
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    const user = userEvent.setup();
    renderSidebar("/agents/a1");

    // Wait for session links to render (agent auto-expanded since route is /agents/a1)
    await waitFor(() =>
      expect(screen.getByText("Research project")).toBeTruthy(),
    );

    // Click the session link
    await user.click(screen.getByText("Research project"));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/agents/a1/c/s1",
      ),
    );
  });

  it("creates an agent and navigates to it", async () => {
    const createAgent = vi.fn().mockResolvedValue(makeAgent("a3", "New Agent"));
    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1")],
      busyAgentIds: new Set<string>(),
      sessions: new Map(),
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent,
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    const user = userEvent.setup();
    renderSidebar("/skills");

    await user.click(screen.getByRole("button", { name: /new agent/i }));
    await user.type(screen.getByPlaceholderText("Agent name..."), "New Agent");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createAgent).toHaveBeenCalledWith("New Agent"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/agents/a3"),
    );
  });

  it("conversation three-dots menu shows Rename and Delete", async () => {
    const sessionsMap = new Map([
      [
        "a1",
        [
          {
            id: "s1",
            title: "Research project",
            created_at: "2024-01-01",
            updated_at: "2024-01-01",
          },
        ],
      ],
    ]);

    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1")],
      busyAgentIds: new Set<string>(),
      sessions: sessionsMap,
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    const user = userEvent.setup();
    renderSidebar("/agents/a1");

    await waitFor(() =>
      expect(screen.getByText("Research project")).toBeTruthy(),
    );

    await user.click(
      screen.getByLabelText("Conversation actions for Research project"),
    );

    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
  });

  it("conversation menu actions work via keyboard", async () => {
    const sessionsMap = new Map([
      [
        "a1",
        [
          {
            id: "s1",
            title: "Research project",
            created_at: "2024-01-01",
            updated_at: "2024-01-01",
          },
        ],
      ],
    ]);

    useAgentsMock.mockReturnValue({
      agents: [makeAgent("a1", "Agent 1")],
      busyAgentIds: new Set<string>(),
      sessions: sessionsMap,
      markBusy: vi.fn(),
      clearBusy: vi.fn(),
      loadAgents: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
      loadSessions: vi.fn(),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      removeSession: vi.fn(),
    });

    const user = userEvent.setup();
    renderSidebar("/agents/a1");

    await waitFor(() =>
      expect(screen.getByText("Research project")).toBeTruthy(),
    );

    const trigger = screen.getByLabelText(
      "Conversation actions for Research project",
    );
    trigger.focus();
    await user.keyboard("{Enter}");

    const renameItem = await screen.findByText("Rename");
    (renameItem as HTMLElement).focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByDisplayValue("Research project")).toBeTruthy(),
    );
  });
});
