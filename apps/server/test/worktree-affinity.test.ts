import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSessionSpec,
} from "@loongboard/agent-runtime";
import {
  listWorktreeSlots,
  openDatabase,
  reconcileRepositories,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { AgentChatController } from "../src/agent-chat.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

const temporaryDirectories: string[] = [];
const controllers: AgentChatController[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.close();
  }
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runGit(repositoryPath: string, args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: repositoryPath,
    encoding: "utf8",
  }).trim();
}

function recordedRuntime(): AgentRuntime {
  return {
    async *run(
      _spec: AgentSessionSpec,
      _prompt: string,
    ): AsyncIterable<AgentRuntimeEvent> {
      // Restart affinity only exercises workspace allocation; no turn runs.
      return;
    },
    stop: async () => undefined,
    close: async () => undefined,
  };
}

interface RestartFixture {
  directory: string;
  databasePath: string;
  repositoryPath: string;
  shaA: string;
  shaB: string;
}

function setupRepository(): RestartFixture {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-worktree-affinity-"));
  temporaryDirectories.push(directory);
  const repositoryPath = join(directory, "repo");
  mkdirSync(repositoryPath, { recursive: true });
  runGit(repositoryPath, ["init", "-b", "main", "."]);
  runGit(repositoryPath, ["config", "user.email", "t@example.com"]);
  runGit(repositoryPath, ["config", "user.name", "Test"]);
  runGit(repositoryPath, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repositoryPath, "first.txt"), "one\n");
  runGit(repositoryPath, ["add", "-A"]);
  runGit(repositoryPath, ["commit", "-qm", "first"]);
  const shaA = runGit(repositoryPath, ["rev-parse", "HEAD"]);
  writeFileSync(join(repositoryPath, "second.txt"), "two\n");
  runGit(repositoryPath, ["add", "-A"]);
  runGit(repositoryPath, ["commit", "-qm", "second"]);
  const shaB = runGit(repositoryPath, ["rev-parse", "HEAD"]);

  const databasePath = join(directory, "state.sqlite3");
  const database = openDatabase(databasePath);
  databases.push(database);
  const configured: ConfiguredRepository = {
    key: "alpha",
    name: "Alpha",
    github: "acme/alpha",
    path: repositoryPath,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  };
  reconcileRepositories(database, [configured]);
  const pullRequests: PullRequestMetadata[] = [
    {
      nodeId: "pr_1",
      number: 1,
      title: "PR 1",
      url: "https://github.com/acme/alpha/pull/1",
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
    },
  ];
  upsertPullRequestPage(database, "alpha", pullRequests);
  database.close();

  return { directory, databasePath, repositoryPath, shaA, shaB };
}

function openController(fixture: RestartFixture): {
  controller: AgentChatController;
  database: DatabaseClient;
} {
  const database = openDatabase(fixture.databasePath);
  databases.push(database);
  const controller = new AgentChatController({
    database,
    workspaceRuns: new WorkspaceRunCoordinator(),
    agentSessionsPath: join(fixture.directory, "agent-sessions"),
    worktreesPath: join(fixture.directory, "worktrees"),
    defaults: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      idleProcessMinutes: 20,
    },
    runtimeFactory: () => recordedRuntime(),
  });
  controllers.push(controller);
  return { controller, database };
}

async function releaseController(entry: {
  controller: AgentChatController;
  database: DatabaseClient;
}): Promise<void> {
  const controllerIndex = controllers.indexOf(entry.controller);
  if (controllerIndex >= 0) controllers.splice(controllerIndex, 1);
  await entry.controller.close();
  const databaseIndex = databases.indexOf(entry.database);
  if (databaseIndex >= 0) databases.splice(databaseIndex, 1);
  if (entry.database.open) entry.database.close();
}

describe("PR worktree affinity across restarts", () => {
  it("reuses one SQLite-bound slot for a PR after restart and switches its target", async () => {
    const fixture = setupRepository();
    const first = openController(fixture);
    const created = await first.controller.ensureSession({
      scope: {
        kind: "pr",
        repositoryId: "alpha",
        prNumber: 1,
        targetSha: fixture.shaA,
      },
    });
    expect(created.workspaceRevision).toBe(fixture.shaA);
    const slotPath = created.session.workspacePath;
    expect(listWorktreeSlots(first.database, "alpha")).toHaveLength(1);
    await releaseController(first);

    // A fresh controller on the reopened database has no in-memory LRU; the
    // worktree_slots row must preserve PR affinity and drive the switch.
    const restarted = openController(fixture);
    const rowsBefore = listWorktreeSlots(restarted.database, "alpha");
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]).toMatchObject({
      slotName: "slot-01",
      path: slotPath,
      prNumber: 1,
      targetSha: fixture.shaA,
    });

    const switched = await restarted.controller.ensureSession({
      scope: {
        kind: "pr",
        repositoryId: "alpha",
        prNumber: 1,
        targetSha: fixture.shaB,
      },
    });
    expect(switched.session.workspacePath).toBe(slotPath);
    expect(switched.workspaceRevision).toBe(fixture.shaB);
    expect(listWorktreeSlots(restarted.database, "alpha")).toHaveLength(1);
    expect(listWorktreeSlots(restarted.database, "alpha")[0]).toMatchObject({
      path: slotPath,
      prNumber: 1,
      targetSha: fixture.shaB,
    });

    await releaseController(restarted);
  });
});
