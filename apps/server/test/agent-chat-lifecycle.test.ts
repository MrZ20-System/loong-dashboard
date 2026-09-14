import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  findAgentSession,
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
  readonly capabilitySpecs: AgentSessionSpec[] = [];
  stopCalls = 0;
  stopHook: (() => void) | undefined;
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

  async discoverCapabilities(spec: AgentSessionSpec) {
    this.capabilitySpecs.push(spec);
    return {
      runtimeKind: "test",
      version: "test",
      profile: "test",
      connected: true,
      models: [],
      reasoning: [],
      commands: [],
      features: [],
      discovery: "runtime" as const,
      discoveredAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopHook?.();
  }

  async close(): Promise<void> {}
}

class BlockingRuntime implements AgentRuntime {
  readonly started: Promise<void>;
  private startedResolve: (() => void) | undefined;
  private readonly release: Promise<void>;
  private releaseResolve: (() => void) | undefined;
  stopCalls = 0;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    this.release = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
  }

  async *run(_spec: AgentSessionSpec, _prompt: string): AsyncIterable<AgentRuntimeEvent> {
    this.startedResolve?.();
    yield { type: "status", status: "starting" };
    yield { type: "status", status: "running" };
    await this.release;
    yield { type: "status", status: "idle" };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.releaseResolve?.();
  }

  async close(): Promise<void> {
    this.releaseResolve?.();
  }
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
  directory: string;
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
  return { controller, database, runtime, directory };
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
  it("uses an existing fallback workspace before Personal Data is imported", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loongboard-agent-chat-unimported-personal-data-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "state.sqlite3"));
    databases.push(database);
    const runtime = new LifecycleRuntime(["success-without-text"]);
    const personalDataPath = join(directory, "personal-data");
    const controller = new AgentChatController({
      database,
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(directory, "agent-sessions"),
      worktreesPath: join(directory, "worktrees"),
      personalDataPath,
      knowledgePath: join(personalDataPath, "knowledge"),
      defaults: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        idleProcessMinutes: 120,
      },
      runtimeFactory: () => runtime,
    });

    const created = await controller.ensureSession({ scope: { kind: "general", route: "before-import" } });
    expect(created.session.workspacePath).toBe(process.cwd());
    expect(existsSync(personalDataPath)).toBe(false);
    await expect(controller.discoverCapabilities()).resolves.toMatchObject({ connected: true });
    expect(runtime.capabilitySpecs[0]?.workspacePath).toBe(process.cwd());
    expect(existsSync(personalDataPath)).toBe(false);

    await controller.close();
  });

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

  it("stops the runtime, deletes DB data, and removes only the session DSH home", async () => {
    const { controller, database, runtime } = createFixture(["success-without-text"]);
    const sessionId = await createAndRun(controller, "delete me");
    const sessionDir = dirname(controller.require(sessionId).dshHomePath);
    const dshHome = controller.require(sessionId).dshHomePath;
    writeFileSync(join(dshHome, "runtime-state.json"), "private");
    let sessionExistedWhenStopped = false;
    runtime.stopHook = () => {
      sessionExistedWhenStopped = controller.require(sessionId).id === sessionId;
    };

    await expect(controller.deleteSession(sessionId)).resolves.toEqual({ deleted: true });
    expect(runtime.stopCalls).toBe(1);
    expect(sessionExistedWhenStopped).toBe(true);
    expect(existsSync(dshHome)).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);
    expect(findAgentSession(database, { kind: "general", route: "delete me" })).toBeNull();
    expect(() => controller.require(sessionId)).toThrow();
    await controller.close();
  });

  it("refuses to delete a running session and leaves its DSH home intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "loongboard-agent-chat-running-delete-"));
    directories.push(directory);
    const database = openDatabase(join(directory, "state.sqlite3"));
    databases.push(database);
    const runtime = new BlockingRuntime();
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
    const created = await controller.ensureSession({ scope: { kind: "general", route: "running-delete" } });
    await controller.acceptMessage(created.session.id, "hold");
    await runtime.started;
    const dshHome = controller.require(created.session.id).dshHomePath;
    expect(existsSync(dshHome)).toBe(true);

    await expect(controller.deleteSession(created.session.id)).rejects.toMatchObject({ code: "AGENT_TURN_BUSY" });
    expect(runtime.stopCalls).toBe(0);
    expect(existsSync(dshHome)).toBe(true);
    await runtime.stop();
    await waitForTurn(controller, created.session.id);
    await controller.close();
  });

  it("allows deletion when the DSH home does not exist", async () => {
    const { controller, runtime } = createFixture(["success-without-text"]);
    const created = await controller.ensureSession({ scope: { kind: "general", route: "missing-home" } });
    const dshHome = created.session.dshHomePath;
    expect(existsSync(dshHome)).toBe(false);
    await expect(controller.deleteSession(created.session.id)).resolves.toEqual({ deleted: true });
    expect(runtime.stopCalls).toBe(0);
    await controller.close();
  });

  it("fails closed for session-directory symlinks and preserves the external sentinel", async () => {
    const { controller, database, directory } = createFixture(["success-without-text"]);
    const created = await controller.ensureSession({ scope: { kind: "general", route: "symlink-home" } });
    const sessionDir = dirname(created.session.dshHomePath);
    const outside = join(directory, "outside");
    mkdirSync(dirname(sessionDir), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel"), "keep");
    rmSync(sessionDir, { recursive: true, force: true });
    symlinkSync(outside, sessionDir, "dir");

    await expect(controller.deleteSession(created.session.id)).rejects.toThrow(
      "session directory is not a real directory",
    );
    expect(existsSync(join(outside, "sentinel"))).toBe(true);
    expect(() => controller.require(created.session.id)).not.toThrow();
    expect(listAgentMessages(database, created.session.id)).toHaveLength(0);

    const targetLink = await controller.ensureSession({ scope: { kind: "general", route: "symlink-target" } });
    const targetSessionDir = dirname(targetLink.session.dshHomePath);
    const targetOutside = join(directory, "target-outside");
    mkdirSync(targetSessionDir, { recursive: true });
    mkdirSync(targetOutside, { recursive: true });
    writeFileSync(join(targetOutside, "sentinel"), "keep");
    symlinkSync(targetOutside, targetLink.session.dshHomePath, "dir");
    await expect(controller.deleteSession(targetLink.session.id)).rejects.toThrow(
      "dsh-home is not a real directory",
    );
    expect(existsSync(join(targetOutside, "sentinel"))).toBe(true);
    expect(() => controller.require(targetLink.session.id)).not.toThrow();
    await controller.close();
  });
});
