import { z } from "zod";

const agentModelSchema = z.enum([
  "gemini-3.1-pro",
  "sonnet-4.6",
  "opus-4.6",
  "gpt-5.2",
]);

export const chatAgentParamsSchema = z.object({
  agentId: z.string().uuid(),
});

export const sendMessageBodySchema = z.object({
  message: z.string().trim().min(1),
  sessionId: z.string().uuid().optional(),
  outputFolder: z.string().trim().min(1).optional().nullable(),
  model: agentModelSchema.optional(),
});

// Session CRUD schemas
export const listSessionsParamsSchema = z.object({
  agentId: z.string().uuid(),
});

export const createSessionBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  model: agentModelSchema.optional(),
});

export const sessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

export const sessionTurnParamsSchema = z.object({
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
});

export const updateSessionBodySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    model: agentModelSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.model !== undefined, {
    message: "At least one field is required",
  });

export const upsertGoalBodySchema = z.object({
  goal: z.string().trim().min(1),
  guidance: z.string().trim().optional().nullable(),
  deadlineAt: z.string().trim().optional().nullable(),
  // Empty string represents workspace root.
  outputFolder: z.string().trim(),
});
