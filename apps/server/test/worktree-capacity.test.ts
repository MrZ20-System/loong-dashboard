import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime, AgentRuntimeEvent, AgentSessionSpec } from "@loongboard/agent-runtime";
import {
  createAgentSession,
  listWorktreeSlots,
  openDatabase,
  recordWorktreeSlotUse,
  reconcileRepositories,
  updateAgentSession,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import { GitCommandError, WorktreePool } from "@loongboard/git-workspace";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import {
  WorktreeMaintenanceService,
} from "../src/worktree-maintenance.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];
const controllers: AgentChatController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runtime(): AgentRuntime {
  return {
    async *run(_spec: AgentSessionSpec, _prompt: string): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "status", status: "idle" };
    },
    stop: async () => undefined,
    close: async () => undefined,
  };
}

function pullRequest(number: number, sha: string): PullRequestMetadata {
  return {
    nodeId: `pr_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/alpha/pull/${number}`,
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature",
    headSha: sha,
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
  };
}

function repositoryFixture(slotCount = 2): {
  root: string;
  repoPath: string;
  database: DatabaseClient;
  sha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "loongboard-worktree-capacity-"));
  directories.push(root);
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main", "."]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  git(repoPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "tracked.txt"), "tracked\n");
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-qm", "seed"]);
  const sha = git(repoPath, ["rev-parse", "HEAD"]);
  const database = openDatabase(join(root, "state.sqlite3"));
  databases.push(database);
  const configured: ConfiguredRepository = {
    key: "alpha",
    name: "Alpha",
    github: "acme/alpha",
    path: repoPath,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: slotCount,
  };
  reconcileRepositories(database, [configured]);
  upsertPullRequestPage(database, "alpha", [pullRequest(1, sha), pullRequest(2, sha), pullRequest(3, sha)]);
  return { root, repoPath, database, sha };
}

describe("dynamic worktree capacity", () => {
  it("uses the Settings resolver for later allocations while preserving an existing session lock", async () => {
    const fixture = repositoryFixture();
    let capacity = 1;
    const workspaceRuns = new WorkspaceRunCoordinator();
    const controller = new AgentChatController({
      database: fixture.database,
      workspaceRuns,
      agentSessionsPath: join(fixture.root, "agent-sessions"),
      worktreesPath: join(fixture.root, "worktrees"),
      worktreeSlotCapacity: (_repositoryId, fallback) => capacity ?? fallback,
      defaults: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        idleProcessMinutes: 20,
      },
      runtimeFactory: runtime,
    });
    controllers.push(controller);

    const first = await controller.ensureSession({
      scope: { kind: "pr", repositoryId: "alpha", prNumber: 1, targetSha: fixture.sha },
    });
    const release = workspaceRuns.acquire(first.session.workspacePath);
    expect(release).not.toBeNull();
    expect(capacity).toBe(1);

    capacity = 2;
    const second = await controller.ensureSession({
      scope: { kind: "pr", repositoryId: "alpha", prNumber: 2, targetSha: fixture.sha },
    });
    expect(second.session.workspacePath).not.toBe(first.session.workspacePath);
    expect(listWorktreeSlots(fixture.database, "alpha")).toHaveLength(2);
    expect(workspaceRuns.isBusy(first.session.workspacePath)).toBe(true);

    const existing = await controller.ensureSession({
      scope: { kind: "pr", repositoryId: "alpha", prNumber: 1, targetSha: fixture.sha },
    });
    expect(existing.session.workspacePath).toBe(first.session.workspacePath);
    expect(workspaceRuns.isBusy(first.session.workspacePath)).toBe(true);
    release?.();
  });

  it("rejects invalid dynamic capacity at the allocation boundary", async () => {
    const fixture = repositoryFixture();
    const controller = new AgentChatController({
      database: fixture.database,
      workspaceRuns: new WorkspaceRunCoordinator(),
      agentSessionsPath: join(fixture.root, "agent-sessions"),
      worktreesPath: join(fixture.root, "worktrees"),
      worktreeSlotCapacity: () => 17,
      defaults: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        idleProcessMinutes: 20,
      },
      runtimeFactory: runtime,
    });
    controllers.push(controller);
    await expect(
      controller.ensureSession({
        scope: { kind: "pr", repositoryId: "alpha", prNumber: 1, targetSha: fixture.sha },
      }),
    ).rejects.toThrow(/expected an integer from 1 to 16/);
    expect(listWorktreeSlots(fixture.database, "alpha")).toEqual([]);
  });
});

