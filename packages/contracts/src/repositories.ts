import { z } from "zod";

import { repositoryIdSchema, syncStatusSchema, utcDateTimeSchema } from "./validation.js";

/** Path parameters shared by all repository-scoped endpoints. */
export const repositoryParamsSchema = z
  .object({
    id: repositoryIdSchema,
  })
  .strict();

export type RepositoryParams = z.infer<typeof repositoryParamsSchema>;

/** The small repository projection used by selectors and navigation. */
export const repositorySummarySchema = z
  .object({
    id: repositoryIdSchema,
    key: repositoryIdSchema,
    displayName: z.string().trim().min(1),
    githubOwner: z.string().trim().min(1),
    githubName: z.string().trim().min(1),
    localPath: z.string().trim().min(1),
    remoteName: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1),
    worktreeSlots: z.number().int().nonnegative(),
    enabled: z.boolean(),
  })
  .strict()
  .refine((repository) => repository.id === repository.key, {
    message: "Repository id must match key",
    path: ["key"],
  });

export const repositoriesResponseSchema = z
  .object({
    items: z.array(repositorySummarySchema),
  })
  .strict();

export const syncStreamStateSchema = z
  .object({
    entityKind: z.enum(["pull_request", "issue"]),
    status: syncStatusSchema,
    watermarkUpdatedAt: utcDateTimeSchema.nullable(),
    lastAttemptAt: utcDateTimeSchema.nullable(),
    lastSuccessAt: utcDateTimeSchema.nullable(),
    lastError: z.string().nullable(),
    rateLimitRemaining: z.number().int().nonnegative().nullable(),
    rateLimitResetAt: utcDateTimeSchema.nullable(),
  })
  .strict();

export const syncAcceptedResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    syncRunId: z.string().trim().min(1),
    status: z.literal("accepted"),
  })
  .strict();

export const syncStatusResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    status: syncStatusSchema,
    pullRequests: syncStreamStateSchema,
    issues: syncStreamStateSchema,
  })
  .strict();

export type RepositorySummary = z.infer<typeof repositorySummarySchema>;
export type RepositoriesResponse = z.infer<typeof repositoriesResponseSchema>;
export type SyncStreamState = z.infer<typeof syncStreamStateSchema>;
export type SyncAcceptedResponse = z.infer<typeof syncAcceptedResponseSchema>;
export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;
