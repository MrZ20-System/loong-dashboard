import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  insertScheduledRun,
  openDatabase,
  reconcileRepositories,
  updateScheduledTask,
  updateScheduledRun,
  type DatabaseClient,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSystemConfig } from "../src/config.js";
import {
  createSystemScheduleProjector,
  SYSTEM_TASK_IDS,
} from "../src/system-schedules.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loongboard-system-schedules-"));
  directories.push(root);
  const statePath = join(root, ".loong");
  const knowledgePath = join(root, "knowledge");
  const worktreesPath = join(root, "worktrees");
  const repositoryPath = join(root, "repository");
  mkdirSync(statePath, { recursive: true });
  mkdirSync(knowledgePath, { recursive: true });
  mkdirSync(worktreesPath, { recursive: true });
  mkdirSync(repositoryPath, { recursive: true });
  const config = parseSystemConfig({
    version: 1,
    timezone: "UTC",
    repositories: [{
      key: "repo",
      name: "Repository",
      github: "example/repo",
      path: repositoryPath,
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    }],
    knowledge: { path: knowledgePath, inbox: "inbox", historyLimit: 10 },
    runtime: {
      statePath,
      worktreesPath,
      serverHost: "127.0.0.1",
      serverPort: 4174,
    },
    agent: {
      defaultProvider: "provider",
      defaultModel: "model",
      defaultReasoningEffort: "high",
      idleProcessMinutes: 0,
    },
  }, join(root, "system.yaml"));
  const database = openDatabase(join(statePath, "loongboard.sqlite3"));
  databases.push(database);
  reconcileRepositories(database, config.repositories);
  const scheduler = {
    refresh(taskId: string) {
      const task = getScheduledTask(database, taskId);
      if (task === null) throw new Error(`missing task ${taskId}`);
      return task;
    },
  };
  const projector = createSystemScheduleProjector({ database, scheduler, config });
  return { config, database, projector };
}

const retention = {
  automaticArchiveEnabled: false,
  archiveAfterDays: 7,
  includeMergedPrs: true,
  includeClosedPrs: true,
  includeClosedIssues: true,
  prunePayloadWhenArchived: true,
};

const knowledge = {
  autoCommit: false,
  autoPush: false,
  remote: "origin",
  sourceRef: "main",
  remoteBranch: "knowledge-backup",
  checkpointIntervalMinutes: 45,
  pushIntervalMinutes: 60,
};

const codeBackup = {
  repositoryPath: "/tmp/code",
  available: true,
  automaticCheckpoint: false,
  checkpointIntervalMinutes: 30,
  automaticPush: false,
  pushIntervalMinutes: 120,
  sourceRef: "main",
  remote: "origin",
  remoteBranch: "code-backup",
};

const archive = {
  archiveRepositoryPath: "/tmp/archive",
  enabled: false,
  exportIntervalMinutes: 15,
  automaticPush: false,
  pushIntervalMinutes: 180,
  sourceRef: "main",
  remote: "origin",
  remoteBranch: "archive-backup",
};

function projectInput(config: ReturnType<typeof parseSystemConfig>) {
  return {
    repositories: [{
      repository: config.repositories[0],
      settings: {
        automaticSync: false,
        syncFrequencyMinutes: 30,
        retention,
      },
    }],
    knowledge,
    codeBackup,
    agentArchive: archive,
  };
}

function addRun(
  database: DatabaseClient,
  taskId: string,
  timestamp: string,
  status: "completed" | "failed",
  error: string | null,
): void {
  const run = insertScheduledRun(database, taskId, timestamp, timestamp);
  updateScheduledRun(database, run.id, {
    status,
    startedAt: timestamp,
    finishedAt: timestamp,
    error,
  });
}

