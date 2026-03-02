import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { pool, withOrgContextQuery } from "../db/index.js";
import {
  combineSanitizeStats,
  hasSanitizationChanges,
  sanitizePersistableString,
  sanitizePersistableValue,
} from "../lib/persistable-sanitize.js";
import { publishSessionLiveEvent } from "../services/agent-chat/live-events.js";
import { isDeployDraining } from "../services/deploy/drain-state.js";
import { buildSystemPrompt } from "../services/pi-agent/stream.js";
import * as gce from "../services/sandbox/gce.js";
import {
  desiredAcceleratorTypeForMachineType,
  usesBuiltinGpuProfile,
} from "../services/sandbox/machine-types.js";
import { getSandboxRuntimeBundle } from "../services/sandbox/runtime-bundle.js";
import { wakeTrace } from "../services/sandbox/wake-trace.js";
import { readInstalledSkillMarkdown } from "../services/skills/packages.js";
import {
  isWebSearchConfigured,
  performWebSearch,
} from "../services/web/web-tools.js";
import {
  appendBackgroundResumableTurnEvent,
  finalizeBackgroundResumableTurn,
  startBackgroundResumableTurn,
} from "./agent-chat.js";

interface VmTokenPayload {
  agentId: string;
  generation: number;
  iat: number;
  exp: number;
}

interface VmAgentRow {
  id: string;
  machine_type: string | null;
  desired_vm_state: string | null;
  observed_vm_state: string | null;
  vm_token_generation: number | null;
  vm_name: string | null;
  vm_zone: string | null;
  deleted_at: Date | null;
}

interface GceIdentityPayload {
  aud?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  google?: {
    compute_engine?: {
      instance_name?: string;
      project_id?: string;
      zone?: string;
    };
  };
}

interface RateLimitState {
  count: number;
  resetAtMs: number;
}

declare global {
  namespace Express {
    interface Request {
      vmTokenPayload?: VmTokenPayload;
    }
  }
}

const router = Router();
const gceIdentityClient = new OAuth2Client();
const internalRateLimits = new Map<string, RateLimitState>();
const INTERNAL_RATE_LIMIT_WINDOW_MS = 60_000;

function logSanitizedInternalPayload(
  scope: string,
  context: Record<string, unknown>,
  stats: {
    stringsSanitized: number;
    nullBytesRemoved: number;
    invalidSurrogatesReplaced: number;
    circularRefsReplaced: number;
  },
): void {
  if (!hasSanitizationChanges(stats)) return;
  console.warn("[internal] sanitized persistable payload", {
    scope,
    ...context,
    ...stats,
  });
}

function normalizeZoneName(zone: string | null | undefined): string {
  if (!zone) return "";
  const trimmed = zone.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || "";
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
    if (Number.isFinite(countRaw) && countRaw <= 0) continue;
    const leaf = extractResourceLeaf(accelerator?.acceleratorType);
    if (leaf) return leaf;
  }
  return null;
}

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function parseIsoDate(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function signVmToken(payload: VmTokenPayload, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function verifyVmToken(token: string, secret: string): VmTokenPayload | null {
  const [encodedHeader, encodedPayload, encodedSig] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSig) {
    return null;
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  const providedSig = base64UrlDecode(encodedSig);
  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      base64UrlDecode(encodedPayload).toString("utf-8"),
    );
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.agentId !== "string") return null;
    if (typeof payload.generation !== "number") return null;
    if (typeof payload.exp !== "number") return null;
    if (typeof payload.iat !== "number") return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload as VmTokenPayload;
  } catch {
    return null;
  }
}

function extractBearerToken(req: Request): string | null {
  const auth = req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice("Bearer ".length).trim() || null;
}

function cleanupExpiredRateLimits(nowMs: number): void {
  for (const [key, state] of internalRateLimits.entries()) {
    if (nowMs >= state.resetAtMs) {
      internalRateLimits.delete(key);
    }
  }
}

function perAgentRateLimit(
  bucket: string,
  maxRequests: number,
  windowMs = INTERNAL_RATE_LIMIT_WINDOW_MS,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const agentId = getRouteParam(req.params.agentId);
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }

    const nowMs = Date.now();
    if (internalRateLimits.size > 10_000) {
      cleanupExpiredRateLimits(nowMs);
    }

    const key = `${bucket}:${agentId}`;
    const existing = internalRateLimits.get(key);
    const activeState =
      existing && nowMs < existing.resetAtMs
        ? existing
        : { count: 0, resetAtMs: nowMs + windowMs };

    activeState.count += 1;
    internalRateLimits.set(key, activeState);

    if (activeState.count > maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((activeState.resetAtMs - nowMs) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "Rate limit exceeded" });
    }

    next();
  };
}

