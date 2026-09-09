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
  getScheduledTask,
  listAgentMessages,
  listScheduledTaskRuns,
  openDatabase,
  requireAgentSession,
  updateAgentSession,
  type DatabaseClient,
  type ScheduledTaskRow,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { SchedulerEngine } from "../src/scheduler.js";
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
      const scope = { kind: "general" as const, route: `scheduled-task:${input.taskId}` };
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

describe("SchedulerEngine conversation lifecycle", () => {
  it("reuses and recreates the task conversation after deletion", async () => {
    const { database, directory, task } = createFixture();
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
    });

    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    const firstTask = getScheduledTask(database, task.id);
    expect(firstTask?.conversationId).toBeTruthy();
    const firstConversation = firstTask?.conversationId as string;
    expect(listAgentMessages(database, firstConversation)).toHaveLength(1);

    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    expect(getScheduledTask(database, task.id)?.conversationId).toBe(firstConversation);
    expect(listAgentMessages(database, firstConversation)).toHaveLength(2);

    deleteAgentSession(database, firstConversation);
    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    const recoveredConversation = getScheduledTask(database, task.id)?.conversationId;
    expect(recoveredConversation).toBeTruthy();
    expect(recoveredConversation).not.toBe(firstConversation);
    expect(listAgentMessages(database, recoveredConversation as string)).toHaveLength(1);
    expect(listScheduledTaskRuns(database, task.id)).toHaveLength(3);

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
    const engine = new SchedulerEngine({
      database,
      chats: fakeChats(database),
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
      executor: {
        async executeSystem(context) {
          calls += 1;
          expect(context.task.id).toBe(task.id);
          expect(context.task.action).toBe("knowledge.checkpoint");
        },
      },
    });

    await engine.runNow(task.id);
    expect((await waitForTerminalRun(database, task.id)).status).toBe("completed");
    expect(calls).toBe(1);
    expect(getScheduledTask(database, task.id)?.conversationId).toBeNull();
    await engine.close();
  });
});
