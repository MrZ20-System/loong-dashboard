import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "REPOSITORY_NOT_FOUND",
  "REPOSITORY_ONBOARDING_NOT_FOUND",
  "REPOSITORY_ONBOARDING_CONFLICT",
  "REPOSITORY_ONBOARDING_FAILED",
  "DOMAIN_NOT_FOUND",
  "DOMAIN_VERSION_NOT_FOUND",
  "DOMAIN_NAME_CONFLICT",
  "PULL_REQUEST_NOT_FOUND",
  "FILE_NOT_FOUND",
  "AGENT_SESSION_NOT_FOUND",
  "AGENT_TURN_BUSY",
  "AGENT_INTERACTION_UNAVAILABLE",
  "WORKSPACE_BUSY",
  "WORKSPACE_REVISION_MISMATCH",
  "WORKTREE_POOL_EXHAUSTED",
  "ISSUE_NOT_FOUND",
  "KNOWLEDGE_DOCUMENT_NOT_FOUND",
  "KNOWLEDGE_DOCUMENT_CONFLICT",
  "KNOWLEDGE_VERSION_NOT_FOUND",
  "SCHEDULED_TASK_NOT_FOUND",
  "SCHEDULED_TASK_WORKSPACE_BUSY",
  "SYNC_ALREADY_RUNNING",
  "HISTORY_PAUSED",
  "SYNC_RUN_NOT_FOUND",
  "MAINTENANCE_RUN_NOT_FOUND",
  "SYNC_FAILED",
  "AUTH_REQUIRED",
  "AUTH_INVALID_PASSWORD",
  "AUTH_RATE_LIMITED",
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