async function verifyGceBootstrapIdentity(
  req: Request,
  row: VmAgentRow,
): Promise<boolean> {
  const bearerToken = extractBearerToken(req);
  if (!bearerToken) {
    return false;
  }

  const normalizedAudience = config.apiCallbackUrl.replace(/\/+$/, "");
  const audienceCandidates = [normalizedAudience, `${normalizedAudience}/`];

  const ticket = await gceIdentityClient.verifyIdToken({
    idToken: bearerToken,
    audience: audienceCandidates,
  });
  const payload = ticket.getPayload() as GceIdentityPayload | undefined;
  if (!payload) {
    return false;
  }

  if (!config.vmServiceAccountEmail) {
    return false;
  }

  if (payload.email !== config.vmServiceAccountEmail) {
    return false;
  }

  if (payload.email_verified !== true) {
    return false;
  }

  const gceClaim = payload.google?.compute_engine;
  if (!gceClaim) {
    return false;
  }

  if (
    config.gcpProjectId &&
    gceClaim.project_id &&
    gceClaim.project_id !== config.gcpProjectId
  ) {
    return false;
  }

  if (row.vm_name && gceClaim.instance_name !== row.vm_name) {
    return false;
  }

  if (row.vm_zone) {
    const claimZone = normalizeZoneName(gceClaim.zone);
    const expectedZone = normalizeZoneName(row.vm_zone);
    if (!claimZone || claimZone !== expectedZone) {
      return false;
    }
  }

  return true;
}

async function allowBootstrapRequest(
  req: Request,
  row: VmAgentRow,
): Promise<boolean> {
  if (config.sandboxMode === "gce") {
    try {
      return await verifyGceBootstrapIdentity(req, row);
    } catch {
      return false;
    }
  }

  const configuredSecret = config.vmBootstrapSecret;
  const providedSecret = req.header("x-sandbox-bootstrap-secret") || "";
  if (configuredSecret && providedSecret === configuredSecret) {
    return true;
  }

  if (config.sandboxMode === "local") {
    const forwardedFor = req.header("x-forwarded-for") || "";
    const remote = req.socket.remoteAddress || "";
    if (
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1" ||
      forwardedFor.includes("127.0.0.1")
    ) {
      return true;
    }
  }

  return false;
}

async function getAgentVmRow(agentId: string): Promise<VmAgentRow | null> {
  const result = await pool.query<VmAgentRow>(
    `SELECT id, machine_type, desired_vm_state, observed_vm_state,
            vm_token_generation, vm_name, vm_zone, deleted_at
     FROM agents
     WHERE id = $1
     LIMIT 1`,
    [agentId],
  );
  return result.rows[0] || null;
}

interface InternalGoalRow {
  id: string;
  session_id: string;
  goal: string;
  guidance: string;
  output_folder: string;
  deadline_at: Date | null;
  status: string;
  status_reason: string | null;
  report_path: string | null;
  artifact_paths: unknown;
  progress_summary: string | null;
  next_suggested_run_at: Date;
  run_count: number;
  created_at: Date;
  updated_at: Date;
}

