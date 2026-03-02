import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { removeAgentDirs } from "../pi-agent/session.js";
import * as gce from "./gce.js";
import {
  desiredAcceleratorTypeForMachineType,
  getSupportedGpuMachineTypes,
  usesBuiltinGpuProfile,
} from "./machine-types.js";
import { wakeTrace } from "./wake-trace.js";

const RECONCILE_LEADER_LOCK_KEY = 1;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_CONVERGENCE_CANDIDATES = 200;
const MAX_PARALLEL_RECONCILES = 8;
const STARTING_RECONCILE_DELAY_CAP_MS = 2_000;
const EXPECTED_RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;

let started = false;
let timer: NodeJS.Timeout | null = null;
let nudgeTimer: NodeJS.Timeout | null = null;
let leaderConn: PoolClient | null = null;
let isLeader = false;
let tickInProgress = false;
let tickQueued = false;
let warnedInvalidExpectedRuntimeVersion = false;

const inFlightAgents = new Set<string>();

interface ReconcileAgentRow {
  id: string;
  org_id: string;
  machine_type: string | null;
  observed_runtime_version: string | null;
  desired_vm_state: string | null;
  observed_vm_state: string | null;
  last_provision_error: string | null;
  last_provision_error_at: Date | null;
  vm_ip: string | null;
  vm_name: string | null;
  vm_zone: string | null;
  data_disk_name: string | null;
  startup_started_at: Date | null;
  next_reconcile_at: Date | null;
  deleted_at: Date | null;
  reconcile_attempt_count: number | null;
  needs_upgrade: boolean | null;
  upgrade_risk_detected: boolean | null;
  upgrade_risk_message: string | null;
}

type ReconcileAction =
  | { kind: "delete-agent" }
  | { kind: "noop"; reason: string }
  | { kind: "mark-starting" }
  | { kind: "mark-running"; needsUpgrade?: boolean }
  | { kind: "mark-stopped" }
  | { kind: "create-vm" }
  | { kind: "recreate-vm" }
  | { kind: "start-vm" }
  | { kind: "suspend-vm" };

interface DecideActionInput {
  mode: "local" | "gce";
  deleted: boolean;
  desiredRunning: boolean;
  actualStatus: string;
  machineProfileMismatch: boolean;
  hasReachableIp: boolean;
  runtimeHealthy: boolean | null;
  startupTimedOut: boolean;
  needsUpgrade: boolean;
  runtimeVersionMismatch: boolean;
  runtimeVersionMatchesExpected: boolean;
}

function statusFromInstance(instance: any | null): string {
  if (!instance) return "MISSING";
  return String(instance.status || "MISSING").toUpperCase();
}

function instanceIp(instance: any | null): string | null {
  if (!instance) return null;
  const external = instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  if (typeof external === "string" && external) return external;
  const internal = instance?.networkInterfaces?.[0]?.networkIP;
  if (!config.gceUseExternalIp && typeof internal === "string" && internal) {
    return internal;
  }
  return null;
}

function effectiveVmIp(
  instance: any | null,
  persistedIp: string | null,
): string {
  const liveIp = instanceIp(instance);
  if (liveIp) return liveIp;
  if (persistedIp) return persistedIp;
  return "";
}

function extractResourceLeaf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = trimmed.split("/");
  return segments[segments.length - 1] || null;
}

function actualMachineTypeFromInstance(instance: any | null): string | null {
  return extractResourceLeaf(instance?.machineType);
}

function actualAcceleratorTypeFromInstance(
  instance: any | null,
): string | null {
  const accelerators = Array.isArray(instance?.guestAccelerators)
    ? instance.guestAccelerators
    : [];
  for (const accelerator of accelerators) {
    const countRaw = Number(accelerator?.acceleratorCount ?? 0);
    if (Number.isFinite(countRaw) && countRaw <= 0) {
      continue;
    }
    const leaf = extractResourceLeaf(accelerator?.acceleratorType);
    if (leaf) return leaf;
  }
  return null;
}

function desiredVmIsRunning(value: string | null): boolean {
  return (value || "stopped") === "running";
}

