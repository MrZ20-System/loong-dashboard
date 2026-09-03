import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime, AgentRuntimeEvent, AgentSessionSpec } from "@loongboard/agent-runtime";
import { openDatabase, type DatabaseClient } from "@loongboard/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { buildApp } from "../src/app.js";
import { SchedulerEngine } from "../src/scheduler.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function recordedRuntime(): AgentRuntime {
  return {
    async *run(_spec: AgentSessionSpec, prompt: string): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "assistant.completed", markdown: `ran: ${prompt}` };
      yield { type: "status", status: "idle" };
    },
    stop: async () => undefined,
    close: async () => undefined,
  };
}

function setup(): { app: FastifyInstance; workspace: string } {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-stage6-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "knowledge"), { recursive: true });
  mkdirSync(join(directory, "workspace"), { recursive: true });
  const workspace = join(directory, "workspace");
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const agentChat = new AgentChatController({
    database,
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    knowledgePath: join(directory, "knowledge"),
    defaults: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high", idleProcessMinutes: 20 },
    runtimeFactory: () => recordedRuntime(),
  });
  const scheduler = new SchedulerEngine({
    database,
    chats: agentChat,
    agentSessionsPath: join(directory, "agent-sessions"),
  });
  const coordinator = {
    start: async () => ({ repositoryId: "x", syncRunId: "r", startedAt: "2026-09-03T00:00:00.000Z" }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp(
    {
      database,
      timezone: "Asia/Shanghai",
      syncCoordinator: coordinator,
      agentChat,
      scheduledTasks: {
        engine: scheduler,
        defaults: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" },
      },
    },
    { logger: false },
  );
  apps.push(app);
  return { app, workspace };
}

async function waitForRun(
  app: FastifyInstance,
  taskId: string,
  runId: string,
  predicate: (status: string) => boolean,
): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}/runs` });
    const items = (JSON.parse(response.body) as { items: Array<{ id: string; status: string; error: string | null }> }).items;
    const current = items.find((item) => item.id === runId);
    if (current !== undefined) {
      last = current.status;
      if (predicate(current.status)) return current.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

describe("Stage 6 scheduler routes", () => {
  it("creates, updates, runs to completion, and lists history", async () => {
    const { app, workspace } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        name: "Daily digest",
        cronExpression: "0 3 * * *",
        timezone: "Asia/Shanghai",
        prompt: "Write today's digest to knowledge/inbox/digest.md",
        workspacePath: workspace,
      },
    });
    expect(created.statusCode).toBe(201);
    const task = JSON.parse(created.body) as { id: string; nextRunAt: string | null; enabled: boolean };
    expect(task.id).toMatch(/^task_/);
    expect(task.nextRunAt).not.toBeNull();

    const disabled = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${task.id}`,
      payload: { enabled: false },
    });
    expect((JSON.parse(disabled.body) as { enabled: boolean; nextRunAt: string | null }).enabled).toBe(false);

    const reenabled = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${task.id}`,
      payload: { enabled: true },
    });
    expect((JSON.parse(reenabled.body) as { enabled: boolean }).enabled).toBe(true);

    const run = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${task.id}/run` });
    expect(run.statusCode).toBe(202);
    const accepted = JSON.parse(run.body) as { runId: string; status: string };
    expect(accepted.status).toBe("accepted");

    const status = await waitForRun(app, task.id, accepted.runId, (value) => value === "completed");
    expect(status).toBe("completed");

    const runs = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${task.id}/runs` });
    const items = (JSON.parse(runs.body) as { items: Array<{ id: string; status: string }> }).items;
    expect(items.some((item) => item.status === "completed")).toBe(true);

    const removed = await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${task.id}` });
    expect(removed.statusCode).toBe(200);
  });

  it("sends the prompt verbatim as the agent user message", async () => {
    const { app, workspace } = setup();
    const prompt = "Exact scheduled prompt text (no reformatting)";
    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        name: "Prompt check",
        cronExpression: "0 4 * * *",
        timezone: "UTC",
        prompt,
        workspacePath: workspace,
      },
    });
    const taskId = (JSON.parse(created.body) as { id: string }).id;
    const run = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/run` });
    const accepted = JSON.parse(run.body) as { runId: string };
    expect(await waitForRun(app, taskId, accepted.runId, (value) => value === "completed")).toBe("completed");

    const runs = await app.inject({ method: "GET", url: `/api/scheduled-tasks/${taskId}/runs` });
    const sessionId = (JSON.parse(runs.body) as { items: Array<{ agentSessionId: string | null }> }).items[0]?.agentSessionId;
    expect(sessionId).not.toBeNull();
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const items = (JSON.parse(messages.body) as { items: Array<{ role: string; contentMarkdown: string }> }).items;
    expect(items[0]?.role).toBe("user");
    expect(items[0]?.contentMarkdown).toBe(prompt);
  });

  it("rejects an unknown task and reports 404", async () => {
    const { app } = setup();
    const missing = await app.inject({ method: "POST", url: "/api/scheduled-tasks/nope/run" });
    expect(missing.statusCode).toBe(404);
    expect((JSON.parse(missing.body) as { error: { code: string } }).error.code).toBe("SCHEDULED_TASK_NOT_FOUND");
  });
});
