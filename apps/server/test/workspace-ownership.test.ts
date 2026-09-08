import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";
import type { AgentScope } from "@loongboard/contracts";
import {
  openDatabase,
  reconcileRepositories,
  updateAgentSession,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import {
  WorktreePool,
  type AllocatedSlot,
  type AllocateSlotInput,
} from "@loongboard/git-workspace";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { buildApp } from "../src/app.js";
import { SchedulerEngine } from "../src/scheduler.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

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

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Blocks WorktreePool.allocate until open(), counting concurrent entries. */
class GatedWorktreePool extends WorktreePool {
  entries = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly entryWaiters: Array<() => void> = [];
  private opened = false;

  override async allocate(input: AllocateSlotInput): Promise<AllocatedSlot> {
    this.entries += 1;
    for (const resolve of this.entryWaiters.splice(0)) resolve();
    if (!this.opened) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return {
      slotName: "slot-01",
      slotPath: join(input.poolRoot, "slot-01"),
      created: true,
    };
  }

  async waitForEntry(): Promise<void> {
    if (this.entries > 0) return;
    await new Promise<void>((resolve) => this.entryWaiters.push(resolve));
  }

  open(): void {
    this.opened = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

function slowRuntime(delayMs = 250): () => AgentRuntime {
  return () => ({
    async *run(
      _spec: AgentSessionSpec,
      prompt: string,
    ): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "assistant.delta", text: "working " };
      await sleep(delayMs);
      yield { type: "assistant.completed", markdown: `echo: ${prompt}` };
      yield { type: "status", status: "idle" };
    },
    stop: async () => undefined,
    close: async () => undefined,
  });
}

interface SetupResult {
  app: FastifyInstance;
  database: DatabaseClient;
  directory: string;
  knowledgePath: string;
  scheduler?: SchedulerEngine;
  workspaceRuns: WorkspaceRunCoordinator;
}

function setup(options: {
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
  withScheduler?: boolean;
} = {}): SetupResult {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-workspace-ownership-"));
  temporaryDirectories.push(directory);
  const knowledgePath = join(directory, "knowledge");
  mkdirSync(knowledgePath, { recursive: true });
  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const workspaceRuns = new WorkspaceRunCoordinator();
  const agentChat = new AgentChatController({
    database,
    workspaceRuns,
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    knowledgePath,
    defaults: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      idleProcessMinutes: 20,
    },
    runtimeFactory: options.runtimeFactory ?? slowRuntime(),
  });
  let scheduler: SchedulerEngine | undefined;
  if (options.withScheduler === true) {
    scheduler = new SchedulerEngine({
      database,
      chats: agentChat,
      workspaceRuns,
      agentSessionsPath: join(directory, "agent-sessions"),
    });
  }
  const coordinator = {
    start: async () => ({
      repositoryId: "x",
      syncRunId: "r",
      startedAt: "2026-09-03T00:00:00.000Z",
    }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp(
    {
      database,
      timezone: "Asia/Shanghai",
      syncCoordinator: coordinator,
      agentChat,
      ...(scheduler !== undefined
        ? {
            scheduledTasks: {
              engine: scheduler,
              defaults: {
                provider: "deepseek-official",
                model: "deepseek-v4-flash",
                reasoningEffort: "high",
              },
            },
          }
        : {}),
    },
    { logger: false },
  );
  apps.push(app);
  return { app, database, directory, knowledgePath, scheduler, workspaceRuns };
}

async function createSession(
  app: FastifyInstance,
  scope: Record<string, unknown>,
): Promise<{ session: { id: string; workspacePath: string }; targetRevision: string | null; workspaceRevision: string | null }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-sessions",
    payload: { scope },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as {
    session: { id: string; workspacePath: string };
    targetRevision: string | null;
    workspaceRevision: string | null;
  };
}

async function waitForSession(
  app: FastifyInstance,
  sessionId: string,
  predicate: (body: { session: { status: string } }) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${sessionId}`,
    });
    const body = JSON.parse(response.body) as { session: { status: string } };
    if (predicate(body)) return;
    await sleep(20);
  }
  throw new Error(`Session ${sessionId} did not reach the expected state`);
}

async function waitForAssistant(
  app: FastifyInstance,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${sessionId}/messages`,
    });
    const items = (
      JSON.parse(response.body) as {
        items: Array<{ role: string }>;
      }
    ).items;
    if (items.some((item) => item.role === "assistant")) return;
    await sleep(20);
  }
  throw new Error(`Session ${sessionId} never produced an assistant message`);
}

function runGit(repositoryPath: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: repositoryPath,
    encoding: "utf8",
  }).trim();
}

