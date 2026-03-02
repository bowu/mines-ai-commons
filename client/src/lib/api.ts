const API_BASE = "/api";

function shouldRedirectToLogin(response: Response, input: RequestInfo | URL) {
  if (response.status !== 401) return false;
  const url = String(input);
  return !url.includes("/api/auth/login");
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const method = (init.method || "GET").toUpperCase();
  const response = await fetch(input, {
    ...(method === "GET" ? { cache: "no-store" as RequestCache } : {}),
    ...init,
    credentials: "include",
  });

  if (typeof window !== "undefined" && shouldRedirectToLogin(response, input)) {
    window.location.href = "/api/auth/login";
  }

  return response;
}

// ==================== Skills ====================
export interface Skill {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  instructions: string;
  tool_type: string | null;
  data_source_files?: string[];
  created_at: string;
  updated_at: string;
}

export async function listSkills(): Promise<Skill[]> {
  const res = await apiFetch(`${API_BASE}/skills`);
  if (!res.ok) throw new Error("Failed to list skills");
  const data = await res.json();
  return data.skills;
}

function buildSkillFormData(
  skill: Partial<Skill>,
  files: File[] = [],
): FormData {
  const formData = new FormData();
  const entries: Array<[keyof Skill, unknown]> = [
    ["name", skill.name],
    ["description", skill.description],
    ["when_to_use", skill.when_to_use],
    ["instructions", skill.instructions],
    ["tool_type", skill.tool_type],
  ];
  for (const [key, value] of entries) {
    if (typeof value === "string") formData.append(key, value);
    if (value === null && key === "tool_type") formData.append(key, "");
  }
  for (const file of files) {
    formData.append("files", file);
  }
  return formData;
}

export async function createSkill(
  skill: Partial<Skill>,
  files: File[] = [],
): Promise<Skill> {
  const res = await apiFetch(`${API_BASE}/skills`, {
    method: "POST",
    body: buildSkillFormData(skill, files),
  });
  if (!res.ok) throw new Error("Failed to create skill");
  const data = await res.json();
  return data.skill;
}

export async function updateSkill(
  id: string,
  skill: Partial<Skill>,
  files: File[] = [],
): Promise<Skill> {
  const res = await apiFetch(`${API_BASE}/skills/${id}`, {
    method: "PUT",
    body: buildSkillFormData(skill, files),
  });
  if (!res.ok) throw new Error("Failed to update skill");
  const data = await res.json();
  return data.skill;
}

export async function deleteSkill(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/skills/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete skill");
}

// ==================== Agents ====================
export interface Agent {
  id: string;
  name: string;
  description: string;
  icon: string;
  system_prompt: string;
  access_role?: "owner" | "editor" | "viewer";
  machine_type?: string | null;
  vm_status?: string | null;
  desired_vm_state?: string | null;
  observed_vm_state?: string | null;
  vm_provision_error?: string | null;
  last_provision_error?: string | null;
  last_provision_error_at?: string | null;
  last_activity_at?: string | null;
  last_user_message_at?: string | null;
  upgrade_risk_detected?: boolean | null;
  upgrade_risk_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentSkill extends Skill {
  enabled: boolean;
  installed: boolean;
  install_path?: string | null;
}

export async function listAgents(): Promise<Agent[]> {
  const res = await apiFetch(`${API_BASE}/agents`);
  if (!res.ok) throw new Error("Failed to list agents");
  const data = await res.json();
  return data.agents;
}

export async function getAgent(
  id: string,
): Promise<{ agent: Agent; skills: AgentSkill[] }> {
  const res = await apiFetch(`${API_BASE}/agents/${id}`);
  if (!res.ok) throw new Error("Failed to get agent");
  return res.json();
}

export async function createAgent(agent: Partial<Agent>): Promise<Agent> {
  const res = await apiFetch(`${API_BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  if (!res.ok) throw new Error("Failed to create agent");
  const data = await res.json();
  return data.agent;
}

export async function updateAgent(
  id: string,
  agent: Partial<Agent> & { confirm_upgrade_risk?: boolean },
): Promise<Agent> {
  const res = await apiFetch(`${API_BASE}/agents/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
      code?: string;
      upgrade_risk_message?: string;
    } | null;
    const error = new Error(
      payload?.error || "Failed to update agent",
    ) as Error & {
      code?: string;
      upgradeRiskMessage?: string;
    };
    if (payload?.code) {
      error.code = payload.code;
    }
    if (payload?.upgrade_risk_message) {
      error.upgradeRiskMessage = payload.upgrade_risk_message;
    }
    throw error;
  }
  const data = await res.json();
  return data.agent;
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/agents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete agent");
}

