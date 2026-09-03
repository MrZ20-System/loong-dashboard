import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/** Scheduled agent task contracts (plan 16, 17.7). */

const reasoningEffortSchema = z.enum(["low", "medium", "high"]);

export const scheduledTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    cronExpression: z.string().min(1),
    timezone: z.string().min(1),
    prompt: z.string(),
    workspacePath: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: reasoningEffortSchema,
    enabled: z.boolean(),
    lastRunAt: utcDateTimeSchema.nullable(),
    nextRunAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const scheduledTasksResponseSchema = z
  .object({
    items: z.array(scheduledTaskSchema),
  })
  .strict();

export const scheduledTaskCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    cronExpression: z.string().trim().min(1).max(64),
    timezone: z.string().trim().min(1).max(64),
    prompt: z.string().trim().min(1).max(200_000),
    workspacePath: z.string().trim().min(1),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const scheduledTaskUpdateSchema = scheduledTaskCreateSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be updated",
  });

export const scheduledTaskParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

export const scheduledRunSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    scheduledFor: utcDateTimeSchema,
    startedAt: utcDateTimeSchema.nullable(),
    finishedAt: utcDateTimeSchema.nullable(),
    status: z.enum(["running", "completed", "failed", "skipped"]),
    agentSessionId: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const scheduledTaskRunsResponseSchema = z
  .object({
    items: z.array(scheduledRunSchema),
  })
  .strict();

export const scheduledTaskRunAcceptedSchema = z
  .object({
    runId: z.string().min(1),
    status: z.literal("accepted"),
  })
  .strict();

export const scheduledTaskDeleteResponseSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;
export type ScheduledTasksResponse = z.infer<typeof scheduledTasksResponseSchema>;
export type ScheduledTaskCreate = z.infer<typeof scheduledTaskCreateSchema>;
export type ScheduledTaskUpdate = z.infer<typeof scheduledTaskUpdateSchema>;
export type ScheduledTaskParams = z.infer<typeof scheduledTaskParamsSchema>;
export type ScheduledRun = z.infer<typeof scheduledRunSchema>;
export type ScheduledTaskRunsResponse = z.infer<typeof scheduledTaskRunsResponseSchema>;
export type ScheduledTaskRunAccepted = z.infer<typeof scheduledTaskRunAcceptedSchema>;