async function expirePastDueGoals(agentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_session_goals g
     SET status = 'expired',
         status_reason = 'deadline_passed',
         completed_at = NOW(),
         updated_at = NOW()
     FROM agent_chat_sessions s
     WHERE g.session_id = s.id
       AND s.agent_id = $1
       AND g.status = 'active'
       AND g.deadline_at IS NOT NULL
       AND g.deadline_at <= NOW()`,
    [agentId],
  );
}

function allowsBootstrap(row: VmAgentRow): boolean {
  if (config.sandboxMode === "local") {
    return true;
  }
  return row.desired_vm_state === "running";
}

function allowsVmTokenUse(row: VmAgentRow): boolean {
  if (config.sandboxMode === "local") {
    return true;
  }
  return (
    row.desired_vm_state === "running" && row.observed_vm_state !== "stopped"
  );
}

async function issueVmToken(
  agentId: string,
): Promise<{ token: string; expiresAt: string }> {
  const row = await getAgentVmRow(agentId);
  if (!row) {
    throw new Error("Agent not found");
  }

  const secret = config.vmTokenSecret || config.sessionSecret;
  if (!secret) {
    throw new Error("VM token secret is not configured");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + 55 * 60;
  const payload: VmTokenPayload = {
    agentId,
    generation: row.vm_token_generation || 0,
    iat: nowSec,
    exp,
  };

  return {
    token: signVmToken(payload, secret),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function vmCredentialPayload(token: string, expiresAt: string) {
  const runtimeEnv: Record<string, string | null> = {
    API_CALLBACK_URL: config.apiCallbackUrl || null,
    LITELLM_PROXY_URL: config.litellmProxyUrl || null,
    LITELLM_MODEL_GEMINI: config.litellmModelGemini || null,
    LITELLM_MODEL_SONNET: config.litellmModelSonnet || null,
    LITELLM_MODEL_OPUS: config.litellmModelOpus || null,
    LITELLM_MODEL_GPT: config.litellmModelGpt || null,
    LITELLM_PROXY_API_KEY: config.litellmProxyApiKey || null,
  };

  const allowProviderKeyCompat =
    config.nodeEnv !== "production" &&
    config.sandboxMode === "gce" &&
    config.devGceAllowProviderKeys;

  // Temporary GCE dev fallback for legacy runtime bundles.
  // Disabled by default to keep VM credential payload proxy-only.
  if (allowProviderKeyCompat && config.geminiApiKey) {
    runtimeEnv.GEMINI_API_KEY = config.geminiApiKey;
  }
  if (allowProviderKeyCompat) {
    if (config.awsAccessKeyId) {
      runtimeEnv.AWS_ACCESS_KEY_ID = config.awsAccessKeyId;
    }
    if (config.awsSecretAccessKey) {
      runtimeEnv.AWS_SECRET_ACCESS_KEY = config.awsSecretAccessKey;
    }
    if (config.awsSessionToken) {
      runtimeEnv.AWS_SESSION_TOKEN = config.awsSessionToken;
    }
    if (config.awsRegion) {
      runtimeEnv.AWS_REGION = config.awsRegion;
    }
  }

  return {
    vmToken: token,
    expiresAt,
    runtimeEnv,
    // Backward-compat field for older sandbox runtime bundles.
    providerEnv: runtimeEnv,
  };
}

function validateVmToken(options?: { allowStopped?: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        return res.status(401).json({ error: "Missing VM token" });
      }

      const secret = config.vmTokenSecret || config.sessionSecret;
      if (!secret) {
        return res.status(500).json({ error: "VM token secret missing" });
      }

      const payload = verifyVmToken(token, secret);
      if (!payload) {
        return res.status(401).json({ error: "Invalid VM token" });
      }

      const agentId = getRouteParam(req.params.agentId);
      if (payload.agentId !== agentId) {
        return res.status(401).json({ error: "VM token agent mismatch" });
      }

      const row = await getAgentVmRow(agentId);
      if (!row) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (row.deleted_at) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!options?.allowStopped && !allowsVmTokenUse(row)) {
        return res
          .status(401)
          .json({ error: "VM token not valid for current VM lifecycle state" });
      }

      if ((row.vm_token_generation || 0) !== payload.generation) {
        return res.status(401).json({ error: "VM token generation mismatch" });
      }

      req.vmTokenPayload = payload;
      next();
    } catch (error) {
      next(error);
    }
  };
}

router.post(
  "/agents/:agentId/bootstrap-credentials",
  perAgentRateLimit("bootstrap", 24),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const row = await getAgentVmRow(agentId);
      if (!row) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (row.deleted_at) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!allowsBootstrap(row)) {
        return res
          .status(401)
          .json({ error: "Agent VM lifecycle does not allow bootstrap" });
      }

      if (!(await allowBootstrapRequest(req, row))) {
        return res.status(401).json({ error: "Invalid bootstrap credentials" });
      }

      const issued = await issueVmToken(agentId);
      return res.json(vmCredentialPayload(issued.token, issued.expiresAt));
    } catch (error) {
      console.error("Bootstrap credentials error:", error);
      return res.status(500).json({ error: "Failed to bootstrap credentials" });
    }
  },
);

router.get(
  "/agents/:agentId/runtime-bundle",
  perAgentRateLimit("runtime_bundle", 24),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const row = await getAgentVmRow(agentId);
      if (!row) {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (row.deleted_at) {
        return res.status(404).json({ error: "Agent not found" });
      }

      if (!allowsBootstrap(row)) {
        return res.status(401).json({
          error: "Agent VM lifecycle does not allow runtime bootstrap",
        });
      }

      if (!(await allowBootstrapRequest(req, row))) {
        return res.status(401).json({ error: "Invalid bootstrap credentials" });
      }

      const bundle = await getSandboxRuntimeBundle();
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=sandbox-runtime.tar.gz",
      );
      return res.status(200).send(bundle);
    } catch (error) {
      console.error("Runtime bundle error:", error);
      return res.status(500).json({ error: "Failed to build runtime bundle" });
    }
  },
);

router.post(
  "/agents/:agentId/refresh-credentials",
  perAgentRateLimit("refresh", 120),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const issued = await issueVmToken(agentId);
      return res.json(vmCredentialPayload(issued.token, issued.expiresAt));
    } catch (error) {
      console.error("Refresh credentials error:", error);
      return res.status(500).json({ error: "Failed to refresh credentials" });
    }
  },
);

router.post(
  "/agents/:agentId/vm-ready",
  perAgentRateLimit("vm_ready", 240),
  validateVmToken({ allowStopped: true }),
  async (req: Request, res: Response) => {
    const agentId = getRouteParam(req.params.agentId);
    try {
      wakeTrace("vm_ready.received", { agentId });
      if (config.sandboxMode === "gce") {
        const row = await getAgentVmRow(agentId);
        if (!row || row.deleted_at) {
          wakeTrace("vm_ready.ignored", {
            agentId,
            reason: "missing_agent_row",
          });
          return res.status(202).json({ status: "ignored" });
        }
        const desiredMachineType = row.machine_type || config.gceMachineType;
        const desiredAcceleratorType =
          desiredAcceleratorTypeForMachineType(desiredMachineType);
        const shouldCompareAccelerator =
          !usesBuiltinGpuProfile(desiredMachineType) &&
          Boolean(desiredAcceleratorType);
        const instance = await gce.getInstance(agentId);
        const actualStatus = String(
          instance?.status || "MISSING",
        ).toUpperCase();
        const actualMachineType = actualMachineTypeFromInstance(instance);
        const actualAcceleratorType =
          actualAcceleratorTypeFromInstance(instance);
        const machineProfileMismatch =
          actualStatus !== "MISSING" &&
          (actualMachineType !== desiredMachineType ||
            (shouldCompareAccelerator &&
              actualAcceleratorType !== desiredAcceleratorType));
        if (actualStatus !== "RUNNING" || machineProfileMismatch) {
          wakeTrace("vm_ready.ignored", {
            agentId,
            reason:
              actualStatus !== "RUNNING"
                ? "instance_not_running"
                : "machine_profile_mismatch",
            desiredMachineType,
            actualMachineType,
            desiredAcceleratorType: shouldCompareAccelerator
              ? desiredAcceleratorType
              : null,
            actualAcceleratorType: shouldCompareAccelerator
              ? actualAcceleratorType
              : null,
            actualStatus,
          });
          return res.status(202).json({ status: "ignored" });
        }
      }
      const result = await pool.query(
        `UPDATE agents
         SET observed_vm_state = 'running',
             last_provision_error = NULL,
             last_provision_error_at = NULL,
             reconcile_attempt_count = 0,
             last_activity_at = NOW(),
             startup_started_at = NULL,
             last_reconciled_at = NOW(),
             next_reconcile_at = NOW()
         WHERE id = $1
           AND desired_vm_state = 'running'
           AND deleted_at IS NULL
         RETURNING id`,
        [agentId],
      );

      if (result.rows.length === 0) {
        wakeTrace("vm_ready.ignored", { agentId });
        return res.status(202).json({ status: "ignored" });
      }
      wakeTrace("vm_ready.applied", { agentId });
      return res.status(204).end();
    } catch (error) {
      wakeTrace("vm_ready.error", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("VM ready callback error:", error);
      return res.status(500).json({ error: "Failed to process vm-ready" });
    }
  },
);

router.post(
  "/agents/:agentId/stream-heartbeat",
  perAgentRateLimit("stream_heartbeat", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      await pool.query(
        `UPDATE agents
         SET active_stream_lease_until = GREATEST(
               COALESCE(active_stream_lease_until, NOW()),
               NOW() + ($2::bigint * INTERVAL '1 millisecond')
             ),
             last_activity_at = NOW()
         WHERE id = $1`,
        [agentId, config.sandboxStreamLeaseTtlMs],
      );
      return res.status(204).end();
    } catch (error) {
      console.error("Stream heartbeat error:", error);
      return res.status(500).json({ error: "Failed to refresh stream lease" });
    }
  },
);

router.post(
  "/agents/:agentId/sessions/:sessionId/background-turn/start",
  perAgentRateLimit("goal_background_turn_start", 2_400),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);

      const sessionResult = await pool.query<{ org_id: string }>(
        `SELECT a.org_id
         FROM agent_chat_sessions s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      const sessionRow = sessionResult.rows[0];
      if (!sessionRow) {
        return res.status(404).json({ error: "Session not found" });
      }

      const started = await startBackgroundResumableTurn({
        orgId: sessionRow.org_id,
        agentId,
        sessionId,
      });
      if (!started.ok) {
        if (started.reason === "session_busy") {
          return res.status(409).json({
            error: "Session is already processing a foreground turn",
            turnId: started.turnId || null,
          });
        }
        return res.status(503).json({
          error: "Chat capacity exhausted. Please retry shortly.",
          reason: "chat_capacity_exhausted",
        });
      }

      return res.status(201).json({ turnId: started.turnId });
    } catch (error) {
      console.error("Start background turn stream error:", error);
      return res
        .status(500)
        .json({ error: "Failed to start background turn stream" });
    }
  },
);

