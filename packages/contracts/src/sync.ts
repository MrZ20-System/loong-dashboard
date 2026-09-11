import { z } from "zod";

import {
  calendarDateSchema,
  entityKindSchema,
  repositoryIdSchema,
  utcDateTimeSchema,
} from "./validation.js";

export const syncRunKindSchema = z.enum(["forward", "history", "fetch_pr"]);
export const syncRunTriggerSchema = z.enum(["automatic", "manual", "api", "system"]);
export const syncRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "interrupted",
]);

export const syncRunStreamSchema = z
  .object({
    runId: z.string().min(1),
    entityKind: entityKindSchema,
    status: syncRunStatusSchema,
    pagesFetched: z.number().int().nonnegative(),
    itemsSeen: z.number().int().nonnegative(),
    itemsWritten: z.number().int().nonnegative(),
    watermarkBefore: utcDateTimeSchema.nullable(),
    watermarkAfter: utcDateTimeSchema.nullable(),
    rateLimitRemaining: z.number().int().nonnegative().nullable(),
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const syncRunSchema = z
  .object({
    syncRunId: z.string().min(1),
    repositoryId: repositoryIdSchema,
    kind: syncRunKindSchema,
    trigger: syncRunTriggerSchema,
    status: syncRunStatusSchema,
    requestedAt: utcDateTimeSchema,
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    selector: z.record(z.unknown()),
    itemsSeen: z.number().int().nonnegative(),
    itemsWritten: z.number().int().nonnegative(),
    error: z.string().nullable(),
    streams: z.array(syncRunStreamSchema),
  })
  .strict();

export const syncRunParamsSchema = z
  .object({ repositoryId: repositoryIdSchema, runId: z.string().min(1) })
  .strict();

export const syncRunsQuerySchema = z
  .object({ limit: z.preprocess((value) => (value === undefined ? undefined : Number(value)), z.number().int().positive().max(100).optional()) })
  .strict();

export const syncRunsResponseSchema = z.object({ items: z.array(syncRunSchema) }).strict();

/** HTTP sync requests select a kind; trigger is fixed to `api` by the server. */
const forwardSyncRequestSchema = z
  .object({
    kind: z.literal("forward").optional(),
    targetDate: z.never().optional(),
    number: z.never().optional(),
  })
  .strict();
const historySyncRequestSchema = z
  .object({
    kind: z.literal("history"),
    targetDate: calendarDateSchema.nullable().optional(),
    number: z.never().optional(),
  })
  .strict();
const fetchPullRequestSyncRequestSchema = z
  .object({
    kind: z.literal("fetch_pr"),
    number: z.number().int().positive(),
    targetDate: z.never().optional(),
  })
  .strict();

export const syncRequestSchema = z.union([
  forwardSyncRequestSchema,
  historySyncRequestSchema,
  fetchPullRequestSyncRequestSchema,
]);

export const historySettingsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    entityKind: entityKindSchema,
    targetDate: calendarDateSchema.nullable(),
    oldestCoveredDay: calendarDateSchema.nullable(),
    cursor: z.string().nullable(),
    enabled: z.boolean(),
    status: z.enum(["idle", "running", "paused", "failed", "completed"]),
    lastRunId: z.string().nullable(),
    lastError: z.string().nullable(),
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const historySettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    targetDate: calendarDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    ({ enabled, targetDate }) => enabled !== undefined || targetDate !== undefined,
    { message: "enabled or targetDate is required" },
  );

export const historyResponseSchema = z
  .object({ settings: z.array(historySettingsSchema) })
  .strict();

export const fetchPullRequestParamsSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    number: z.preprocess(
      (value) => (typeof value === "string" ? Number(value) : value),
      z.number().int().positive(),
    ),
  })
  .strict();

export const syncRunAcceptedSchema = z
  .object({ repositoryId: repositoryIdSchema, syncRunId: z.string().min(1), status: z.literal("accepted") })
  .strict();

export type SyncRunKind = z.infer<typeof syncRunKindSchema>;
export type SyncRunTrigger = z.infer<typeof syncRunTriggerSchema>;
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;
export type SyncRunStream = z.infer<typeof syncRunStreamSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type SyncRunParams = z.infer<typeof syncRunParamsSchema>;
export type SyncRunsQuery = z.infer<typeof syncRunsQuerySchema>;
export type SyncRunsResponse = z.infer<typeof syncRunsResponseSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;
export type HistorySettings = z.infer<typeof historySettingsSchema>;
export type HistorySettingsUpdate = z.infer<typeof historySettingsUpdateSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
export type FetchPullRequestParams = z.infer<typeof fetchPullRequestParamsSchema>;
export type SyncRunAccepted = z.infer<typeof syncRunAcceptedSchema>;