export function resolveConfiguredExpectedRuntimeVersionForTest(
  rawValue: string,
): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "latest") return null;
  if (!EXPECTED_RUNTIME_VERSION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function resolveConfiguredExpectedRuntimeVersion(
  rawValue: string,
): string | null {
  const resolved = resolveConfiguredExpectedRuntimeVersionForTest(rawValue);
  const trimmed = rawValue.trim();
  if (!resolved && trimmed) {
    if (!warnedInvalidExpectedRuntimeVersion) {
      warnedInvalidExpectedRuntimeVersion = true;
      console.warn(
        `Ignoring SANDBOX_EXPECTED_RUNTIME_VERSION='${trimmed}' because only explicit [A-Za-z0-9._-]+ versions are supported`,
      );
    }
    wakeTrace("reconcile.runtime_enforcement_disabled_invalid_config", {
      configuredExpectedRuntimeVersion: trimmed,
    });
  }
  return resolved;
}

function successReconcileDelayMs(): number {
  return Math.max(5_000, Math.min(config.sandboxIdlePollIntervalMs, 60_000));
}

function nextReconcileDelayMsForObservedState(
  observed: "running" | "starting" | "stopped" | "error",
): number {
  const normalDelay = successReconcileDelayMs();
  if (observed === "starting") {
    return Math.min(STARTING_RECONCILE_DELAY_CAP_MS, normalDelay);
  }
  return normalDelay;
}

export function nextReconcileDelayMsForObservedStateForTest(
  observed: "running" | "starting" | "stopped" | "error",
): number {
  return nextReconcileDelayMsForObservedState(observed);
}

async function dbQuery<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return withDbTimeout(() => pool.query<T>(text, values), text);
}

async function withDbTimeout<T extends QueryResultRow>(
  query: () => Promise<QueryResult<T>>,
  label: string,
): Promise<QueryResult<T>> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      query(),
      new Promise<QueryResult<T>>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Reconciler DB query timed out after ${config.sandboxReconcileDbQueryTimeoutMs}ms: ${label.slice(
                0,
                80,
              )}`,
            ),
          );
        }, config.sandboxReconcileDbQueryTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface StatusProbeResult {
  runtimeHealthy: boolean;
  controlPlaneConnected: boolean | null;
  runtimeVersion: string | null;
  upgradeRiskDetected: boolean | null;
  upgradeRiskMessage: string | null;
}

async function statusProbe(ipOrBaseUrl: string): Promise<StatusProbeResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.sandboxHealthProbeTimeoutMs,
    );
    const baseUrl = ipOrBaseUrl.startsWith("http")
      ? ipOrBaseUrl
      : `http://${ipOrBaseUrl}:8888`;
    const res = await fetch(`${baseUrl}/status`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return {
        runtimeHealthy: false,
        controlPlaneConnected: null,
        runtimeVersion: null,
        upgradeRiskDetected: null,
        upgradeRiskMessage: null,
      };
    }

    const payload = (await res.json()) as {
      runtimeVersion?: unknown;
      runtime_version?: unknown;
      controlPlaneConnected?: unknown;
      control_plane_connected?: unknown;
      upgradeRiskDetected?: unknown;
      upgrade_risk_detected?: unknown;
      upgradeRiskMessage?: unknown;
      upgrade_risk_message?: unknown;
    };
    const runtimeCandidate =
      typeof payload?.runtimeVersion === "string"
        ? payload.runtimeVersion
        : typeof payload?.runtime_version === "string"
          ? payload.runtime_version
          : "";
    const runtimeVersion = runtimeCandidate.trim() || null;
    const riskDetectedCandidate =
      typeof payload?.upgradeRiskDetected === "boolean"
        ? payload.upgradeRiskDetected
        : typeof payload?.upgrade_risk_detected === "boolean"
          ? payload.upgrade_risk_detected
          : null;
    const riskMessageCandidate =
      typeof payload?.upgradeRiskMessage === "string"
        ? payload.upgradeRiskMessage
        : typeof payload?.upgrade_risk_message === "string"
          ? payload.upgrade_risk_message
          : null;
    const upgradeRiskMessage = riskMessageCandidate?.trim() || null;
    const controlPlaneConnectedCandidate =
      typeof payload?.controlPlaneConnected === "boolean"
        ? payload.controlPlaneConnected
        : typeof payload?.control_plane_connected === "boolean"
          ? payload.control_plane_connected
          : true;
    return {
      runtimeHealthy: true,
      controlPlaneConnected: controlPlaneConnectedCandidate,
      runtimeVersion,
      upgradeRiskDetected: riskDetectedCandidate,
      upgradeRiskMessage,
    };
  } catch {
    return {
      runtimeHealthy: false,
      controlPlaneConnected: null,
      runtimeVersion: null,
      upgradeRiskDetected: null,
      upgradeRiskMessage: null,
    };
  }
}

