import {
  createScheduledTask,
  getScheduledTask,
  insertScheduledRun,
  openDatabase,
  reconcileRepositories,
  updateScheduledTask,
  updateScheduledRun,
  type DatabaseClient,
} from "@loongboard/database";
import type { GitHubMetadataProvider } from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createServerRuntime, type ServerRuntime } from "../src/runtime.js";
import { parseSystemConfig } from "../src/config.js";

const runtimes: ServerRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.app.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function emptyProvider(): GitHubMetadataProvider {
  return {
    async *fetchPullRequestUpdates() { /* no repositories */ },
    async *fetchIssueUpdates() { /* no repositories */ },
    async fetchPullRequestFiles() { return []; },
    async fetchIssueDetail() { throw new Error("not used"); },
  } as unknown as GitHubMetadataProvider;
}

function settingsDocument(systemRoot: string): Record<string, unknown> {
  return {
    version: 2,
    repositories: {
      repo: {
        automaticSync: false,
        syncFrequencyMinutes: 30,
        syncLookbackDays: 30,
        retention: {
          automaticArchiveEnabled: false,
          archiveAfterDays: 7,
          includeMergedPrs: true,
          includeClosedPrs: true,
          includeClosedIssues: true,
          prunePayloadWhenArchived: true,
        },
        worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
      },
    },
    github: {
      verifiedSource: null,
      account: null,
      rest: null,
      graphql: null,
      lastVerifiedAt: null,
    },
    agent: {
      defaultProvider: "provider",
      defaultModel: "model",
      defaultReasoning: "high",
      retentionMinutes: 120,
    },
    knowledgeBackup: {
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "knowledge-backup",
      checkpointIntervalMinutes: 45,
      pushIntervalMinutes: 60,
    },
    codeBackup: {
      automaticCheckpoint: false,
      checkpointIntervalMinutes: 30,
      automaticPush: false,
      pushIntervalMinutes: 120,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "code-backup",
    },
    agentArchive: {
      enabled: false,
      archiveRepositoryPath: join(systemRoot, "agent-archive"),
      exportIntervalMinutes: 15,
      automaticPush: false,
      pushIntervalMinutes: 180,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "agent-backup",
    },
  };
}

function fixture(): {
  root: string;
  databasePath: string;
  config: ReturnType<typeof parseSystemConfig>;
} {
  const root = mkdtempSync(join(tmpdir(), "loongboard-runtime-projection-"));
  directories.push(root);
  const statePath = join(root, ".loong");
  const knowledgePath = join(root, "knowledge");
  const worktreesPath = join(root, "worktrees");
  const repositoryPath = join(root, "repository");
  mkdirSync(statePath, { recursive: true });
  mkdirSync(knowledgePath, { recursive: true });
  mkdirSync(worktreesPath, { recursive: true });
  mkdirSync(repositoryPath, { recursive: true });
  writeFileSync(join(root, "settings.json"), `${JSON.stringify(settingsDocument(root))}\n`);
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
  return {
    root,
    databasePath: join(statePath, "loongboard.sqlite3"),
    config,
  };
}

function seedTask(
  database: DatabaseClient,
  id: string,
  action: string,
  repositoryId?: string,
): void {
  createScheduledTask(database, {
    id,
    name: id,
    cronExpression: "0 * * * *",
    timezone: "UTC",
    kind: "system",
    action,
    repositoryId,
    enabled: true,
  });
}

function addRun(
  database: DatabaseClient,
  taskId: string,
  scheduledFor: string,
  status: "completed" | "failed",
  error: string | null,
): void {
  const run = insertScheduledRun(database, taskId, scheduledFor, scheduledFor);
  updateScheduledRun(database, run.id, {
    status,
    startedAt: scheduledFor,
    finishedAt: scheduledFor,
    error,
  });
}