router.post(
  "/agents/:agentId/sessions/:sessionId/background-turn/:turnId/event",
  perAgentRateLimit("goal_background_turn_event", 120_000),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);
      const turnId = getRouteParam(req.params.turnId);

      const sessionResult = await pool.query<{ id: string }>(
        `SELECT s.id
         FROM agent_chat_sessions s
         WHERE s.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      const event =
        req.body && typeof req.body === "object"
          ? (req.body as { event?: unknown }).event
          : null;
      if (!event || typeof event !== "object") {
        return res.status(400).json({ error: "event object is required" });
      }
      const eventType = (event as { type?: unknown }).type;
      if (typeof eventType !== "string" || !eventType.trim()) {
        return res.status(400).json({ error: "event.type is required" });
      }

      const appended = await appendBackgroundResumableTurnEvent({
        turnId,
        event: {
          type: eventType,
          data: (event as { data?: unknown }).data,
          source: "goal_background",
        },
      });
      if (!appended.ok) {
        return res.status(404).json({ error: "Background turn not found" });
      }
      return res.status(202).json({ seq: appended.seq });
    } catch (error) {
      console.error("Append background turn event error:", error);
      return res
        .status(500)
        .json({ error: "Failed to append background turn event" });
    }
  },
);

router.post(
  "/agents/:agentId/sessions/:sessionId/background-turn/:turnId/finalize",
  perAgentRateLimit("goal_background_turn_finalize", 2_400),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);
      const turnId = getRouteParam(req.params.turnId);

      const sessionResult = await pool.query<{ id: string }>(
        `SELECT s.id
         FROM agent_chat_sessions s
         WHERE s.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      const statusRaw = String(req.body?.status || "")
        .trim()
        .toLowerCase();
      const status =
        statusRaw === "failed"
          ? "failed"
          : statusRaw === "aborted"
            ? "aborted"
            : "completed";
      const errorMessage =
        typeof req.body?.errorMessage === "string"
          ? req.body.errorMessage.trim() || undefined
          : undefined;

      await finalizeBackgroundResumableTurn({
        turnId,
        status,
        errorMessage,
        content:
          typeof req.body?.content === "string" ? req.body.content : undefined,
        toolCalls: Array.isArray(req.body?.toolCalls) ? req.body.toolCalls : [],
        segments: Array.isArray(req.body?.segments) ? req.body.segments : [],
      });

      return res.status(204).end();
    } catch (error) {
      console.error("Finalize background turn stream error:", error);
      return res
        .status(500)
        .json({ error: "Failed to finalize background turn stream" });
    }
  },
);