async function tryBecomeLeader(): Promise<boolean> {
  try {
    if (leaderConn && isLeader) {
      return true;
    }

    if (!leaderConn) {
      leaderConn = await pool.connect();
    }

    const result = await leaderConn.query<{ acquired: boolean }>({
      text: "SELECT pg_try_advisory_lock($1::bigint) as acquired",
      values: [String(RECONCILE_LEADER_LOCK_KEY)],
    });
    isLeader = Boolean(result.rows[0]?.acquired);
    return isLeader;
  } catch {
    if (leaderConn) {
      try {
        leaderConn.release();
      } catch {
        // ignore
      }
    }
    leaderConn = null;
    isLeader = false;
    return false;
  }
}

async function runIdleIntentPass(): Promise<void> {
  const gpuMachineTypes = getSupportedGpuMachineTypes();
  const result = await dbQuery(
    `UPDATE agents
     SET desired_vm_state = 'stopped',
         next_reconcile_at = NOW()
     WHERE desired_vm_state = 'running'
       AND observed_vm_state = 'running'
       AND deleted_at IS NULL
       AND (active_stream_lease_until IS NULL OR active_stream_lease_until <= NOW())
       AND last_activity_at < NOW() - (
         CASE
           WHEN COALESCE(machine_type, $2) = ANY($3::text[]) THEN $4::bigint
           ELSE $1::bigint
         END * INTERVAL '1 millisecond'
       )`,
    [
      config.sandboxIdleCpuMs,
      config.gceMachineType,
      gpuMachineTypes,
      config.sandboxIdleGpuMs,
    ],
  );
  const updatedCount = result.rowCount || 0;
  if (updatedCount > 0) {
    wakeTrace("reconcile.idle_marked_stopped", {
      count: updatedCount,
      cpuIdleMs: config.sandboxIdleCpuMs,
      gpuIdleMs: config.sandboxIdleGpuMs,
    });
  }
}

async function listConvergenceCandidates(): Promise<ReconcileAgentRow[]> {
  const result = await dbQuery<ReconcileAgentRow>(
    `SELECT id, org_id, machine_type, observed_runtime_version,
            desired_vm_state, observed_vm_state,
            last_provision_error, last_provision_error_at,
            vm_ip, vm_name, vm_zone, data_disk_name,
            startup_started_at, next_reconcile_at, deleted_at, reconcile_attempt_count,
            needs_upgrade, upgrade_risk_detected, upgrade_risk_message
     FROM agents
     WHERE deleted_at IS NOT NULL
        OR desired_vm_state IS DISTINCT FROM observed_vm_state
        OR next_reconcile_at IS NULL
        OR next_reconcile_at <= NOW()
     ORDER BY COALESCE(next_reconcile_at, NOW()) ASC
     LIMIT $1`,
    [MAX_CONVERGENCE_CANDIDATES],
  );
  if (result.rows.length > 0) {
    wakeTrace("reconcile.candidates", {
      count: result.rows.length,
    });
  }
  return result.rows;
}

