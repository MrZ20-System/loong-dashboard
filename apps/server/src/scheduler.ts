import {
  appendAgentMessage,
  getScheduledRun,
  insertScheduledRun,
  listScheduledTaskRuns,
  listScheduledTasks,
  recoverInterruptedScheduledRuns,
  requireScheduledTask,
  setTaskOccurrence,
  updateScheduledRun,
  type DatabaseClient,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from "@loongboard/database";
import { nextOccurrence } from "@loongboard/scheduler";

import type { AgentChatController } from "./agent-chat.js";
import type { WorkspaceRunCoordinator } from "./workspace-run-coordinator.js";

/** Node clamps setTimeout delays above this signed 32-bit-safe boundary. */
export const MAX_SCHEDULER_TIMER_DELAY_MS = 2_147_000_000;

export class ScheduledTaskWorkspaceBusyError extends Error {
  readonly code = "SCHEDULED_TASK_WORKSPACE_BUSY" as const;

  constructor(workspacePath: string) {
    super(`Another agent run is already using the workspace: ${workspacePath}`);
    this.name = "ScheduledTaskWorkspaceBusyError";
  }
}

/** Context passed to one injected system action. */
export interface SchedulerSystemExecutionContext {
  task: ScheduledTaskRow;
  run: ScheduledRunRow;
  workspacePath: string | null;
}

/**
 * System actions share this engine's timer and run history. They do not claim
 * the Agent workspace guard because repository/Knowledge actions own their
 * resource-specific coordination.
 */
export interface SchedulerExecutor {
  executeSystem(context: SchedulerSystemExecutionContext): Promise<void>;
}

export interface SchedulerEngineOptions {
  database: DatabaseClient;
  chats: AgentChatController;
  /** Shared in-process ownership guard for every agent workspace. */
  workspaceRuns: WorkspaceRunCoordinator;
  /** Root for per-run DSH homes. */
  agentSessionsPath: string;
  /** Injected repository sync/checkpoint/push implementation for system tasks. */
  executor?: SchedulerExecutor;
  now?: () => Date;
}

/**
 * One timer engine for Agent sessions and trusted system actions. Every Agent
 * occurrence creates a new durable session. System actions share
 * the timer and run history but never claim an Agent workspace.
 */
export class SchedulerEngine {
  private readonly database: DatabaseClient;
  private readonly chats: AgentChatController;
  private readonly workspaceRuns: WorkspaceRunCoordinator;
  private readonly executor: SchedulerExecutor | undefined;
  private readonly now: () => Date;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runningRuns = new Map<string, Promise<void>>();
  private readonly runContext = new Map<string, { workspacePath: string | null }>();
  private closed = false;

  constructor(options: SchedulerEngineOptions) {
    this.database = options.database;
    this.chats = options.chats;
    this.workspaceRuns = options.workspaceRuns;
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  /** Load enabled tasks, recover crashed runs, and arm the nearest timers. */
  start(): void {
    if (this.closed) return;
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

  /**
   * Disarm all timers synchronously, then wait for active work. Keeping the
   * disarm before the first await prevents a shutdown race from starting a
   * new run after the caller has begun closing the server.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    while (this.runningRuns.size > 0) {
      await Promise.all([...this.runningRuns.values()]);
    }
  }

  listRuns(taskId: string): ScheduledRunRow[] {
    return listScheduledTaskRuns(this.database, taskId);
  }

  /** Start one run now. Only Agent tasks claim the Agent workspace guard. */
  async runNow(taskId: string): Promise<{ runId: string }> {
    if (this.closed) throw new Error("Scheduler is closed");
    const task = requireScheduledTask(this.database, taskId);
    const release = this.tryAcquireTaskWorkspace(task);
    if (release === null) {
      if (task.workspacePath === null) {
        throw new Error(`Agent scheduled task ${task.id} is missing workspacePath`);
      }
      throw new ScheduledTaskWorkspaceBusyError(task.workspacePath);
    }
    try {
      const run = insertScheduledRun(this.database, task.id, this.timestamp());
      this.launchRun(run, task.workspacePath, release);
      return { runId: run.id };
    } catch (error) {
      release();
      throw error;
    }
  }

  private launchRun(
    run: ScheduledRunRow,
    workspacePath: string | null,
    release: () => void,
  ): void {
    this.runContext.set(run.id, { workspacePath });
    const promise = this.executeRun(run.id).catch((error: unknown) => {
      this.failRun(run.id, error);
    });
    this.runningRuns.set(run.id, promise);
    void promise.finally(() => {
      this.runningRuns.delete(run.id);
      this.runContext.delete(run.id);
      release();
    });
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
      this.schedule(taskId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      if (delay > MAX_SCHEDULER_TIMER_DELAY_MS) {
        // Re-arm long-dated occurrences instead of relying on Node's
        // signed-32-bit timeout clamp, which would create a hot loop.
        this.schedule(taskId);
        return;
      }
      void this.fire(taskId).catch((error: unknown) => {
        // The run failure is recorded inside fire; only scheduling errors land here.
        this.failCurrentTaskSchedule(taskId, error);
      });
    }, Math.min(delay, MAX_SCHEDULER_TIMER_DELAY_MS));
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
    if (this.closed) return;
    const task = this.databaseTask(taskId);
    const scheduledFor = task.nextRunAt;
    if (!task.enabled || scheduledFor === null) {
      this.schedule(taskId);
      return;
    }
    // A busy workspace defers this same occurrence without creating a run.
    const release = this.tryAcquireTaskWorkspace(task);
    if (release === null) {
      const retry = setTimeout(() => {
        this.timers.delete(taskId);
        void this.fire(taskId).catch(() => undefined);
      }, 30_000);
      this.timers.set(taskId, retry);
      return;
    }
    try {
      // Arm the next future occurrence before running so a crash cannot
      // replay the missed run on restart.
      const updated = this.storeNextRun(task);
      this.schedule(taskId);
      const run = insertScheduledRun(
        this.database,
        task.id,
        scheduledFor,
        this.timestamp(),
      );
      this.launchRun(run, updated.workspacePath, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const task = requireScheduledTask(this.database, run.taskId);
    const workspace = this.runContext.get(runId)?.workspacePath ?? task.workspacePath;
    updateScheduledRun(this.database, run.id, { startedAt: this.timestamp() });
    let finishedStatus: ScheduledRunRow["status"] = "completed";
    let failureMessage: string | null = null;

    try {
      if (task.kind === "system") {
        if (task.action === null || task.action.length === 0) {
          throw new Error("System scheduled task is missing an action");
        }
        if (this.executor === undefined) {
          throw new Error("System scheduled tasks are unavailable");
        }
        await this.executor.executeSystem({ task, run, workspacePath: workspace });
      } else {
        const result = await this.runAgentTask(task, run, workspace);
        updateScheduledRun(this.database, run.id, {
          agentSessionId: result.sessionId,
        });
      }
    } catch (error) {
      finishedStatus = "failed";
      failureMessage = error instanceof Error ? error.message : String(error);
    } finally {
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

  /** Execute one Agent occurrence in a new durable session. */
  private async runAgentTask(
    task: ScheduledTaskRow,
    run: ScheduledRunRow,
    workspace: string | null,
  ): Promise<{ sessionId: string }> {
    if (
      task.kind !== "agent" ||
      workspace === null ||
      task.workspacePath === null ||
      task.prompt === null ||
      task.provider === null ||
      task.model === null ||
      task.reasoningEffort === null
    ) {
      throw new Error(`Agent scheduled task ${task.id} is missing canonical Agent fields`);
    }
    const session = await this.chats.ensureScheduledSession({
      taskId: task.id,
      runId: run.id,
      workspacePath: workspace,
      provider: task.provider,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      title: task.name,
    });
    const configured = await this.chats.updateSession(session.id, {
      provider: task.provider,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
    });
    const sessionId = configured.session.id;
    updateScheduledRun(this.database, run.id, {
      agentSessionId: sessionId,
    });
    // The prompt is appended once per scheduled occurrence and sent verbatim;
    // the scheduler never parses report format.
    appendAgentMessage(this.database, {
      sessionId,
      role: "user",
      contentMarkdown: task.prompt,
      now: this.timestamp(),
    });
    const result = await this.chats.runSessionTurn(sessionId, task.prompt, {
      // fire/runNow already owns this path; acquiring again deadlocks.
      workspaceOwned: true,
    });
    if (result.status !== "idle") {
      throw new Error(`Agent session ended with status: ${result.status}`);
    }
    return { sessionId };
  }

  private tryAcquireTaskWorkspace(task: ScheduledTaskRow): (() => void) | null {
    if (task.kind === "system") return () => undefined;
    if (task.workspacePath === null) {
      throw new Error(`Agent scheduled task ${task.id} is missing workspacePath`);
    }
    return this.workspaceRuns.acquire(task.workspacePath);
  }

  private failRun(runId: string, error: unknown): void {
    try {
      const run = this.requireRun(runId);
      updateScheduledRun(this.database, run.id, {
        status: "failed",
        finishedAt: this.timestamp(),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The run may already be terminal.
    }
  }

  private requireRun(runId: string): ScheduledRunRow {
    const run = getScheduledRun(this.database, runId);
    if (run === null) {
      throw new Error(`Scheduled run was not found: ${runId}`);
    }
    return run;
  }

  private storeNextRun(task: ScheduledTaskRow): ScheduledTaskRow {
    let next: Date;
    try {
      next = nextOccurrence(task.cronExpression, task.timezone, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An invalid cron must not crash the engine; surface it in history-free
      // state until the task is corrected.
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