router.post(
  "/agents/:agentId/sessions/:sessionId/live-events",
  perAgentRateLimit("goal_live_events", 60_000),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);
      const event =
        req.body && typeof req.body === "object"
          ? (req.body as { event?: unknown }).event
          : null;

      if (!event || typeof event !== "object") {
        return res.status(400).json({ error: "event object is required" });
      }
      const eventType = (event as { type?: unknown }).type;
      if (typeof eventType !== "string" || !eventType.trim()) {
        return res.status(400).json({ error: "event.type is required" });
      }

      const sessionResult = await pool.query<{ id: string }>(
        `SELECT s.id
         FROM agent_chat_sessions s
         WHERE s.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      const delivered = publishSessionLiveEvent(sessionId, event as any);
      return res.status(202).json({ delivered });
    } catch (error) {
      console.error("Publish live event error:", error);
      return res.status(500).json({ error: "Failed to publish live event" });
    }
  },
);

router.post(
  "/agents/:agentId/sessions/:sessionId/messages/append-assistant",
  perAgentRateLimit("goal_append_message", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);

      const sessionResult = await pool.query<{ id: string }>(
        `SELECT s.id
         FROM agent_chat_sessions s
         WHERE s.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }

      const content =
        typeof req.body?.content === "string" ? req.body.content : "";
      const toolCalls = Array.isArray(req.body?.toolCalls)
        ? req.body.toolCalls
        : [];
      const segments = Array.isArray(req.body?.segments)
        ? req.body.segments
        : [];
      const sanitizedContent = sanitizePersistableString(content);
      const sanitizedToolCalls = sanitizePersistableValue(toolCalls);
      const sanitizedSegments = sanitizePersistableValue(segments);
      const combinedStats = combineSanitizeStats(
        sanitizedContent.stats,
        sanitizedToolCalls.stats,
        sanitizedSegments.stats,
      );
      logSanitizedInternalPayload(
        "append_assistant",
        { sessionId, agentId },
        combinedStats,
      );

      const hasContent = sanitizedContent.value.trim().length > 0;
      const hasToolCalls = (sanitizedToolCalls.value as unknown[]).length > 0;
      if (!hasContent && !hasToolCalls) {
        return res.status(204).end();
      }

      await pool.query(
        `INSERT INTO agent_chat_messages (session_id, role, content, tool_calls, segments, sources)
         VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb, '[]'::jsonb)`,
        [
          sessionId,
          sanitizedContent.value,
          JSON.stringify(sanitizedToolCalls.value),
          JSON.stringify(sanitizedSegments.value),
        ],
      );

      await pool.query(
        `UPDATE agent_chat_sessions
         SET updated_at = NOW()
         WHERE id = $1`,
        [sessionId],
      );

      return res.status(201).json({ ok: true });
    } catch (error) {
      console.error("Append assistant message error:", error);
      return res
        .status(500)
        .json({ error: "Failed to append assistant message" });
    }
  },
);