describe("WorktreeMaintenanceService", () => {
  it("reconciles removed physical slots and deletes exact DB affinity metadata", async () => {
    const fixture = repositoryFixture(3);
    const poolRoot = join(fixture.root, "worktrees", "alpha");
    const pool = new WorktreePool();
    const rows: Array<{ slotName: string; slotPath: string; prNumber: number; targetSha: string; lastUsedAt: string }> = [];
    for (const prNumber of [1, 2, 3]) {
      await pool.allocate({
        mainRepositoryPath: fixture.repoPath,
        poolRoot,
        slotCount: 3,
        prNumber,
        targetSha: fixture.sha,
        busySlotPaths: [],
        slots: rows,
        onUsed: (usage) => {
          rows.push({ ...usage });
          // Persist the same affinity row that AgentChatController writes.
          recordWorktreeSlotUse(fixture.database, {
            repositoryId: "alpha",
            slotName: usage.slotName,
            path: usage.slotPath,
            prNumber: usage.prNumber,
            targetSha: usage.targetSha,
            lastUsedAt: usage.lastUsedAt,
          });
        },
      });
    }
    const service = new WorktreeMaintenanceService({
      database: fixture.database,
      worktreesPath: join(fixture.root, "worktrees"),
      policyResolver: () => ({ configuredSlots: 2, idleCleanupTtlMs: 365 * 86_400_000 }),
      worktreePool: pool,
    });
    const result = await service.reconcile({
      repositoryId: "alpha",
      repositoryKey: "alpha",
      mainRepositoryPath: fixture.repoPath,
      fallbackSlots: 3,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(result.removed).toEqual([join(poolRoot, "slot-03")]);
    expect(result.removedMetadata).toBe(1);
    expect(listWorktreeSlots(fixture.database, "alpha")).toHaveLength(2);
  });

  it("preserves busy and dirty over-capacity slots", async () => {
    const fixture = repositoryFixture(4);
    const poolRoot = join(fixture.root, "worktrees", "alpha");
    const pool = new WorktreePool();
    const third = join(poolRoot, "slot-03");
    const fourth = join(poolRoot, "slot-04");
    const rows: Array<{ slotName: string; slotPath: string; prNumber: number; targetSha: string; lastUsedAt: string }> = [];
    for (const prNumber of [1, 2, 3, 4]) {
      await pool.allocate({
        mainRepositoryPath: fixture.repoPath,
        poolRoot,
        slotCount: 4,
        prNumber,
        targetSha: fixture.sha,
        busySlotPaths: [],
        slots: rows,
        onUsed: (usage) => {
          rows.push({ ...usage });
        },
      });
    }
    writeFileSync(join(third, "dirty.txt"), "keep\n");
    createAgentSession(fixture.database, {
      id: "sess_busy_slot",
      scope: { kind: "pr", repositoryId: "alpha", prNumber: 3, targetSha: fixture.sha },
      dshHomePath: join(fixture.root, "agent-sessions", "sess_busy_slot", "dsh-home"),
      workspacePath: fourth,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      now: "2026-09-10T00:00:00.000Z",
    });
    updateAgentSession(fixture.database, "sess_busy_slot", { status: "running" });
    const service = new WorktreeMaintenanceService({
      database: fixture.database,
      worktreesPath: join(fixture.root, "worktrees"),
      policyResolver: () => ({ configuredSlots: 2, idleCleanupTtlMs: 0 }),
      worktreePool: pool,
    });
    const dirty = await service.inspect({
      repositoryId: "alpha",
      repositoryKey: "alpha",
      mainRepositoryPath: fixture.repoPath,
      fallbackSlots: 3,
    });
    expect(dirty.dirty).toBe(1);
    expect(dirty.active).toBe(1);
    expect(dirty.pendingRetirement).toBe(2);
    expect(dirty.removed).toEqual([]);
  });

  it("fails closed when Git status fails", async () => {
    const fixture = repositoryFixture(1);
    const poolRoot = join(fixture.root, "worktrees", "alpha");
    const basePool = new WorktreePool();
    await basePool.allocate({
      mainRepositoryPath: fixture.repoPath,
      poolRoot,
      slotCount: 1,
      prNumber: 1,
      targetSha: fixture.sha,
      busySlotPaths: [],
    });
    class StatusFailingPool extends WorktreePool {
      override async isClean(slotPath: string): Promise<boolean> {
        throw new GitCommandError(slotPath, ["status", "--porcelain"], 128, "simulated failure");
      }
    }
    const service = new WorktreeMaintenanceService({
      database: fixture.database,
      worktreesPath: join(fixture.root, "worktrees"),
      policyResolver: () => ({ configuredSlots: 1, idleCleanupTtlMs: 0 }),
      worktreePool: new StatusFailingPool(),
    });
    const result = await service.reconcile({
      repositoryId: "alpha",
      repositoryKey: "alpha",
      mainRepositoryPath: fixture.repoPath,
      fallbackSlots: 1,
    });
    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});