export interface SandboxEnsureResponse {
  status: "ready" | "starting";
  reason?: string;
  retryAfterMs?: number;
}

export interface EnsureSandboxOptions {
  touchActivity?: boolean;
}

export async function ensureSandbox(
  agentId: string,
  options: EnsureSandboxOptions = {},
): Promise<SandboxEnsureResponse> {
  const res = await apiFetch(`${API_BASE}/sandbox/${agentId}/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touchActivity: options.touchActivity === true,
    }),
  });

  if (res.status === 503) {
    const data = (await res
      .json()
      .catch(() => null)) as SandboxEnsureResponse | null;
    return {
      status: "starting",
      reason: data?.reason || "vm_starting",
      retryAfterMs: data?.retryAfterMs || 5000,
    };
  }

  if (!res.ok) throw new Error("Failed to ensure sandbox");
  return res.json();
}

export async function toggleAgentSkill(
  agentId: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/agents/${agentId}/skills/${skillId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) throw new Error("Failed to toggle skill");
}

export async function installAgentSkill(
  agentId: string,
  skillId: string,
): Promise<{ installed: boolean; enabled: boolean; installPath: string }> {
  const res = await apiFetch(
    `${API_BASE}/agents/${agentId}/skills/${skillId}/install`,
    {
      method: "POST",
    },
  );
  if (!res.ok) throw new Error("Failed to install skill");
  return res.json();
}

export async function uninstallAgentSkill(
  agentId: string,
  skillId: string,
): Promise<{ installed: boolean; enabled: boolean }> {
  const res = await apiFetch(
    `${API_BASE}/agents/${agentId}/skills/${skillId}/uninstall`,
    {
      method: "POST",
    },
  );
  if (!res.ok) throw new Error("Failed to uninstall skill");
  return res.json();
}

// ==================== Agent Sessions ====================
export type AgentModel =
  | "gemini-3.1-pro"
  | "sonnet-4.6"
  | "opus-4.6"
  | "gpt-5.2";

export interface ChatSession {
  id: string;
  agent_id: string;
  created_by: string | null;
  title: string | null;
  model: AgentModel;
  shared: boolean;
  created_at: string;
  updated_at: string;
}

export async function listSessions(agentId: string): Promise<ChatSession[]> {
  const res = await apiFetch(`${API_BASE}/agent-chat/${agentId}/sessions`);
  if (!res.ok) throw new Error("Failed to list sessions");
  const data = await res.json();
  return data.sessions;
}

export async function createSession(
  agentId: string,
  title?: string,
  model?: AgentModel,
): Promise<ChatSession> {
  const res = await apiFetch(`${API_BASE}/agent-chat/${agentId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, model }),
  });
  if (!res.ok) throw new Error("Failed to create session");
  const data = await res.json();
  return data.session;
}

export async function updateSession(
  sessionId: string,
  data: { title?: string; model?: AgentModel },
): Promise<ChatSession> {
  const res = await apiFetch(`${API_BASE}/agent-chat/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update session");
  const result = await res.json();
  return result.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/agent-chat/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete session");
}

export interface SessionGoal {
  id: string;
  session_id: string;
  goal: string;
  guidance: string;
  output_folder: string;
  deadline_at: string | null;
  status: "active" | "completed" | "expired" | "cancelled";
  status_reason: string | null;
  report_path: string | null;
  artifact_paths: string[];
  progress_summary: string | null;
  next_suggested_run_at: string;
  run_count: number;
  last_run_started_at?: string | null;
  last_run_ended_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export async function getSessionGoal(
  sessionId: string,
): Promise<SessionGoal | null> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${sessionId}/goal`,
  );
  if (!res.ok) throw new Error("Failed to get session goal");
  const data = await res.json();
  return data.goal || null;
}

