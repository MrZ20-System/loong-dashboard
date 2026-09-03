import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  appendAgentMessage,
  createAgentSession,
  getScheduledRun,
  insertScheduledRun,
  listScheduledTaskRuns,
  listScheduledTasks,
  recoverInterruptedScheduledRuns,
  requireAgentSession,
  requireScheduledTask,
  setTaskOccurrence,
  updateScheduledRun,
  type DatabaseClient,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from "@loongboard/database";
import { nextOccurrence } from "@loongboard/scheduler";

import type { AgentChatController } from "./agent-chat.js";

export class ScheduledTaskWorkspaceBusyError extends Error {
  readonly code = "SCHEDULED_TASK_WORKSPACE_BUSY" as const;

  constructor(workspacePath: string) {
    super(`Another scheduled agent run is already using the workspace: ${workspacePath}`);
    this.name = "ScheduledTaskWorkspaceBusyError";
  }
}

export interface SchedulerEngineOptions {
  database: DatabaseClient;
  chats: AgentChatController;
  /** Root for per-run DSH homes (plan 13.2). */
  agentSessionsPath: string;
  now?: () => Date;
}

/**
 * Scheduled Agent runs (plan 16, 17.7). One min-heap is a single timer for
 * the nearest enabled task; each due task starts a fresh Agent Session with
 * the prompt sent verbatim, waits for the turn to idle, and records
 * completed/failed in the run history. One workspace path runs at most one
 * agent turn at a time (plan 16.3), and restarts never replay missed runs
 * (plan 16.2).
 */
export class SchedulerEngine {
  private readonly database: DatabaseClient;
  private readonly chats: AgentChatController;
  private readonly agentSessionsPath: string;
  private readonly now: () => Date;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workspaceLocks = new Set<string>();
  private readonly runningRuns = new Map<string, Promise<void>>();
  private readonly runContext = new Map<string, { workspacePath: string }>();
  private closed = false;

  constructor(options: SchedulerEngineOptions) {
    this.database = options.database;
    this.chats = options.chats;
    this.agentSessionsPath = options.agentSessionsPath;
    this.now = options.now ?? (() => new Date());
  }

  /** Load enabled tasks, recover crashed runs, and arm the nearest timers. */
  start(): void {
    recoverInterruptedScheduledRuns(this.database);
    for (const task of listScheduledTasks(this.database)) {
      if (!task.enabled) continue;
      if (task.nextRunAt === null) {
        this.storeNextRun(task);
      }
      this.schedule(task.id);
    }
  }

