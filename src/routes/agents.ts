import { type Request, type Response, Router } from "express";
import { config } from "../config.js";
import { withOrgContextQuery } from "../db/index.js";
import { requireAuthContext } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { grantAgentAccess, requireAgentAccess } from "../services/auth/acl.js";
import { invalidateSession } from "../services/pi-agent/session.js";
import {
  getSupportedAgentMachineTypes,
  isSupportedAgentMachineType,
} from "../services/sandbox/machine-types.js";
import {
  type SkillRecord,
  installSkillPackage,
  uninstallSkillPackage,
} from "../services/skills/packages.js";
import {
  agentIdParamsSchema,
  agentSkillParamsSchema,
  createAgentBodySchema,
  markAgentsNeedsUpgradeBodySchema,
  removeShareParamsSchema,
  shareAgentBodySchema,
  toggleAgentSkillBodySchema,
  updateAgentBodySchema,
} from "./schemas/agents.schema.js";

const router = Router();

const createAgentRateLimit = createRateLimit({
  bucket: "agent_create",
  maxRequests: config.agentCreateRateLimitMax,
  windowMs: config.agentCreateRateLimitWindowMs,
  key: (req) => {
    const { user } = requireAuthContext(req);
    return user.id;
  },
});

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function withComputedVmStatus<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    vm_status:
      typeof row.observed_vm_state === "string"
        ? row.observed_vm_state
        : "stopped",
  };
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "superadmin";
}

