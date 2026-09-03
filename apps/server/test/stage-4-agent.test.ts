import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";
import { openDatabase, type DatabaseClient } from "@loongboard/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { buildApp } from "../src/app.js";
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

function makeController(runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime): { controller: AgentChatController; app: FastifyInstance } {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-stage4-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const controller = new AgentChatController({
    database,
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    defaults: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high", idleProcessMinutes: 20 },
    runtimeFactory: runtimeFactory ?? (() => recordedRuntime()),
  });
  const coordinator = {
    start: async () => ({ repositoryId: "x", syncRunId: "r", startedAt: "2026-09-03T00:00:00.000Z" }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp({ database, timezone: "Asia/Shanghai", syncCoordinator: coordinator, agentChat: controller }, { logger: false });
  apps.push(app);
  return { controller, app };
}

function recordedRuntime(): AgentRuntime {
  return {
    async *run(_spec: AgentSessionSpec, prompt: string): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "assistant.delta", text: "thinking " };
      yield { type: "assistant.completed", markdown: `echo: ${prompt}` };
      yield { type: "status", status: "idle" };
    },
    stop: async () => undefined,
    close: async () => undefined,
  };
}

async function waitForMessages(app: FastifyInstance, sessionId: string, predicate: (items: Array<{ role: string; contentMarkdown: string }>) => boolean): Promise<Array<{ role: string; contentMarkdown: string }>> {
  let last: Array<{ role: string; contentMarkdown: string }> = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const body = JSON.parse(response.body) as { items: Array<{ role: string; contentMarkdown: string }> };
    last = body.items;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

describe("Stage 4 agent chat routes", () => {
  it("creates a session for a general scope and returns a validated summary", async () => {
    const { app } = makeController();
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { scope: { kind: "general" } },
    });
    expect(created.statusCode).toBe(200);
    const body = JSON.parse(created.body) as {
      session: { id: string; status: string; model: string; workspacePath: string };
    };
    expect(body.session.status).toBe("idle");
    expect(body.session.model).toBe("deepseek-v4-flash");
    expect(body.session.workspacePath.length).toBeGreaterThan(0);

    const missing = await app.inject({ method: "GET", url: "/api/agent-sessions/nope/messages" });
    expect(missing.statusCode).toBe(404);
    const missingError = JSON.parse(missing.body) as { error: { code: string } };
    expect(missingError.error.code).toBe("AGENT_SESSION_NOT_FOUND");
  });

  it("persists user and assistant messages across a recorded runtime turn", async () => {
    const { app } = makeController();
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { scope: { kind: "general" } },
    });
    const session = (JSON.parse(created.body) as { session: { id: string } }).session;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.id}/messages`,
      payload: { content: "explain this PR" },
    });
    expect(accepted.statusCode).toBe(201);
    expect((JSON.parse(accepted.body) as { status: string }).status).toBe("accepted");

    const messages = await waitForMessages(app, session.id, (items) =>
      items.some((message) => message.role === "assistant"),
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.contentMarkdown).toBe("echo: explain this PR");
  });

  it("rejects a second message while a turn is running", async () => {
    const slowRuntime = (): AgentRuntime => ({
      async *run(_spec: AgentSessionSpec, prompt: string): AsyncIterable<AgentRuntimeEvent> {
        yield { type: "assistant.delta", text: "..." };
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield { type: "assistant.completed", markdown: `echo: ${prompt}` };
        yield { type: "status", status: "idle" };
      },
      stop: async () => undefined,
      close: async () => undefined,
    });
    const { app } = makeController(slowRuntime);
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { scope: { kind: "general" } },
    });
    const session = (JSON.parse(created.body) as { session: { id: string } }).session;
    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.id}/messages`,
      payload: { content: "first" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.id}/messages`,
      payload: { content: "second" },
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_TURN_BUSY");
    await waitForMessages(app, session.id, (items) => items.some((message) => message.role === "assistant"));
  });

  it("marks a cancelled session as interrupted", async () => {
    const { app } = makeController();
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { scope: { kind: "general" } },
    });
    const session = (JSON.parse(created.body) as { session: { id: string } }).session;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${session.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    const body = JSON.parse(cancelled.body) as { session: { status: string } };
    expect(body.session.status).toBe("interrupted");
  });
});