export async function upsertSessionGoal(
  sessionId: string,
  payload: {
    goal: string;
    guidance?: string | null;
    deadlineAt?: string | null;
    outputFolder: string;
  },
): Promise<SessionGoal | null> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${sessionId}/goal`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error("Failed to update session goal");
  const data = await res.json();
  return data.goal || null;
}

export async function cancelSessionGoal(
  sessionId: string,
): Promise<SessionGoal | null> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${sessionId}/goal`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error("Failed to cancel session goal");
  const data = await res.json();
  return data.goal || null;
}

export async function getSessionMessages(sessionId: string): Promise<{
  messages: ChatHistoryMessage[];
  runningTurnId: string | null;
}> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${sessionId}/messages`,
  );
  if (!res.ok) throw new Error("Failed to get session messages");
  const data = await res.json();
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    runningTurnId:
      typeof data.runningTurnId === "string" ? data.runningTurnId : null,
  };
}

// ==================== Agent Chat (SSE) ====================
export interface ChatHistoryMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: any[];
  partial?: boolean;
  turn_id?: string | null;
  last_seq?: number;
  segments?: Array<{
    type: string;
    content?: string;
    name?: string;
    args?: any;
    result?: any;
    error?: boolean;
  }> | null;
  sources: any[];
  created_at: string;
}

export async function getLatestChat(agentId: string): Promise<{
  sessionId: string | null;
  messages: ChatHistoryMessage[];
}> {
  const res = await apiFetch(`${API_BASE}/agent-chat/${agentId}/latest`);
  if (!res.ok) throw new Error("Failed to get latest chat");
  return res.json();
}

export interface AgentChatEvent {
  type:
    | "session"
    | "turn"
    | "session_update"
    | "text"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "vm_starting"
    | "error"
    | "done";
  data?: any;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  truncated?: boolean;
  truncated_bytes?: number;
  source?: string;
}

async function* readSseResponse(
  response: Response,
): AsyncGenerator<AgentChatEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as AgentChatEvent;
        yield event;
      } catch {
        // skip malformed events
      }
    }
  }
}

async function* streamLegacyAgentChat(
  agentId: string,
  message: string,
  sessionId?: string,
  signal?: AbortSignal,
  outputFolder?: string | null,
  model?: AgentModel,
): AsyncGenerator<AgentChatEvent> {
  const res = await apiFetch(`${API_BASE}/agent-chat/${agentId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      sessionId,
      outputFolder: outputFolder || undefined,
      model: model || undefined,
    }),
    signal,
  });

  if (!res.ok) {
    if (res.status === 503) {
      const payload = (await res.json().catch(() => null)) as {
        reason?: string;
        retryAfterMs?: number;
      } | null;
      yield {
        type: "vm_starting",
        data: {
          reason: payload?.reason || "vm_starting",
          retryAfterMs: payload?.retryAfterMs || 5000,
        },
      };
      yield { type: "done" };
      return;
    }

    yield {
      type: "error",
      data: `Failed to connect to agent (${res.status} ${res.statusText})`,
    };
    yield { type: "done" };
    return;
  }

  yield* readSseResponse(res);
}