router.get(
  "/agents/:agentId/goals/active",
  perAgentRateLimit("goal_active", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      if (isDeployDraining()) {
        return res.json({ goals: [] });
      }
      await expirePastDueGoals(agentId);
      const result = await pool.query<InternalGoalRow>(
        `SELECT g.id, g.session_id, g.goal, g.guidance, g.output_folder,
                g.deadline_at, g.status, g.status_reason, g.report_path,
                g.artifact_paths, g.progress_summary, g.next_suggested_run_at,
                g.run_count, g.created_at, g.updated_at
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE s.agent_id = $1
           AND g.status = 'active'
         ORDER BY g.updated_at ASC, g.created_at ASC`,
        [agentId],
      );
      return res.json({ goals: result.rows });
    } catch (error) {
      console.error("List active goals error:", error);
      return res.status(500).json({ error: "Failed to list active goals" });
    }
  },
);

router.get(
  "/agents/:agentId/sessions/:sessionId/goal",
  perAgentRateLimit("goal_session_get", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);
      await expirePastDueGoals(agentId);

      const result = await pool.query<InternalGoalRow>(
        `SELECT g.id, g.session_id, g.goal, g.guidance, g.output_folder,
                g.deadline_at, g.status, g.status_reason, g.report_path,
                g.artifact_paths, g.progress_summary, g.next_suggested_run_at,
                g.run_count, g.created_at, g.updated_at
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE s.agent_id = $1
           AND g.session_id = $2
           AND g.status = 'active'
         ORDER BY g.created_at DESC
         LIMIT 1`,
        [agentId, sessionId],
      );

      return res.json({ goal: result.rows[0] || null });
    } catch (error) {
      console.error("Get session goal error:", error);
      return res.status(500).json({ error: "Failed to get session goal" });
    }
  },
);

