import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  reconcileRepositories,
  beginQueuedForwardSync,
  completeSyncStream,
  completeSyncRunStream,
  createSyncRun,
  getRepositorySyncState,
  type DatabaseClient,
} from "@loongboard/database";
import {
  settingsDocumentV2Schema,
} from "@loongboard/contracts";
import { GitHubCredentialService } from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsController } from "../src/settings.js";

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

describe("SettingsController", () => {
  it("materializes a complete V2 document for a missing file", () => {
    const { root, statePath, database } = fixture();
    new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });

    const persisted = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(settingsDocumentV2Schema.safeParse(persisted).success).toBe(true);
    expect(persisted).toMatchObject({
      version: 2,
      repositories: {
        vllm: {
          automaticSync: false,
          syncFrequencyMinutes: 60,
          syncLookbackDays: 7,
          worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
        },
      },
      knowledgeBackup: {
        sourceRef: "main",
        checkpointIntervalMinutes: null,
        pushIntervalMinutes: null,
      },
      agentArchive: {
        archiveRepositoryPath: join(root, "agent-history"),
      },
    });
  });

  it("materializes a newly configured repository into an existing V2 document", () => {
    const { root, statePath, database } = fixture();
    const credential = () => new GitHubCredentialService({
      filePath: join(statePath, "github-credential.json"),
      environment: {},
      ghExecutable: "false",
    });
    new SettingsController({ database, systemRoot: root, statePath, environment: {}, credential: credential() });
    const settingsPath = join(root, "settings.json");
    const document = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
    document.repositories = {};
    writeFileSync(settingsPath, JSON.stringify(document), "utf8");

    new SettingsController({ database, systemRoot: root, statePath, environment: {}, credential: credential() });
    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
    expect(persisted.repositories.vllm).toMatchObject({
      automaticSync: false,
      syncFrequencyMinutes: 60,
      syncLookbackDays: 7,
      worktrees: { configuredSlots: 1, idleCleanupTtlHours: 24 },
    });
  });

  it("persists a canonical V2 document and drops legacy opaque fields", async () => {
    const { root, statePath, database } = fixture();
    const settingsPath = join(root, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, unrelated: { keep: true } }),
      "utf8",
    );
    const updates: Array<Record<string, unknown>> = [];
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      agent: {
        snapshot: () => ({
          status: "ready",
          version: "native-1",
          profile: "default",
          connected: true,
          capabilities: null,
        }),
        update: (patch) => {
          updates.push(patch);
        },
      },
      repositorySchedules: {
        update: (_repositoryId, patch) => ({
          automaticSync: patch.automaticSync ?? false,
          syncFrequencyMinutes: patch.syncFrequencyMinutes ?? 60,
          nextSyncAt: null,
        }),
      },
      defaults: {
        defaultProvider: "deepseek-official",
        defaultModel: "deepseek-v4-flash",
        defaultReasoning: "medium",
        retentionMinutes: 120,
      },
    });

    const updatedAgent = await controller.updateAgent({ retentionMinutes: 0 });
    expect(updatedAgent.retentionMinutes).toBe(0);
    expect(updates).toEqual([{ retentionMinutes: 0 }]);

    const updatedRepository = await controller.updateRepository("vllm", {
      automaticSync: true,
      syncFrequencyMinutes: 30,
    });
    expect(updatedRepository).toMatchObject({
      repositoryId: "vllm",
      automaticSync: true,
      syncFrequencyMinutes: 30,
      syncLookbackDays: 7,
    });

    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(persisted.version).toBe(2);
    expect(persisted.unrelated).toBeUndefined();
    expect(persisted.agent).toMatchObject({ retentionMinutes: 0 });
    expect(persisted.repositories).toMatchObject({
      vllm: { automaticSync: true, syncFrequencyMinutes: 30, syncLookbackDays: 7 },
    });
    expect(settingsDocumentV2Schema.safeParse(persisted).success).toBe(true);
  });

  it("fills retention defaults when upgrading a legacy repository and merges partial updates", async () => {
    const { root, statePath, database } = fixture();
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        version: 1,
        repositories: { vllm: { automaticSync: true, syncFrequencyMinutes: 15 } },
      }),
      "utf8",
    );
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });

    expect((await controller.repository("vllm")).retention).toEqual({
      automaticArchiveEnabled: false,
      archiveAfterDays: 7,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    });
    const updated = await controller.updateRepository("vllm", {
      retention: { automaticArchiveEnabled: true, archiveAfterDays: 30 },
    });
    expect(updated.retention).toEqual({
      automaticArchiveEnabled: true,
      archiveAfterDays: 30,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    });
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toMatchObject({
      repositories: {
        vllm: {
          retention: {
            automaticArchiveEnabled: true,
            archiveAfterDays: 30,
            includeClosedIssues: true,
          },
        },
      },
    });
  });

  it("migrates V1 aliases with canonical precedence and discards runtime projections", () => {
    const { root, statePath, database } = fixture();
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        version: 1,
        repositories: {
          vllm: {
            automaticSync: true,
            syncFrequencyMinutes: 15,
            syncLookbackDays: 7,
            nextSyncAt: "2026-09-11T01:00:00.000Z",
            lastSyncAt: "2026-09-10T01:00:00.000Z",
            lastError: "old runtime error",
            worktrees: {
              configuredSlots: 2,
              idleCleanupTtlHours: 48,
              physicalSlots: 9,
              active: 8,
              errors: [{ slotPath: "slot", message: "old" }],
            },
          },
        },
        checkpoint: {
          sourceRef: "canonical-source",
          branch: "legacy-source",
          checkpointIntervalMinutes: 15,
          intervalMinutes: 3,
          pushIntervalMinutes: 45,
          nextRunAt: "2026-09-11T01:00:00.000Z",
          lastSuccessAt: "2026-09-10T01:00:00.000Z",
          lastError: "old checkpoint error",
        },
        codeBackup: {
          repositoryPath: "/old/code",
          automaticCheckpoint: true,
          checkpointIntervalMinutes: 20,
          automaticPush: true,
          pushIntervalMinutes: 40,
          sourceRef: "main",
          remote: "origin",
          remoteBranch: "code-backup",
          nextCheckpointAt: "2026-09-11T01:00:00.000Z",
          lastError: "old code error",
        },
        agentArchive: {
          archiveRepositoryPath: "/old/archive",
          enabled: true,
          exportIntervalMinutes: 25,
          automaticPush: true,
          pushIntervalMinutes: 50,
          sourceRef: "main",
          remote: "origin",
          remoteBranch: "archive-backup",
          nextExportAt: "2026-09-11T01:00:00.000Z",
          lastError: "old archive error",
        },
        agent: {
          defaultProvider: "provider",
          defaultModel: "model",
          defaultReasoning: "high",
          retentionMinutes: 9,
          status: "offline",
          capabilities: { providers: [] },
        },
        providers: { deepseek: { configured: true } },
      }),
      "utf8",
    );

    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });
    const persisted = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, any>;

    expect(persisted.version).toBe(2);
    expect(persisted.knowledgeBackup).toMatchObject({
      sourceRef: "canonical-source",
      checkpointIntervalMinutes: 15,
      pushIntervalMinutes: 45,
    });
    expect(persisted.knowledgeBackup).not.toHaveProperty("branch");
    expect(persisted.knowledgeBackup).not.toHaveProperty("intervalMinutes");
    expect(persisted.repositories.vllm).not.toHaveProperty("nextSyncAt");
    expect(persisted.repositories.vllm).not.toHaveProperty("lastSyncAt");
    expect(persisted.repositories.vllm).not.toHaveProperty("lastError");
    expect(persisted.repositories.vllm.worktrees).toEqual({
      configuredSlots: 2,
      idleCleanupTtlHours: 48,
    });
    expect(persisted.codeBackup).not.toHaveProperty("repositoryPath");
    expect(persisted.codeBackup).not.toHaveProperty("nextCheckpointAt");
    expect(persisted.agentArchive.archiveRepositoryPath).toBe("/old/archive");
    expect(persisted.agentArchive).not.toHaveProperty("nextExportAt");
    expect(persisted.agent).not.toHaveProperty("status");
    expect(persisted.agent).not.toHaveProperty("capabilities");
    expect(persisted).not.toHaveProperty("providers");
    expect(settingsDocumentV2Schema.parse(persisted)).toEqual(persisted);
    expect(controller.agentArchiveSettingsSync().archiveRepositoryPath).toBe("/old/archive");
  });

  it("rejects invalid V2 input without overwriting the original file", () => {
    const { root, statePath, database } = fixture();
    const credential = () => new GitHubCredentialService({
      filePath: join(statePath, "github-credential.json"),
      environment: {},
      ghExecutable: "false",
    });
    new SettingsController({ database, systemRoot: root, statePath, environment: {}, credential: credential() });
    const settingsPath = join(root, "settings.json");
    const valid = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
    const invalidDocuments: Array<string> = [
      "{",
      "null",
      "[]",
      JSON.stringify({ version: 0 }),
      JSON.stringify({ version: 3 }),
      JSON.stringify({ ...valid, unknown: true }),
      JSON.stringify({ ...valid, agent: { ...valid.agent, retentionMinutes: "bad" } }),
      JSON.stringify({ ...valid, agent: undefined }),
    ];

    for (const invalid of invalidDocuments) {
      writeFileSync(settingsPath, invalid, "utf8");
      expect(() => new SettingsController({
        database,
        systemRoot: root,
        statePath,
        environment: {},
        credential: credential(),
      })).toThrow();
      expect(readFileSync(settingsPath, "utf8")).toBe(invalid);
    }
  });

  it("does not let bridge runtime projections overwrite durable policy", async () => {
    const { root, statePath, database } = fixture();
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      agent: {
        snapshot: () => ({
          status: "ready",
          version: "runtime-version",
          profile: "runtime-profile",
          connected: true,
          capabilities: null,
          defaultModel: "runtime-must-not-win",
        } as never),
      },
      repositorySchedules: {
        get: () => ({
          automaticSync: false,
          syncFrequencyMinutes: 1,
          nextSyncAt: "2026-09-11T02:00:00.000Z",
        } as never),
      },
      worktrees: {
        inspect: () => ({
          configuredSlots: 8,
          idleCleanupTtlHours: 1,
          physicalSlots: 2,
          active: 1,
          idle: 1,
          dirty: 0,
          pendingRetirement: 0,
        } as never),
      },
      checkpoint: {
        get: () => ({
          remote: "runtime-origin",
          sourceRef: "runtime-ref",
          checkpointIntervalMinutes: 1,
          pushIntervalMinutes: 2,
          nextRunAt: "2026-09-11T02:00:00.000Z",
          lastSuccessAt: null,
          lastError: null,
        } as never),
      },
      codeBackup: {
        get: () => ({
          automaticCheckpoint: true,
          checkpointIntervalMinutes: 1,
          nextCheckpointAt: "2026-09-11T02:00:00.000Z",
          lastCheckpointAt: null,
          lastPushAt: null,
          nextPushAt: null,
          lastError: null,
        } as never),
      },
      agentArchive: {
        get: () => ({
          enabled: true,
          exportIntervalMinutes: 1,
          nextExportAt: "2026-09-11T02:00:00.000Z",
          lastExportAt: null,
          lastPushAt: null,
          nextPushAt: null,
          lastError: null,
        } as never),
      },
    });

    await controller.updateRepository("vllm", {
      automaticSync: true,
      syncFrequencyMinutes: 45,
    });
    await controller.updateAgent({ defaultModel: "policy-model" });
    await controller.updateCheckpoint({ sourceRef: "policy-ref" });
    await controller.updateCodeBackup({ sourceRef: "policy-code" });
    await controller.updateAgentArchive({ sourceRef: "policy-archive" });

    await expect(controller.repository("vllm")).resolves.toMatchObject({
      automaticSync: true,
      syncFrequencyMinutes: 45,
      nextSyncAt: "2026-09-11T02:00:00.000Z",
      worktrees: { configuredSlots: 1, physicalSlots: 2 },
    });
    await expect(controller.agentSettings()).resolves.toMatchObject({
      defaultModel: "policy-model",
      version: "runtime-version",
    });
    await expect(controller.checkpointSettings()).resolves.toMatchObject({
      sourceRef: "policy-ref",
      remote: "origin",
      checkpointIntervalMinutes: null,
      nextRunAt: "2026-09-11T02:00:00.000Z",
    });
    await expect(controller.codeBackupSettings()).resolves.toMatchObject({
      sourceRef: "policy-code",
      automaticCheckpoint: false,
      repositoryPath: root,
      nextCheckpointAt: "2026-09-11T02:00:00.000Z",
    });
    await expect(controller.agentArchiveSettings()).resolves.toMatchObject({
      sourceRef: "policy-archive",
      enabled: false,
      nextExportAt: "2026-09-11T02:00:00.000Z",
    });
  });

  it("writes policy before projecting every settings update and persists backup cadence", async () => {
    const { root, statePath, database } = fixture();
    const settingsPath = join(root, "settings.json");
    const observed: Array<{ scope: string; document: Record<string, any> }> = [];
    const observe = (scope: string) => {
      observed.push({
        scope,
        document: JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>,
      });
    };
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      repositorySchedules: {
        update: () => {
          observe("repository");
          return { nextSyncAt: null };
        },
      },
      agent: {
        update: () => observe("agent"),
      },
      checkpoint: {
        update: () => {
          observe("knowledge");
          return null;
        },
      },
      codeBackup: {
        update: () => {
          observe("code");
          return null;
        },
      },
      agentArchive: {
        update: () => {
          observe("archive");
          return null;
        },
      },
    });

    await controller.updateRepository("vllm", { automaticSync: true, syncFrequencyMinutes: 15 });
    await controller.updateAgent({ retentionMinutes: 7 });
    await controller.updateCheckpoint({ checkpointIntervalMinutes: 20, pushIntervalMinutes: 40 });
    await controller.updateCodeBackup({ automaticCheckpoint: true, checkpointIntervalMinutes: 30, automaticPush: true, pushIntervalMinutes: 60 });
    const archivePath = join(root, "custom-agent-archive");
    await controller.updateAgentArchive({ archiveRepositoryPath: archivePath, enabled: true, exportIntervalMinutes: 25, automaticPush: true, pushIntervalMinutes: 50 });

    expect(observed.map((item) => item.scope)).toEqual([
      "repository",
      "agent",
      "knowledge",
      "code",
      "archive",
    ]);
    for (const item of observed) expect(item.document.version).toBe(2);
    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
    expect(persisted.knowledgeBackup).toMatchObject({
      checkpointIntervalMinutes: 20,
      pushIntervalMinutes: 40,
    });
    expect(persisted.codeBackup).toMatchObject({
      automaticCheckpoint: true,
      checkpointIntervalMinutes: 30,
      automaticPush: true,
      pushIntervalMinutes: 60,
    });
    expect(persisted.agentArchive).toMatchObject({
      archiveRepositoryPath: archivePath,
      enabled: true,
      exportIntervalMinutes: 25,
      automaticPush: true,
      pushIntervalMinutes: 50,
    });
    expect(persisted.codeBackup).not.toHaveProperty("repositoryPath");
    const restarted = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });
    expect(restarted.agentArchiveSettingsSync().archiveRepositoryPath).toBe(archivePath);
  });

  it("rejects enabling unavailable code backup before writing the policy", async () => {
    const { root, statePath, database } = fixture();
    const settingsPath = join(root, "settings.json");
    let updateCalls = 0;
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      codeBackup: {
        get: () => ({ available: false }),
        update: () => {
          updateCalls += 1;
          return { available: false };
        },
        runCheckpoint: () => {
          throw new Error("Git must not be called");
        },
        runPush: () => {
          throw new Error("Git must not be called");
        },
      },
    });
    const before = readFileSync(settingsPath, "utf8");

    await expect(controller.codeBackupSettings()).resolves.toMatchObject({
      repositoryPath: root,
      available: false,
    });

    await expect(controller.updateCodeBackup({ automaticCheckpoint: true })).rejects.toThrow(
      "Code backup unavailable in container-image deployment.",
    );
    await expect(controller.updateCodeBackup({ automaticPush: true })).rejects.toThrow(
      "Code backup unavailable in container-image deployment.",
    );
    await expect(controller.runCodeBackupCheckpoint()).rejects.toThrow(
      "Code backup unavailable in container-image deployment.",
    );
    await expect(controller.runCodeBackupPush()).rejects.toThrow(
      "Code backup unavailable in container-image deployment.",
    );

    expect(updateCalls).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });

  it("uses the runtime code checkout path without persisting it in Settings V2", async () => {
    const { root, statePath, database } = fixture();
    const runtimeRepositoryPath = join(root, "installed-loongboard");
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      codeBackup: {
        get: () => ({ repositoryPath: runtimeRepositoryPath, available: true }),
        update: () => ({ repositoryPath: runtimeRepositoryPath, available: true }),
      },
    });

    await expect(controller.codeBackupSettings()).resolves.toMatchObject({
      repositoryPath: runtimeRepositoryPath,
      available: true,
    });
    await expect(controller.updateCodeBackup({ sourceRef: "release" })).resolves.toMatchObject({
      repositoryPath: runtimeRepositoryPath,
      sourceRef: "release",
    });
    expect(controller.codeBackupSettingsSync().repositoryPath).toBe(runtimeRepositoryPath);

    const persisted = JSON.parse(readFileSync(join(root, "settings.json"), "utf8")) as Record<string, any>;
    expect(persisted.codeBackup).not.toHaveProperty("repositoryPath");
    expect(settingsDocumentV2Schema.parse(persisted)).toEqual(persisted);
  });

  it("hydrates persisted Agent overrides over system defaults after restart", () => {
    const { root, statePath, database } = fixture();
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        version: 1,
        agent: {
          defaultProvider: "persisted-provider",
          defaultModel: "persisted-model",
          defaultReasoning: "max",
          retentionMinutes: 7,
        },
      }),
      "utf8",
    );
    const updates: Array<Record<string, unknown>> = [];
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
      agent: {
        update: (patch) => {
          updates.push(patch);
        },
      },
      defaults: {
        defaultProvider: "yaml-provider",
        defaultModel: "yaml-model",
        defaultReasoning: "high",
        retentionMinutes: 120,
      },
    });

    controller.hydrateAgentRuntime();

    expect(updates).toEqual([
      {
        defaultProvider: "persisted-provider",
        defaultModel: "persisted-model",
        defaultReasoning: "max",
        retentionMinutes: 7,
      },
    ]);
  });

  it("persists the initial sync window without changing an existing watermark", async () => {
    const { root, statePath, database } = fixture();
    const startedAt = "2026-09-09T10:00:00.000Z";
    const run = createSyncRun(database, {
      repositoryId: "vllm",
      kind: "forward",
      attemptStartedAt: startedAt,
    });
    beginQueuedForwardSync(database, {
      repositoryId: "vllm",
      runId: run.syncRunId,
      startedAt,
    });
    completeSyncRunStream(database, run.syncRunId, "pull_request", {
      finishedAt: "2026-09-09T10:00:01.000Z",
      watermarkAfter: startedAt,
    });
    completeSyncRunStream(database, run.syncRunId, "issue", {
      finishedAt: "2026-09-09T10:00:01.000Z",
      watermarkAfter: startedAt,
    });
    completeSyncStream(database, {
      repositoryId: "vllm",
      entityKind: "pull_request",
      completedAt: "2026-09-09T10:00:01.000Z",
    });
    completeSyncStream(database, {
      repositoryId: "vllm",
      entityKind: "issue",
      completedAt: "2026-09-09T10:00:01.000Z",
    });
    const before = getRepositorySyncState(database, "vllm", "pull_request").watermarkUpdatedAt;
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });

    const updated = await controller.updateRepository("vllm", { syncLookbackDays: 7 });

    expect(updated.syncLookbackDays).toBe(7);
    expect(getRepositorySyncState(database, "vllm", "pull_request").watermarkUpdatedAt).toBe(before);
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toMatchObject({
      repositories: { vllm: { syncLookbackDays: 7 } },
    });
  });

  it("redacts the GitHub token and stores it with private permissions", async () => {
    const { root, statePath, database } = fixture();
    const credentialPath = join(statePath, "github-credential.json");
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: credentialPath,
        environment: {},
        ghExecutable: "false",
      }),
    });

    const response = await controller.saveGithubToken("secret-token-value");
    expect(response.configured).toBe(true);
    expect(response.source).toBe("settings");
    expect(JSON.stringify(response)).not.toContain("secret-token-value");
    expect(JSON.stringify(readFileSync(join(root, "settings.json"), "utf8"))).not.toContain(
      "secret-token-value",
    );
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(existsSync(credentialPath)).toBe(true);

    await controller.removeGithubToken();
    expect(existsSync(credentialPath)).toBe(false);
  });

  it("loads provider secrets only through the internal runtime callback", async () => {
    const { root, statePath, database } = fixture();
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      credential: new GitHubCredentialService({
        filePath: join(statePath, "github-credential.json"),
        environment: {},
        ghExecutable: "false",
      }),
    });

    await controller.saveProviderSecret("deepseek", "provider-secret");
    expect(controller.readProviderSecrets()).toEqual({ deepseek: "provider-secret" });
    const providerPath = join(statePath, "provider-secrets", "deepseek.secret");
    expect(statSync(providerPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(readFileSync(join(root, "settings.json"), "utf8"))).not.toContain(
      "provider-secret",
    );
    chmodSync(providerPath, 0o600);
  });

  it("persists worktree policy overrides and reconciles immediately", async () => {
    const { root, statePath, database } = fixture();
    const reconciled: string[] = [];
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath,
      environment: {},
      worktrees: {
        inspect: () => ({ physicalSlots: 1, active: 0, idle: 1, dirty: 0, pendingRetirement: 0 }),
        reconcile: (repositoryId) => {
          reconciled.push(repositoryId);
          return { physicalSlots: 1, active: 0, idle: 1, dirty: 0, pendingRetirement: 0 };
        },
      },
    });

    const updated = await controller.updateRepository("vllm", {
      worktrees: { configuredSlots: 2, idleCleanupTtlHours: 72 },
    });
    expect(updated.worktrees).toMatchObject({
      configuredSlots: 2,
      idleCleanupTtlHours: 72,
      physicalSlots: 1,
      idle: 1,
    });
    expect(reconciled).toEqual(["vllm"]);
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toMatchObject({
      repositories: { vllm: { worktrees: { configuredSlots: 2, idleCleanupTtlHours: 72 } } },
    });
  });
});