// List all visible agents (user-scoped)
router.get("/", async (req: Request, res: Response) => {
  try {
    const { orgId, user } = requireAuthContext(req);
    const result = await withOrgContextQuery(
      orgId,
      `SELECT a.*, aa.role AS access_role
       FROM agents a
       JOIN agent_access aa ON aa.agent_id = a.id
       WHERE aa.user_id = $1
         AND a.deleted_at IS NULL
       ORDER BY COALESCE(a.last_user_message_at, a.created_at) DESC,
                a.created_at DESC`,
      [user.id],
    );
    res.json({ agents: result.rows.map((row) => withComputedVmStatus(row)) });
  } catch (error) {
    console.error("List agents error:", error);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

router.post(
  "/runtime/upgrade",
  validate({ body: markAgentsNeedsUpgradeBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      if (!isAdminRole(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const requestedOrgId = req.body.orgId as string | undefined;
      const targetOrgId = requestedOrgId || orgId;
      if (
        requestedOrgId &&
        user.role !== "superadmin" &&
        requestedOrgId !== orgId
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const requestedAgentIds = Array.isArray(req.body.agentIds)
        ? (req.body.agentIds as string[])
        : [];

      const params: unknown[] = [targetOrgId];
      let filterSql = "";
      if (requestedAgentIds.length > 0) {
        params.push(requestedAgentIds);
        filterSql = `AND id = ANY($2::uuid[])`;
      }

      const result = await withOrgContextQuery<{ id: string }>(
        targetOrgId,
        `UPDATE agents
         SET needs_upgrade = true,
             next_reconcile_at = NOW()
         WHERE org_id = $1
           AND deleted_at IS NULL
           ${filterSql}
         RETURNING id`,
        params,
      );

      return res.json({
        updatedCount: result.rows.length,
        agentIds: result.rows.map((row) => row.id),
      });
    } catch (error) {
      console.error("Runtime upgrade mark error:", error);
      return res
        .status(500)
        .json({ error: "Failed to mark agents for upgrade" });
    }
  },
);

// Get single agent with its skills
router.get(
  "/:id",
  requireAgentAccess("viewer"),
  validate({ params: agentIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const agentResult = await withOrgContextQuery(
        orgId,
        `SELECT a.*, aa.role AS access_role
         FROM agents a
         JOIN agent_access aa
           ON aa.agent_id = a.id
          AND aa.user_id = $2
         WHERE a.id = $1
           AND a.deleted_at IS NULL
         LIMIT 1`,
        [agentId, user.id],
      );

      if (agentResult.rows.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const skillsResult = await withOrgContextQuery(
        orgId,
        `SELECT
           s.id,
           s.name,
           s.description,
           s.when_to_use,
           s.instructions,
           s.tool_type,
           s.created_at,
           s.updated_at,
           COALESCE(ags.enabled, false) AS enabled,
           COALESCE(ags.installed, false) AS installed,
           ags.install_path
         FROM skills s
         LEFT JOIN agent_skills ags
           ON ags.skill_id = s.id
          AND ags.agent_id = $1
         ORDER BY s.created_at ASC`,
        [agentId],
      );

      res.json({
        agent: withComputedVmStatus(agentResult.rows[0]),
        skills: skillsResult.rows,
      });
    } catch (error) {
      console.error("Get agent error:", error);
      res.status(500).json({ error: "Failed to get agent" });
    }
  },
);

// Create agent and auto-assign owner access
router.post(
  "/",
  createAgentRateLimit,
  validate({ body: createAgentBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const { name, description, icon, system_prompt } = req.body;
      const defaultResearchPrompt =
        "You are a research assistant for Colorado School of Mines. Help faculty and students with research, grants, courses, and collaboration. Be thorough, cite sources, and suggest follow-up questions.";

      const created = await withOrgContextQuery(
        orgId,
        `INSERT INTO agents (
           org_id,
           name,
           description,
           icon,
           system_prompt,
           machine_type,
           desired_vm_state,
           observed_vm_state
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'stopped', 'stopped')
         RETURNING *`,
        [
          orgId,
          name,
          description || "",
          icon || "🔬",
          system_prompt || defaultResearchPrompt,
          config.gceMachineType,
        ],
      );

      const agent = created.rows[0];
      if (!agent) {
        throw new Error("Failed to create agent");
      }

      await grantAgentAccess(orgId, agent.id as string, user.id, "owner");

      res.status(201).json({
        agent: withComputedVmStatus({
          ...agent,
          access_role: "owner",
        }),
      });
    } catch (error) {
      console.error("Create agent error:", error);
      res.status(500).json({ error: "Failed to create agent" });
    }
  },
);

// Update agent
router.put(
  "/:id",
  requireAgentAccess("owner"),
  validate({ params: agentIdParamsSchema, body: updateAgentBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const {
        name,
        description,
        icon,
        system_prompt,
        machine_type,
        confirm_upgrade_risk,
      } = req.body;
      if (
        machine_type !== undefined &&
        !isSupportedAgentMachineType(machine_type)
      ) {
        return res.status(400).json({
          error: "Unsupported machine type",
          supported_machine_types: getSupportedAgentMachineTypes(),
        });
      }
      const hasMachineMutation = machine_type !== undefined;
      if (hasMachineMutation) {
        const riskResult = await withOrgContextQuery<{
          upgrade_risk_detected: boolean;
          upgrade_risk_message: string | null;
        }>(
          orgId,
          `SELECT upgrade_risk_detected, upgrade_risk_message
           FROM agents
           WHERE id = $1
             AND deleted_at IS NULL
           LIMIT 1`,
          [agentId],
        );
        if (riskResult.rows.length === 0) {
          return res.status(404).json({ error: "Agent not found" });
        }
        const riskRow = riskResult.rows[0];
        if (riskRow?.upgrade_risk_detected && confirm_upgrade_risk !== true) {
          return res.status(409).json({
            error:
              "This agent has system-level package installs. Confirm to continue with VM reconfiguration.",
            code: "upgrade_risk_confirmation_required",
            upgrade_risk_message: riskRow.upgrade_risk_message,
          });
        }
      }
      const result = await withOrgContextQuery(
        orgId,
        `UPDATE agents SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         icon = COALESCE($3, icon),
         system_prompt = COALESCE($4, system_prompt),
         machine_type = COALESCE($5, machine_type),
         observed_vm_state = CASE
           WHEN $5 IS NOT NULL
             THEN 'starting'
           ELSE observed_vm_state
         END,
         desired_vm_state = CASE
           WHEN $5 IS NOT NULL
             THEN 'running'
           ELSE desired_vm_state
         END,
         next_reconcile_at = CASE
           WHEN $5 IS NOT NULL
             THEN NOW()
           ELSE next_reconcile_at
         END,
         last_activity_at = CASE
           WHEN $5 IS NOT NULL
             THEN NOW()
           ELSE last_activity_at
         END
       WHERE id = $6
         AND deleted_at IS NULL
       RETURNING *`,
        [name, description, icon, system_prompt, machine_type, agentId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }
      invalidateSession(orgId, agentId);
      res.json({
        agent: withComputedVmStatus({
          ...result.rows[0],
          access_role: "owner",
        }),
      });
    } catch (error) {
      console.error("Update agent error:", error);
      res.status(500).json({ error: "Failed to update agent" });
    }
  },
);

// Delete agent
router.delete(
  "/:id",
  requireAgentAccess("owner"),
  validate({ params: agentIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const existing = await withOrgContextQuery(
        orgId,
        `SELECT id
         FROM agents
         WHERE id = $1
         LIMIT 1`,
        [agentId],
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }

      await withOrgContextQuery(
        orgId,
        `UPDATE agents
         SET observed_vm_state = 'stopped',
             desired_vm_state = 'stopped',
             deleted_at = NOW(),
             next_reconcile_at = NOW(),
             vm_token_generation = vm_token_generation + 1
         WHERE id = $1`,
        [agentId],
      );
      return res.status(204).end();
    } catch (error) {
      console.error("Delete agent error:", error);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  },
);

// Toggle skill for an agent
router.put(
  "/:id/skills/:skillId",
  requireAgentAccess("owner"),
  validate({
    params: agentSkillParamsSchema,
    body: toggleAgentSkillBodySchema,
  }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const skillId = getRouteParam(req.params.skillId);
      const { enabled } = req.body;
      const nextEnabled = enabled !== false;

      if (nextEnabled) {
        const statusResult = await withOrgContextQuery(
          orgId,
          `SELECT installed
           FROM agent_skills
           WHERE agent_id = $1 AND skill_id = $2`,
          [agentId, skillId],
        );
        if (!statusResult.rows[0]?.installed) {
          return res
            .status(400)
            .json({ error: "Skill must be installed before enabling" });
        }
      }

      await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_skills (agent_id, skill_id, enabled, installed, install_path, installed_at)
         VALUES ($1, $2, $3, false, NULL, NULL)
         ON CONFLICT (agent_id, skill_id) DO UPDATE SET enabled = $3`,
        [agentId, skillId, nextEnabled],
      );
      invalidateSession(orgId, agentId);
      res.json({
        agentId,
        skillId,
        enabled: nextEnabled,
      });
    } catch (error) {
      console.error("Toggle skill error:", error);
      res.status(500).json({ error: "Failed to toggle skill" });
    }
  },
);

// Install a skill package for an agent
router.post(
  "/:id/skills/:skillId/install",
  requireAgentAccess("owner"),
  validate({ params: agentSkillParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const skillId = getRouteParam(req.params.skillId);

      const skillResult = await withOrgContextQuery(
        orgId,
        "SELECT * FROM skills WHERE id = $1",
        [skillId],
      );
      if (skillResult.rows.length === 0) {
        return res.status(404).json({ error: "Skill not found" });
      }
      const skill = skillResult.rows[0] as SkillRecord;

      const associationResult = await withOrgContextQuery(
        orgId,
        `SELECT install_path
         FROM agent_skills
         WHERE agent_id = $1 AND skill_id = $2`,
        [agentId, skillId],
      );
      const oldInstallPath = associationResult.rows[0]?.install_path as
        | string
        | null
        | undefined;
      if (oldInstallPath) {
        await uninstallSkillPackage(orgId, agentId, oldInstallPath);
      }

      const { installPath } = await installSkillPackage(orgId, agentId, skill);

      await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_skills (agent_id, skill_id, enabled, installed, install_path, installed_at)
         VALUES ($1, $2, true, true, $3, NOW())
         ON CONFLICT (agent_id, skill_id)
         DO UPDATE SET enabled = true, installed = true, install_path = $3, installed_at = NOW()`,
        [agentId, skillId, installPath],
      );

      invalidateSession(orgId, agentId);
      res.json({
        agentId,
        skillId,
        installed: true,
        enabled: true,
        installPath,
      });
    } catch (error) {
      console.error("Install skill error:", error);
      res.status(500).json({ error: "Failed to install skill" });
    }
  },
);

// Uninstall a skill package for an agent
router.post(
  "/:id/skills/:skillId/uninstall",
  requireAgentAccess("owner"),
  validate({ params: agentSkillParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const skillId = getRouteParam(req.params.skillId);

      const associationResult = await withOrgContextQuery(
        orgId,
        `SELECT install_path
         FROM agent_skills
         WHERE agent_id = $1 AND skill_id = $2`,
        [agentId, skillId],
      );
      const installPath = associationResult.rows[0]?.install_path as
        | string
        | null
        | undefined;
      if (installPath) {
        await uninstallSkillPackage(orgId, agentId, installPath);
      }

      await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_skills (agent_id, skill_id, enabled, installed, install_path, installed_at)
         VALUES ($1, $2, false, false, NULL, NULL)
         ON CONFLICT (agent_id, skill_id)
         DO UPDATE SET enabled = false, installed = false, install_path = NULL, installed_at = NULL`,
        [agentId, skillId],
      );

      invalidateSession(orgId, agentId);
      res.json({ agentId, skillId, installed: false, enabled: false });
    } catch (error) {
      console.error("Uninstall skill error:", error);
      res.status(500).json({ error: "Failed to uninstall skill" });
    }
  },
);

router.get(
  "/:id/access",
  requireAgentAccess("owner"),
  validate({ params: agentIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);

      const result = await withOrgContextQuery(
        orgId,
        `SELECT aa.user_id, aa.role, u.email, u.name
         FROM agent_access aa
         JOIN users u ON u.id = aa.user_id
         WHERE aa.agent_id = $1
         ORDER BY
           CASE aa.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
           LOWER(u.email) ASC`,
        [agentId],
      );

      res.json({ access: result.rows });
    } catch (error) {
      console.error("List agent access error:", error);
      res.status(500).json({ error: "Failed to list agent access" });
    }
  },
);

router.post(
  "/:id/share",
  requireAgentAccess("owner"),
  validate({ params: agentIdParamsSchema, body: shareAgentBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const email = (req.body.email as string).trim().toLowerCase();
      const role = req.body.role;

      const userResult = await withOrgContextQuery<{ id: string }>(
        orgId,
        `SELECT id
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [email],
      );

      const targetUserId = userResult.rows[0]?.id;
      if (!targetUserId) {
        return res
          .status(404)
          .json({ error: "User not found in organization" });
      }

      await grantAgentAccess(orgId, agentId, targetUserId, role);
      res.json({ ok: true });
    } catch (error) {
      console.error("Share agent error:", error);
      res.status(500).json({ error: "Failed to share agent" });
    }
  },
);

router.delete(
  "/:id/share/:userId",
  requireAgentAccess("owner"),
  validate({ params: removeShareParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.id);
      const targetUserId = getRouteParam(req.params.userId);

      const result = await withOrgContextQuery<{
        owner_count: number;
        target_exists: boolean;
        target_is_owner: boolean;
        deleted: boolean;
      }>(
        orgId,
        `WITH locked AS (
           SELECT user_id, role
           FROM agent_access
           WHERE agent_id = $1
           FOR UPDATE
         ),
         owner_count AS (
           SELECT COUNT(*)::int AS count
           FROM locked
           WHERE role = 'owner'
         ),
         target AS (
           SELECT role
           FROM locked
           WHERE user_id = $2
           LIMIT 1
         ),
         deleted AS (
           DELETE FROM agent_access
           WHERE agent_id = $1
             AND user_id = $2
             AND NOT (
               (SELECT count FROM owner_count) <= 1
               AND EXISTS (SELECT 1 FROM target WHERE role = 'owner')
             )
           RETURNING user_id
         )
         SELECT
           COALESCE((SELECT count FROM owner_count), 0) AS owner_count,
           EXISTS(SELECT 1 FROM target) AS target_exists,
           EXISTS(SELECT 1 FROM target WHERE role = 'owner') AS target_is_owner,
           EXISTS(SELECT 1 FROM deleted) AS deleted`,
        [agentId, targetUserId],
      );

      const row = result.rows[0];
      if (!row?.target_exists) {
        return res.status(404).json({ error: "Access entry not found" });
      }

      if (!row.deleted && row.target_is_owner && row.owner_count <= 1) {
        return res.status(409).json({ error: "Cannot remove the last owner" });
      }

      if (!row.deleted) {
        return res.status(404).json({ error: "Access entry not found" });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("Revoke agent access error:", error);
      res.status(500).json({ error: "Failed to revoke access" });
    }
  },
);

export default router;
