import { config } from "../../config.js";
import { withOrgContextQuery } from "../../db/index.js";
import { touchActivityThrottled } from "./activity.js";
import * as reconciler from "./reconciler.js";
import { wakeTrace } from "./wake-trace.js";

export type EnsureReason =
  | "vm_creating"
  | "vm_starting"
  | "vm_stopping"
  | "vm_deleting"
  | "vm_upgrading"
  | "vm_error_retrying";

export interface EnsureReadyResult {
  status: "ready";
}

export interface EnsureStartingResult {
  status: "starting";
  reason: EnsureReason;
  retryAfterMs: number;
}

export type EnsureResult = EnsureReadyResult | EnsureStartingResult;

export interface EnsureSandboxOptions {
  touchActivity?: boolean;
}

export class SandboxNotReadyError extends Error {
  statusCode: number;
  retryAfterMs: number;
  reason: string;

  constructor(reason: string, retryAfterMs = config.sandboxReadyRetryAfterMs) {
    super(reason);
    this.statusCode = 503;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

interface AgentVmRow {
  id: string;
  org_id: string;
  machine_type: string | null;
  desired_vm_state: string | null;
  observed_vm_state: string | null;
  vm_ip: string | null;
  vm_name: string | null;
  vm_zone: string | null;
  data_disk_name: string | null;
  last_provision_error: string | null;
  deleted_at: Date | null;
}

async function getAgentRow(
  orgId: string,
  agentId: string,
): Promise<AgentVmRow> {
  const result = await withOrgContextQuery<AgentVmRow>(
    orgId,
    `SELECT id, org_id, machine_type,
            desired_vm_state, observed_vm_state, vm_ip, vm_name, vm_zone,
            data_disk_name, last_provision_error, deleted_at
     FROM agents
     WHERE id = $1
     LIMIT 1`,
    [agentId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Agent not found");
  }

  return row;
}

function buildSandboxUrl(row: AgentVmRow): string {
  if (config.sandboxMode === "local") {
    return config.sandboxLocalUrl;
  }

  if (!row.vm_ip) {
    throw new SandboxNotReadyError("vm_starting");
  }

  return `http://${row.vm_ip}:8888`;
}

export async function ensureSandbox(
  orgId: string,
  agentId: string,
  options: EnsureSandboxOptions = {},
): Promise<EnsureResult> {
  const startedAt = Date.now();
  const touchActivity = options.touchActivity === true;
  wakeTrace("ensure.begin", {
    agentId,
    orgId,
    touchActivity,
  });
  const intentResult = await withOrgContextQuery<{ id: string }>(
    orgId,
    `UPDATE agents
     SET desired_vm_state = 'running',
         last_activity_at = CASE WHEN $2::boolean THEN NOW() ELSE last_activity_at END,
         next_reconcile_at = NOW()
     WHERE id = $1
       AND deleted_at IS NULL
     RETURNING id`,
    [agentId, touchActivity],
  );
  if (intentResult.rows.length === 0) {
    wakeTrace("ensure.not_found", {
      agentId,
      orgId,
      touchActivity,
      elapsedMs: Date.now() - startedAt,
    });
    throw new Error("Agent not found");
  }

  const row = await getAgentRow(orgId, agentId);
  if (row.observed_vm_state === "running") {
    if (touchActivity) {
      await touchActivityThrottled(orgId, agentId);
    }
    wakeTrace("ensure.ready", {
      agentId,
      orgId,
      touchActivity,
      observedVmState: row.observed_vm_state,
      desiredVmState: row.desired_vm_state,
      vmIp: row.vm_ip,
      elapsedMs: Date.now() - startedAt,
    });
    return { status: "ready" };
  }

  // Wake-up fast path: trigger a one-shot reconcile so /ensure does not wait for
  // the periodic interval when the VM is still starting/stopped.
  reconciler.nudgeReconcilerNow();

  wakeTrace("ensure.starting", {
    agentId,
    orgId,
    touchActivity,
    observedVmState: row.observed_vm_state,
    desiredVmState: row.desired_vm_state,
    vmIp: row.vm_ip,
    reason: row.last_provision_error ? "vm_error_retrying" : "vm_starting",
    retryAfterMs: config.sandboxReadyRetryAfterMs,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    status: "starting",
    reason: row.last_provision_error ? "vm_error_retrying" : "vm_starting",
    retryAfterMs: config.sandboxReadyRetryAfterMs,
  };
}

async function ensureReadyOrThrow(
  orgId: string,
  agentId: string,
): Promise<AgentVmRow> {
  const ensured = await ensureSandbox(orgId, agentId, { touchActivity: true });
  if (ensured.status !== "ready") {
    throw new SandboxNotReadyError(ensured.reason, ensured.retryAfterMs);
  }
  return getAgentRow(orgId, agentId);
}

async function requestSandbox(
  orgId: string,
  agentId: string,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const row = await ensureReadyOrThrow(orgId, agentId);
  const baseUrl = buildSandboxUrl(row);
  const res = await fetch(`${baseUrl}${endpoint}`, init);
  return res;
}

export interface ChatRequest {
  message: string;
  systemPrompt: string;
  chatHistory: Array<{ role: string; content: string }>;
  model?: "gemini-3.1-pro" | "sonnet-4.6" | "opus-4.6" | "gpt-5.2";
}

export async function chatStream(
  orgId: string,
  agentId: string,
  sessionId: string,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const row = await ensureReadyOrThrow(orgId, agentId);
  const baseUrl = buildSandboxUrl(row);

  return fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId,
      sessionId,
      message: req.message,
      systemPrompt: req.systemPrompt,
      chatHistory: req.chatHistory,
      model: req.model,
    }),
    signal,
  });
}