  /** Clear an armed timer after a task deletion. */
  refreshIfArmed(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /** Recompute and persist the next run after a task mutation. */
  refresh(taskId: string): ScheduledTaskRow {
    const task = requireScheduledTask(this.database, taskId);
    if (task.enabled) this.storeNextRun(task);
    const updated = requireScheduledTask(this.database, taskId);
    this.schedule(taskId);
    return updated;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    while (this.runningRuns.size > 0) {
      await Promise.all([...this.runningRuns.values()]);
    }
    this.workspaceLocks.clear();
  }

  listRuns(taskId: string): ScheduledRunRow[] {
    return listScheduledTaskRuns(this.database, taskId);
  }

  /**
   * Start one run now (plan 16.2 Run Now). Throws when the workspace is
   * already busy so the caller surfaces a clear conflict.
   */
  async runNow(taskId: string): Promise<{ runId: string }> {
    const task = requireScheduledTask(this.database, taskId);
    if (this.workspaceLocks.has(task.workspacePath)) {
      throw new ScheduledTaskWorkspaceBusyError(task.workspacePath);
    }
    const run = insertScheduledRun(this.database, task.id, this.timestamp());
    this.runContext.set(run.id, { workspacePath: task.workspacePath });
    const promise = this.executeRun(run.id).catch((error: unknown) => {
      this.failRun(run.id, error);
    });
    this.runningRuns.set(run.id, promise);
    void promise.finally(() => this.runningRuns.delete(run.id));
    return { runId: run.id };
  }

  private databaseTask(taskId: string): ScheduledTaskRow {
    return requireScheduledTask(this.database, taskId);
  }

  private schedule(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.delete(taskId);
    if (this.closed) return;
    const task = this.databaseTask(taskId);
    if (!task.enabled || task.nextRunAt === null) return;
    const delay = Date.parse(task.nextRunAt) - this.now().getTime();
    if (delay < 0) {
      // next_run_at is stale (clock moved); recompute a future occurrence.
      this.storeNextRun(task);
      const updated = this.databaseTask(taskId);
      if (updated.nextRunAt === null) return;
      return this.schedule(taskId);
    }
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      void this.fire(taskId).catch((error: unknown) => {
        // The run failure is recorded inside fire; only scheduling errors land here.
        this.failCurrentTaskSchedule(taskId, error);
      });
    }, delay);
    this.timers.set(taskId, timer);
  }

  private failCurrentTaskSchedule(taskId: string, error: unknown): void {
    try {
      this.refresh(taskId);
    } catch {
      // Keep the process alive; a later CRUD refresh repairs the task.
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Scheduled task ${taskId} failed to fire: ${message}`);
  }

  private async fire(taskId: string): Promise<void> {
    const task = this.databaseTask(taskId);
    const scheduledFor = task.nextRunAt;
    if (!task.enabled || scheduledFor === null) {
      this.schedule(taskId);
      return;
    }
    // A busy workspace defers the SAME occurrence without advancing the
    // schedule: retry later instead of silently skipping or running early.
    if (this.workspaceLocks.has(task.workspacePath)) {
      const retry = setTimeout(() => {
        this.timers.delete(taskId);
        void this.fire(taskId).catch(() => undefined);
      }, 30_000);
      this.timers.set(taskId, retry);
      return;
    }
    // Arm the next future occurrence before running so a crash cannot replay
    // the missed run (plan 16.2 restart semantics).
    const updated = this.storeNextRun(task);
    this.schedule(taskId);

    const run = insertScheduledRun(this.database, task.id, scheduledFor);
    this.runContext.set(run.id, { workspacePath: updated.workspacePath });
    const promise = this.executeRun(run.id);
    this.runningRuns.set(run.id, promise);
    void promise.finally(() => this.runningRuns.delete(run.id));
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const task = requireScheduledTask(this.database, run.taskId);
    const workspace = this.runContext.get(runId)?.workspacePath ?? task.workspacePath;
    this.workspaceLocks.add(workspace);
    updateScheduledRun(this.database, run.id, { startedAt: this.timestamp() });
    const sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    let finishedStatus: ScheduledRunRow["status"] = "completed";
    let failureMessage: string | null = null;

    try {
      createAgentSession(this.database, {
        id: sessionId,
        scope: { kind: "general" },
        dshHomePath: join(this.agentSessionsPath, sessionId, "dsh-home"),
        workspacePath: workspace,
        provider: task.provider,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        now: this.timestamp(),
      });
      updateScheduledRun(this.database, run.id, { agentSessionId: sessionId });
      // The prompt is sent verbatim; the scheduler never parses report format.
      appendAgentMessage(this.database, {
        sessionId,
        role: "user",
        contentMarkdown: task.prompt,
      });
      const session = await this.chats.runSessionTurn(sessionId, task.prompt);
      if (session.status !== "idle") {
        finishedStatus = "failed";
        failureMessage = `Agent session ended with status: ${session.status}`;
      }
    } catch (error) {
      finishedStatus = "failed";
      failureMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.workspaceLocks.delete(workspace);
      this.runContext.delete(runId);
      updateScheduledRun(this.database, run.id, {
        status: finishedStatus,
        finishedAt: this.timestamp(),
        error: failureMessage,
      });
      try {
        const sessionTask = requireScheduledTask(this.database, run.taskId);
        setTaskOccurrence(
          this.database,
          sessionTask.id,
          sessionTask.nextRunAt,
          this.timestamp(),
        );
      } catch {
        // The task was deleted while its run executed; history stays intact.
      }
    }
  }

  private failRun(runId: string, error: unknown): void {
    try {
      const run = this.requireRun(runId);
      const workspace = this.runContext.get(runId)?.workspacePath;
      if (workspace !== undefined) this.workspaceLocks.delete(workspace);
      this.runContext.delete(runId);
      updateScheduledRun(this.database, run.id, {
        status: "failed",
        finishedAt: this.timestamp(),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The run may already be terminal.
    }
  }

  private requireRun(runId: string): { id: string; taskId: string } {
    const run = getScheduledRun(this.database, runId);
    if (run === null) {
      throw new Error(`Scheduled run was not found: ${runId}`);
    }
    return { id: run.id, taskId: run.taskId };
  }

  private storeNextRun(task: ScheduledTaskRow): ScheduledTaskRow {
    let next: Date;
    try {
      next = nextOccurrence(task.cronExpression, task.timezone, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An invalid cron must not crash the engine; surface it in history-free
      // state by disabling the occurrence until the task is corrected.
      setTaskOccurrence(this.database, task.id, null);
      console.error(`Scheduled task ${task.id} has an invalid cron: ${message}`);
      return requireScheduledTask(this.database, task.id);
    }
    setTaskOccurrence(this.database, task.id, next.toISOString());
    return requireScheduledTask(this.database, task.id);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Scheduler clock returned an invalid Date");
    }
    return value.toISOString();
  }
}
