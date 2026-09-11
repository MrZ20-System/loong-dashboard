import type { ScheduledTaskRow } from "@loongboard/database";
import { describe, expect, it, vi } from "vitest";

import {
  createSystemActionExecutor,
  SYSTEM_ACTIONS,
  type SystemActionState,
} from "../src/system-actions.js";

function task(action: string, repositoryId: string | null = null): ScheduledTaskRow {
  return {
    id: `task-${action}`,
    name: action,
    cronExpression: "0 * * * *",
    timezone: "UTC",
    prompt: null,
    workspacePath: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    kind: "system",
    action,
    repositoryId,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function state(): SystemActionState {
  return {
    checkpoint: {
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "knowledge-backup",
      checkpointIntervalMinutes: null,
      pushIntervalMinutes: null,
      nextRunAt: null,
      lastSuccessAt: null,
      lastError: null,
    },
    codeBackup: {
      repositoryPath: "/tmp/code",
      available: true,
      automaticCheckpoint: false,
      checkpointIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "code-backup",
      lastCheckpointAt: null,
      nextCheckpointAt: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
    },
    agentArchive: {
      archiveRepositoryPath: "/tmp/archive",
      enabled: false,
      exportIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "archive-backup",
      lastExportAt: null,
      nextExportAt: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
    },
  };
}

function executor(overrides: Record<string, unknown> = {}) {
  const coordinator = {
    start: () => ({ syncRunId: "sync-1" }),
    waitForRun: async () => ({ status: "completed", error: null }),
  };
  return createSystemActionExecutor({
    database: {} as never,
    config: {
      knowledge: { path: "/tmp/knowledge" },
      runtime: { statePath: "/tmp/state", worktreesPath: "/tmp/worktrees" },
    } as never,
    coordinator: coordinator as never,
    metadataMaintenance: {} as never,
    worktreeMaintenance: {} as never,
    repositorySettings: () => undefined,
    knowledge: {} as never,
    codeRepositoryPath: "/tmp/code",
    state: state(),
    ...overrides,
  });
}

describe("system action registry", () => {
  it("registers exactly the canonical system actions", () => {
    expect(SYSTEM_ACTIONS).toEqual([
      "repository.sync",
      "repository.metadata-maintenance",
      "repository.worktrees.cleanup",
      "knowledge.checkpoint",
      "knowledge.push",
      "git.checkpoint",
      "git.push",
      "agent.archive.checkpoint",
      "agent.archive.push",
    ]);
  });

  it("fails unknown actions explicitly", async () => {
    await expect(
      executor().executeSystem({
        task: task("unknown.action"),
        run: {} as never,
        workspacePath: null,
      }),
    ).rejects.toThrow("Unknown system scheduled action: unknown.action");
  });

  it.each([
    "repository.sync",
    "repository.metadata-maintenance",
    "repository.worktrees.cleanup",
  ])("requires repositoryId for %s", async (action) => {
    await expect(
      executor().executeSystem({
        task: task(action),
        run: {} as never,
        workspacePath: null,
      }),
    ).rejects.toThrow("missing repositoryId");
  });

  it("dispatches repository.sync through the coordinator", async () => {
    const start = vi.fn(() => ({ syncRunId: "sync-1" }));
    const waitForRun = vi.fn(async () => ({ status: "completed", error: null }));
    const actionExecutor = executor({
      coordinator: { start, waitForRun } as never,
    });
    await actionExecutor.executeSystem({
      task: task("repository.sync", "repo"),
      run: {} as never,
      workspacePath: null,
    });
    expect(start).toHaveBeenCalledWith("repo", "system");
    expect(waitForRun).toHaveBeenCalledWith("sync-1");
  });

  it.each(["git.checkpoint", "git.push"])(
    "fails %s before Git when code backup is unavailable",
    async (action) => {
      const unavailable = state();
      unavailable.codeBackup.available = false;
      await expect(
        executor({ state: unavailable }).executeSystem({
          task: task(action),
          run: {} as never,
          workspacePath: null,
        }),
      ).rejects.toThrow("Code backup unavailable in container-image deployment.");
    },
  );
});