export async function* streamAgentTurn(
  sessionId: string,
  turnId: string,
  fromSeq: number,
  signal?: AbortSignal,
): AsyncGenerator<AgentChatEvent> {
  let nextFromSeq = Math.max(1, fromSeq);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const qs = new URLSearchParams();
    qs.set("fromSeq", String(nextFromSeq));
    const res = await apiFetch(
      `${API_BASE}/agent-chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stream?${qs.toString()}`,
      { signal },
    );

    if (res.ok) {
      yield* readSseResponse(res);
      return;
    }

    if (res.status === 410) {
      const payload = (await res.json().catch(() => null)) as {
        minSeq?: number;
      } | null;
      const minSeq =
        typeof payload?.minSeq === "number" && Number.isFinite(payload.minSeq)
          ? Math.max(1, Math.floor(payload.minSeq))
          : null;
      if (minSeq !== null && minSeq > nextFromSeq && attempt === 0) {
        nextFromSeq = minSeq;
        continue;
      }
      yield {
        type: "error",
        data: "Turn stream is no longer available.",
      };
      yield { type: "done" };
      return;
    }

    if (res.status === 404) {
      yield {
        type: "error",
        data: "Turn stream is no longer available.",
      };
      yield { type: "done" };
      return;
    }

    yield {
      type: "error",
      data: `Failed to stream turn (${res.status} ${res.statusText})`,
    };
    yield { type: "done" };
    return;
  }
}

export async function getSessionRunningTurn(
  sessionId: string,
): Promise<{ turnId: string | null; source: string | null }> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${encodeURIComponent(sessionId)}/running-turn`,
  );
  if (!res.ok) {
    throw new Error("Failed to get running turn");
  }
  const payload = (await res.json().catch(() => null)) as {
    turnId?: unknown;
    source?: unknown;
  } | null;
  return {
    turnId: typeof payload?.turnId === "string" ? payload.turnId : null,
    source: typeof payload?.source === "string" ? payload.source : null,
  };
}

export async function cancelSessionTurn(
  sessionId: string,
  turnId: string,
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/agent-chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    throw new Error("Failed to cancel turn");
  }
}

export async function* streamAgentChat(
  agentId: string,
  message: string,
  sessionId?: string,
  signal?: AbortSignal,
  outputFolder?: string | null,
  model?: AgentModel,
  busyFromSeq = 1,
): AsyncGenerator<AgentChatEvent> {
  const payload = {
    message,
    sessionId,
    outputFolder: outputFolder || undefined,
    model: model || undefined,
  };

  const startRes = await apiFetch(
    `${API_BASE}/agent-chat/${agentId}/chat/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
  );

  if (startRes.status === 404) {
    yield* streamLegacyAgentChat(
      agentId,
      message,
      sessionId,
      signal,
      outputFolder,
      model,
    );
    return;
  }

  if (!startRes.ok) {
    if (startRes.status === 409) {
      const busyPayload = (await startRes.json().catch(() => null)) as {
        sessionId?: string;
        turnId?: string;
        retryAfterMs?: number;
      } | null;
      if (busyPayload?.sessionId && busyPayload?.turnId) {
        yield { type: "session", sessionId: busyPayload.sessionId };
        yield {
          type: "turn",
          sessionId: busyPayload.sessionId,
          turnId: busyPayload.turnId,
          data: {
            turnId: busyPayload.turnId,
            sessionId: busyPayload.sessionId,
          },
        };
        yield* streamAgentTurn(
          busyPayload.sessionId,
          busyPayload.turnId,
          Math.max(1, Math.floor(busyFromSeq)),
          signal,
        );
        return;
      }
    }

    if (startRes.status === 503) {
      const errPayload = (await startRes.json().catch(() => null)) as {
        reason?: string;
        retryAfterMs?: number;
      } | null;
      yield {
        type: "vm_starting",
        data: {
          reason: errPayload?.reason || "vm_starting",
          retryAfterMs: errPayload?.retryAfterMs || 5000,
        },
      };
      yield { type: "done" };
      return;
    }

    yield {
      type: "error",
      data: `Failed to connect to agent (${startRes.status} ${startRes.statusText})`,
    };
    yield { type: "done" };
    return;
  }

  const startPayload = (await startRes.json().catch(() => null)) as {
    sessionId?: string;
    turnId?: string;
  } | null;
  if (!startPayload?.sessionId || !startPayload?.turnId) {
    yield {
      type: "error",
      data: "Failed to start turn stream.",
    };
    yield { type: "done" };
    return;
  }

  yield { type: "session", sessionId: startPayload.sessionId };
  yield {
    type: "turn",
    sessionId: startPayload.sessionId,
    turnId: startPayload.turnId,
    data: { turnId: startPayload.turnId, sessionId: startPayload.sessionId },
  };
  yield* streamAgentTurn(
    startPayload.sessionId,
    startPayload.turnId,
    1,
    signal,
  );
}

