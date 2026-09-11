import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentChatController } from "../src/agent-chat.js";
import type { AgentSessionUpdate } from "@loongboard/contracts";
import {
  createAgentSession,
  createScheduledTask,
  deleteAgentSession,
  findAgentSession,
  listAgentMessages,
  listScheduledTaskRuns,
  openDatabase,
  requireAgentSession,
  updateScheduledTask,
  updateAgentSession,
  type DatabaseClient,
  type ScheduledTaskRow,
} from "@loongboard/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_SCHEDULER_TIMER_DELAY_MS, SchedulerEngine } from "../src/scheduler.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

const resources: Array<{ database: DatabaseClient; directory: string }> = [];

type ScheduledSessionInput = Parameters<AgentChatController["ensureScheduledSession"]>[0];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.database.open) resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

async function waitForTerminalRun(
  database: DatabaseClient,
  taskId: string,
): Promise<ReturnType<typeof listScheduledTaskRuns>[number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = listScheduledTaskRuns(database, taskId, 1)[0];
    if (run !== undefined && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Scheduled run did not finish");
}

function fakeChats(database: DatabaseClient): AgentChatController {
  return {
    ensureScheduledSession: async (input: ScheduledSessionInput) => {
      const scope = {
        kind: "general" as const,
        route: `scheduled-task:${input.taskId}:run:${input.runId}`,
      };
      const existing = findAgentSession(database, scope);
      if (existing !== null) return existing;
      return createAgentSession(database, {
        id: `sess_${randomUUID().replace(/-/g, "")}`,
        scope,
        dshHomePath: "/tmp/dsh-home",
        workspacePath: input.workspacePath,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        now: new Date().toISOString(),
      });
    },
    updateSession: async (sessionId: string, patch: AgentSessionUpdate) => {
      const session = updateAgentSession(database, sessionId, patch);
      return { session, targetRevision: null, workspaceRevision: null };
    },
    runSessionTurn: async (sessionId: string) => requireAgentSession(database, sessionId),
  } as unknown as AgentChatController;
}

function createFixture(): {
  database: DatabaseClient;
  directory: string;
  task: ScheduledTaskRow;
} {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-scheduler-persistence-"));
  const database = openDatabase(join(directory, "state.sqlite3"));
  resources.push({ database, directory });
  const task = createScheduledTask(
    database,
    {
      name: "Persistent task",
      cronExpression: "0 3 * * *",
      timezone: "UTC",
      prompt: "keep the conversation",
      workspacePath: join(directory, "workspace"),
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      enabled: false,
    },
  );
  return { database, directory, task };
}

describe("SchedulerEngine session lifecycle", () => {
  it("creates a new Agent session for every run and keeps run history addressable", async () => {
    const { database, directory, task } = createFixture();
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
    });

    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    const firstRun = listScheduledTaskRuns(database, task.id)[0];
    const firstConversation = firstRun?.agentSessionId as string;
    expect(firstConversation).toBeTruthy();
    expect(listAgentMessages(database, firstConversation)).toHaveLength(1);

    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    const runs = listScheduledTaskRuns(database, task.id);
    const secondRun = runs.find((run) => run.id !== firstRun?.id);
    const secondConversation = secondRun?.agentSessionId;
    expect(secondConversation).toBeTruthy();
    expect(secondConversation).not.toBe(firstConversation);
    expect(listAgentMessages(database, firstConversation)).toHaveLength(1);
    expect(listAgentMessages(database, secondConversation as string)).toHaveLength(1);

    deleteAgentSession(database, firstConversation);
    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    const thirdRun = listScheduledTaskRuns(database, task.id).find(
      (run) => run.id !== firstRun?.id && run.id !== secondRun?.id,
    );
    expect(thirdRun?.agentSessionId).toBeTruthy();
    expect(thirdRun?.agentSessionId).not.toBe(firstConversation);
    expect(thirdRun?.agentSessionId).not.toBe(secondConversation);
    expect(listAgentMessages(database, thirdRun?.agentSessionId as string)).toHaveLength(1);
    expect(listScheduledTaskRuns(database, task.id)).toHaveLength(3);

    await engine.close();
  });

  it("isolates manual session model changes from future scheduled task runs", async () => {
    const { database, directory, task } = createFixture();
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
    });

    await engine.runNow(task.id);
    await waitForTerminalRun(database, task.id);
    const firstRun = listScheduledTaskRuns(database, task.id)[0];
    const firstConversation = firstRun?.agentSessionId as string;
    updateAgentSession(database, firstConversation, { model: "manually-selected" });
    updateScheduledTask(database, task.id, { model: "future-scheduled-model" });

    await engine.runNow(task.id);
    await waitForTerminalRun(database, task.id);
    const runs = listScheduledTaskRuns(database, task.id);
    const secondRun = runs.find((run) => run.agentSessionId !== firstConversation);
    expect(secondRun?.agentSessionId).not.toBe(firstConversation);
    expect(requireAgentSession(database, firstConversation).model).toBe("manually-selected");
    expect(requireAgentSession(database, secondRun?.agentSessionId as string).model).toBe(
      "future-scheduled-model",
    );
    await engine.close();
  });

  it("runs a system action through the injected executor", async () => {
    const { database, directory } = createFixture();
    const task = createScheduledTask(database, {
      name: "Checkpoint",
      cronExpression: "0 3 * * *",
      timezone: "UTC",
      prompt: "",
      workspacePath: join(directory, "workspace"),
      provider: "system",
      model: "system",
      reasoningEffort: "none",
      kind: "system",
      action: "knowledge.checkpoint",
      enabled: false,
    });
    let calls = 0;
    const workspaceRuns = new WorkspaceRunCoordinator();
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns,
      agentSessionsPath: join(directory, "agent-sessions"),
      executor: {
        async executeSystem(context) {
          calls += 1;
          expect(context.task.id).toBe(task.id);
          expect(context.task.action).toBe("knowledge.checkpoint");
        },
      },
    });

    const release = workspaceRuns.acquire(join(directory, "workspace"));
    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    expect(calls).toBe(1);
    release?.();
    await engine.close();
  });

  it("re-arms long-dated timers without overflowing Node's timeout", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
    const { database, directory } = createFixture();
    const task = createScheduledTask(database, {
      name: "Far future task",
      cronExpression: "0 3 * * *",
      timezone: "UTC",
      prompt: "wait",
      workspacePath: join(directory, "workspace"),
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      enabled: true,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    try {
      engine.start();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_SCHEDULER_TIMER_DELAY_MS);
      expect(listScheduledTaskRuns(database, task.id)).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await engine.close();
      vi.useRealTimers();
    }
  });
});
