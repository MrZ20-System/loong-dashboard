import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "REPOSITORY_NOT_FOUND",
  "SYNC_ALREADY_RUNNING",
  "SYNC_FAILED",
  "INTERNAL_ERROR",
]);

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
