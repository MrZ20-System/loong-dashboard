import { z } from "zod";

import { repositoryIdSchema, utcDateTimeSchema } from "./validation.js";

/** Durable onboarding state. A ready job may still be waiting for metadata credentials. */
export const repositoryOnboardingStatusSchema = z.enum([
  "queued",
  "validating",
  "cloning",
  "registering",
  "initializing",
  "syncing",
  "ready",
  "failed",
  "cancelled",
]);

/** User supplied fields accepted by POST /api/repositories. */
export const repositoryOnboardingCreateSchema = z
  .object({
    /** https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo. */
    url: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(200).optional(),
    key: z.string().trim().min(1).max(128).optional(),
    remote: z.string().trim().min(1).max(128).optional(),
    defaultBranch: z.string().trim().min(1).max(255).optional(),
    worktreeSlots: z.number().int().min(1).max(16).optional(),
  })
  .strict();

/** Sanitized and normalized input persisted with an onboarding job. */
export const repositoryOnboardingInputSchema = z
  .object({
    github: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
    cloneUrl: z.string().url(),
    key: repositoryIdSchema,
    displayName: z.string().trim().min(1),
    remoteName: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1),
    targetPath: z.string().trim().min(1),
    worktreeSlots: z.number().int().min(1).max(16),
  })
  .strict();

export const repositoryOnboardingErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const repositoryOnboardingAcceptedSchema = z
  .object({
    jobId: z.string().trim().min(1),
    /** A job is durable before the HTTP request completes. */
    status: z.union([z.literal("queued"), z.literal("accepted")]),
  })
  .strict();

export const repositoryOnboardingSchema = z
  .object({
    jobId: z.string().trim().min(1),
    status: repositoryOnboardingStatusSchema,
    /** Stable machine-readable phase, equal to status for the current flow. */
    step: repositoryOnboardingStatusSchema,
    detail: z.string().trim().min(1),
    progress: z.number().int().min(0).max(100),
    repositoryId: repositoryIdSchema.nullable(),
    /** True when source code is ready but the first GitHub metadata sync awaits credentials. */
    githubMetadataPending: z.boolean(),
    input: repositoryOnboardingInputSchema,
    error: repositoryOnboardingErrorSchema.nullable(),
    createdAt: utcDateTimeSchema,
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const repositoryOnboardingParamsSchema = z
  .object({ jobId: z.string().trim().min(1) })
  .strict();

export type RepositoryOnboardingStatus = z.infer<
  typeof repositoryOnboardingStatusSchema
>;
export type RepositoryOnboardingCreate = z.infer<
  typeof repositoryOnboardingCreateSchema
>;
export type RepositoryOnboardingInput = z.infer<
  typeof repositoryOnboardingInputSchema
>;
export type RepositoryOnboardingError = z.infer<
  typeof repositoryOnboardingErrorSchema
>;
export type RepositoryOnboardingAccepted = z.infer<
  typeof repositoryOnboardingAcceptedSchema
>;
export type RepositoryOnboarding = z.infer<typeof repositoryOnboardingSchema>;
export type RepositoryOnboardingParams = z.infer<
  typeof repositoryOnboardingParamsSchema
>;