function nextBackoffMs(currentAttempt: number): number {
  const exponent = Math.max(0, currentAttempt);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

async function writeErrorState(agentId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const current = await dbQuery<{ reconcile_attempt_count: number | null }>(
    "SELECT reconcile_attempt_count FROM agents WHERE id = $1 LIMIT 1",
    [agentId],
  );
  const attempt = (current.rows[0]?.reconcile_attempt_count || 0) + 1;
  const backoffMs = nextBackoffMs(attempt);

  await dbQuery(
    `UPDATE agents
     SET last_provision_error = $1,
         last_provision_error_at = NOW(),
         reconcile_attempt_count = $2,
         next_reconcile_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
         startup_started_at = COALESCE(startup_started_at, NOW()),
         last_reconciled_at = NOW()
     WHERE id = $4`,
    [message, attempt, backoffMs, agentId],
  );
}

async function markState(
  row: ReconcileAgentRow,
  observed: "running" | "starting" | "stopped" | "error",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const patch = {
    observed_vm_state: observed,
    last_reconciled_at: new Date(),
    next_reconcile_at: new Date(
      Date.now() + nextReconcileDelayMsForObservedState(observed),
    ),
    ...(observed === "running" || observed === "stopped"
      ? { startup_started_at: null }
      : {}),
    ...(observed === "running"
      ? {
          last_provision_error: null,
          last_provision_error_at: null,
          reconcile_attempt_count: 0,
        }
      : {}),
    ...extra,
  };

  const keys = Object.keys(patch);
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  const assignments = keys.map((k, idx) => `${k} = $${idx + 1}`).join(", ");
  await dbQuery(
    `UPDATE agents
     SET ${assignments}
     WHERE id = $${keys.length + 1}`,
    [...values, row.id],
  );
  wakeTrace("reconcile.mark_state", {
    agentId: row.id,
    observedVmState: observed,
    desiredVmState: row.desired_vm_state,
    patchKeys: keys,
  });
}

export function decideAction(input: DecideActionInput): ReconcileAction {
  if (input.deleted) {
    return { kind: "delete-agent" };
  }

  if (input.mode === "local") {
    if (!input.desiredRunning) {
      return { kind: "mark-stopped" };
    }
    if (input.runtimeHealthy) {
      return {
        kind: "mark-running",
        needsUpgrade: input.runtimeVersionMatchesExpected ? false : undefined,
      };
    }
    return { kind: "mark-starting" };
  }

  if (!input.desiredRunning) {
    if (
      input.actualStatus === "RUNNING" ||
      input.actualStatus === "STAGING" ||
      input.actualStatus === "PROVISIONING"
    ) {
      return { kind: "suspend-vm" };
    }
    // SUSPENDED means the VM is already in the desired idle state — just reflect
    // that in the DB without making another GCE call.
    return { kind: "mark-stopped" };
  }

  if (input.actualStatus === "MISSING") {
    return { kind: "create-vm" };
  }

  if (input.actualStatus === "RUNNING") {
    if (input.machineProfileMismatch) {
      return { kind: "recreate-vm" };
    }

    if (!input.hasReachableIp) {
      return { kind: "mark-starting" };
    }

    if (input.runtimeHealthy && input.runtimeVersionMismatch) {
      return { kind: "mark-running", needsUpgrade: true };
    }

    if (!input.runtimeHealthy && input.startupTimedOut) {
      return { kind: "recreate-vm" };
    }

    if (input.runtimeHealthy) {
      return {
        kind: "mark-running",
        needsUpgrade: input.runtimeVersionMatchesExpected ? false : undefined,
      };
    }
    return { kind: "mark-starting" };
  }

  if (
    input.actualStatus === "TERMINATED" ||
    input.actualStatus === "STOPPED" ||
    input.actualStatus === "SUSPENDED"
  ) {
    if (input.needsUpgrade || input.machineProfileMismatch) {
      return { kind: "recreate-vm" };
    }
    return { kind: "start-vm" };
  }

  if (
    input.actualStatus === "SUSPENDING" ||
    input.actualStatus === "STOPPING"
  ) {
    return { kind: "mark-starting" };
  }

  if (
    input.actualStatus === "PROVISIONING" ||
    input.actualStatus === "STAGING"
  ) {
    return { kind: "mark-starting" };
  }

  return { kind: "mark-starting" };
}

async function applyAction(
  row: ReconcileAgentRow,
  action: ReconcileAction,
  actual: any | null,
): Promise<void> {
  switch (action.kind) {
    case "noop": {
      wakeTrace("reconcile.noop", {
        agentId: row.id,
        reason: action.reason,
        desiredVmState: row.desired_vm_state,
        observedVmState: row.observed_vm_state,
      });
      return;
    }

    case "delete-agent": {
      if (config.sandboxMode === "gce") {
        await gce.deleteVM(row.id);
        await gce.deleteDataDisk(row.id);
      }
      await dbQuery("DELETE FROM agents WHERE id = $1", [row.id]);
      try {
        await removeAgentDirs(row.org_id, row.id);
      } catch (error) {
        console.error("[reconciler] workspace cleanup failed", row.id, error);
      }
      return;
    }

    case "mark-running": {
      await markState(row, "running", {
        vm_ip: effectiveVmIp(actual, row.vm_ip),
        vm_name: actual?.name || row.vm_name,
        vm_zone: row.vm_zone || config.gcpZone,
        ...(typeof action.needsUpgrade === "boolean"
          ? { needs_upgrade: action.needsUpgrade }
          : {}),
      });
      if (row.observed_vm_state !== "running") {
        await dbQuery(
          "UPDATE agents SET last_activity_at = NOW() WHERE id = $1",
          [row.id],
        );
      }
      return;
    }

    case "mark-starting": {
      await markState(row, "starting", {
        vm_ip: effectiveVmIp(actual, row.vm_ip),
        vm_name: actual?.name || row.vm_name,
        vm_zone: row.vm_zone || config.gcpZone,
        startup_started_at: row.startup_started_at || new Date(),
      });
      return;
    }

    case "mark-stopped": {
      await markState(row, "stopped");
      return;
    }

    case "create-vm": {
      const machineType = row.machine_type || config.gceMachineType;
      const acceleratorType = desiredAcceleratorTypeForMachineType(machineType);
      const startupStartedAt = new Date();
      await markState(row, "starting", {
        startup_started_at: startupStartedAt,
        observed_runtime_version: null,
      });
      const vm = await gce.createVM(row.id, machineType, { acceleratorType });
      await markState(row, "starting", {
        vm_name: vm.vmName,
        vm_ip: vm.vmIp,
        vm_zone: vm.vmZone,
        data_disk_name: vm.dataDiskName,
        needs_upgrade: false,
        upgrade_risk_detected: false,
        upgrade_risk_message: null,
        startup_started_at: startupStartedAt,
        observed_runtime_version: null,
      });
      return;
    }

    case "recreate-vm": {
      const machineType = row.machine_type || config.gceMachineType;
      const acceleratorType = desiredAcceleratorTypeForMachineType(machineType);

      const deleteStartedAt = new Date();
      await markState(row, "starting", {
        startup_started_at: deleteStartedAt,
        observed_runtime_version: null,
      });
      await gce.deleteVM(row.id);
      // Reset startup timeout window for the fresh VM boot after delete.
      const startupStartedAt = new Date();
      const vm = await gce.createVM(row.id, machineType, { acceleratorType });
      await markState(row, "starting", {
        vm_name: vm.vmName,
        vm_ip: vm.vmIp,
        vm_zone: vm.vmZone,
        data_disk_name: vm.dataDiskName,
        needs_upgrade: false,
        upgrade_risk_detected: false,
        upgrade_risk_message: null,
        startup_started_at: startupStartedAt,
        observed_runtime_version: null,
      });
      return;
    }

    case "start-vm": {
      const startupStartedAt = new Date();
      await markState(row, "starting", {
        startup_started_at: startupStartedAt,
      });
      const vm = await gce.startVM(row.id);
      await markState(row, "starting", {
        vm_name: vm.vmName,
        vm_ip: vm.vmIp,
        vm_zone: vm.vmZone,
        data_disk_name: vm.dataDiskName,
        startup_started_at: startupStartedAt,
      });
      return;
    }

    case "suspend-vm": {
      await gce.suspendVM(row.id);
      await markState(row, "stopped");
      return;
    }
  }
}

async function getCurrentRow(
  agentId: string,
): Promise<ReconcileAgentRow | null> {
  const fresh = await dbQuery<ReconcileAgentRow>(
    `SELECT id, org_id, machine_type, observed_runtime_version,
            desired_vm_state, observed_vm_state,
            last_provision_error, last_provision_error_at,
            vm_ip, vm_name, vm_zone, data_disk_name,
            startup_started_at, next_reconcile_at, deleted_at, reconcile_attempt_count,
            needs_upgrade, upgrade_risk_detected, upgrade_risk_message
     FROM agents
     WHERE id = $1
     LIMIT 1`,
    [agentId],
  );
  return fresh.rows[0] || null;
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error ?? "");
}

