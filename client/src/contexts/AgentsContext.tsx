import type { Agent, ChatSession } from "@/lib/api";
import {
  createAgent as createAgentApi,
  createSession as createSessionApi,
  deleteAgent as deleteAgentApi,
  deleteSession as deleteSessionApi,
  listAgents,
  listSessions,
  updateAgent as updateAgentApi,
  updateSession as updateSessionApi,
} from "@/lib/api";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface AgentsContextValue {
  agents: Agent[];
  busyAgentIds: ReadonlySet<string>;
  /** Sessions keyed by agentId */
  sessions: ReadonlyMap<string, ChatSession[]>;
  markBusy: (agentId: string) => void;
  clearBusy: (agentId: string) => void;
  /** Bump an agent's user-message recency locally so it ranks to the top */
  touchAgent: (agentId: string) => void;
  loadAgents: () => Promise<void>;
  createAgent: (name: string) => Promise<Agent>;
  updateAgent: (
    id: string,
    data: Partial<Agent> & { confirm_upgrade_risk?: boolean },
  ) => Promise<Agent>;
  deleteAgent: (agentId: string) => Promise<void>;
  loadSessions: (
    agentId: string,
    options?: { force?: boolean },
  ) => Promise<ChatSession[]>;
  createNewSession: (agentId: string, title?: string) => Promise<ChatSession>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  removeSession: (agentId: string, sessionId: string) => Promise<void>;
  /** Update a session's updated_at locally (e.g. after a chat message) */
  touchSession: (agentId: string, sessionId: string) => void;
  /** Update a session's title locally (e.g. from auto-title SSE event) */
  setSessionTitle: (agentId: string, sessionId: string, title: string) => void;
  /** Update a session's selected model locally */
  setSessionModel: (
    agentId: string,
    sessionId: string,
    model: ChatSession["model"],
  ) => void;
}

const AgentsContext = createContext<AgentsContextValue | null>(null);
const SESSION_LIST_CACHE_TTL_MS = 5_000;

function toSortableTime(value: string | null | undefined): number {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function newerSession(
  existing: ChatSession,
  incoming: ChatSession,
): ChatSession {
  const existingTs = toSortableTime(existing.updated_at);
  const incomingTs = toSortableTime(incoming.updated_at);
  return existingTs > incomingTs ? existing : incoming;
}

function mergeSessions(
  existing: ChatSession[],
  incoming: ChatSession[],
): ChatSession[] {
  if (existing.length === 0) return sortSessions(incoming);

  const existingById = new Map(
    existing.map((session) => [session.id, session]),
  );
  const merged = incoming.map((session) => {
    const prev = existingById.get(session.id);
    if (!prev) return session;
    return newerSession(prev, session);
  });
  return sortSessions(merged);
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => {
    const updatedDelta =
      toSortableTime(b.updated_at) - toSortableTime(a.updated_at);
    if (updatedDelta !== 0) return updatedDelta;

    const createdDelta =
      toSortableTime(b.created_at) - toSortableTime(a.created_at);
    if (createdDelta !== 0) return createdDelta;

    return a.id.localeCompare(b.id);
  });
}

function getAgentActivityTimestamp(agent: Agent): number {
  const lastUserMessageMs = toSortableTime(agent.last_user_message_at);
  if (lastUserMessageMs > 0) return lastUserMessageMs;

  const updatedMs = toSortableTime(agent.updated_at);
  if (updatedMs > 0) return updatedMs;

  return toSortableTime(agent.created_at);
}

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const activityDelta =
      getAgentActivityTimestamp(b) - getAgentActivityTimestamp(a);
    if (activityDelta !== 0) return activityDelta;

    const createdDelta =
      toSortableTime(b.created_at) - toSortableTime(a.created_at);
    if (createdDelta !== 0) return createdDelta;

    return a.id.localeCompare(b.id);
  });
}

