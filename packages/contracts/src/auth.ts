import { z } from "zod";

/** The only authentication projection safe to return to the browser. */
export const authStatusSchema = z
  .object({
    enabled: z.boolean(),
    unlocked: z.boolean(),
  })
  .strict();

export const authUnlockRequestSchema = z
  .object({
    password: z.string().min(1).max(1024),
  })
  .strict();

/** A password is never persisted or echoed; this schema only validates input. */
export const authPasswordUpdateSchema = z
  .object({
    password: z.string().min(1).max(1024),
    currentPassword: z.string().min(1).max(1024).optional(),
  })
  .strict();

export type AuthStatus = z.infer<typeof authStatusSchema>;
export type AuthUnlockRequest = z.infer<typeof authUnlockRequestSchema>;
export type AuthPasswordUpdate = z.infer<typeof authPasswordUpdateSchema>;
