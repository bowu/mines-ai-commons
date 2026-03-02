import type { NextFunction, Request, Response } from "express";
import { withOrgContextQuery } from "../../db/index.js";
import { AppError } from "../../lib/errors.js";
import { requireAuthContext } from "../../middleware/auth.js";

export type AgentRole = "owner" | "editor" | "viewer";
export type AccessDecision = "allowed" | "forbidden" | "not_found";

const roleRank: Record<AgentRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

function hasRequiredRole(
  assignedRole: AgentRole | null,
  requiredRole: AgentRole,
): boolean {
  if (!assignedRole) return false;
  return roleRank[assignedRole] >= roleRank[requiredRole];
}

function resolveAgentId(req: Request): string | null {
  const id = req.params.id ?? req.params.agentId;
  return Array.isArray(id) ? (id[0] ?? null) : (id ?? null);
}

export async function checkAgentAccess(
  orgId: string,
  agentId: string,
  userId: string,
  requiredRole: AgentRole,
): Promise<AccessDecision> {
  const accessResult = await withOrgContextQuery<{ role: AgentRole | null }>(
    orgId,
    `SELECT role
     FROM agent_access
     WHERE agent_id = $1
       AND user_id = $2
     LIMIT 1`,
    [agentId, userId],
  );

  const accessRow = accessResult.rows[0];
  if (!accessRow) {
    return "forbidden";
  }

  const agentResult = await withOrgContextQuery<{ deleted_at: Date | null }>(
    orgId,
    `SELECT deleted_at
     FROM agents
     WHERE id = $1
     LIMIT 1`,
    [agentId],
  );

  const agentRow = agentResult.rows[0];
  if (!agentRow || agentRow.deleted_at) {
    return "not_found";
  }

  return hasRequiredRole(accessRow.role ?? null, requiredRole)
    ? "allowed"
    : "forbidden";
}

export async function checkSessionAccess(
  orgId: string,
  sessionId: string,
  userId: string,
  requiredRole: AgentRole,
): Promise<AccessDecision> {
  const result = await withOrgContextQuery<{
    role: AgentRole | null;
    deleted_at: Date | null;
  }>(
    orgId,
    `SELECT aa.role, a.deleted_at
     FROM agent_chat_sessions s
     LEFT JOIN agents a ON a.id = s.agent_id
     LEFT JOIN agent_access aa
       ON aa.agent_id = s.agent_id
      AND aa.user_id = $2
     WHERE s.id = $1
     LIMIT 1`,
    [sessionId, userId],
  );

  const row = result.rows[0];
  if (!row) {
    return "forbidden";
  }
  if (!row.role) {
    return "forbidden";
  }
  if (row.deleted_at) {
    return "not_found";
  }

  return hasRequiredRole(row.role, requiredRole) ? "allowed" : "forbidden";
}

export function requireAgentAccess(requiredRole: AgentRole) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const agentId = resolveAgentId(req);
      if (!agentId) {
        return res.status(400).json({ error: "Agent ID is required" });
      }

      const decision = await checkAgentAccess(
        orgId,
        agentId,
        user.id,
        requiredRole,
      );

      if (decision === "not_found") {
        return res.status(404).json({ error: "Agent not found" });
      }
      if (decision !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function grantAgentAccess(
  orgId: string,
  agentId: string,
  userId: string,
  role: AgentRole,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `INSERT INTO agent_access (agent_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [agentId, userId, role],
  );
}

export async function revokeAgentAccess(
  orgId: string,
  agentId: string,
  userId: string,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `DELETE FROM agent_access
     WHERE agent_id = $1
       AND user_id = $2`,
    [agentId, userId],
  );
}

export function assertAgentRole(value: string): AgentRole {
  if (value === "owner" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new AppError("Invalid role", 400, "INVALID_ROLE");
}
