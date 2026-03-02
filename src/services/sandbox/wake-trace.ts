import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";

const IMPORTANT_EVENTS = new Set<string>([
  "ensure.begin",
  "ensure.starting",
  "ensure.ready",
  "ensure.not_found",
  "reconcile.begin_agent",
  "reconcile.gce_state",
  "reconcile.action",
  "reconcile.action_applied",
  "reconcile.mark_state",
  "reconcile.error_agent",
  "vm_ready.received",
  "vm_ready.applied",
  "vm_ready.ignored",
  "vm_ready.error",
  "sandbox.vm_ready_callback",
  "sandbox.vm_ready_callback_error",
]);

let traceDirReady = false;

function shouldLog(agentId?: string): boolean {
  if (!config.sandboxWakeTraceLogs) return false;
  if (!agentId) return true;
  if (config.sandboxWakeTraceAgentIds.length === 0) return true;
  return config.sandboxWakeTraceAgentIds.includes(agentId);
}

async function appendTraceLine(line: string): Promise<void> {
  const filePath = config.sandboxWakeTraceFilePath;
  if (!filePath) return;

  if (!traceDirReady) {
    await mkdir(path.dirname(filePath), { recursive: true });
    traceDirReady = true;
  }

  await appendFile(filePath, `${line}\n`, "utf8");
}

export function wakeTrace(
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!IMPORTANT_EVENTS.has(event)) return;

  const agentIdValue = details.agentId;
  const agentId =
    typeof agentIdValue === "string" && agentIdValue ? agentIdValue : undefined;
  if (!shouldLog(agentId)) return;

  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  const line = JSON.stringify(payload);

  if (config.sandboxWakeTraceConsole) {
    console.log(`[wake_trace] ${line}`);
  }

  void appendTraceLine(line).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[wake_trace] failed to write trace file: ${message}`);
  });
}