export async function listFiles(
  orgId: string,
  agentId: string,
  options: {
    path?: string;
    recursive?: boolean;
    includeStats?: boolean;
  } = {},
): Promise<unknown> {
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

  const endpoint = params.size > 0 ? `/files?${params.toString()}` : "/files";
  const res = await requestSandbox(orgId, agentId, endpoint, {
    method: "GET",
  });
  if (!res.ok) throw new Error("Failed to list files");
  return res.json();
}

export async function readFile(
  orgId: string,
  agentId: string,
  filePath: string,
  options?: { raw?: boolean; download?: boolean },
): Promise<Response> {
  const query = new URLSearchParams({ path: filePath });
  if (options?.raw) query.set("raw", "true");
  if (options?.download) query.set("download", "true");
  return requestSandbox(orgId, agentId, `/file?${query.toString()}`, {
    method: "GET",
  });
}

export async function uploadFile(
  orgId: string,
  agentId: string,
  formData: FormData,
): Promise<unknown> {
  const res = await requestSandbox(orgId, agentId, "/upload", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    throw new Error("Failed to upload file");
  }
  return res.json();
}

export async function deleteFile(
  orgId: string,
  agentId: string,
  filePath: string,
): Promise<void> {
  const query = new URLSearchParams({ path: filePath });
  const res = await requestSandbox(
    orgId,
    agentId,
    `/file?${query.toString()}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    throw new Error("Failed to delete file");
  }
}

export async function mkdir(
  orgId: string,
  agentId: string,
  dirPath: string,
): Promise<unknown> {
  const res = await requestSandbox(orgId, agentId, "/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) throw new Error("Failed to create directory");
  return res.json();
}

export async function move(
  orgId: string,
  agentId: string,
  fromPath: string,
  toDirPath: string,
): Promise<unknown> {
  const res = await requestSandbox(orgId, agentId, "/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromPath, to: toDirPath }),
  });
  if (!res.ok) {
    let message = "Failed to move file";
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) {
        message = data.error;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }
  return res.json();
}

export async function stats(orgId: string, agentId: string): Promise<unknown> {
  const res = await requestSandbox(orgId, agentId, "/stats", { method: "GET" });
  if (!res.ok) {
    throw new Error("Failed to get stats");
  }
  return res.json();
}

export async function status(orgId: string, agentId: string): Promise<unknown> {
  const res = await requestSandbox(orgId, agentId, "/status", {
    method: "GET",
  });
  if (!res.ok) throw new Error("Failed to fetch sandbox status");
  return res.json();
}
