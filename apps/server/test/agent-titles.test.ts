import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  listAgentMessages,
  openDatabase,
  requireAgentSession,
  type DatabaseClient,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

class TitleRuntime implements AgentRuntime {
  getTitleCalls = 0;
  renameCalls = 0;
  private runCount = 0;

  constructor(
    private readonly outcome: "success" | "empty" | "failure",
    private readonly renameFails = false,
  ) {}

  async *run(
    _spec: AgentSessionSpec,
    _prompt: string,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.runCount += 1;
    yield { type: "status", status: "starting" };
    yield { type: "status", status: "running" };
    if (this.outcome !== "empty") {
      yield {
        type: "assistant.completed",
        markdown: this.outcome === "failure" ? "partial answer" : `answer ${this.runCount}`,
      };
    }
    if (this.outcome === "failure") {
      yield { type: "error", message: "native turn failed" };
    }
    yield { type: "status", status: "idle" };
  }

  runtimeSessionId(): string {
    return "opaque-native-session";
  }

  async getTitle(): Promise<{ title: string }> {
    this.getTitleCalls += 1;
    return { title: "Native conversation title" };
  }

  async rename(_sessionId: string, title: string): Promise<{ title: string }> {
    this.renameCalls += 1;
    if (this.renameFails) throw new Error("runtime rename failed");
    return { title };
  }

  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

const databases: DatabaseClient[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(
  outcome: "success" | "empty" | "failure" = "success",
  renameFails = false,
): { controller: AgentChatController; database: DatabaseClient; runtime: TitleRuntime } {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-agent-titles-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const runtime = new TitleRuntime(outcome, renameFails);
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
      idleProcessMinutes: 120,
    },
    runtimeFactory: () => runtime,
  });
  return { controller, database, runtime };
}

async function waitForTurn(controller: AgentChatController, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("agent turn did not finish");
}

async function waitForTitle(runtime: TitleRuntime): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.getTitleCalls > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("native title was not requested");
}

describe("AgentChatController conversation titles", () => {
  it("discovers a first successful title once without adding a title prompt", async () => {
    const { controller, database, runtime } = fixture();
    const created = await controller.ensureSession({ scope: { kind: "general", route: "title-once" } });
    expect(created.session.titleSource).toBe("provisional");

    await controller.acceptMessage(created.session.id, "first user message");
    await waitForTurn(controller, created.session.id);
    await waitForTitle(runtime);
    expect(runtime.getTitleCalls).toBe(1);
    expect(requireAgentSession(database, created.session.id)).toMatchObject({
      title: "Native conversation title",
      titleSource: "generated",
    });
    expect(listAgentMessages(database, created.session.id).map((message) => message.contentMarkdown)).toEqual([
      "first user message",
      "answer 1",
    ]);

    await controller.acceptMessage(created.session.id, "second user message");
    await waitForTurn(controller, created.session.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.getTitleCalls).toBe(1);
    await controller.close();
  });

  it("does not discover an empty or failed turn title", async () => {
    const empty = fixture("empty");
    const emptySession = await empty.controller.ensureSession({ scope: { kind: "general", route: "empty" } });
    await empty.controller.acceptMessage(emptySession.session.id, "empty result");
    await waitForTurn(empty.controller, emptySession.session.id);
    expect(empty.runtime.getTitleCalls).toBe(0);
    await empty.controller.close();

    const failed = fixture("failure");
    const failedSession = await failed.controller.ensureSession({ scope: { kind: "general", route: "failed" } });
    await failed.controller.acceptMessage(failedSession.session.id, "failed result");
    await waitForTurn(failed.controller, failedSession.session.id);
    expect(failed.runtime.getTitleCalls).toBe(0);
    expect(requireAgentSession(failed.database, failedSession.session.id).status).toBe("error");
    await failed.controller.close();
  });

  it("keeps a local manual rename successful when the runtime rename fails", async () => {
    const { controller, database, runtime } = fixture("success", true);
    const created = await controller.ensureSession({ scope: { kind: "general", route: "manual" } });
    await controller.acceptMessage(created.session.id, "start runtime");
    await waitForTurn(controller, created.session.id);
    await waitForTitle(runtime);

    const updated = await controller.updateSession(created.session.id, { title: "Local manual title" });
    expect(updated.session.title).toBe("Local manual title");
    expect(updated.session.titleSource).toBe("manual");
    expect(runtime.renameCalls).toBe(1);
    expect(requireAgentSession(database, created.session.id).titleSource).toBe("manual");
    await controller.close();
  });

  it("does not let native title discovery overwrite a manual title", async () => {
    const { controller, database, runtime } = fixture();
    const created = await controller.ensureSession({ scope: { kind: "general", route: "manual-before-native" } });
    const updated = await controller.updateSession(created.session.id, { title: "Manual title" });
    expect(updated.session.titleSource).toBe("manual");

    await controller.acceptMessage(created.session.id, "first user message");
    await waitForTurn(controller, created.session.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(runtime.getTitleCalls).toBe(0);
    expect(requireAgentSession(database, created.session.id)).toMatchObject({
      title: "Manual title",
      titleSource: "manual",
    });
    await controller.close();
  });

  it("creates each scheduled occurrence with its own provisional task title", async () => {
    const { controller } = fixture();
    const first = await controller.ensureScheduledSession({
      taskId: "task-1",
      runId: "run-1",
      workspacePath: "/tmp/workspace",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      title: "Nightly review",
    });
    const second = await controller.ensureScheduledSession({
      taskId: "task-1",
      runId: "run-2",
      workspacePath: "/tmp/workspace",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      title: "Nightly review",
    });
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ title: "Nightly review", titleSource: "provisional" });
    expect(second).toMatchObject({ title: "Nightly review", titleSource: "provisional" });
    await controller.close();
  });
});