describe("system schedule projection", () => {
  it("reprojects policy over existing tasks and creates the missing repository task", async () => {
    const { root, databasePath, config } = fixture();
    const database = openDatabase(databasePath);
    reconcileRepositories(database, config.repositories);
    seedTask(database, "system_knowledge_checkpoint", "knowledge.checkpoint");
    seedTask(database, "system_knowledge_push", "knowledge.push");
    seedTask(database, "system_code_checkpoint", "git.checkpoint");
    seedTask(database, "system_code_push", "git.push");
    seedTask(database, "system_agent_archive_checkpoint", "agent.archive.checkpoint");
    seedTask(database, "system_agent_archive_push", "agent.archive.push");
    database.close();

    const runtime = createServerRuntime({
      config,
      systemRoot: root,
      provider: emptyProvider(),
    });
    runtimes.push(runtime);

    expect(getScheduledTask(runtime.database, "system_repository_sync_repo")).toMatchObject({
      enabled: false,
      cronExpression: "*/30 * * * *",
    });
    expect(getScheduledTask(runtime.database, "system_knowledge_checkpoint")).toMatchObject({
      enabled: false,
      cronExpression: "*/45 * * * *",
    });
    expect(getScheduledTask(runtime.database, "system_knowledge_push")).toMatchObject({
      enabled: false,
      cronExpression: "0 */1 * * *",
    });
    expect(getScheduledTask(runtime.database, "system_code_checkpoint")).toMatchObject({
      enabled: false,
      cronExpression: "*/30 * * * *",
    });
    expect(getScheduledTask(runtime.database, "system_code_push")).toMatchObject({
      enabled: false,
      cronExpression: "0 */2 * * *",
    });
    expect(getScheduledTask(runtime.database, "system_agent_archive_checkpoint")).toMatchObject({
      enabled: false,
      cronExpression: "*/15 * * * *",
    });
    expect(getScheduledTask(runtime.database, "system_agent_archive_push")).toMatchObject({
      enabled: false,
      cronExpression: "0 */3 * * *",
    });

    // A task row is executable projection, not a policy source. Even if an
    // external repair mutates its policy-shaped columns, Settings reads the
    // V2 document and only accepts runtime facts from the bridge.
    for (const taskId of [
      "system_repository_sync_repo",
      "system_knowledge_checkpoint",
      "system_knowledge_push",
      "system_code_checkpoint",
      "system_code_push",
      "system_agent_archive_checkpoint",
      "system_agent_archive_push",
    ]) {
      updateScheduledTask(runtime.database, taskId, {
        cronExpression: "0 * * * *",
        enabled: true,
      });
    }
    expect((await runtime.settings.repository("repo"))).toMatchObject({
      automaticSync: false,
      syncFrequencyMinutes: 30,
    });
    expect((await runtime.settings.checkpointSettings())).toMatchObject({
      autoCommit: false,
      autoPush: false,
      checkpointIntervalMinutes: 45,
      pushIntervalMinutes: 60,
    });
    expect((await runtime.settings.codeBackupSettings())).toMatchObject({
      automaticCheckpoint: false,
      checkpointIntervalMinutes: 30,
      automaticPush: false,
      pushIntervalMinutes: 120,
      repositoryPath: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
      available: true,
    });
    expect((await runtime.settings.agentArchiveSettings())).toMatchObject({
      enabled: false,
      exportIntervalMinutes: 15,
      automaticPush: false,
      pushIntervalMinutes: 180,
    });
  });

  it("uses the newest terminal run for repository, code, and archive errors", async () => {
    const { root, databasePath, config } = fixture();
    const database = openDatabase(databasePath);
    reconcileRepositories(database, config.repositories);
    database.close();

    const runtime = createServerRuntime({
      config,
      systemRoot: root,
      provider: emptyProvider(),
    });
    runtimes.push(runtime);

    addRun(runtime.database, "system_repository_sync_repo", "2026-01-01T00:00:00.000Z", "failed", "old repository error");
    addRun(runtime.database, "system_repository_sync_repo", "2026-01-02T00:00:00.000Z", "completed", null);
    addRun(runtime.database, "system_code_checkpoint", "2026-01-01T00:00:00.000Z", "failed", "old code error");
    addRun(runtime.database, "system_code_push", "2026-01-02T00:00:00.000Z", "completed", null);
    addRun(runtime.database, "system_agent_archive_checkpoint", "2026-01-01T00:00:00.000Z", "failed", "old archive error");
    addRun(runtime.database, "system_agent_archive_push", "2026-01-02T00:00:00.000Z", "completed", null);

    expect((await runtime.settings.repository("repo")).lastError).toBeNull();
    expect((await runtime.settings.codeBackupSettings()).lastError).toBeNull();
    expect((await runtime.settings.agentArchiveSettings()).lastError).toBeNull();

    addRun(runtime.database, "system_code_checkpoint", "2026-01-03T00:00:00.000Z", "failed", "new code error");
    addRun(runtime.database, "system_agent_archive_checkpoint", "2026-01-03T00:00:00.000Z", "failed", "new archive error");
    expect((await runtime.settings.codeBackupSettings()).lastError).toBe("new code error");
    expect((await runtime.settings.agentArchiveSettings()).lastError).toBe("new archive error");
  });
});