interface PrSetupResult {
  app: FastifyInstance;
  controller: AgentChatController;
  shaA: string;
  shaB: string;
  runSpecs: AgentSessionSpec[];
  stopCalls: () => number;
}

function setupPrController(delayMs = 120, worktreePool?: WorktreePool): PrSetupResult {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-pr-workspace-"));
  temporaryDirectories.push(directory);
  const repositoryPath = join(directory, "repo");
  mkdirSync(repositoryPath, { recursive: true });
  runGit(repositoryPath, ["init", "-b", "main", "."]);
  runGit(repositoryPath, ['config', 'user.email "t@example.com"']);
  runGit(repositoryPath, ['config', 'user.name "Test"']);
  runGit(repositoryPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repositoryPath, "first.txt"), "one\n");
  runGit(repositoryPath, ["add", "-A"]);
  runGit(repositoryPath, ["commit", "-qm", "first"]);
  const shaA = runGit(repositoryPath, ["rev-parse", "HEAD"]);
  writeFileSync(join(repositoryPath, "second.txt"), "two\n");
  runGit(repositoryPath, ["add", "-A"]);
  runGit(repositoryPath, ["commit", "-qm", "second"]);
  const shaB = runGit(repositoryPath, ["rev-parse", "HEAD"]);

  const database = openDatabase(join(directory, "state.sqlite3"));
  databases.push(database);
  const configured: ConfiguredRepository = {
    key: "alpha",
    name: "Alpha",
    github: "acme/alpha",
    path: repositoryPath,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
  reconcileRepositories(database, [configured]);
  const pullRequests: PullRequestMetadata[] = [1, 2, 3].map((number) => ({
    nodeId: `pr_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/alpha/pull/${number}`,
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature",
    headSha: shaB,
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
  }));
  upsertPullRequestPage(database, "alpha", pullRequests);

  const runSpecs: AgentSessionSpec[] = [];
  let stopCalls = 0;
  const workspaceRuns = new WorkspaceRunCoordinator();
  const agentChat = new AgentChatController({
    database,
    workspaceRuns,
    agentSessionsPath: join(directory, "agent-sessions"),
    worktreesPath: join(directory, "worktrees"),
    ...(worktreePool !== undefined ? { worktreePool } : {}),
    defaults: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      idleProcessMinutes: 20,
    },
    runtimeFactory: () => ({
      async *run(spec: AgentSessionSpec, prompt: string): AsyncIterable<AgentRuntimeEvent> {
        runSpecs.push(spec);
        yield { type: "assistant.delta", text: "..." };
        if (delayMs > 0) await sleep(delayMs);
        yield { type: "assistant.completed", markdown: `echo: ${prompt}` };
        yield { type: "status", status: "idle" };
      },
      stop: async () => {
        stopCalls += 1;
      },
      close: async () => undefined,
    }),
  });
  const coordinator = {
    start: async () => ({
      repositoryId: "alpha",
      syncRunId: "r",
      startedAt: "2026-09-03T00:00:00.000Z",
    }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp(
    {
      database,
      timezone: "Asia/Shanghai",
      syncCoordinator: coordinator,
      agentChat,
    },
    { logger: false },
  );
  apps.push(app);
  return {
    app,
    controller: agentChat,
    shaA,
    shaB,
    runSpecs,
    stopCalls: () => stopCalls,
  };
}

describe("WorkspaceRunCoordinator", () => {
  it("owns one normalized path and releases idempotently", () => {
    const coordinator = new WorkspaceRunCoordinator();
    const path = join(tmpdir(), "coordinator", "workspace");
    const normalized = resolve(path);

    const release = coordinator.acquire(path);
    expect(release).not.toBeNull();
    expect(coordinator.isBusy(path)).toBe(true);
    expect(coordinator.acquire(`${normalized}/`)).toBeNull();

    release?.();
    release?.();
    expect(coordinator.isBusy(path)).toBe(false);
    expect(coordinator.acquire(normalized)).not.toBeNull();
  });

  it("allows different workspaces at the same time", () => {
    const coordinator = new WorkspaceRunCoordinator();
    const first = join(tmpdir(), "workspace-a");
    const second = join(tmpdir(), "workspace-b");
    const releaseFirst = coordinator.acquire(first);
    const releaseSecond = coordinator.acquire(second);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(coordinator.isBusy(first)).toBe(true);
    expect(coordinator.isBusy(second)).toBe(true);
    releaseFirst?.();
    releaseSecond?.();
  });
});

describe("Workspace ownership across agent runs", () => {
  it("rejects a second chat session on the same workspace while the first runs", async () => {
    const { app } = setup();
    const first = await createSession(app, { kind: "general" });
    const second = await createSession(app, { kind: "knowledge" });
    expect(first.session.workspacePath).toBe(second.session.workspacePath);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${first.session.id}/messages`,
      payload: { content: "first" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForSession(app, first.session.id, (body) => body.session.status === "running");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${second.session.id}/messages`,
      payload: { content: "second" },
    });
    expect(rejected.statusCode).toBe(409);
    const errorBody = JSON.parse(rejected.body) as { error: { code: string; message: string } };
    expect(errorBody.error.code).toBe("WORKSPACE_BUSY");
    expect(errorBody.error.message).toContain("already using the workspace");

    const secondMessages = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${second.session.id}/messages`,
    });
    expect(
      (JSON.parse(secondMessages.body) as { items: unknown[] }).items,
    ).toHaveLength(0);
    await waitForAssistant(app, first.session.id);
  });

  it("lets sessions in different workspaces run concurrently", async () => {
    const { app, database, directory } = setup();
    const first = await createSession(app, { kind: "general" });
    const second = await createSession(app, { kind: "knowledge" });
    const otherWorkspace = join(directory, "other-workspace");
    updateAgentSession(database, second.session.id, {
      workspacePath: otherWorkspace,
    });

    const firstAccepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${first.session.id}/messages`,
      payload: { content: "first" },
    });
    expect(firstAccepted.statusCode).toBe(201);
    await waitForSession(app, first.session.id, (body) => body.session.status === "running");

    const secondAccepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${second.session.id}/messages`,
      payload: { content: "second" },
    });
    expect(secondAccepted.statusCode).toBe(201);
    await waitForSession(app, second.session.id, (body) => body.session.status === "running");
    expect(
      (await app.inject({
        method: "GET",
        url: `/api/agent-sessions/${first.session.id}`,
      })).statusCode,
    ).toBe(200);
    await Promise.all([
      waitForAssistant(app, first.session.id),
      waitForAssistant(app, second.session.id),
    ]);
  });

  it("keeps a scheduled run out of a workspace claimed by a manual chat", async () => {
    const { app, knowledgePath } = setup({ withScheduler: true });
    const chat = await createSession(app, { kind: "general" });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${chat.session.id}/messages`,
      payload: { content: "manual turn" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForSession(app, chat.session.id, (body) => body.session.status === "running");

    const task = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        name: "Conflict check",
        cronExpression: "0 3 * * *",
        timezone: "UTC",
        prompt: "write report",
        workspacePath: knowledgePath,
      },
    });
    expect(task.statusCode).toBe(201);
    const taskId = (JSON.parse(task.body) as { id: string }).id;

    const run = await app.inject({
      method: "POST",
      url: `/api/scheduled-tasks/${taskId}/run`,
    });
    expect(run.statusCode).toBe(409);
    const errorBody = JSON.parse(run.body) as { error: { code: string } };
    expect(errorBody.error.code).toBe("SCHEDULED_TASK_WORKSPACE_BUSY");
    const runs = await app.inject({
      method: "GET",
      url: `/api/scheduled-tasks/${taskId}/runs`,
    });
    expect(
      (JSON.parse(runs.body) as { items: unknown[] }).items,
    ).toHaveLength(0);

    await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${taskId}` });
    await waitForAssistant(app, chat.session.id);
  });

  it("defers a due scheduled fire without creating a run when the workspace is busy", async () => {
    const { app, knowledgePath, scheduler } = setup({ withScheduler: true });
    const engine = scheduler as SchedulerEngine;
    const chat = await createSession(app, { kind: "general" });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${chat.session.id}/messages`,
      payload: { content: "manual turn" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForSession(app, chat.session.id, (body) => body.session.status === "running");

    const task = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        name: "Fire defer check",
        cronExpression: "0 3 * * *",
        timezone: "UTC",
        prompt: "write report",
        workspacePath: knowledgePath,
      },
    });
    const taskId = (JSON.parse(task.body) as { id: string; nextRunAt: string | null }).id;
    engine.refreshIfArmed(taskId);

    const fire = (
      engine as unknown as {
        fire: (taskIdValue: string) => Promise<void>;
      }
    ).fire.bind(engine);
    await fire(taskId);

    const runs = await app.inject({
      method: "GET",
      url: `/api/scheduled-tasks/${taskId}/runs`,
    });
    expect(
      (JSON.parse(runs.body) as { items: unknown[] }).items,
    ).toHaveLength(0);

    engine.refreshIfArmed(taskId);
    await app.inject({ method: "DELETE", url: `/api/scheduled-tasks/${taskId}` });
    await waitForAssistant(app, chat.session.id);
  });
});

