import { z } from "zod";

import { utcDateTimeSchema } from "./validation.js";

/** Scheduled Agent and system task contracts. */

const reasoningEffortSchema = z.string().trim().min(1);

export const scheduledTaskKindSchema = z.enum(["agent", "system"]);

/** Only the persisted dotted action namespace is accepted at the HTTP boundary. */
export const scheduledSystemActionSchema = z.enum([
  "repository.sync",
  "repository.metadata-maintenance",
  "repository.worktrees.cleanup",
  "git.checkpoint",
  "git.push",
  "knowledge.checkpoint",
  "knowledge.push",
  "agent.archive.checkpoint",
  "agent.archive.push",
]);

const repositoryScopedScheduledActions = new Set([
  "repository.sync",
  "repository.metadata-maintenance",
  "repository.worktrees.cleanup",
]);

export function scheduledActionRequiresRepository(
  action: string | null | undefined,
): boolean {
  return action !== null && action !== undefined && repositoryScopedScheduledActions.has(action);
}

/** Agent-only fields are explicit NULLs on system task responses. */
export const scheduledTaskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    cronExpression: z.string().min(1),
    timezone: z.string().min(1),
    prompt: z.string().nullable(),
    workspacePath: z.string().min(1).nullable(),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    reasoningEffort: reasoningEffortSchema.nullable(),
    kind: scheduledTaskKindSchema,
    action: scheduledSystemActionSchema.nullable(),
    repositoryId: z.string().trim().min(1).nullable(),
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
    action: scheduledSystemActionSchema.optional(),
    repositoryId: z.string().trim().min(1).optional(),
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
      for (const field of ["prompt", "workspacePath", "provider", "model", "reasoningEffort"] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "System tasks cannot define Agent-only fields",
          });
        }
      }
      if (scheduledActionRequiresRepository(value.action) && value.repositoryId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repositoryId"],
          message: "This system action requires a repositoryId",
        });
      }
      return;
    }
    if (value.action !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Agent tasks cannot define a system action",
      });
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
