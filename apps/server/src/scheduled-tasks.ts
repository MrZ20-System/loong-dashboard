import type { DatabaseClient } from "@loongboard/database";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  requireScheduledTask,
  updateScheduledTask,
  type ScheduledTaskRow,
} from "@loongboard/database";
import {
  scheduledTaskCreateSchema,
  scheduledTaskDeleteResponseSchema,
  scheduledTaskParamsSchema,
  scheduledTaskRunsResponseSchema,
  scheduledTaskRunAcceptedSchema,
  scheduledTaskSchema,
  scheduledTasksResponseSchema,
  scheduledTaskUpdateSchema,
  scheduledActionRequiresRepository,
  type ScheduledTaskCreate,
  type ScheduledTaskUpdate,
} from "@loongboard/contracts";
import { validateCron } from "@loongboard/scheduler";
import type { FastifyInstance } from "fastify";

import { InvalidRequestError, parseRequest, sendParsed } from "./route-helpers.js";
import type { SchedulerEngine } from "./scheduler.js";

/** Actions backed by existing Server services; arbitrary command strings are rejected. */
export const SUPPORTED_SYSTEM_ACTIONS = [
  "repository.sync",
  "repository.metadata-maintenance",
  "repository.worktrees.cleanup",
  "git.checkpoint",
  "git.push",
  "personal-data.checkpoint",
  "personal-data.push",
  "agent.archive.checkpoint",
  "agent.archive.push",
] as const;

function requireSupportedSystemAction(action: string | undefined): void {
  if (action === undefined) {
    throw new InvalidRequestError("System tasks require an action");
  }
  if (!(SUPPORTED_SYSTEM_ACTIONS as readonly string[]).includes(action)) {
    throw new InvalidRequestError(`Unsupported system scheduled action: ${action}`);
  }
}

function requireRepositoryForSystemAction(
  action: string | null | undefined,
  repositoryId: string | null | undefined,
): void {
  if (scheduledActionRequiresRepository(action) && !repositoryId) {
    throw new InvalidRequestError(`System action ${action} requires a repositoryId`);
  }
}

function requireValidCron(expression: string): void {
  try {
    validateCron(expression);
  } catch (error) {
    throw new InvalidRequestError(
      `Invalid cronExpression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ScheduledTaskRoutesDependencies {
  database: DatabaseClient;
  engine: SchedulerEngine;
  defaults: {
    provider: string;
    model: string;
    reasoningEffort: string;
  };
}

/** Map a validated create/update body onto the DB task shape. */
export function taskInput(
  body: ScheduledTaskCreate,
  defaults: ScheduledTaskRoutesDependencies["defaults"],
  existing?: ScheduledTaskRow,
): Parameters<typeof createScheduledTask>[1] {
  const kind = body.kind ?? existing?.kind ?? "agent";
  const shared = {
    name: body.name ?? existing?.name ?? "Untitled task",
    cronExpression: body.cronExpression ?? existing?.cronExpression ?? "0 9 * * *",
    timezone: body.timezone ?? existing?.timezone ?? "Asia/Shanghai",
    kind,
    repositoryId: body.repositoryId ?? existing?.repositoryId ?? null,
    enabled: body.enabled ?? existing?.enabled ?? true,
  };
  if (kind === "system") {
    return {
      ...shared,
      kind: "system",
      action: body.action ?? existing?.action ?? null,
    };
  }
  return {
    ...shared,
    prompt: body.prompt ?? existing?.prompt ?? "",
    workspacePath: body.workspacePath ?? existing?.workspacePath ?? process.cwd(),
    provider: body.provider ?? existing?.provider ?? defaults.provider,
    model: body.model ?? existing?.model ?? defaults.model,
    reasoningEffort: body.reasoningEffort ?? existing?.reasoningEffort ?? defaults.reasoningEffort,
    kind: "agent",
    action: null,
  };
}

export function registerScheduledTaskRoutes(
  app: FastifyInstance,
  dependencies: ScheduledTaskRoutesDependencies,
): void {
  const { database, engine, defaults } = dependencies;

  app.get("/api/scheduled-tasks", async (_request, reply) => {
    const items = listScheduledTasks(database);
    return sendParsed(reply, 200, scheduledTasksResponseSchema, { items });
  });

  app.post("/api/scheduled-tasks", async (request, reply) => {
    const body = parseRequest(scheduledTaskCreateSchema, request.body);
    if (body.kind === "system") requireSupportedSystemAction(body.action);
    const input = taskInput(body, defaults);
    requireValidCron(input.cronExpression);
    requireRepositoryForSystemAction(input.action, input.repositoryId);
    const task = createScheduledTask(database, input);
    const scheduled = engine.refresh(task.id);
    return sendParsed(reply, 201, scheduledTaskSchema, scheduled);
  });

  app.put("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = parseRequest(scheduledTaskParamsSchema, request.params);
    const body = parseRequest(scheduledTaskUpdateSchema, request.body) as ScheduledTaskUpdate;
    const existing = requireScheduledTask(database, id);
    if (existing.kind === "system") {
      throw new InvalidRequestError(
        "System scheduled tasks are managed by Settings",
      );
    }
    const nextKind = body.kind ?? existing.kind;
    if (nextKind === "system") {
      throw new InvalidRequestError(
        "System scheduled tasks are managed by Settings",
      );
    } else if (body.action !== undefined) {
      throw new InvalidRequestError("Agent tasks cannot define a system action");
    }
    const input = taskInput(body as ScheduledTaskCreate, defaults, existing);
    requireValidCron(input.cronExpression);
    requireRepositoryForSystemAction(input.action, input.repositoryId);
    const nextRun =
      body.enabled === undefined || body.enabled
        ? input.nextRunAt
        : null;
    const task = updateScheduledTask(database, id, { ...input, nextRunAt: nextRun ?? undefined });
    const scheduled = engine.refresh(task.id);
    return sendParsed(reply, 200, scheduledTaskSchema, scheduled);
  });

  app.delete("/api/scheduled-tasks/:id", async (request, reply) => {
    const { id } = parseRequest(scheduledTaskParamsSchema, request.params);
    deleteScheduledTask(database, id);
    engine.refreshIfArmed(id);
    return sendParsed(reply, 200, scheduledTaskDeleteResponseSchema, { deleted: true });
  });

  app.post("/api/scheduled-tasks/:id/run", async (request, reply) => {
    const { id } = parseRequest(scheduledTaskParamsSchema, request.params);
    requireScheduledTask(database, id);
    const accepted = await engine.runNow(id);
    return sendParsed(reply, 202, scheduledTaskRunAcceptedSchema, {
      runId: accepted.runId,
      status: "accepted",
    });
  });

  app.get("/api/scheduled-tasks/:id/runs", async (request, reply) => {
    const { id } = parseRequest(scheduledTaskParamsSchema, request.params);
    const items = engine.listRuns(id);
    return sendParsed(reply, 200, scheduledTaskRunsResponseSchema, { items });
  });
}
