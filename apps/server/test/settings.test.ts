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
  it("persists non-secret settings beside the system config and preserves unknown fields", async () => {
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
      syncLookbackDays: 30,
    });

    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(persisted.unrelated).toEqual({ keep: true });
    expect(persisted.agent).toMatchObject({ retentionMinutes: 0 });
    expect(persisted.repositories).toMatchObject({
      vllm: { automaticSync: true, syncFrequencyMinutes: 30, syncLookbackDays: 30 },
    });
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