router.get(
  "/agents/:agentId/sessions/:sessionId/bootstrap",
  perAgentRateLimit("session_bootstrap", 600),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const sessionId = getRouteParam(req.params.sessionId);

      const sessionResult = await pool.query<{
        org_id: string;
        system_prompt: string | null;
      }>(
        `SELECT a.org_id, a.system_prompt
         FROM agent_chat_sessions s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.id = $1
           AND a.id = $2
         LIMIT 1`,
        [sessionId, agentId],
      );
      const sessionRow = sessionResult.rows[0];
      if (!sessionRow) {
        return res.status(404).json({ error: "Session not found" });
      }

      const { org_id: orgId } = sessionRow;

      const skillRows = await withOrgContextQuery<{
        id: string;
        name: string;
        when_to_use: string | null;
        instructions: string | null;
        install_path: string | null;
      }>(
        orgId,
        `SELECT s.id, s.name, s.when_to_use, s.instructions, ags.install_path
         FROM skills s
         JOIN agent_skills ags ON ags.skill_id = s.id
         WHERE ags.agent_id = $1
           AND ags.installed = true
           AND ags.enabled = true
         ORDER BY s.created_at ASC`,
        [agentId],
      );

      const goalResult = await pool.query<{ output_folder: string }>(
        `SELECT g.output_folder
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE g.session_id = $1
           AND s.agent_id = $2
           AND g.status = 'active'
         ORDER BY g.created_at DESC
         LIMIT 1`,
        [sessionId, agentId],
      );

      const outputFolder = goalResult.rows[0]?.output_folder || undefined;

      const skills = await Promise.all(
        skillRows.rows.map(async (row) => {
          const skillMarkdown = await readInstalledSkillMarkdown(
            orgId,
            agentId,
            row.install_path || null,
          );
          return {
            name: row.name,
            whenToUse: row.when_to_use || "",
            instructions: row.instructions || "",
            installPath: row.install_path || null,
            skillMarkdown: skillMarkdown || undefined,
          };
        }),
      );

      const systemPrompt = buildSystemPrompt(
        sessionRow.system_prompt || "",
        skills,
        outputFolder,
      );

      const historyResult = await pool.query<{
        role: string;
        content: string;
      }>(
        `SELECT role, content
         FROM agent_chat_messages
         WHERE session_id = $1
           AND role IN ('user', 'assistant')
         ORDER BY created_at ASC`,
        [sessionId],
      );

      const chatHistory = historyResult.rows.map((row) => ({
        role: row.role,
        content: row.content || "",
      }));

      return res.json({
        systemPrompt,
        chatHistory,
      });
    } catch (error) {
      console.error("Session bootstrap error:", error);
      return res
        .status(500)
        .json({ error: "Failed to bootstrap session context" });
    }
  },
);

router.post(
  "/agents/:agentId/goals/:goalId/runs",
  perAgentRateLimit("goal_run_start", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const goalId = getRouteParam(req.params.goalId);
      if (isDeployDraining()) {
        return res.status(423).json({ error: "Deployment drain is active" });
      }
      await expirePastDueGoals(agentId);

      const runType =
        req.body?.runType === "foreground" ? "foreground" : "background";
      const trigger =
        typeof req.body?.trigger === "string" ? req.body.trigger.trim() : null;

      const goalResult = await pool.query<{
        id: string;
        session_id: string;
        status: string;
      }>(
        `SELECT g.id, g.session_id, g.status
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE g.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [goalId, agentId],
      );
      const goalRow = goalResult.rows[0];
      if (!goalRow) {
        return res.status(404).json({ error: "Goal not found" });
      }
      if (goalRow.status !== "active") {
        return res.status(409).json({ error: "Goal is not active" });
      }

      const runResult = await pool.query<{
        id: string;
        goal_id: string;
        session_id: string;
        run_type: string;
        trigger: string | null;
        status: string;
        started_at: Date;
      }>(
        `INSERT INTO agent_session_goal_runs (
           goal_id, session_id, run_type, trigger, status, started_at, created_at
         )
         VALUES ($1, $2, $3, $4, 'running', NOW(), NOW())
         RETURNING id, goal_id, session_id, run_type, trigger, status, started_at`,
        [goalId, goalRow.session_id, runType, trigger],
      );

      await pool.query(
        `UPDATE agent_session_goals
         SET run_count = run_count + 1,
             last_run_started_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [goalId],
      );

      return res.status(201).json({ run: runResult.rows[0] });
    } catch (error) {
      console.error("Start goal run error:", error);
      return res.status(500).json({ error: "Failed to start goal run" });
    }
  },
);