export function subscribeSessionLiveEvents(
  sessionId: string,
  onEvent: (event: AgentChatEvent) => void,
  onError?: (event: Event) => void,
): () => void {
  const stream = new EventSource(
    `${API_BASE}/agent-chat/sessions/${encodeURIComponent(sessionId)}/live`,
    {
      withCredentials: true,
    },
  );

  stream.onmessage = (message) => {
    try {
      const event = JSON.parse(String(message.data || "")) as AgentChatEvent;
      onEvent(event);
    } catch {
      // Ignore malformed live events.
    }
  };

  stream.onerror = (event) => {
    if (onError) onError(event);
  };

  return () => {
    stream.close();
  };
}

// ==================== Workspace ====================
export interface WorkspaceFile {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  children?: WorkspaceFile[];
}

export interface WorkspaceStats {
  totalSize: number;
  fileCount: number;
  maxSize: number;
}

export interface ListWorkspaceFilesOptions {
  path?: string;
  recursive?: boolean;
  includeStats?: boolean;
}

export async function listWorkspaceFiles(
  agentId: string,
  options: ListWorkspaceFilesOptions = {},
): Promise<{ files: WorkspaceFile[]; stats?: WorkspaceStats }> {
  const params = new URLSearchParams();
  if (typeof options.path === "string" && options.path.length > 0) {
    params.set("path", options.path);
  }
  if (options.recursive === false) {
    params.set("recursive", "false");
  }
  if (options.includeStats === true) {
    params.set("includeStats", "true");
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`${API_BASE}/workspace/${agentId}/files${suffix}`);
  if (!res.ok) throw new Error("Failed to list workspace files");
  return res.json();
}

export async function readWorkspaceFile(
  agentId: string,
  filePath: string,
): Promise<{ path: string; content: string; size: number; modified: string }> {
  const res = await apiFetch(
    `${API_BASE}/workspace/${agentId}/file?path=${encodeURIComponent(filePath)}`,
  );
  if (!res.ok) throw new Error("Failed to read file");
  return res.json();
}

export async function uploadWorkspaceFile(
  agentId: string,
  file: File,
  destPath?: string,
): Promise<{ path: string; size: number; name: string }> {
  const formData = new FormData();
  formData.append("file", file);
  if (destPath) formData.append("path", destPath);

  const res = await apiFetch(`${API_BASE}/workspace/${agentId}/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error("Failed to upload file");
  return res.json();
}

export async function deleteWorkspaceFile(
  agentId: string,
  filePath: string,
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/workspace/${agentId}/file?path=${encodeURIComponent(filePath)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error("Failed to delete file");
}

export async function createWorkspaceDir(
  agentId: string,
  dirPath: string,
): Promise<void> {
  const res = await apiFetch(`${API_BASE}/workspace/${agentId}/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw new Error("Failed to create directory");
}

export async function moveWorkspaceFile(
  agentId: string,
  fromPath: string,
  toDirPath: string,
): Promise<{ from: string; to: string }> {
  const res = await apiFetch(`${API_BASE}/workspace/${agentId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromPath, to: toDirPath }),
  });

  if (!res.ok) {
    let message = "Failed to move file";
    try {
      const data = await res.json();
      if (data?.error) {
        message = String(data.error);
      }
    } catch {
      // Ignore JSON parsing errors and use fallback message
    }
    throw new Error(message);
  }

  return res.json();
}
