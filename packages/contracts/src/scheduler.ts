import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/** Scheduled agent task contracts (plan 16, 17.7). */

const reasoningEffortSchema = z.string().trim().min(1);

/** A schedule may send a prompt to an Agent conversation or invoke a system action. */
export const scheduledTaskKindSchema = z.enum(["agent", "system"]);

/** System actions are intentionally opaque to the cron package and interpreted by Server. */
export const scheduledSystemActionSchema = z.string().trim().min(1).optional();

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
    kind: scheduledTaskKindSchema.optional(),
    action: z.string().trim().min(1).nullable().optional(),
    repositoryId: z.string().trim().min(1).nullable().optional(),
    conversationId: z.string().trim().min(1).nullable().optional(),
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

const scheduledTaskCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    cronExpression: z.string().trim().min(1).max(64),
    timezone: z.string().trim().min(1).max(64),
    prompt: z.string().trim().max(200_000).optional(),
    workspacePath: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    kind: scheduledTaskKindSchema.optional(),
    action: scheduledSystemActionSchema,
    repositoryId: z.string().trim().min(1).optional(),
    conversationId: z.string().trim().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const scheduledTaskCreateSchema = scheduledTaskCreateBodySchema.superRefine(
  (value, context) => {
    if (value.kind === "system") {
      if (value.action === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action"],
          message: "System tasks require an action",
        });
      }
      return;
    }
    if (value.prompt === undefined || value.prompt.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "Agent tasks require a prompt",
      });
    }
    if (value.workspacePath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspacePath"],
        message: "Agent tasks require a workspacePath",
      });
    }
  },
);

export const scheduledTaskUpdateSchema = scheduledTaskCreateBodySchema
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
    conversationId: z.string().nullable().optional(),
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
export type ScheduledTaskKind = z.infer<typeof scheduledTaskKindSchema>;
export type ScheduledSystemAction = z.infer<typeof scheduledSystemActionSchema>;
