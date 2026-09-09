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
  type DatabaseClient,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

type Outcome = "success-without-text" | "error-after-text";

class LifecycleRuntime implements AgentRuntime {
  readonly specs: AgentSessionSpec[] = [];
  private runCount = 0;

  constructor(private readonly outcomes: readonly Outcome[]) {}

  async *run(spec: AgentSessionSpec, _prompt: string): AsyncIterable<AgentRuntimeEvent> {
    this.specs.push(spec);
    const outcome = this.outcomes[Math.min(this.runCount, this.outcomes.length - 1)];
    this.runCount += 1;
    yield { type: "status", status: "starting" };
    yield { type: "status", status: "running" };
    yield {
      type: "agent.activity",
      kind: "command",
      phase: "completed",
      id: `command-${this.runCount}`,
      title: "runtime command",
    };
    if (outcome === "error-after-text") {
      yield { type: "assistant.completed", markdown: "partial answer" };
      yield { type: "error", message: "native turn failed" };
    }
    yield { type: "status", status: "idle" };
  }

  runtimeSessionId(_sessionId: string): string {
    return "opaque-native-session";
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

function createFixture(outcomes: readonly Outcome[]): {
  controller: AgentChatController;
  database: DatabaseClient;
  runtime: LifecycleRuntime;
} {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-agent-chat-lifecycle-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const runtime = new LifecycleRuntime(outcomes);
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

async function createAndRun(
  controller: AgentChatController,
  prompt: string,
): Promise<string> {
  const created = await controller.ensureSession({
    scope: { kind: "general", route: prompt },
  });
  await controller.acceptMessage(created.session.id, prompt);
  await waitForTurn(controller, created.session.id);
  return created.session.id;
}

describe("AgentChatController native turn lifecycle", () => {
  it("marks a no-text native command success idle and retains its opaque id", async () => {
    const { controller, database, runtime } = createFixture(["success-without-text"]);
    const sessionId = await createAndRun(controller, "/status");

    const session = controller.require(sessionId);
    expect(session.status).toBe("idle");
    expect(session.dshSessionId).toBe("opaque-native-session");
    expect(listAgentMessages(database, sessionId)).toHaveLength(1);
    expect(runtime.specs[0]?.runtimeSessionId).toBeUndefined();

    await controller.close();
  });

  it("marks an error after partial text failed while retaining and reusing context", async () => {
    const { controller, runtime } = createFixture([
      "error-after-text",
      "success-without-text",
    ]);
    const firstSessionId = await createAndRun(controller, "first");
    expect(controller.require(firstSessionId).status).toBe("error");
    expect(controller.require(firstSessionId).dshSessionId).toBe("opaque-native-session");

    await controller.updateSession(firstSessionId, { model: "deepseek-v4-reasoner" });
    await controller.acceptMessage(firstSessionId, "retry");
    await waitForTurn(controller, firstSessionId);
    expect(runtime.specs[1]?.runtimeSessionId).toBe("opaque-native-session");
    expect(runtime.specs[1]?.model).toBe("deepseek-v4-reasoner");
    expect(controller.require(firstSessionId).status).toBe("idle");

    await controller.close();
  });
});