function isPermanentMachineAllocationError(error: unknown): boolean {
  const message = errorMessageText(error).toLowerCase();
  if (!message) return false;
  const patterns = [
    "zone_resource_pool_exhausted",
    "does not have enough resources available",
    "quota",
    "resource exhausted",
    "resource_exhausted",
    "invalid value for field 'resource.machinetype'",
    'invalid value for field "resource.machinetype"',
    "machine type",
    "machineType",
    "not found",
    "not supported",
  ];
  return patterns.some((pattern) => message.includes(pattern.toLowerCase()));
}

function shouldFallbackMachineToCpu(
  row: ReconcileAgentRow,
  desiredRunning: boolean,
  startupTimedOut: boolean,
): boolean {
  if (config.sandboxMode !== "gce") return false;
  if (!desiredRunning) return false;
  const requestedMachineType = row.machine_type || config.gceMachineType;
  if (requestedMachineType === config.gceMachineType) return false;
  if (row.observed_vm_state !== "starting") return false;
  if (!startupTimedOut) return false;
  if (!(row.last_provision_error || "").trim()) return false;
  return true;
}

function shouldFallbackMachineToCpuImmediately(
  row: ReconcileAgentRow,
  error: unknown,
): boolean {
  if (config.sandboxMode !== "gce") return false;
  if (!desiredVmIsRunning(row.desired_vm_state)) return false;
  const requestedMachineType = row.machine_type || config.gceMachineType;
  if (requestedMachineType === config.gceMachineType) return false;
  return isPermanentMachineAllocationError(error);
}

