import { z } from "zod";

const oidcSuccessCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const oidcErrorCallbackQuerySchema = z.object({
  error: z.string().min(1),
  state: z.string().min(1).optional(),
  error_description: z.string().optional(),
});

export const oidcCallbackQuerySchema = z.union([
  oidcSuccessCallbackQuerySchema,
  oidcErrorCallbackQuerySchema,
]);

export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;

export const magicLinkRequestBodySchema = z.object({
  email: z.string().trim().email(),
});

export const magicLinkVerifyQuerySchema = z.object({
  token: z.string().min(1),
});

export const magicLinkVerifyBodySchema = z.object({
  token: z.string().min(1),
});
