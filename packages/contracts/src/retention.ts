import { z } from "zod";

import { calendarDateSchema, repositoryIdSchema, utcDateTimeSchema } from "./validation.js";

/** The three read projections exposed by PR and Issue lists. */
export const archiveFilterSchema = z.enum(["current", "archived", "all"]);

/** Terminal metadata scopes that can be selected by a maintenance run. */
export const archiveScopeSchema = z.enum([
  "merged_prs",
  "closed_prs",
  "closed_issues",
]);

export const repositoryRetentionSettingsSchema = z
  .object({
    automaticArchiveEnabled: z.boolean(),
    archiveAfterDays: z.number().int().positive().max(3650),
    includeMergedPrs: z.boolean(),
    includeClosedPrs: z.boolean(),
    includeClosedIssues: z.boolean(),
    prunePayloadWhenArchived: z.boolean(),
  })
  .strict();

export const repositoryRetentionSettingsUpdateSchema = z
  .object({
    automaticArchiveEnabled: z.boolean().optional(),
    archiveAfterDays: z.number().int().positive().max(3650).optional(),
    includeMergedPrs: z.boolean().optional(),
    includeClosedPrs: z.boolean().optional(),
    includeClosedIssues: z.boolean().optional(),
    prunePayloadWhenArchived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one retention setting must be provided",
  });

export const archivePreviewRequestSchema = z
  .object({
    /** A user-entered local calendar date; the Server applies its timezone. */
    date: calendarDateSchema,
    includeMergedPrs: z.boolean().default(true),
    includeClosedPrs: z.boolean().default(true),
    includeClosedIssues: z.boolean().default(true),
  })
  .strict();

export const archiveRunCreateSchema = archivePreviewRequestSchema
  .extend({
    /** Keep terminal metadata while optionally clearing heavy cached payloads. */
    prune: z.boolean().default(true),
  })
  .strict();

export const archivePreviewResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    date: calendarDateSchema,
    calendarTimeZone: z.string().trim().min(1),
    /** UTC start of the selected local day. */
    cutoff: utcDateTimeSchema,
    scopes: z.array(archiveScopeSchema),
    mergedPrCount: z.number().int().nonnegative(),
    closedPrCount: z.number().int().nonnegative(),
    closedIssueCount: z.number().int().nonnegative(),
    prFileRows: z.number().int().nonnegative(),
    issueCommentRows: z.number().int().nonnegative(),
    prPayloadCount: z.number().int().nonnegative(),
    issuePayloadCount: z.number().int().nonnegative(),
  })
  .strict();

export const maintenanceRunKindSchema = z.enum([
  "archive",
  "prune",
  "purge_runtime_history",
  "optimize",
]);

export const maintenanceRunTriggerSchema = z.enum(["manual", "automatic"]);
export const maintenanceRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const maintenanceRunSchema = z
  .object({
    id: z.string().trim().min(1),
    repositoryId: repositoryIdSchema,
    kind: maintenanceRunKindSchema,
    trigger: maintenanceRunTriggerSchema,
    status: maintenanceRunStatusSchema,
    cutoff: utcDateTimeSchema.nullable(),
    selector: z.record(z.unknown()),
    requestedAt: utcDateTimeSchema,
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    prCount: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
    filesDeleted: z.number().int().nonnegative(),
    commentsDeleted: z.number().int().nonnegative(),
    error: z.string().nullable(),
  })
  .strict();

export const maintenanceRunsResponseSchema = z
  .object({ items: z.array(maintenanceRunSchema) })
  .strict();

export const maintenanceRunAcceptedSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    runId: z.string().trim().min(1),
    status: z.literal("accepted"),
  })
  .strict();

export const maintenanceRunParamsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    runId: z.string().trim().min(1),
  })
  .strict();

export const restoreMetadataResponseSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    entityKind: z.enum(["pull_request", "issue"]),
    number: z.number().int().positive(),
    archivedAt: z.null(),
    payloadPrunedAt: utcDateTimeSchema.nullable(),
  })
  .strict();

export type ArchiveFilter = z.infer<typeof archiveFilterSchema>;
export type ArchiveScope = z.infer<typeof archiveScopeSchema>;
export type RepositoryRetentionSettings = z.infer<typeof repositoryRetentionSettingsSchema>;
export type RepositoryRetentionSettingsUpdate = z.infer<typeof repositoryRetentionSettingsUpdateSchema>;
export type ArchivePreviewRequest = z.infer<typeof archivePreviewRequestSchema>;
export type ArchiveRunCreate = z.infer<typeof archiveRunCreateSchema>;
export type ArchivePreviewResponse = z.infer<typeof archivePreviewResponseSchema>;
export type MaintenanceRun = z.infer<typeof maintenanceRunSchema>;
export type MaintenanceRunsResponse = z.infer<typeof maintenanceRunsResponseSchema>;
export type MaintenanceRunAccepted = z.infer<typeof maintenanceRunAcceptedSchema>;
export type MaintenanceRunParams = z.infer<typeof maintenanceRunParamsSchema>;
export type RestoreMetadataResponse = z.infer<typeof restoreMetadataResponseSchema>;
