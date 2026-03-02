import { z } from "zod";

export const agentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const agentSkillParamsSchema = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
});

export const createAgentBodySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  system_prompt: z.string().optional(),
});

export const updateAgentBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    system_prompt: z.string().optional(),
    machine_type: z.string().trim().min(1).optional(),
    confirm_upgrade_risk: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.icon !== undefined ||
      value.system_prompt !== undefined ||
      value.machine_type !== undefined,
    {
      message: "At least one field must be provided",
    },
  );

export const toggleAgentSkillBodySchema = z.object({
  enabled: z.boolean().optional(),
});

export const shareAgentBodySchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["owner", "editor", "viewer"]),
});

export const markAgentsNeedsUpgradeBodySchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  orgId: z.string().uuid().optional(),
});

export const removeShareParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