async function fallbackMachineToCpu(
  row: ReconcileAgentRow,
  startupError: string,
  reason: "startup-timeout" | "allocation-error",
): Promise<void> {
  const requestedMachineType = row.machine_type || config.gceMachineType;
  const fallbackMachineType = config.gceMachineType;
  const fallbackError = `Requested machine type '${requestedMachineType}' failed to allocate. Falling back to '${fallbackMachineType}'. Last error: ${startupError}`;

  await dbQuery(
    `UPDATE agents
     SET machine_type = $2,
         observed_vm_state = 'starting',
         desired_vm_state = 'running',
         last_provision_error = $3,
         last_provision_error_at = NOW(),
         reconcile_attempt_count = 0,
         startup_started_at = NOW(),
         next_reconcile_at = NOW(),
         last_reconciled_at = NOW()
     WHERE id = $1`,
    [row.id, fallbackMachineType, fallbackError],
  );
  wakeTrace("reconcile.machine_fallback_to_cpu", {
    agentId: row.id,
    requestedMachineType,
    fallbackMachineType,
    startupError,
    reason,
  });
}

async function reconcileAgent(agentId: string): Promise<void> {
  const startedAt = Date.now();
  const current = await getCurrentRow(agentId);
  if (!current) return;

  const desiredRunning = desiredVmIsRunning(current.desired_vm_state);
  const expectedRuntimeVersion = resolveConfiguredExpectedRuntimeVersion(
    config.sandboxExpectedRuntimeVersion,
  );
  const desiredMachineType = current.machine_type || config.gceMachineType;
  const desiredAcceleratorType =
    desiredAcceleratorTypeForMachineType(desiredMachineType);
  const observedRuntimeVersion =
    current.observed_runtime_version?.trim() || null;

  let actual: any | null = null;
  let actualStatus = "MISSING";
  let machineProfileMismatch = false;
  let hasReachableIp = false;
  let runtimeHealthy: boolean | null = null;
  let controlPlaneConnected: boolean | null = null;
  let runtimeVersion: string | null = null;
  let upgradeRiskDetected: boolean | null = null;
  let upgradeRiskMessage: string | null = null;
  const startupTimedOut =
    desiredRunning &&
    (current.startup_started_at instanceof Date ||
      current.last_provision_error_at instanceof Date) &&
    Date.now() -
      (current.startup_started_at instanceof Date
        ? current.startup_started_at.getTime()
        : (current.last_provision_error_at as Date).getTime()) >
      config.sandboxStartupGraceMs;

  if (shouldFallbackMachineToCpu(current, desiredRunning, startupTimedOut)) {
    await fallbackMachineToCpu(
      current,
      (current.last_provision_error || "").trim() || "startup timeout",
      "startup-timeout",
    );
    return;
  }

  if (config.sandboxMode === "local") {
    if (desiredRunning) {
      const probe = await statusProbe(config.sandboxLocalUrl);
      runtimeHealthy = probe.runtimeHealthy;
      controlPlaneConnected = probe.controlPlaneConnected;
      runtimeVersion = probe.runtimeVersion;
      upgradeRiskDetected = probe.upgradeRiskDetected;
      upgradeRiskMessage = probe.upgradeRiskMessage;
      wakeTrace("reconcile.local_probe", {
        agentId,
        desiredRunning,
        runtimeHealthy,
        controlPlaneConnected,
        runtimeVersion,
        upgradeRiskDetected,
        upgradeRiskMessage,
      });
    }
  } else {
    actual = await gce.getInstance(current.id);
    actualStatus = statusFromInstance(actual);
    const actualMachineType = actualMachineTypeFromInstance(actual);
    const actualAcceleratorType = actualAcceleratorTypeFromInstance(actual);
    const shouldCompareAccelerator =
      !usesBuiltinGpuProfile(desiredMachineType) && !!desiredAcceleratorType;
    machineProfileMismatch =
      actualStatus !== "MISSING" &&
      (actualMachineType !== desiredMachineType ||
        (shouldCompareAccelerator &&
          actualAcceleratorType !== desiredAcceleratorType));
    const probeIp = effectiveVmIp(actual, current.vm_ip);
    hasReachableIp = Boolean(probeIp);

    const shouldProbe =
      desiredRunning && actualStatus === "RUNNING" && hasReachableIp;

    if (shouldProbe) {
      const probe = await statusProbe(probeIp);
      runtimeHealthy = probe.runtimeHealthy;
      controlPlaneConnected = probe.controlPlaneConnected;
      runtimeVersion = probe.runtimeVersion;
      upgradeRiskDetected = probe.upgradeRiskDetected;
      upgradeRiskMessage = probe.upgradeRiskMessage;
    }
    wakeTrace("reconcile.gce_state", {
      agentId,
      desiredRunning,
      actualStatus,
      hasReachableIp,
      runtimeHealthy,
      controlPlaneConnected,
      runtimeVersion,
      desiredMachineType,
      desiredAcceleratorType,
      actualMachineType,
      actualAcceleratorType,
      machineProfileMismatch,
      expectedRuntimeVersion: expectedRuntimeVersion || null,
      upgradeRiskDetected,
      upgradeRiskMessage,
      startupTimedOut,
      vmIp: probeIp,
      observedRuntimeVersion,
    });
  }

  const effectiveRuntimeVersion =
    runtimeHealthy === true
      ? runtimeVersion?.trim() || null
      : observedRuntimeVersion;
  const runtimeVersionKnown = Boolean(effectiveRuntimeVersion);
  const runtimeVersionMismatch = expectedRuntimeVersion
    ? !effectiveRuntimeVersion ||
      effectiveRuntimeVersion !== expectedRuntimeVersion
    : false;
  const runtimeVersionMatchesExpected = expectedRuntimeVersion
    ? Boolean(
        runtimeHealthy === true &&
          (runtimeVersion?.trim() || null) === expectedRuntimeVersion,
      )
    : Boolean(runtimeHealthy === true);
  const needsUpgrade = expectedRuntimeVersion
    ? Boolean(current.needs_upgrade) || runtimeVersionMismatch
    : false;

  const action = decideAction({
    mode: config.sandboxMode as "local" | "gce",
    deleted: Boolean(current.deleted_at),
    desiredRunning,
    actualStatus,
    machineProfileMismatch,
    hasReachableIp,
    runtimeHealthy,
    startupTimedOut,
    needsUpgrade,
    runtimeVersionMismatch,
    runtimeVersionMatchesExpected,
  });

  wakeTrace("reconcile.action", {
    agentId,
    action: action.kind,
    desiredVmState: current.desired_vm_state,
    observedVmState: current.observed_vm_state,
    actualStatus,
    machineProfileMismatch,
    runtimeHealthy,
    controlPlaneConnected,
    runtimeVersion,
    observedRuntimeVersion,
    effectiveRuntimeVersion,
    runtimeVersionKnown,
    expectedRuntimeVersion: expectedRuntimeVersion || null,
    needsUpgrade,
    upgradeRiskDetected,
    upgradeRiskMessage,
    elapsedMs: Date.now() - startedAt,
  });
  await applyAction(current, action, actual);
  const nextObservedRuntimeVersion =
    runtimeHealthy === true ? runtimeVersion?.trim() || null : null;
  if (
    runtimeHealthy === true &&
    nextObservedRuntimeVersion !== observedRuntimeVersion
  ) {
    await dbQuery(
      `UPDATE agents
       SET observed_runtime_version = $2
       WHERE id = $1`,
      [agentId, nextObservedRuntimeVersion],
    );
  }
  if (upgradeRiskDetected !== null) {
    await dbQuery(
      `UPDATE agents
       SET upgrade_risk_detected = $2,
           upgrade_risk_message = $3
       WHERE id = $1`,
      [agentId, upgradeRiskDetected, upgradeRiskMessage],
    );
  }
  wakeTrace("reconcile.action_applied", {
    agentId,
    action: action.kind,
    upgradeRiskDetected,
    upgradeRiskMessage,
    elapsedMs: Date.now() - startedAt,
  });
}

