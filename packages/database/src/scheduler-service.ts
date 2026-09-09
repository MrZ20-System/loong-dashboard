import { randomBytes } from "node:crypto";

import type { DatabaseClient } from "./types.js";

export class ScheduledTaskNotFoundError extends Error {
  readonly code = "SCHEDULED_TASK_NOT_FOUND" as const;

  constructor(taskId: string) {
    super(`Scheduled task was not found: ${taskId}`);
    this.name = "ScheduledTaskNotFoundError";
  }
}

export interface ScheduledTaskRow {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  kind: "agent" | "system";
  action: string | null;
  repositoryId: string | null;
  conversationId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskCreateInput {
  /** Optional stable id for server-owned system tasks. */
  id?: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  kind?: "agent" | "system";
  action?: string | null;
  repositoryId?: string | null;
  conversationId?: string | null;
  enabled?: boolean;
  nextRunAt?: string | null;
}

export type ScheduledTaskUpdateInput = Partial<
  Omit<ScheduledTaskCreateInput, "nextRunAt"> & { nextRunAt?: string | null }
>;

interface TaskRowSql {
  id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  prompt: string;
  workspace_path: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  kind: "agent" | "system";
  action: string | null;
  repository_id: string | null;
  conversation_id: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The server-owned system actions use dotted names. Keep old rows readable
 * after the action namespace migration so a restart cannot strand an enabled
 * task with the retired hyphenated spelling.
 */
function normalizeSystemAction(action: string | null): string | null {
  if (action === "repository-sync") return "repository.sync";
  if (action === "knowledge-checkpoint") return "knowledge.checkpoint";
  return action;
}

function mapTask(row: TaskRowSql): ScheduledTaskRow {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    prompt: row.prompt,
    workspacePath: row.workspace_path,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    kind: row.kind ?? "agent",
    action: normalizeSystemAction(row.action ?? null),
    repositoryId: row.repository_id ?? null,
    conversationId: row.conversation_id ?? null,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskById(database: DatabaseClient, taskId: string): TaskRowSql | null {
  const row = database
    .prepare(
      `SELECT id, name, cron_expression, timezone, prompt, workspace_path,
              provider, model, reasoning_effort, kind, action, repository_id,
              conversation_id, enabled, last_run_at, next_run_at, created_at,
              updated_at
       FROM scheduled_tasks WHERE id = ?`,
    )
    .get(taskId) as TaskRowSql | undefined;
  return row ?? null;
}

export function listScheduledTasks(database: DatabaseClient): ScheduledTaskRow[] {
  const rows = database
    .prepare(
      `SELECT id, name, cron_expression, timezone, prompt, workspace_path,
              provider, model, reasoning_effort, kind, action, repository_id,
              conversation_id, enabled, last_run_at, next_run_at, created_at,
              updated_at
       FROM scheduled_tasks ORDER BY created_at ASC`,
    )
    .all() as TaskRowSql[];
  return rows.map(mapTask);
}

export function getScheduledTask(
  database: DatabaseClient,
  taskId: string,
): ScheduledTaskRow | null {
  const row = taskById(database, taskId);
  return row === null ? null : mapTask(row);
}

export function requireScheduledTask(
  database: DatabaseClient,
  taskId: string,
): ScheduledTaskRow {
  const row = getScheduledTask(database, taskId);
  if (row === null) throw new ScheduledTaskNotFoundError(taskId);
  return row;
}

export function createScheduledTask(
  database: DatabaseClient,
  input: ScheduledTaskCreateInput,
  now: string = new Date().toISOString(),
): ScheduledTaskRow {
  const id = input.id ?? `task_${randomBytes(10).toString("hex")}`;
  database
    .prepare(
      `INSERT INTO scheduled_tasks (
        id, name, cron_expression, timezone, prompt, workspace_path,
        provider, model, reasoning_effort, kind, action, repository_id,
        conversation_id, enabled, last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.cronExpression,
      input.timezone,
      input.prompt,
      input.workspacePath,
      input.provider,
      input.model,
      input.reasoningEffort,
      input.kind ?? "agent",
      input.action ?? null,
      input.repositoryId ?? null,
      input.conversationId ?? null,
      input.enabled === false ? 0 : 1,
      input.nextRunAt ?? null,
      now,
      now,
    );
  const created = getScheduledTask(database, id);
  if (created === null) throw new Error("Failed to read back the scheduled task");
  return created;
}

export function updateScheduledTask(
  database: DatabaseClient,
  taskId: string,
  patch: ScheduledTaskUpdateInput,
  now: string = new Date().toISOString(),
): ScheduledTaskRow {
  const existing = requireScheduledTask(database, taskId);
  const sets: string[] = [];
  const parameters: unknown[] = [];
  const add = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    parameters.push(value);
  };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.cronExpression !== undefined) add("cron_expression", patch.cronExpression);
  if (patch.timezone !== undefined) add("timezone", patch.timezone);
  if (patch.prompt !== undefined) add("prompt", patch.prompt);
  if (patch.workspacePath !== undefined) add("workspace_path", patch.workspacePath);
  if (patch.provider !== undefined) add("provider", patch.provider);
  if (patch.model !== undefined) add("model", patch.model);
  if (patch.reasoningEffort !== undefined) add("reasoning_effort", patch.reasoningEffort);
  if (patch.kind !== undefined) add("kind", patch.kind);
  if (patch.action !== undefined) add("action", patch.action);
  if (patch.repositoryId !== undefined) add("repository_id", patch.repositoryId);
  if (patch.conversationId !== undefined) add("conversation_id", patch.conversationId);
  if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
  if (patch.nextRunAt !== undefined) add("next_run_at", patch.nextRunAt);
  if (patch.nextRunAt === undefined && patch.enabled === false) {
    // Disabling cancels the pending occurrence.
    sets.push("next_run_at = NULL");
  }
  sets.push("updated_at = ?");
  parameters.push(now, taskId);
  database.prepare(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...parameters);
  const updated = getScheduledTask(database, taskId);
  if (updated === null) {
    // Should never happen: updateScheduledTask only runs against existing rows.
    throw new ScheduledTaskNotFoundError(taskId);
  }
  return updated;
}

export function setTaskOccurrence(
  database: DatabaseClient,
  taskId: string,
  nextRunAt: string | null,
  lastRunAt?: string,
): ScheduledTaskRow {
  database
    .prepare(
      `UPDATE scheduled_tasks SET next_run_at = ?, ${lastRunAt !== undefined ? "last_run_at = ?, " : ""}updated_at = ? WHERE id = ?`,
    )
    .run(
      nextRunAt,
      ...(lastRunAt !== undefined ? [lastRunAt] : []),
      new Date().toISOString(),
      taskId,
    );
  return requireScheduledTask(database, taskId);
}

/** Persist the conversation reused by future runs of one agent task. */
export function setScheduledTaskConversation(
  database: DatabaseClient,
  taskId: string,
  conversationId: string | null,
  now: string = new Date().toISOString(),
): ScheduledTaskRow {
  database
    .prepare(
      "UPDATE scheduled_tasks SET conversation_id = ?, updated_at = ? WHERE id = ?",
    )
    .run(conversationId, now, taskId);
  return requireScheduledTask(database, taskId);
}

export function deleteScheduledTask(database: DatabaseClient, taskId: string): void {
  const result = database.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
  if (result.changes === 0) throw new ScheduledTaskNotFoundError(taskId);
}

export interface ScheduledRunRow {
  id: string;
  taskId: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "skipped";
  agentSessionId: string | null;
  conversationId: string | null;
  error: string | null;
}

function mapRun(row: Record<string, unknown>): ScheduledRunRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    scheduledFor: row.scheduled_for as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    status: row.status as ScheduledRunRow["status"],
    agentSessionId: (row.agent_session_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

export function insertScheduledRun(
  database: DatabaseClient,
  taskId: string,
  scheduledFor: string,
  now: string = new Date().toISOString(),
): ScheduledRunRow {
  void now;
  const id = `run_${randomBytes(10).toString("hex")}`;
  database
    .prepare(
      `INSERT INTO scheduled_task_runs (
        id, task_id, scheduled_for, started_at, finished_at, status, agent_session_id,
        conversation_id, error
      ) VALUES (?, ?, ?, NULL, NULL, 'running', NULL, ?, NULL)`,
    )
    .run(id, taskId, scheduledFor, null);
  return {
    id,
    taskId,
    scheduledFor,
    startedAt: null,
    finishedAt: null,
    status: "running",
    agentSessionId: null,
    conversationId: null,
    error: null,
  };
}

/** Running run rows; a task/workspace guard lives in the scheduler engine. */
export function getScheduledRun(
  database: DatabaseClient,
  runId: string,
): ScheduledRunRow | null {
  const row = database
    .prepare(
      `SELECT id, task_id, scheduled_for, started_at, finished_at, status,
              agent_session_id, conversation_id, error
       FROM scheduled_task_runs WHERE id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row === undefined ? null : mapRun(row);
}

export function listRunningRuns(database: DatabaseClient): ScheduledRunRow[] {
  const rows = database
    .prepare(
      `SELECT id, task_id, scheduled_for, started_at, finished_at, status,
              agent_session_id, conversation_id, error
       FROM scheduled_task_runs WHERE status = 'running'`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRun);
}

export function listScheduledTaskRuns(
  database: DatabaseClient,
  taskId: string,
  limit = 20,
): ScheduledRunRow[] {
  requireScheduledTask(database, taskId);
  const rows = database
    .prepare(
      `SELECT id, task_id, scheduled_for, started_at, finished_at, status,
              agent_session_id, conversation_id, error
       FROM scheduled_task_runs
       WHERE task_id = ?
       ORDER BY scheduled_for DESC
       LIMIT ?`,
    )
    .all(taskId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRun);
}

export function updateScheduledRun(
  database: DatabaseClient,
  runId: string,
  patch: {
    status?: ScheduledRunRow["status"];
    finishedAt?: string;
    agentSessionId?: string | null;
    conversationId?: string | null;
    error?: string | null;
    startedAt?: string;
  },
): ScheduledRunRow {
  const existing = database
    .prepare("SELECT * FROM scheduled_task_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    throw new Error(`Scheduled run was not found: ${runId}`);
  }
  const sets: string[] = [];
  const parameters: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    parameters.push(patch.status);
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    parameters.push(patch.finishedAt);
  }
  if (patch.agentSessionId !== undefined) {
    sets.push("agent_session_id = ?");
    parameters.push(patch.agentSessionId);
  }
  if (patch.conversationId !== undefined) {
    sets.push("conversation_id = ?");
    parameters.push(patch.conversationId);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    parameters.push(patch.error);
  }
  if (patch.startedAt !== undefined) {
    sets.push("started_at = ?");
    parameters.push(patch.startedAt);
  }
  if (sets.length > 0) {
    database
      .prepare(`UPDATE scheduled_task_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...parameters, runId);
  }
  const updated = database
    .prepare("SELECT * FROM scheduled_task_runs WHERE id = ?")
    .get(runId) as Record<string, unknown>;
  return mapRun(updated);
}

/** Mark runs that were interrupted by a restart as failed (plan 16.2). */
export function recoverInterruptedScheduledRuns(database: DatabaseClient): number {
  const result = database
    .prepare(
      `UPDATE scheduled_task_runs
       SET status = 'failed', error = 'Interrupted by server restart', finished_at = ?
       WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
  return result.changes;
}