describe("system schedule projector", () => {
  it("reprojects stale rows and recreates missing stable tasks", () => {
    const { config, database, projector } = fixture();
    projector.projectAll(projectInput(config));

    updateScheduledTaskForTest(database, SYSTEM_TASK_IDS.repositorySync("repo"));
    deleteScheduledTask(database, SYSTEM_TASK_IDS.knowledgePush);
    projector.projectAll(projectInput(config));

    expect(getScheduledTask(database, SYSTEM_TASK_IDS.repositorySync("repo"))).toMatchObject({
      cronExpression: "*/30 * * * *",
      enabled: false,
      action: "repository.sync",
      repositoryId: "repo",
    });
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.knowledgePush)).toMatchObject({
      cronExpression: "0 */1 * * *",
      enabled: false,
      action: "knowledge.push",
    });
  });

  it("clears accidental repository bindings from global system tasks", () => {
    const { config, database, projector } = fixture();
    const globalTasks = [
      [SYSTEM_TASK_IDS.knowledgeCheckpoint, "knowledge.checkpoint"],
      [SYSTEM_TASK_IDS.knowledgePush, "knowledge.push"],
      [SYSTEM_TASK_IDS.codeCheckpoint, "git.checkpoint"],
      [SYSTEM_TASK_IDS.codePush, "git.push"],
      [SYSTEM_TASK_IDS.agentArchiveCheckpoint, "agent.archive.checkpoint"],
      [SYSTEM_TASK_IDS.agentArchivePush, "agent.archive.push"],
    ] as const;
    for (const [id, action] of globalTasks) {
      createScheduledTask(database, {
        id,
        name: id,
        cronExpression: "0 * * * *",
        timezone: "UTC",
        kind: "system",
        action,
        repositoryId: "repo",
        enabled: true,
      });
    }

    projector.projectAll(projectInput(config));

    for (const [id] of globalTasks) {
      expect(getScheduledTask(database, id)?.repositoryId).toBeNull();
    }
  });

  it("derives lastError from the newest terminal run across backup tasks", () => {
    const { config, database, projector } = fixture();
    projector.projectAll(projectInput(config));
    addRun(database, SYSTEM_TASK_IDS.codeCheckpoint, "2026-01-01T00:00:00.000Z", "failed", "old error");
    addRun(database, SYSTEM_TASK_IDS.codePush, "2026-01-02T00:00:00.000Z", "completed", null);

    expect(projector.codeBackupStatus(codeBackup).lastError).toBeNull();

    addRun(database, SYSTEM_TASK_IDS.codePush, "2026-01-03T00:00:00.000Z", "failed", "new error");
    expect(projector.codeBackupStatus(codeBackup).lastError).toBe("new error");
  });

  it("disables code backup tasks when the runtime repository is unavailable", () => {
    const { database, projector } = fixture();
    projector.projectCodeBackup({
      ...codeBackup,
      available: false,
      automaticCheckpoint: true,
      automaticPush: true,
    });

    expect(getScheduledTask(database, SYSTEM_TASK_IDS.codeCheckpoint)?.enabled).toBe(false);
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.codePush)?.enabled).toBe(false);
  });

  it("gates repository sync, metadata, and worktree tasks until checkout is available", () => {
    const { config, database } = fixture();
    const scheduler = {
      refresh(taskId: string) {
        const task = getScheduledTask(database, taskId);
        if (task === null) throw new Error(`missing task ${taskId}`);
        return task;
      },
    };
    const unavailable = createSystemScheduleProjector({
      database,
      scheduler,
      config,
      repositoryAvailability: () => false,
    });
    unavailable.projectAll({
      ...projectInput(config),
      repositories: [{
        repository: config.repositories[0],
        settings: { automaticSync: true, syncFrequencyMinutes: 30, retention },
      }],
    });
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.repositorySync("repo"))?.enabled).toBe(false);
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.metadataMaintenance("repo"))?.enabled).toBe(false);
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.worktreeCleanup("repo"))?.enabled).toBe(false);

    const available = createSystemScheduleProjector({
      database,
      scheduler,
      config,
      repositoryAvailability: () => true,
    });
    available.projectAll({
      ...projectInput(config),
      repositories: [{
        repository: config.repositories[0],
        settings: { automaticSync: true, syncFrequencyMinutes: 30, retention },
      }],
    });
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.repositorySync("repo"))?.enabled).toBe(true);
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.metadataMaintenance("repo"))?.enabled).toBe(true);
    expect(getScheduledTask(database, SYSTEM_TASK_IDS.worktreeCleanup("repo"))?.enabled).toBe(true);
  });
});

function updateScheduledTaskForTest(database: DatabaseClient, taskId: string): void {
  updateScheduledTask(database, taskId, {
    cronExpression: "0 * * * *",
    enabled: true,
  });
}