async function runOrphanSweep(): Promise<void> {
  if (!config.sandboxOrphanSweepDeleteEnabled) {
    wakeTrace("reconcile.orphan_sweep_disabled", {});
    return;
  }
  const instances = await gce.listInstances("labels.managed_by=mines_ai");
  for (const instance of instances) {
    const metadataItems = Array.isArray(instance?.metadata?.items)
      ? instance.metadata.items
      : [];
    const agentId = metadataItems.find(
      (item: { key?: string; value?: string }) => {
        return item?.key === "agent-id" && typeof item?.value === "string";
      },
    )?.value;
    if (!agentId) continue;

    const row = await dbQuery<{ id: string }>(
      "SELECT id FROM agents WHERE id = $1 LIMIT 1",
      [agentId],
    );
    if (row.rows.length > 0) continue;

    const createdAt = instance?.creationTimestamp
      ? new Date(instance.creationTimestamp)
      : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      continue;
    }
    const ageMs = Date.now() - createdAt.getTime();
    if (ageMs < config.gceOrphanMaxAgeMs) {
      continue;
    }

    await gce.deleteVM(agentId);
    await gce.deleteDataDisk(agentId);
  }
}

async function reconcileCandidate(row: ReconcileAgentRow): Promise<void> {
  if (inFlightAgents.has(row.id)) {
    wakeTrace("reconcile.skip_inflight", { agentId: row.id });
    return;
  }

  inFlightAgents.add(row.id);
  try {
    wakeTrace("reconcile.begin_agent", {
      agentId: row.id,
      desiredVmState: row.desired_vm_state,
      observedVmState: row.observed_vm_state,
      nextReconcileAt: row.next_reconcile_at?.toISOString?.() || null,
    });
    await reconcileAgent(row.id);
  } catch (error) {
    wakeTrace("reconcile.error_agent", {
      agentId: row.id,
      error: errorMessageText(error),
    });
    console.error("[reconciler] failed for agent", row.id, error);
    try {
      await writeErrorState(row.id, error);
      const fresh = await getCurrentRow(row.id);
      if (fresh && shouldFallbackMachineToCpuImmediately(fresh, error)) {
        await fallbackMachineToCpu(
          fresh,
          errorMessageText(error) || "allocation failure",
          "allocation-error",
        );
      }
    } catch (writeError) {
      console.error(
        "[reconciler] failed to persist error state",
        row.id,
        writeError,
      );
    }
  } finally {
    inFlightAgents.delete(row.id);
    wakeTrace("reconcile.end_agent", { agentId: row.id });
  }
}