export function AgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busyAgentIds, setBusyAgentIds] = useState<Set<string>>(new Set());
  const [sessionsMap, setSessionsMap] = useState<Map<string, ChatSession[]>>(
    new Map(),
  );
  const sessionsMapRef = useRef<Map<string, ChatSession[]>>(new Map());
  const sessionsLoadInFlightRef = useRef<Map<string, Promise<ChatSession[]>>>(
    new Map(),
  );
  const sessionsLoadedAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    sessionsMapRef.current = sessionsMap;
  }, [sessionsMap]);

  const loadAgents = useCallback(async () => {
    try {
      const data = await listAgents();
      setAgents(sortAgents(data));
    } catch (error) {
      console.error("Failed to load agents:", error);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const createAgent = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Agent name is required");
    }
    const created = await createAgentApi({ name: trimmed });
    const nowIso = new Date().toISOString();
    const withActivity: Agent = {
      ...created,
      last_user_message_at: created.last_user_message_at || nowIso,
      updated_at: created.updated_at || nowIso,
      created_at: created.created_at || nowIso,
    };
    setAgents((prev) => sortAgents([withActivity, ...prev]));
    return created;
  }, []);

  const updateAgent = useCallback(
    async (
      id: string,
      data: Partial<Agent> & { confirm_upgrade_risk?: boolean },
    ) => {
      const updated = await updateAgentApi(id, data);
      setAgents((prev) =>
        sortAgents(prev.map((agent) => (agent.id === id ? updated : agent))),
      );
      return updated;
    },
    [],
  );

  const deleteAgent = useCallback(async (agentId: string) => {
    await deleteAgentApi(agentId);
    setBusyAgentIds((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Set(prev);
      next.delete(agentId);
      return next;
    });
    setAgents((prev) => prev.filter((agent) => agent.id !== agentId));
    setSessionsMap((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
    sessionsLoadInFlightRef.current.delete(agentId);
    sessionsLoadedAtRef.current.delete(agentId);
  }, []);

  const markBusy = useCallback((agentId: string) => {
    setBusyAgentIds((prev) => {
      if (prev.has(agentId)) return prev;
      const next = new Set(prev);
      next.add(agentId);
      return next;
    });
  }, []);

  const clearBusy = useCallback((agentId: string) => {
    setBusyAgentIds((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Set(prev);
      next.delete(agentId);
      return next;
    });
  }, []);

  const touchAgent = useCallback((agentId: string) => {
    setAgents((prev) => {
      const idx = prev.findIndex((agent) => agent.id === agentId);
      if (idx < 0) return prev;

      const nowIso = new Date().toISOString();
      const touched: Agent = {
        ...prev[idx],
        last_user_message_at: nowIso,
        updated_at: nowIso,
      };

      const next = [...prev];
      next[idx] = touched;
      return sortAgents(next);
    });
  }, []);

  const loadSessions = useCallback(
    async (agentId: string, options?: { force?: boolean }) => {
      const force = options?.force === true;
      const existing = sessionsMapRef.current.get(agentId);
      const loadedAt = sessionsLoadedAtRef.current.get(agentId) || 0;
      const freshEnough =
        !!existing && Date.now() - loadedAt < SESSION_LIST_CACHE_TTL_MS;
      if (!force && freshEnough) {
        return sortSessions(existing || []);
      }

      const inFlight = sessionsLoadInFlightRef.current.get(agentId);
      if (inFlight) {
        return inFlight;
      }

      const request = listSessions(agentId)
        .then((data) => {
          const merged = mergeSessions(
            sessionsMapRef.current.get(agentId) || [],
            data,
          );
          setSessionsMap((prev) => {
            const next = new Map(prev);
            next.set(agentId, merged);
            return next;
          });
          sessionsLoadedAtRef.current.set(agentId, Date.now());
          return merged;
        })
        .finally(() => {
          sessionsLoadInFlightRef.current.delete(agentId);
        });

      sessionsLoadInFlightRef.current.set(agentId, request);
      return request;
    },
    [],
  );

  const createNewSession = useCallback(
    async (agentId: string, title?: string) => {
      const session = await createSessionApi(agentId, title);
      setSessionsMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(agentId) || [];
        next.set(agentId, sortSessions([session, ...existing]));
        return next;
      });
      sessionsLoadedAtRef.current.set(agentId, Date.now());
      return session;
    },
    [],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const updated = await updateSessionApi(sessionId, { title });
      setSessionsMap((prev) => {
        const next = new Map(prev);
        for (const [agentId, sessions] of next) {
          const idx = sessions.findIndex((s) => s.id === sessionId);
          if (idx >= 0) {
            const updatedSessions = [...sessions];
            updatedSessions[idx] = updated;
            next.set(agentId, sortSessions(updatedSessions));
            break;
          }
        }
        return next;
      });
    },
    [],
  );

  const removeSession = useCallback(
    async (agentId: string, sessionId: string) => {
      await deleteSessionApi(sessionId);
      setSessionsMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(agentId) || [];
        next.set(
          agentId,
          existing.filter((s) => s.id !== sessionId),
        );
        return next;
      });
    },
    [],
  );

  const touchSession = useCallback((agentId: string, sessionId: string) => {
    setSessionsMap((prev) => {
      const existing = prev.get(agentId);
      if (!existing) return prev;
      const idx = existing.findIndex((s) => s.id === sessionId);
      if (idx < 0) return prev;
      const next = new Map(prev);
      const touched = {
        ...existing[idx],
        updated_at: new Date().toISOString(),
      };
      const reordered = [
        touched,
        ...existing.filter((session) => session.id !== sessionId),
      ];
      next.set(agentId, reordered);
      return next;
    });
  }, []);

  const setSessionTitle = useCallback(
    (agentId: string, sessionId: string, title: string) => {
      setSessionsMap((prev) => {
        const existing = prev.get(agentId);
        if (!existing) return prev;
        const idx = existing.findIndex((s) => s.id === sessionId);
        if (idx < 0) return prev;
        const next = new Map(prev);
        const updated = [...existing];
        updated[idx] = { ...updated[idx], title };
        next.set(agentId, sortSessions(updated));
        return next;
      });
    },
    [],
  );

  const setSessionModel = useCallback(
    (agentId: string, sessionId: string, model: ChatSession["model"]) => {
      setSessionsMap((prev) => {
        const existing = prev.get(agentId);
        if (!existing) return prev;
        const idx = existing.findIndex((s) => s.id === sessionId);
        if (idx < 0) return prev;
        const next = new Map(prev);
        const updated = [...existing];
        updated[idx] = { ...updated[idx], model };
        next.set(agentId, sortSessions(updated));
        return next;
      });
    },
    [],
  );

  const value = useMemo(
    () => ({
      agents,
      busyAgentIds,
      sessions: sessionsMap,
      markBusy,
      clearBusy,
      touchAgent,
      loadAgents,
      createAgent,
      updateAgent,
      deleteAgent,
      loadSessions,
      createNewSession,
      renameSession,
      removeSession,
      touchSession,
      setSessionTitle,
      setSessionModel,
    }),
    [
      agents,
      busyAgentIds,
      sessionsMap,
      markBusy,
      clearBusy,
      touchAgent,
      loadAgents,
      createAgent,
      updateAgent,
      deleteAgent,
      loadSessions,
      createNewSession,
      renameSession,
      removeSession,
      touchSession,
      setSessionTitle,
      setSessionModel,
    ],
  );

  return (
    <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>
  );
}

export function useAgents(): AgentsContextValue {
  const context = useContext(AgentsContext);
  if (!context) {
    throw new Error("useAgents must be used within AgentsProvider");
  }
  return context;
}
