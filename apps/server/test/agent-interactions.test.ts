import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  openDatabase,
  type DatabaseClient,
} from "@loongboard/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { buildTestApp } from "../src/app.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

class ApprovalRuntime implements AgentRuntime {
  readonly respondCalls: Array<{
    sessionId: string;
    requestId: string;
    value: unknown;
  }> = [];
  private responseResolve: (() => void) | undefined;
  private readonly response = new Promise<void>((resolve) => {
    this.responseResolve = resolve;
  });
  requestedResolve: (() => void) | undefined;
  readonly requested = new Promise<void>((resolve) => {
    this.requestedResolve = resolve;
  });

  async *run(
    _spec: AgentSessionSpec,
    _prompt: string,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.requestedResolve?.();
    yield {
      type: "interaction.requested",
      requestId: "approval-1",
      kind: "approval",
      title: "Allow shell?",
      description: "The command changes files.",
      options: [
        { id: "rejected", label: "Reject" },
        { id: "allowed-once", label: "Allow once" },
      ],
    };
    await this.response;
    yield { type: "interaction.resolved", requestId: "approval-1" };
    yield { type: "assistant.completed", markdown: "done" };
    yield { type: "status", status: "idle" };
  }

  async respond(sessionId: string, requestId: string, value: unknown): Promise<void> {
    this.respondCalls.push({ sessionId, requestId, value });
    this.responseResolve?.();
  }

  async stop(): Promise<void> {
    this.responseResolve?.();
  }

  async close(): Promise<void> {
    this.responseResolve?.();
  }
}

const databases: DatabaseClient[] = [];
const directories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(): {
  app: FastifyInstance;
  database: DatabaseClient;
  directory: string;
  controller: AgentChatController;
  runtime: ApprovalRuntime;
} {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-agent-interactions-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const runtime = new ApprovalRuntime();
  const controller = new AgentChatController({
    database,
    workspaceRuns: new WorkspaceRunCoordinator(),
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    knowledgePath: join(directory, "knowledge"),
    defaults: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      idleProcessMinutes: 0,
    },
    runtimeFactory: () => runtime,
  });
  const syncCoordinator = createSyncCoordinatorStub();
  const app = buildTestApp(
    { database, timezone: "UTC", syncCoordinator, agentChat: controller },
    { logger: false },
  );
  apps.push(app);
  return { app, database, directory, controller, runtime };
}

async function waitForIdle(
  controller: AgentChatController,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("approval turn did not finish");
}

describe("agent interaction response route", () => {
  it("requires an active runtime, forwards the value, and persists one resolution", async () => {
    const { app, controller, runtime } = createFixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { scope: { kind: "general", route: "chat" } },
    });
    expect(created.statusCode).toBe(200);
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      payload: { content: "run the command" },
    });
    expect(accepted.statusCode).toBe(201);
    await runtime.requested;

    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/interactions/approval-1`,
      payload: { value: "allowed-once" },
    });
    expect(response.statusCode).toBe(204);
    expect(runtime.respondCalls).toEqual([
      { sessionId, requestId: "approval-1", value: "allowed-once" },
    ]);

    await waitForIdle(controller, sessionId);
    const messages = controller.listMessages(sessionId).items;
    expect(messages.filter((message) => message.contentMarkdown.includes("Approval requested"))).toHaveLength(1);
    expect(messages.filter((message) => message.contentMarkdown.includes("Approval resolved"))).toHaveLength(1);
    expect(messages.at(-1)?.contentMarkdown).toBe("done");
    expect(messages.filter((message) => message.contentMarkdown === "Approval resolved: approval-1")).toHaveLength(1);

    await expect(
      controller.respond(sessionId, "approval-1", "rejected"),
    ).rejects.toMatchObject({ code: "AGENT_INTERACTION_UNAVAILABLE" });
  });
});