describe("Concurrent PR session creation", () => {
  it("coalesces duplicate creates for the same scope into one allocation", async () => {
    const pool = new GatedWorktreePool();
    const { controller, shaB } = setupPrController(0, pool);
    const scope: AgentScope = {
      kind: "pr",
      repositoryId: "alpha",
      prNumber: 1,
      targetSha: shaB,
    };

    const first = controller.ensureSession({ scope });
    await pool.waitForEntry();
    const second = controller.ensureSession({ scope });
    // The second StrictMode-style open must reuse the in-flight creation;
    // the old code path reaches WorktreePool.allocate again before returning.
    expect(pool.entries).toBe(1);
    pool.open();

    const [firstView, secondView] = await Promise.all([first, second]);
    expect(firstView.session.id).toBe(secondView.session.id);
    expect(firstView.session.workspacePath).toBe(secondView.session.workspacePath);
    expect(pool.entries).toBe(1);
  });
});

describe("PR workspace revision safety", () => {
  it("rejects a message when the worktree is off revision, syncs, then accepts", async () => {
    const { app, shaA, shaB, runSpecs } = setupPrController(0);
    const created = await createSession(app, {
      kind: "pr",
      repositoryId: "alpha",
      prNumber: 1,
      targetSha: shaB,
    });
    expect(created.workspaceRevision).toBe(shaB);
    const slotPath = created.session.workspacePath;

    // Simulate a reused worktree left on an older revision.
    runGit(slotPath, ["checkout", "-q", shaA]);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/messages`,
      payload: { content: "still on old code?" },
    });
    expect(rejected.statusCode).toBe(409);
    const errorBody = JSON.parse(rejected.body) as {
      error: { code: string; message: string };
    };
    expect(errorBody.error.code).toBe("WORKSPACE_REVISION_MISMATCH");
    expect(errorBody.error.message).toContain(
      "Sync the workspace before continuing this chat.",
    );

    const messagesBeforeSync = await app.inject({
      method: "GET",
      url: `/api/agent-sessions/${created.session.id}/messages`,
    });
    expect(
      (JSON.parse(messagesBeforeSync.body) as { items: unknown[] }).items,
    ).toHaveLength(0);

    const synced = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/workspace`,
    });
    expect(synced.statusCode).toBe(200);
    const syncedView = JSON.parse(synced.body) as {
      session: { id: string; workspacePath: string };
      workspaceRevision: string | null;
    };
    expect(syncedView.workspaceRevision).toBe(shaB);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/messages`,
      payload: { content: "on the right code now" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForAssistant(app, created.session.id);
    expect(runSpecs).toHaveLength(1);
    expect(runSpecs[0]?.workspacePath).toBe(syncedView.session.workspacePath);
  });

  it("stops the old host process before sync and runs the next turn on the synced path", async () => {
    const { app, shaA, shaB, runSpecs, stopCalls } = setupPrController(0);
    const created = await createSession(app, {
      kind: "pr",
      repositoryId: "alpha",
      prNumber: 2,
      targetSha: shaB,
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/messages`,
      payload: { content: "first" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForAssistant(app, created.session.id);
    expect(runSpecs).toHaveLength(1);
    expect(stopCalls()).toBe(0);

    runGit(created.session.workspacePath, ["checkout", "-q", shaA]);
    const synced = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/workspace`,
    });
    expect(synced.statusCode).toBe(200);
    expect(stopCalls()).toBe(1);
    const syncedView = JSON.parse(synced.body) as {
      session: { id: string; workspacePath: string };
      workspaceRevision: string | null;
    };
    expect(syncedView.workspaceRevision).toBe(shaB);

    const second = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/messages`,
      payload: { content: "second" },
    });
    expect(second.statusCode).toBe(201);
    await waitForAssistant(app, created.session.id);
    expect(runSpecs).toHaveLength(2);
    expect(runSpecs[1]?.workspacePath).toBe(syncedView.session.workspacePath);
    expect(stopCalls()).toBe(1);
  });

  it("rejects sync while a turn is running without stopping the host", async () => {
    const { app, shaB, stopCalls } = setupPrController(250);
    const created = await createSession(app, {
      kind: "pr",
      repositoryId: "alpha",
      prNumber: 3,
      targetSha: shaB,
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/messages`,
      payload: { content: "slow" },
    });
    expect(accepted.statusCode).toBe(201);
    await waitForSession(app, created.session.id, (body) => body.session.status === "running");

    const synced = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${created.session.id}/workspace`,
    });
    expect(synced.statusCode).toBe(409);
    const syncError = JSON.parse(synced.body) as { error: { code: string } };
    expect(syncError.error.code).toBe("AGENT_TURN_BUSY");
    expect(stopCalls()).toBe(0);
    await waitForAssistant(app, created.session.id);
  });
});