router.post(
  "/agents/:agentId/goals/:goalId/runs/:runId/end",
  perAgentRateLimit("goal_run_end", 1_200),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const goalId = getRouteParam(req.params.goalId);
      const runId = getRouteParam(req.params.runId);
      const statusRaw = String(req.body?.status || "")
        .trim()
        .toLowerCase();
      const status =
        statusRaw === "aborted"
          ? "aborted"
          : statusRaw === "failed"
            ? "failed"
            : "completed";
      const errorMessage =
        typeof req.body?.errorMessage === "string"
          ? req.body.errorMessage.trim() || null
          : null;

      const runResult = await pool.query<{
        id: string;
      }>(
        `UPDATE agent_session_goal_runs r
         SET status = $1,
             error_message = $2,
             ended_at = NOW()
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE r.id = $3
           AND r.goal_id = g.id
           AND g.id = $4
           AND s.agent_id = $5
         RETURNING r.id`,
        [status, errorMessage, runId, goalId, agentId],
      );
      if (runResult.rows.length === 0) {
        return res.status(404).json({ error: "Goal run not found" });
      }

      await pool.query(
        `UPDATE agent_session_goals
         SET last_run_ended_at = NOW(),
             next_suggested_run_at = CASE
               WHEN status = 'active' THEN NOW()
               ELSE next_suggested_run_at
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [goalId],
      );

      return res.status(204).end();
    } catch (error) {
      console.error("Complete goal run error:", error);
      return res.status(500).json({ error: "Failed to complete goal run" });
    }
  },
);

router.post(
  "/agents/:agentId/goals/:goalId/complete",
  perAgentRateLimit("goal_complete", 2_400),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      const agentId = getRouteParam(req.params.agentId);
      const goalId = getRouteParam(req.params.goalId);

      const goalResult = await pool.query<{
        id: string;
      }>(
        `SELECT g.id
         FROM agent_session_goals g
         JOIN agent_chat_sessions s ON s.id = g.session_id
         WHERE g.id = $1
           AND s.agent_id = $2
         LIMIT 1`,
        [goalId, agentId],
      );
      if (goalResult.rows.length === 0) {
        return res.status(404).json({ error: "Goal not found" });
      }

      const result = await pool.query<InternalGoalRow>(
        `UPDATE agent_session_goals
         SET status_reason = 'completion_requested',
             updated_at = NOW()
         WHERE id = $1
           AND status = 'active'
         RETURNING id, session_id, goal, guidance, output_folder,
                   deadline_at, status, status_reason, report_path,
                   artifact_paths, progress_summary, next_suggested_run_at,
                   run_count, created_at, updated_at`,
        [goalId],
      );
      const updatedGoal =
        result.rows[0] ||
        (
          await pool.query<InternalGoalRow>(
            `SELECT id, session_id, goal, guidance, output_folder,
                    deadline_at, status, status_reason, report_path,
                    artifact_paths, progress_summary, next_suggested_run_at,
                    run_count, created_at, updated_at
             FROM agent_session_goals
             WHERE id = $1
             LIMIT 1`,
            [goalId],
          )
        ).rows[0] ||
        null;
      return res.json({ goal: updatedGoal });
    } catch (error) {
      console.error("Complete goal error:", error);
      return res.status(500).json({ error: "Failed to complete goal" });
    }
  },
);

router.post(
  "/agents/:agentId/brave/search",
  perAgentRateLimit("brave_search", 60),
  validateVmToken(),
  async (req: Request, res: Response) => {
    try {
      if (!isWebSearchConfigured()) {
        return res.status(503).json({
          error: "Web search is not configured. BRAVE_API_KEY is missing.",
        });
      }

      const result = await performWebSearch({
        query: String(req.body?.query || ""),
        count: Number(req.body?.count),
        country:
          typeof req.body?.country === "string" ? req.body.country : undefined,
        searchLang:
          typeof req.body?.search_lang === "string"
            ? req.body.search_lang
            : undefined,
        uiLang:
          typeof req.body?.ui_lang === "string" ? req.body.ui_lang : undefined,
        freshness:
          typeof req.body?.freshness === "string"
            ? req.body.freshness
            : undefined,
      });
      return res.json(result);
    } catch (error) {
      console.error("Brave proxy error:", error);
      const message =
        error instanceof Error ? error.message : "Failed to search web";
      return res
        .status(500)
        .json({ error: `Failed to search web: ${message}` });
    }
  },
);

export const _testOnly = {
  vmCredentialPayload,
};

export default router;
