import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime, AgentRuntimeEvent, AgentSessionSpec } from "@loongboard/agent-runtime";
import { openDatabase, type DatabaseClient } from "@loongboard/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { buildApp } from "../src/app.js";
import { KnowledgeController } from "../src/knowledge.js";
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
      yield { type: "assistant.completed", markdown: `echo: ${prompt}` };
      yield { type: "status", status: "idle" };
    },
    stop: async () => undefined,
    close: async () => undefined,
  };
}

function setup(): { app: FastifyInstance; knowledgePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-stage5-"));
  temporaryDirectories.push(directory);
  const knowledgePath = join(directory, "knowledge");
  mkdirSync(knowledgePath, { recursive: true });
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const agentChat = new AgentChatController({
    database,
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    knowledgePath,
    defaults: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high", idleProcessMinutes: 20 },
    runtimeFactory: () => recordedRuntime(),
  });
  const knowledge = new KnowledgeController({ database, knowledgePath, chats: agentChat });
  knowledge.start();
  const coordinator = {
    start: async () => ({ repositoryId: "x", syncRunId: "r", startedAt: "2026-09-03T00:00:00.000Z" }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp(
    { database, timezone: "Asia/Shanghai", syncCoordinator: coordinator, agentChat, knowledge },
    { logger: false },
  );
  apps.push(app);
  return { app, knowledgePath };
}

describe("Stage 5 knowledge routes", () => {
  it("creates, reads, saves versions, moves, restores, and deletes documents", async () => {
    const { app, knowledgePath } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge/documents",
      payload: { path: "notes/idea.md", title: "Idea", content: "first body" },
    });
    expect(created.statusCode).toBe(201);
    const doc = JSON.parse(created.body) as { id: string; path: string; content: string };
    expect(doc.id).toMatch(/^doc_/);
    expect(doc.content).toContain("loongboard_id: ");

    const tree = await app.inject({ method: "GET", url: "/api/knowledge/tree" });
    expect((JSON.parse(tree.body) as { items: Array<{ path: string }> }).items.map((i) => i.path)).toContain("notes/idea.md");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/knowledge/documents/${doc.id}`,
      payload: { content: "---\nloongboard_id: doc_x\n---\n\n# Idea\n\nsecond body" },
    });
    expect(updated.statusCode).toBe(200);
    expect((JSON.parse(updated.body) as { content: string }).content).toContain("second body");

    const versions = await app.inject({ method: "GET", url: `/api/knowledge/documents/${doc.id}/versions` });
    const versionItems = (JSON.parse(versions.body) as { items: Array<{ versionNumber: number; source: string }> }).items;
    expect(versionItems.map((item) => item.source)).toEqual(["manual", "manual"]);

    const moved = await app.inject({
      method: "POST",
      url: `/api/knowledge/documents/${doc.id}/move`,
      payload: { path: "notes/renamed.md" },
    });
    expect(moved.statusCode).toBe(200);
    expect((JSON.parse(moved.body) as { path: string }).path).toBe("notes/renamed.md");

    const fullVersions = await app.inject({ method: "GET", url: `/api/knowledge/documents/${doc.id}/versions` });
    const firstVersion = (JSON.parse(fullVersions.body) as { items: Array<{ id: string }> }).items.at(-1);
    const restore = await app.inject({
      method: "POST",
      url: `/api/knowledge/documents/${doc.id}/versions/${firstVersion?.id}/restore`,
    });
    expect(restore.statusCode).toBe(200);
    expect((JSON.parse(restore.body) as { content: string }).content).toContain("first body");

    const removed = await app.inject({ method: "DELETE", url: `/api/knowledge/documents/${doc.id}` });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(join(knowledgePath, "notes", "renamed.md"))).toBe(false);
  });

  it("adopts a front-matter-less file on its first save", async () => {
    const { app, knowledgePath } = setup();
    writeFileSync(join(knowledgePath, "legacy.md"), "# Legacy\n\nplain notes");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/knowledge/documents?path=legacy.md",
      payload: { content: "# Legacy\n\nplain notes edited" },
    });
    expect(saved.statusCode).toBe(200);
    const doc = JSON.parse(saved.body) as { id: string | null; path: string };
    expect(doc.path).toBe("legacy.md");
    expect(doc.id).toMatch(/^doc_/);

    const read = await app.inject({ method: "GET", url: "/api/knowledge/documents?path=legacy.md" });
    expect((JSON.parse(read.body) as { content: string }).content).toContain("plain notes edited");
  });
});
