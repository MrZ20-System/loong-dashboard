import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createScheduledTask,
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import {
  settingsDocumentV3Schema,
} from "@loongboard/contracts";
import { GitHubCredentialService } from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsController } from "../src/settings.js";
import { SYSTEM_TASK_IDS } from "../src/system-schedules.js";

const fixtures: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loongboard-settings-"));
  const statePath = join(root, ".loong");
  mkdirSync(statePath, { recursive: true });
  const database = openDatabase(join(statePath, "state.sqlite3"));
  fixtures.push({ database, root });
  reconcileRepositories(database, [
    {
      key: "vllm",
      name: "vLLM",
      github: "openai/vllm",
      path: join(root, "vllm"),
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ]);
  return { root, statePath, database };
}

function credential(statePath: string) {
  return new GitHubCredentialService({
    filePath: join(statePath, "github-credential.json"),
    environment: {},
    ghExecutable: "false",
  });
}

function readSettings(root: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, any>;
}

function legacyV2Document() {
  return {
    version: 2,
    repositories: {
      vllm: {
        automaticSync: false,
        syncFrequencyMinutes: 60,
        syncLookbackDays: 7,
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
      defaultProvider: null,
      defaultModel: null,
      defaultReasoning: null,
      retentionMinutes: 120,
    },
    knowledgeBackup: {
      autoCommit: false,
      autoPush: false,
      remote: "origin",
      sourceRef: "main",
      remoteBranch: "loongboard-knowledge-backup",
      checkpointIntervalMinutes: null,
      pushIntervalMinutes: null,
    },
    codeBackup: {
      automaticCheckpoint: false,
      checkpointIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "loongboard-backup",
    },
    agentArchive: {
      archiveRepositoryPath: "agent-history",
      enabled: false,
      exportIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "agent-history-backup",
    },
  };
}

function addSystemTask(
  database: DatabaseClient,
  input: { id: string; action: string; cronExpression: string; repositoryId?: string },
) {
  return createScheduledTask(database, {
    id: input.id,
    name: input.action,
    cronExpression: input.cronExpression,
    timezone: "Asia/Shanghai",
    kind: "system",
    action: input.action,
    repositoryId: input.repositoryId ?? null,
    enabled: false,
  });
}

describe("SettingsController", () => {
  it("materializes a complete V3 document for a missing file", () => {
    const { root, statePath, database } = fixture();
    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    });

    const persisted = readSettings(root);
    expect(settingsDocumentV3Schema.safeParse(persisted).success).toBe(true);
    expect(persisted).toMatchObject({
      version: 3,
      repositories: {
        vllm: {
          automaticSync: false,
          syncCron: "0 */1 * * *",
          syncLookbackDays: 7,
          worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
        },
      },
      knowledgeBackup: {
        checkpointCron: "0 0 * * *",
        pushCron: "0 0 * * *",
      },
      codeBackup: {
        checkpointCron: "0 0 * * *",
        pushCron: "0 0 * * *",
      },
      agentArchive: {
        exportCron: "0 0 * * *",
        pushCron: "0 0 * * *",
      },
    });
  });

  it("migrates V2 cadence with persisted scheduled-task cron taking priority", () => {
    const { root, statePath, database } = fixture();
    writeFileSync(join(root, "settings.json"), JSON.stringify(legacyV2Document()), "utf8");
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.repositorySync("vllm"),
      action: "repository.sync",
      cronExpression: "0 7 * * *",
      repositoryId: "vllm",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.knowledgeCheckpoint,
      action: "knowledge.checkpoint",
      cronExpression: "17 * * * *",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.knowledgePush,
      action: "knowledge.push",
      cronExpression: "23 * * * *",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.codeCheckpoint,
      action: "git.checkpoint",
      cronExpression: "0 4 * * 1",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.codePush,
      action: "git.push",
      cronExpression: "0 5 * * 1",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.agentArchiveCheckpoint,
      action: "agent.archive.checkpoint",
      cronExpression: "0 6 * * 1",
    });
    addSystemTask(database, {
      id: SYSTEM_TASK_IDS.agentArchivePush,
      action: "agent.archive.push",
      cronExpression: "0 8 * * 1",
    });

    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    });

    const persisted = readSettings(root);
    expect(persisted.version).toBe(3);
    expect(persisted.repositories.vllm.syncCron).toBe("0 7 * * *");
    expect(persisted.knowledgeBackup).toMatchObject({
      checkpointCron: "17 * * * *",
      pushCron: "23 * * * *",
    });
    expect(persisted.codeBackup).toMatchObject({
      checkpointCron: "0 4 * * 1",
      pushCron: "0 5 * * 1",
    });
    expect(persisted.agentArchive).toMatchObject({
      exportCron: "0 6 * * 1",
      pushCron: "0 8 * * 1",
    });
    expect(settingsDocumentV3Schema.safeParse(persisted).success).toBe(true);
  });

  it("uses effective valid daily defaults when a disabled V2 cadence was null", () => {
    const { root, statePath, database } = fixture();
    writeFileSync(join(root, "settings.json"), JSON.stringify(legacyV2Document()), "utf8");
    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    });
    expect(readSettings(root)).toMatchObject({
      knowledgeBackup: { checkpointCron: "0 0 * * *", pushCron: "0 0 * * *" },
      codeBackup: { checkpointCron: "0 0 * * *", pushCron: "0 0 * * *" },
      agentArchive: { exportCron: "0 0 * * *", pushCron: "0 0 * * *" },
    });
  });

  it("drops legacy runtime projections while migrating V1", () => {
    const { root, statePath, database } = fixture();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      version: 1,
      unrelated: { keep: true },
      repositories: {
        vllm: {
          automaticSync: true,
          syncFrequencyMinutes: 15,
          nextSyncAt: "2026-09-11T01:00:00.000Z",
          worktrees: { configuredSlots: 2, idleCleanupTtlHours: 48, active: 1 },
        },
      },
      checkpoint: {
        sourceRef: "main",
        checkpointIntervalMinutes: 15,
        pushIntervalMinutes: 45,
        nextRunAt: "2026-09-11T01:00:00.000Z",
      },
    }), "utf8");

    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    });
    const persisted = readSettings(root);
    expect(persisted.version).toBe(3);
    expect(persisted.unrelated).toBeUndefined();
    expect(persisted.repositories.vllm).toMatchObject({
      syncCron: "*/15 * * * *",
      worktrees: { configuredSlots: 2, idleCleanupTtlHours: 48 },
    });
    expect(persisted.knowledgeBackup).toMatchObject({
      checkpointCron: "*/15 * * * *",
      pushCron: "*/45 * * * *",
    });
    expect(persisted.repositories.vllm).not.toHaveProperty("nextSyncAt");
    expect(persisted.knowledgeBackup).not.toHaveProperty("nextRunAt");
    expect(settingsDocumentV3Schema.safeParse(persisted).success).toBe(true);
  });

  it("rejects invalid V3 input without overwriting the original file", () => {
    const { root, statePath, database } = fixture();
    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    });
    const settingsPath = join(root, "settings.json");
    const invalid = JSON.stringify({ ...readSettings(root), version: 3, unknown: true });
    writeFileSync(settingsPath, invalid, "utf8");
    expect(() => new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
    })).toThrow();
    expect(readFileSync(settingsPath, "utf8")).toBe(invalid);
  });

  it("validates every saved Cron before writing or projecting it", async () => {
    const { root, statePath, database } = fixture();
    const calls: Array<Record<string, unknown>> = [];
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
      repositorySchedules: {
        update: (_id, patch) => {
          calls.push(patch);
          return { nextSyncAt: null };
        },
      },
      checkpoint: { update: (patch) => { calls.push(patch); return null; } },
      codeBackup: { update: (patch) => { calls.push(patch); return null; } },
      agentArchive: { update: (patch) => { calls.push(patch); return null; } },
    });
    const before = readFileSync(join(root, "settings.json"), "utf8");
    await expect(controller.updateRepository("vllm", { syncCron: "invalid" })).rejects.toThrow(
      "Invalid syncCron",
    );
    await expect(controller.updateCheckpoint({ checkpointCron: "invalid" })).rejects.toThrow(
      "Invalid checkpointCron",
    );
    await expect(controller.updateCodeBackup({ pushCron: "invalid" })).rejects.toThrow(
      "Invalid pushCron",
    );
    await expect(controller.updateAgentArchive({ exportCron: "invalid" })).rejects.toThrow(
      "Invalid exportCron",
    );
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(before);
  });

  it("persists V3 Cron policy before projecting updates", async () => {
    const { root, statePath, database } = fixture();
    const observed: Array<Record<string, any>> = [];
    const observe = () => observed.push(readSettings(root));
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
      repositorySchedules: { update: () => { observe(); return { nextSyncAt: null }; } },
      checkpoint: { update: () => { observe(); return null; } },
      codeBackup: { update: () => { observe(); return null; } },
      agentArchive: { update: () => { observe(); return null; } },
    });

    await controller.updateRepository("vllm", { automaticSync: true, syncCron: "*/15 * * * *" });
    await controller.updateCheckpoint({ checkpointCron: "0 */6 * * *", pushCron: "0 3 * * 1" });
    await controller.updateCodeBackup({ automaticCheckpoint: true, checkpointCron: "0 4 * * *", automaticPush: true, pushCron: "0 5 * * *" });
    await controller.updateAgentArchive({ enabled: true, exportCron: "0 6 * * *", automaticPush: true, pushCron: "0 7 * * *" });

    expect(observed).toHaveLength(4);
    expect(observed.every((document) => document.version === 3)).toBe(true);
    expect(readSettings(root)).toMatchObject({
      repositories: { vllm: { automaticSync: true, syncCron: "*/15 * * * *" } },
      knowledgeBackup: { checkpointCron: "0 */6 * * *", pushCron: "0 3 * * 1" },
      codeBackup: { checkpointCron: "0 4 * * *", pushCron: "0 5 * * *" },
      agentArchive: { exportCron: "0 6 * * *", pushCron: "0 7 * * *" },
    });
  });

  it("keeps runtime code backup availability out of the durable V3 document", async () => {
    const { root, statePath, database } = fixture();
    const runtimePath = join(root, "installed-loongboard");
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: credential(statePath),
      codeBackup: {
        get: () => ({ repositoryPath: runtimePath, available: false }),
      },
    });
    await expect(controller.codeBackupSettings()).resolves.toMatchObject({
      repositoryPath: runtimePath,
      available: false,
      checkpointCron: "0 0 * * *",
    });
    expect(readSettings(root).codeBackup).not.toHaveProperty("repositoryPath");
    expect(existsSync(join(root, "settings.json"))).toBe(true);
  });
});