export async function processQueueWithConcurrencyForTest<T>(
  items: T[],
  maxParallel: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workerCount = Math.min(Math.max(1, maxParallel), queue.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) {
        break;
      }
      await worker(next);
    }
  });

  await Promise.all(workers);
}

async function tick(): Promise<void> {
  const startedAt = Date.now();
  const leader = await tryBecomeLeader();
  if (!leader) {
    wakeTrace("reconcile.skip_not_leader", {
      elapsedMs: Date.now() - startedAt,
    });
    return;
  }

  await runIdleIntentPass();
  const candidates = await listConvergenceCandidates();
  await processQueueWithConcurrencyForTest(
    candidates,
    MAX_PARALLEL_RECONCILES,
    reconcileCandidate,
  );

  if (config.sandboxMode === "gce") {
    await runOrphanSweep();
  }
  wakeTrace("reconcile.tick_complete", {
    candidateCount: candidates.length,
    elapsedMs: Date.now() - startedAt,
  });
}

export async function runReconcilerTickForTest(): Promise<void> {
  await tick();
}

async function runTickSafeOnce(): Promise<void> {
  if (tickInProgress) {
    tickQueued = true;
    return;
  }

  tickInProgress = true;
  try {
    await tick();
  } catch (error) {
    console.error("[reconciler] tick failed", error);
  } finally {
    tickInProgress = false;
    if (tickQueued) {
      tickQueued = false;
      queueMicrotask(() => {
        void runTickSafeOnce();
      });
    }
  }
}

function runTickSafe() {
  void runTickSafeOnce();
}

export function nudgeReconcilerNow(): void {
  if (!started) return;
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    runTickSafe();
  }, 0);
}

export function startReconciler(): void {
  if (started) return;
  started = true;
  runTickSafe();
  timer = setInterval(runTickSafe, config.sandboxIdlePollIntervalMs);
}

export async function stopReconciler(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }

  if (leaderConn) {
    try {
      if (isLeader) {
        await leaderConn.query("SELECT pg_advisory_unlock($1::bigint)", [
          String(RECONCILE_LEADER_LOCK_KEY),
        ]);
      }
      leaderConn.release();
    } catch {
      // ignore
    }
  }

  leaderConn = null;
  isLeader = false;
  started = false;
  tickInProgress = false;
  tickQueued = false;
  inFlightAgents.clear();
}
