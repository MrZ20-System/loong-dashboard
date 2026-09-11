import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  recoverInterruptedAgentSessions,
  createScheduledTask,
  getScheduledTask,
  getRepository,
  listScheduledTaskRuns,
  recoverInterruptedSyncStates,
  updateScheduledTask,
  type DatabaseClient,
  type ScheduledTaskRow,
} from "@loongboard/database";
import {
  GitHubCredentialService,
  GhGitHubMetadataProvider,
  type GhGitHubMetadataProviderOptions,
  type GitHubMetadataProvider,
} from "@loongboard/github";
import type { FastifyInstance } from "fastify";

import { buildApp, type BuildAppOptions } from "./app.js";
import {
  loadSystemConfig,
  resolveSystemConfigPath,
  type SystemConfig,
} from "./config.js";
import { PullRequestEnrichmentService } from "./enrichment-service.js";
import { DomainReclassificationService } from "./reclassification-service.js";
import {
  type AgentRuntime,
  type AgentSessionSpec,
} from "@loongboard/agent-runtime";

import { AgentChatController } from "./agent-chat.js";
import { KnowledgeController } from "./knowledge.js";
import { SchedulerEngine } from "./scheduler.js";
import {
  RepositorySyncCoordinator,
  type SyncCoordinatorLogger,
} from "./sync-coordinator.js";
import { WorkspaceRunCoordinator } from "./workspace-run-coordinator.js";
import { DomainFileService } from "./domain-file.js";
import {
  SettingsController,
  type AgentArchiveBridge,
  type AgentRuntimeSettingsBridge,
  type CodeBackupBridge,
  type KnowledgeCheckpointBridge,
  type RepositorySettingsBridge,
  type RepositoryWorktreeBridge,
} from "./settings.js";
import type { SchedulerExecutor } from "./scheduler.js";
import { pushBackupRef, runCheckpoint } from "@loongboard/git-workspace";
import type { CodeBackupSettings } from "@loongboard/contracts";
import type { AgentArchiveSettings } from "@loongboard/contracts";
import type { RepositoryWorktreeSettings } from "@loongboard/contracts";
import { AgentArchiveExporter } from "./agent-archive.js";
import { GitRepositoryLock } from "./git-repository-lock.js";
import { WorktreeMaintenanceService } from "./worktree-maintenance.js";
import { AuthService } from "./auth.js";

export interface CreateServerRuntimeOptions {
  /** Use a prevalidated config in tests or an embedding process. */
  config?: SystemConfig;
  configPath?: string;
  /** Explicit root for settings/domains/prompts; required for nonstandard layouts. */
  systemRoot?: string;
  environment?: NodeJS.ProcessEnv;
  currentWorkingDirectory?: string;
  provider?: GitHubMetadataProvider;
  providerOptions?: GhGitHubMetadataProviderOptions;
  now?: () => Date;
  coordinatorLogger?: SyncCoordinatorLogger;
  appOptions?: BuildAppOptions;
  /** Override the DSH-backed runtime factory (tests inject a scripted one). */
  runtimeFactory?: (spec: AgentSessionSpec) => AgentRuntime;
}

export interface ServerRuntime {
  readonly app: FastifyInstance;
  readonly config: SystemConfig;
  readonly database: DatabaseClient;
  readonly databasePath: string;
  readonly coordinator: RepositorySyncCoordinator;
  readonly reclassification: DomainReclassificationService;
  readonly agentChat: AgentChatController;
  readonly knowledge: KnowledgeController;
  readonly scheduler: SchedulerEngine;
  readonly domainFiles: DomainFileService;
  readonly settings: SettingsController;
  readonly auth: AuthService;
}

/** Resolve the one SQLite path owned by the Server runtime. */
export function runtimeDatabasePath(config: SystemConfig): string {
  return join(config.runtime.statePath, "loongboard.sqlite3");
}

/**
 * Compose the complete Stage 1 process without listening on a socket.
 * Configuration is loaded first, then the runtime directory/database is
 * prepared, and only then are typed application dependencies constructed.
 */
export function createServerRuntime(
  options: CreateServerRuntimeOptions = {},
): ServerRuntime {
  const resolvedConfigPath = resolveRuntimeConfigPath(options);
  const config =
    options.config ??
    loadSystemConfig(resolvedConfigPath, options.environment ?? process.env);
  const systemRoot = resolve(
    options.systemRoot ??
      (options.config !== undefined && options.configPath === undefined
        ? dirname(config.runtime.statePath)
        : dirname(resolvedConfigPath)),
  );
  mkdirSync(config.runtime.statePath, { recursive: true });
  const databasePath = runtimeDatabasePath(config);
  const database = openDatabase(databasePath);

  try {
    reconcileRepositories(database, config.repositories);
    // A process interruption leaves the persisted streams marked running.
    // Recover them before composing the coordinator so the next manual or
    // scheduled run can start from the last successful watermark.
    recoverInterruptedSyncStates(database);
    // Startup recovery: mark sessions a previous process left running as
    // interrupted so their worktree slots are recyclable and knowledge
    // agent-version aggregation is not held open forever (plan 12.2/16.2).
    recoverInterruptedAgentSessions(database);

    const credential = new GitHubCredentialService({
      filePath: join(config.runtime.statePath, "github-credential.json"),
      environment: options.environment ?? process.env,
    });
    const auth = new AuthService({
      statePath: config.runtime.statePath,
      environment: options.environment ?? process.env,
      now: options.now,
    });
    const provider =
      options.provider ??
      new GhGitHubMetadataProvider({
        ...options.providerOptions,
        environment: options.providerOptions?.environment ?? options.environment ?? process.env,
        tokenResolver:
          options.providerOptions?.tokenResolver ?? credential.resolveToken.bind(credential),
      });
    const enricher = new PullRequestEnrichmentService({
      database,
      provider,
      logger: options.coordinatorLogger,
    });
    let settingsController: SettingsController | null = null;
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      calendarTimeZone: config.timezone,
      now: options.now,
      logger: options.coordinatorLogger,
      enricher,
      lookbackDaysForRepository: (repositoryId) =>
        settingsController?.repositorySettingsSync(repositoryId).syncLookbackDays ?? 30,
    });
    const reclassification = new DomainReclassificationService({ database });
    const workspaceRuns = new WorkspaceRunCoordinator();
    const worktreePolicyResolver = (repositoryId: string, fallbackSlots: number) => {
      const settings = settingsController?.repositorySettingsSync(repositoryId);
      return {
        configuredSlots: settings?.worktrees.configuredSlots ?? Math.min(8, Math.max(1, fallbackSlots)),
        idleCleanupTtlMs: (settings?.worktrees.idleCleanupTtlHours ?? 24) * 60 * 60 * 1_000,
      };
    };
    const worktreeSlotCapacityResolver = (repositoryId: string, fallbackSlots: number) =>
      worktreePolicyResolver(repositoryId, fallbackSlots).configuredSlots;
    const worktreeMaintenance = new WorktreeMaintenanceService({
      database,
      worktreesPath: config.runtime.worktreesPath,
      policyResolver: worktreePolicyResolver,
      liveBusyWorkspacePaths: () => workspaceRuns.busyPaths(),
    });
    const agentChat = new AgentChatController({
      database,
      workspaceRuns,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      domainWorkspaceRoot: systemRoot,
      worktreeSlotCapacity: worktreeSlotCapacityResolver,
      defaults: {
        provider: config.agent.defaultProvider,
        model: config.agent.defaultModel,
        reasoningEffort: config.agent.defaultReasoningEffort,
        idleProcessMinutes: config.agent.idleProcessMinutes,
      },
      credentials: async () => settingsController?.readProviderSecrets() ?? {},
      ...(options.runtimeFactory !== undefined
        ? { runtimeFactory: options.runtimeFactory as (spec: AgentSessionSpec) => AgentRuntime }
        : {}),
    });
    const knowledge = new KnowledgeController({
      database,
      knowledgePath: config.knowledge.path,
      historyLimit: config.knowledge.historyLimit,
      chats: agentChat,
      checkpoint: config.knowledge.checkpoint,
    });
    const checkpointTaskId = "system_knowledge_checkpoint";
    const knowledgePushTaskId = "system_knowledge_push";
    const codeCheckpointTaskId = "system_code_checkpoint";
    const codePushTaskId = "system_code_push";
    const archiveCheckpointTaskId = "system_agent_archive_checkpoint";
    const archivePushTaskId = "system_agent_archive_push";
    const worktreeCleanupTaskId = (repositoryId: string) =>
      `system_repository_worktrees_cleanup_${encodeURIComponent(repositoryId)}`;
    const repositoryTaskId = (repositoryId: string) =>
      `system_repository_sync_${encodeURIComponent(repositoryId)}`;
    let checkpointState = {
      autoCommit: config.knowledge.checkpoint?.autoCommit ?? false,
      autoPush: config.knowledge.checkpoint?.autoPush ?? false,
      remote: config.knowledge.checkpoint?.remote ?? "origin",
      branch: config.knowledge.checkpoint?.sourceRef ?? config.knowledge.checkpoint?.branch ?? "main",
      intervalMinutes: null as number | null,
      nextRunAt: null as string | null,
      lastSuccessAt: null as string | null,
      lastError: null as string | null,
      sourceRef: config.knowledge.checkpoint?.sourceRef ?? config.knowledge.checkpoint?.branch ?? "main",
      remoteBranch: config.knowledge.checkpoint?.remoteBranch ?? "loongboard-knowledge-backup",
      checkpointIntervalMinutes: null as number | null,
      pushIntervalMinutes: null as number | null,
    };
    // The code backup target is the installed LoongBoard repository itself,
    // independent of the shell cwd used to launch the server.
    const codeRepositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const defaultArchivePath = resolve(codeRepositoryPath, "..", "agent-archive");
    let codeBackupState: CodeBackupSettings = {
      repositoryPath: codeRepositoryPath,
      automaticCheckpoint: false,
      checkpointIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "loongboard-backup",
      lastCheckpointAt: null,
      nextCheckpointAt: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
    };
    let agentArchiveState: AgentArchiveSettings = {
      archiveRepositoryPath: defaultArchivePath,
      enabled: false,
      exportIntervalMinutes: null,
      automaticPush: false,
      pushIntervalMinutes: null,
      sourceRef: "main",
      remote: "origin",
      remoteBranch: "agent-history-backup",
      lastExportAt: null,
      nextExportAt: null,
      lastPushAt: null,
      nextPushAt: null,
      lastError: null,
    };
    const gitRepositoryLock = new GitRepositoryLock();

    const executor: SchedulerExecutor = {
      executeSystem: async ({ task }) => {
        if (task.action === "repository.sync") {
          if (task.repositoryId === null) {
            throw new Error("Repository sync task is missing repositoryId");
          }
          const run = coordinator.start(task.repositoryId, "system");
          const completed = await coordinator.waitForRun(run.syncRunId);
          if (completed.status === "failed" || completed.status === "partial") {
            throw new Error(completed.error ?? `Repository sync failed for ${task.repositoryId}`);
          }
          return;
        }
        if (task.action === "repository.worktrees.cleanup") {
          if (task.repositoryId === null) {
            throw new Error("Worktree cleanup task is missing repositoryId");
          }
          const repository = getRepository(database, task.repositoryId);
          if (repository === null) throw new Error(`Repository is missing or disabled: ${task.repositoryId}`);
          await worktreeMaintenance.reconcile({
            repositoryId: repository.id,
            repositoryKey: repository.key,
            mainRepositoryPath: repository.localPath,
            fallbackSlots: repository.worktreeSlots,
          });
          return;
        }
        if (task.action === "knowledge.checkpoint") {
          const result = await gitRepositoryLock.run(config.knowledge.path, () =>
            knowledge.runCheckpointNow({ push: false }),
          );
          if (result.error !== undefined) throw new Error(result.error);
          checkpointState = {
            ...checkpointState,
            lastSuccessAt: new Date().toISOString(),
            lastError: null,
          };
          return;
        }
        if (task.action === "git.checkpoint") {
          const result = await gitRepositoryLock.run(codeBackupState.repositoryPath, () =>
            runCheckpoint({
              repositoryPath: codeBackupState.repositoryPath,
              message: `chore: automatic checkpoint ${new Date().toISOString()}`,
              sourceRef: codeBackupState.sourceRef,
            }),
          );
          if (result.error !== undefined) throw new Error(result.error);
          codeBackupState = { ...codeBackupState, lastCheckpointAt: new Date().toISOString(), lastError: null };
          return;
        }
        if (task.action === "git.push") {
          const result = await gitRepositoryLock.run(codeBackupState.repositoryPath, () =>
            pushBackupRef({
              repositoryPath: codeBackupState.repositoryPath,
              remote: codeBackupState.remote,
              sourceRef: codeBackupState.sourceRef,
              remoteBranch: codeBackupState.remoteBranch,
            }),
          );
          if (!result.pushed) throw new Error(result.error ?? "Code backup push failed");
          codeBackupState = { ...codeBackupState, lastPushAt: new Date().toISOString(), lastError: null };
          return;
        }
        if (task.action === "knowledge.push") {
          const result = await gitRepositoryLock.run(config.knowledge.path, () =>
            knowledge.runPushNow(),
          );
          if (result.error !== undefined) throw new Error(result.error);
          checkpointState = {
            ...checkpointState,
            lastSuccessAt: new Date().toISOString(),
            lastError: null,
          };
          return;
        }
        if (task.action === "agent.archive.checkpoint") {
          const result = await gitRepositoryLock.run(
            agentArchiveState.archiveRepositoryPath,
            async () => {
              validateAgentArchivePath({
                archivePath: agentArchiveState.archiveRepositoryPath,
                statePath: config.runtime.statePath,
                worktreesPath: config.runtime.worktreesPath,
                knowledgePath: config.knowledge.path,
                codeRepositoryPath,
                create: false,
              });
              new AgentArchiveExporter({
                database,
                archiveRoot: agentArchiveState.archiveRepositoryPath,
              }).export();
              return runCheckpoint({
                repositoryPath: agentArchiveState.archiveRepositoryPath,
                message: `chore(agent-archive): export ${new Date().toISOString()}`,
                sourceRef: agentArchiveState.sourceRef,
              });
            },
          );
          if (result.error !== undefined) {
            throw new Error(`Agent archive checkpoint failed: ${result.error}`);
          }
          agentArchiveState = {
            ...agentArchiveState,
            lastExportAt: new Date().toISOString(),
            lastError: null,
          };
          return;
        }
        if (task.action === "agent.archive.push") {
          const result = await gitRepositoryLock.run(
            agentArchiveState.archiveRepositoryPath,
            async () => {
              validateAgentArchivePath({
                archivePath: agentArchiveState.archiveRepositoryPath,
                statePath: config.runtime.statePath,
                worktreesPath: config.runtime.worktreesPath,
                knowledgePath: config.knowledge.path,
                codeRepositoryPath,
                create: false,
              });
              return pushBackupRef({
                repositoryPath: agentArchiveState.archiveRepositoryPath,
                remote: agentArchiveState.remote,
                sourceRef: agentArchiveState.sourceRef,
                remoteBranch: agentArchiveState.remoteBranch,
              });
            },
          );
          if (!result.pushed) {
            throw new Error(`Agent archive push failed: ${result.error ?? "unknown Git error"}`);
          }
          agentArchiveState = {
            ...agentArchiveState,
            lastPushAt: new Date().toISOString(),
            lastError: null,
          };
          return;
        }
        throw new Error(`Unknown system scheduled action: ${task.action ?? ""}`);
      },
    };

    const scheduler = new SchedulerEngine({
      database,
      chats: agentChat,
      workspaceRuns,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      executor,
    });

    const repositorySchedules: RepositorySettingsBridge = {
      get: (repositoryId) => repositoryScheduleFromTask(database, repositoryId, repositoryTaskId),
      update: (repositoryId, patch) => {
        const repository = getRepository(database, repositoryId);
        if (repository === null) throw new Error(`Repository is missing or disabled: ${repositoryId}`);
        const taskId = repositoryTaskId(repositoryId);
        const existing = getScheduledTask(database, taskId);
        const automaticSync = patch.automaticSync ?? existing?.enabled ?? false;
        const syncFrequencyMinutes =
          patch.syncFrequencyMinutes ??
          (existing === null || existing === undefined
            ? 60
            : intervalFromCron(existing.cronExpression) ?? 60);
        if (!automaticSync && existing === null) {
          return {
            automaticSync: false,
            syncFrequencyMinutes,
            nextSyncAt: null,
          };
        }
        const cronExpression = cronForInterval(syncFrequencyMinutes);
        const task =
          existing === null
            ? createScheduledTask(database, {
                id: taskId,
                name: `Sync ${repository.displayName}`,
                cronExpression,
                timezone: config.timezone,
                prompt: `Synchronize repository metadata for ${repository.key}.`,
                workspacePath: repository.localPath,
                provider: config.agent.defaultProvider,
                model: config.agent.defaultModel,
                reasoningEffort: config.agent.defaultReasoningEffort,
                kind: "system",
                action: "repository.sync",
                repositoryId,
                enabled: automaticSync,
              })
            : updateSystemTask(database, existing, {
                cronExpression,
                workspacePath: repository.localPath,
                timezone: config.timezone,
                enabled: automaticSync,
              });
        scheduler.refresh(task.id);
        const current = getScheduledTask(database, task.id)!;
        return {
          automaticSync: current.enabled,
          syncFrequencyMinutes,
          nextSyncAt: current.nextRunAt,
        };
      },
    };

    const checkpointBridge: KnowledgeCheckpointBridge = {
      get: () => {
        const task = getScheduledTask(database, checkpointTaskId);
        const pushTask = getScheduledTask(database, knowledgePushTaskId);
        if (task === null) {
          return checkpointState.intervalMinutes === null && checkpointState.pushIntervalMinutes === null
            ? checkpointState
            : { ...checkpointState, autoCommit: false, autoPush: false, intervalMinutes: null, checkpointIntervalMinutes: null, pushIntervalMinutes: null, nextRunAt: null };
        }
        const runs = [
          ...listScheduledTaskRuns(database, checkpointTaskId),
          ...(getScheduledTask(database, knowledgePushTaskId) === null
            ? []
            : listScheduledTaskRuns(database, knowledgePushTaskId)),
        ].sort(
          (left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor),
        );
        const completed = runs.find((run) => run.status === "completed");
        const latestTerminal = runs.find((run) => run.status !== "running");
        return {
          ...checkpointState,
          autoCommit: task.enabled,
          autoPush: pushTask?.enabled ?? false,
          // A disabled stable task still has a placeholder cron so Run now
          // can use the same scheduler path. Preserve the user's nullable
          // interval while it is disabled.
          intervalMinutes: task.enabled
            ? intervalFromCron(task.cronExpression)
            : checkpointState.intervalMinutes,
          checkpointIntervalMinutes: task.enabled
            ? intervalFromCron(task.cronExpression)
            : checkpointState.checkpointIntervalMinutes,
          pushIntervalMinutes: pushTask?.enabled
            ? intervalFromCron(pushTask.cronExpression)
            : checkpointState.pushIntervalMinutes,
          nextRunAt: task.nextRunAt,
          lastSuccessAt: completed?.finishedAt ?? checkpointState.lastSuccessAt,
          // A later successful run clears an older failure; only the latest
          // terminal run represents the current status.
          lastError:
            latestTerminal?.status === "failed"
              ? latestTerminal.error
              : latestTerminal?.status === "completed"
                ? null
                : checkpointState.lastError,
        };
      },
      update: (settings) => {
        checkpointState = {
          ...checkpointState,
          ...settings,
          nextRunAt: null,
        };
        knowledge.updateCheckpoint(checkpointState);
        const task = syncKnowledgeCheckpointTask({
          database,
          scheduler,
          taskId: checkpointTaskId,
          settings: checkpointState,
          config,
          workspacePath: config.knowledge.path,
        });
        syncKnowledgePushTask({
          database,
          scheduler,
          taskId: knowledgePushTaskId,
          settings: checkpointState,
          config,
          workspacePath: config.knowledge.path,
        });
        checkpointState.nextRunAt = task.nextRunAt;
        return checkpointState;
      },
      run: async () => {
        await scheduler.runNow(checkpointTaskId);
      },
      push: async () => {
        await scheduler.runNow(knowledgePushTaskId);
      },
    };

    const codeBackupBridge: CodeBackupBridge = {
      get: () => codeBackupStatus(database, codeBackupState),
      update: (patch) => {
        codeBackupState = { ...codeBackupState, ...patch };
        syncCodeBackupTasks({ database, scheduler, codeBackupState, config });
        return codeBackupState;
      },
      runCheckpoint: async () => {
        await scheduler.runNow(codeCheckpointTaskId);
      },
      runPush: async () => {
        await scheduler.runNow(codePushTaskId);
      },
    };

    const agentArchiveBridge: AgentArchiveBridge = {
      get: () => agentArchiveStatus(database, agentArchiveState),
      update: (patch) => {
        const next = { ...agentArchiveState, ...patch };
        const archiveRepositoryPath = validateAgentArchivePath({
          archivePath: next.archiveRepositoryPath,
          statePath: config.runtime.statePath,
          worktreesPath: config.runtime.worktreesPath,
          knowledgePath: config.knowledge.path,
          codeRepositoryPath,
          create: true,
        });
        agentArchiveState = { ...next, archiveRepositoryPath };
        syncAgentArchiveTasks({
          database,
          scheduler,
          state: agentArchiveState,
          config,
        });
        return agentArchiveState;
      },
      runExport: async () => {
        await scheduler.runNow(archiveCheckpointTaskId);
      },
      runPush: async () => {
        await scheduler.runNow(archivePushTaskId);
      },
    };

    const worktreeRef = (repositoryId: string) => {
      const repository = getRepository(database, repositoryId);
      if (repository === null) throw new Error(`Repository is missing or disabled: ${repositoryId}`);
      return {
        repositoryId,
        repositoryKey: repository.key,
        mainRepositoryPath: repository.localPath,
        fallbackSlots: repository.worktreeSlots,
      };
    };
    const projectWorktreeResult = (
      repositoryId: string,
      result: {
        configuredSlots: number;
        physicalSlots: number;
        active: number;
        idle: number;
        dirty: number;
        pendingRetirement: number;
        pendingRetirementPaths: readonly string[];
        dirtyPaths: readonly string[];
        busyPaths: readonly string[];
        errors: readonly { slotPath: string; message: string }[];
      },
    ): Partial<RepositoryWorktreeSettings> => {
      const policy = worktreePolicyResolver(repositoryId, worktreeRef(repositoryId).fallbackSlots);
      return {
        configuredSlots: policy.configuredSlots,
        idleCleanupTtlHours: policy.idleCleanupTtlMs / (60 * 60 * 1_000),
        physicalSlots: result.physicalSlots,
        active: result.active,
        idle: result.idle,
        dirty: result.dirty,
        pendingRetirement: result.pendingRetirement,
        pendingRetirementPaths: [...result.pendingRetirementPaths],
        dirtyPaths: [...result.dirtyPaths],
        busyPaths: [...result.busyPaths],
        errors: result.errors.map((error) => ({ slotPath: error.slotPath, message: error.message })),
      };
    };
    const worktreeBridge: RepositoryWorktreeBridge = {
      inspect: async (repositoryId) => {
        const result = await worktreeMaintenance.inspect(worktreeRef(repositoryId));
        return projectWorktreeResult(repositoryId, result);
      },
      reconcile: async (repositoryId) => {
        const result = await worktreeMaintenance.reconcile(worktreeRef(repositoryId));
        return projectWorktreeResult(repositoryId, result);
      },
      cleanupUnused: async (repositoryId) => {
        const result = await worktreeMaintenance.cleanupUnused(worktreeRef(repositoryId));
        return projectWorktreeResult(repositoryId, result);
      },
    };

    const agentBridge: AgentRuntimeSettingsBridge = {
      snapshot: async () => {
        const health = agentChat.health();
        const capabilities = await agentChat.discoverCapabilities();
        return {
          status:
            capabilities === null
              ? health.status
              : capabilities.connected
                ? health.status
                : "offline",
          version: capabilities?.version ?? null,
          profile: capabilities?.profile ?? null,
          connected: capabilities?.connected ?? false,
          capabilities,
        };
      },
      update: (patch) => {
        agentChat.updateRuntimeSettings(patch);
      },
    };

    const settings = new SettingsController({
      database,
      systemRoot,
      statePath: config.runtime.statePath,
      environment: options.environment ?? process.env,
      github: provider,
      credential,
      agent: agentBridge,
      repositorySchedules,
      worktrees: worktreeBridge,
      checkpoint: checkpointBridge,
      codeBackup: codeBackupBridge,
      agentArchive: agentArchiveBridge,
      defaults: {
        defaultProvider: config.agent.defaultProvider,
        defaultModel: config.agent.defaultModel,
        defaultReasoning: config.agent.defaultReasoningEffort,
        retentionMinutes: config.agent.idleProcessMinutes,
        checkpoint: config.knowledge.checkpoint,
      },
    });
    settingsController = settings;
    // system.yaml constructed AgentChatController with installation defaults;
    // apply user operational overrides before any scheduler run can create a
    // new session. Scheduled task settings remain their own authority.
    settings.hydrateAgentRuntime();

    const persistedCheckpoint = settings.checkpointSettingsSync();
    checkpointState = {
      ...checkpointState,
      ...persistedCheckpoint,
      sourceRef: persistedCheckpoint.sourceRef ?? persistedCheckpoint.branch,
      remoteBranch: persistedCheckpoint.remoteBranch ?? config.knowledge.checkpoint?.remoteBranch ?? "loongboard-knowledge-backup",
      checkpointIntervalMinutes: persistedCheckpoint.checkpointIntervalMinutes ?? persistedCheckpoint.intervalMinutes ?? null,
      pushIntervalMinutes: persistedCheckpoint.pushIntervalMinutes ?? null,
    };
    // Keep one stable checkpoint task even when automatic scheduling is off;
    // Settings Run now/Push now then use the same workspace lock and run
    // history as scheduled execution. Existing task state is authoritative
    // and is never re-enabled from stale settings.json.
    const checkpointTask = ensureKnowledgeCheckpointTask({
      database,
      scheduler,
      taskId: checkpointTaskId,
      settings: {
        autoCommit: persistedCheckpoint.autoCommit,
        autoPush: persistedCheckpoint.autoPush,
        remote: persistedCheckpoint.remote,
        branch: persistedCheckpoint.branch,
        intervalMinutes: persistedCheckpoint.checkpointIntervalMinutes ?? persistedCheckpoint.intervalMinutes ?? null,
      },
      config,
      workspacePath: config.knowledge.path,
    });
    ensureKnowledgePushTask({
      database,
      scheduler,
      taskId: knowledgePushTaskId,
      settings: {
        autoPush: persistedCheckpoint.autoPush,
        pushIntervalMinutes: persistedCheckpoint.pushIntervalMinutes ?? null,
      },
      config,
      workspacePath: config.knowledge.path,
    });
    checkpointState = {
      ...checkpointState,
      autoCommit: checkpointTask.enabled,
      intervalMinutes: checkpointTask.enabled
        ? intervalFromCron(checkpointTask.cronExpression)
        : persistedCheckpoint.intervalMinutes ?? null,
      nextRunAt: checkpointTask.nextRunAt,
    };
    const persistedCode = settings.codeBackupSettingsSync();
    codeBackupState = { ...codeBackupState, ...persistedCode };
    ensureCodeBackupTasks({ database, scheduler, codeBackupState, config });
    const persistedArchive = settings.agentArchiveSettingsSync();
    agentArchiveState = { ...agentArchiveState, ...persistedArchive };
    const archiveRepositoryPath = validateAgentArchivePath({
      archivePath: agentArchiveState.archiveRepositoryPath,
      statePath: config.runtime.statePath,
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      codeRepositoryPath,
      create: true,
    });
    agentArchiveState = { ...agentArchiveState, archiveRepositoryPath };
    ensureAgentArchiveTasks({ database, scheduler, state: agentArchiveState, config });
    for (const repository of config.repositories) {
      ensureWorktreeCleanupTask({
        database,
        scheduler,
        taskId: worktreeCleanupTaskId(repository.key),
        repository,
        config,
      });
    }
    knowledge.updateCheckpoint(checkpointState);
    for (const repository of config.repositories) {
      const repositorySettings = settings.repositorySettingsSync(repository.key);
      if (repositorySettings.automaticSync && getScheduledTask(database, repositoryTaskId(repository.key)) === null) {
        repositorySchedules.update?.(repository.key, repositorySettings);
      }
    }
    knowledge.start();
    scheduler.start();
    // Resume enabled cursors left by an interrupted run or by an older
    // release that stopped after one bounded partial batch. Always admit a
    // fresh run; prior durable run records remain immutable.
    coordinator.resumeEnabledHistories();
    const domainFiles = new DomainFileService({
      database,
      systemRoot,
      statePath: config.runtime.statePath,
      reclassification,
    });
    domainFiles.start();
    const app = buildApp(
      {
        database,
        timezone: config.timezone,
        syncCoordinator: coordinator,
        github: provider,
        reclassification,
        agentChat,
        knowledge,
        scheduledTasks: {
          engine: scheduler,
          defaults: {
            provider: config.agent.defaultProvider,
            model: config.agent.defaultModel,
            reasoningEffort: config.agent.defaultReasoningEffort,
          },
        },
        domainFiles,
        settings,
        auth,
      },
      options.appOptions,
    );

    let closePromise: Promise<void> | undefined;
    app.addHook("onClose", async () => {
      closePromise ??= (async () => {
        const schedulerClose = scheduler.close();
        await agentChat.close();
        await schedulerClose;
        await coordinator.close();
        await knowledge.close();
        await domainFiles.close();
        await reclassification.close();
        database.close();
      })();
      await closePromise;
    });

    return {
      app,
      config,
      database,
      databasePath,
      coordinator,
      reclassification,
      agentChat,
      knowledge,
      scheduler,
      domainFiles,
      settings,
      auth,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function resolveRuntimeConfigPath(options: CreateServerRuntimeOptions): string {
  if (options.configPath !== undefined) return resolve(options.configPath);
  if (options.config !== undefined) {
    return resolve(dirname(options.config.runtime.statePath), "system.yaml");
  }
  const environment = options.environment ?? process.env;
  const currentWorkingDirectory =
    options.currentWorkingDirectory ?? process.cwd();
  return resolveSystemConfigPath(environment, currentWorkingDirectory);
}

function repositoryScheduleFromTask(
  database: DatabaseClient,
  repositoryId: string,
  taskId: (repositoryId: string) => string,
): Partial<{
  automaticSync: boolean;
  syncFrequencyMinutes: number;
  nextSyncAt: string | null;
}> | null {
  const task = getScheduledTask(database, taskId(repositoryId));
  if (task === null || task.kind !== "system" || task.action !== "repository.sync") return null;
  return {
    automaticSync: task.enabled,
    syncFrequencyMinutes: intervalFromCron(task.cronExpression) ?? 60,
    nextSyncAt: task.nextRunAt,
  };
}

function updateSystemTask(
  database: DatabaseClient,
  existing: ScheduledTaskRow,
  patch: {
    cronExpression: string;
    workspacePath: string;
    timezone: string;
    enabled: boolean;
  },
): ScheduledTaskRow {
  if (existing.kind !== "system" || existing.action !== "repository.sync") {
    throw new Error(`System task id is already used: ${existing.id}`);
  }
  return updateScheduledTask(database, existing.id, patch);
}

function cronForInterval(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("Sync frequency must be positive");
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < 1_440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  if (minutes % 1_440 === 0) return "0 0 * * *";
  throw new Error("Sync frequency must be a whole number of hours or days");
}

function ensureWorktreeCleanupTask(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  taskId: string;
  repository: SystemConfig["repositories"][number];
  config: SystemConfig;
}): ScheduledTaskRow {
  const existing = getScheduledTask(input.database, input.taskId);
  if (
    existing !== null &&
    (existing.kind !== "system" || existing.action !== "repository.worktrees.cleanup")
  ) {
    throw new Error(`System task id is already used: ${input.taskId}`);
  }
  const task = existing === null
    ? createScheduledTask(input.database, {
        id: input.taskId,
        name: `Clean worktrees ${input.repository.name}`,
        cronExpression: "0 */6 * * *",
        timezone: input.config.timezone,
        prompt: `Reconcile idle worktrees for repository ${input.repository.key}.`,
        workspacePath: input.repository.path,
        provider: input.config.agent.defaultProvider,
        model: input.config.agent.defaultModel,
        reasoningEffort: input.config.agent.defaultReasoningEffort,
        kind: "system",
        action: "repository.worktrees.cleanup",
        repositoryId: input.repository.key,
        enabled: true,
      })
    : updateScheduledTask(input.database, existing.id, {
        // `scheduled_tasks` is the runtime cadence authority. Preserve a
        // user's cron/enabled/next state across restart; only refresh the
        // immutable system action and repository binding.
        name: existing.name,
        cronExpression: existing.cronExpression,
        timezone: existing.timezone,
        prompt: existing.prompt,
        workspacePath: input.repository.path,
        provider: existing.provider,
        model: existing.model,
        reasoningEffort: existing.reasoningEffort,
        kind: "system",
        action: "repository.worktrees.cleanup",
        repositoryId: input.repository.key,
        enabled: existing.enabled,
      });
  input.scheduler.refresh(task.id);
  return getScheduledTask(input.database, task.id) ?? task;
}

function intervalFromCron(cron: string): number | null {
  const minute = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minute !== null) return Number(minute[1]);
  const hour = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hour !== null) return Number(hour[1]) * 60;
  if (cron === "0 0 * * *") return 1_440;
  return null;
}

function syncKnowledgeCheckpointTask(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  taskId: string;
  settings: {
    autoCommit: boolean;
    autoPush: boolean;
    remote: string;
    branch: string;
    intervalMinutes: number | null;
    checkpointIntervalMinutes?: number | null;
  };
  config: SystemConfig;
  workspacePath: string;
}): ScheduledTaskRow {
  const existing = getScheduledTask(input.database, input.taskId);
  if (
    existing !== null &&
    (existing.kind !== "system" || existing.action !== "knowledge.checkpoint")
  ) {
    throw new Error(`System task id is already used: ${input.taskId}`);
  }
  const checkpointInterval = input.settings.checkpointIntervalMinutes ?? input.settings.intervalMinutes;
  const shouldSchedule = input.settings.autoCommit && checkpointInterval !== null;
  const task =
    existing === null
      ? createScheduledTask(input.database, {
          id: input.taskId,
          name: "Knowledge checkpoint",
          cronExpression: cronForInterval(checkpointInterval ?? 1_440),
          timezone: input.config.timezone,
          prompt: "Run the Knowledge repository checkpoint.",
          workspacePath: input.workspacePath,
          provider: input.config.agent.defaultProvider,
          model: input.config.agent.defaultModel,
          reasoningEffort: input.config.agent.defaultReasoningEffort,
          kind: "system",
          action: "knowledge.checkpoint",
          enabled: shouldSchedule,
        })
      : updateScheduledTask(input.database, existing.id, {
          ...(checkpointInterval === null
            ? {}
            : { cronExpression: cronForInterval(checkpointInterval) }),
          enabled: shouldSchedule,
          workspacePath: input.workspacePath,
          timezone: input.config.timezone,
        });
  input.scheduler.refresh(task.id);
  const current = getScheduledTask(input.database, task.id);
  if (current === null) throw new Error(`Knowledge task disappeared: ${task.id}`);
  return current;
}

function ensureKnowledgeCheckpointTask(input: Parameters<typeof syncKnowledgeCheckpointTask>[0]): ScheduledTaskRow {
  const existing = getScheduledTask(input.database, input.taskId);
  if (existing !== null) {
    if (existing.kind !== "system" || existing.action !== "knowledge.checkpoint") {
      throw new Error(`System task id is already used: ${input.taskId}`);
    }
    return existing;
  }
  return syncKnowledgeCheckpointTask(input);
}

function ensureKnowledgePushTask(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  taskId: string;
  settings: { autoPush: boolean; pushIntervalMinutes: number | null };
  config: SystemConfig;
  workspacePath: string;
}): ScheduledTaskRow {
  const existing = getScheduledTask(input.database, input.taskId);
  if (existing !== null) {
    if (existing.kind !== "system" || existing.action !== "knowledge.push") {
      throw new Error(`System task id is already used: ${input.taskId}`);
    }
    return existing;
  }
  const task = createScheduledTask(input.database, {
    id: input.taskId,
    name: "Knowledge push",
    cronExpression: cronForInterval(input.settings.pushIntervalMinutes ?? 1_440),
    timezone: input.config.timezone,
    prompt: "Push the Knowledge repository checkpoint.",
    workspacePath: input.workspacePath,
    provider: input.config.agent.defaultProvider,
    model: input.config.agent.defaultModel,
    reasoningEffort: input.config.agent.defaultReasoningEffort,
    kind: "system",
    action: "knowledge.push",
    enabled: input.settings.autoPush && input.settings.pushIntervalMinutes !== null,
  });
  input.scheduler.refresh(task.id);
  return getScheduledTask(input.database, task.id)!;
}

function syncKnowledgePushTask(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  taskId: string;
  settings: { autoPush: boolean; pushIntervalMinutes: number | null };
  config: SystemConfig;
  workspacePath: string;
}): ScheduledTaskRow {
  const existing = getScheduledTask(input.database, input.taskId);
  if (existing === null) {
    return ensureKnowledgePushTask(input);
  }
  if (existing.kind !== "system" || existing.action !== "knowledge.push") {
    throw new Error(`System task id is already used: ${input.taskId}`);
  }
  const task = updateScheduledTask(input.database, existing.id, {
    ...(input.settings.pushIntervalMinutes === null ? {} : { cronExpression: cronForInterval(input.settings.pushIntervalMinutes) }),
    enabled: input.settings.autoPush && input.settings.pushIntervalMinutes !== null,
    workspacePath: input.workspacePath,
    timezone: input.config.timezone,
  });
  input.scheduler.refresh(task.id);
  return getScheduledTask(input.database, task.id)!;
}

function syncCodeBackupTasks(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  codeBackupState: CodeBackupSettings;
  config: SystemConfig;
}): void {
  const createOrUpdate = (taskId: string, name: string, action: "git.checkpoint" | "git.push", enabled: boolean, interval: number | null) => {
    const existing = getScheduledTask(input.database, taskId);
    if (existing !== null && (existing.kind !== "system" || existing.action !== action)) {
      throw new Error(`System task id is already used: ${taskId}`);
    }
    const task = existing === null
      ? createScheduledTask(input.database, {
          id: taskId,
          name,
          cronExpression: cronForInterval(interval ?? 1_440),
          timezone: input.config.timezone,
          prompt: name,
          workspacePath: input.codeBackupState.repositoryPath,
          provider: input.config.agent.defaultProvider,
          model: input.config.agent.defaultModel,
          reasoningEffort: input.config.agent.defaultReasoningEffort,
          kind: "system",
          action,
          enabled: enabled && interval !== null,
        })
      : updateScheduledTask(input.database, taskId, {
          ...(interval === null ? {} : { cronExpression: cronForInterval(interval) }),
          workspacePath: input.codeBackupState.repositoryPath,
          timezone: input.config.timezone,
          enabled: enabled && interval !== null,
        });
    input.scheduler.refresh(task.id);
  };
  createOrUpdate("system_code_checkpoint", "Code checkpoint", "git.checkpoint", input.codeBackupState.automaticCheckpoint, input.codeBackupState.checkpointIntervalMinutes ?? null);
  createOrUpdate("system_code_push", "Code push", "git.push", input.codeBackupState.automaticPush, input.codeBackupState.pushIntervalMinutes ?? null);
}

function ensureCodeBackupTasks(input: {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  codeBackupState: CodeBackupSettings;
  config: SystemConfig;
}): void {
  const ensure = (taskId: string, name: string, action: "git.checkpoint" | "git.push", enabled: boolean, interval: number | null) => {
    const existing = getScheduledTask(input.database, taskId);
    if (existing !== null) {
      if (existing.kind !== "system" || existing.action !== action) throw new Error(`System task id is already used: ${taskId}`);
      // The repository path is installation topology, not scheduler policy.
      // Repair an old cwd-derived projection while preserving task enabled,
      // cron, and nextRunAt authority.
      if (existing.workspacePath !== input.codeBackupState.repositoryPath) {
        updateScheduledTask(input.database, taskId, {
          workspacePath: input.codeBackupState.repositoryPath,
        });
      }
      return;
    }
    const task = createScheduledTask(input.database, {
      id: taskId,
      name,
      cronExpression: cronForInterval(interval ?? 1_440),
      timezone: input.config.timezone,
      prompt: name,
      workspacePath: input.codeBackupState.repositoryPath,
      provider: input.config.agent.defaultProvider,
      model: input.config.agent.defaultModel,
      reasoningEffort: input.config.agent.defaultReasoningEffort,
      kind: "system",
      action,
      enabled: enabled && interval !== null,
    });
    input.scheduler.refresh(task.id);
  };
  ensure("system_code_checkpoint", "Code checkpoint", "git.checkpoint", input.codeBackupState.automaticCheckpoint, input.codeBackupState.checkpointIntervalMinutes ?? null);
  ensure("system_code_push", "Code push", "git.push", input.codeBackupState.automaticPush, input.codeBackupState.pushIntervalMinutes ?? null);
}

function codeBackupStatus(database: DatabaseClient, state: CodeBackupSettings): CodeBackupSettings {
  const checkpointTask = getScheduledTask(database, "system_code_checkpoint");
  const pushTask = getScheduledTask(database, "system_code_push");
  const runs = [
    ...(checkpointTask === null ? [] : listScheduledTaskRuns(database, checkpointTask.id)),
    ...(pushTask === null ? [] : listScheduledTaskRuns(database, pushTask.id)),
  ].sort((left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor));
  const checkpointRun = checkpointTask === null ? undefined : listScheduledTaskRuns(database, checkpointTask.id).find((run) => run.status === "completed");
  const pushRun = pushTask === null ? undefined : listScheduledTaskRuns(database, pushTask.id).find((run) => run.status === "completed");
  const latestFailure = runs.find((run) => run.status === "failed");
  return {
    ...state,
    automaticCheckpoint: checkpointTask?.enabled ?? state.automaticCheckpoint,
    checkpointIntervalMinutes: checkpointTask?.enabled ? intervalFromCron(checkpointTask.cronExpression) : state.checkpointIntervalMinutes,
    nextCheckpointAt: checkpointTask?.nextRunAt ?? null,
    automaticPush: pushTask?.enabled ?? state.automaticPush,
    pushIntervalMinutes: pushTask?.enabled ? intervalFromCron(pushTask.cronExpression) : state.pushIntervalMinutes,
    nextPushAt: pushTask?.nextRunAt ?? null,
    lastCheckpointAt: checkpointRun?.finishedAt ?? state.lastCheckpointAt,
    lastPushAt: pushRun?.finishedAt ?? state.lastPushAt,
    lastError: latestFailure?.error ?? null,
  };
}

interface AgentArchiveTaskInput {
  database: DatabaseClient;
  scheduler: SchedulerEngine;
  state: AgentArchiveSettings;
  config: SystemConfig;
}

function pathContains(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** Resolve symlinks through the nearest existing ancestor of a future path. */
function canonicalPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(existing.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    existing = parent;
  }
  const canonicalExisting = existsSync(existing) ? realpathSync(existing) : existing;
  return resolve(canonicalExisting, ...suffix);
}

/** Validate and, when requested, create the explicit archive target. */
export function validateAgentArchivePath(input: {
  archivePath: string;
  statePath: string;
  worktreesPath: string;
  knowledgePath: string;
  codeRepositoryPath: string;
  create: boolean;
}): string {
  const archivePath = resolve(input.archivePath);
  const canonicalArchivePath = canonicalPath(archivePath);
  const forbiddenRoots = [
    input.statePath,
    join(input.statePath, "agent-sessions"),
    join(input.statePath, "provider-secrets"),
    input.worktreesPath,
    input.knowledgePath,
    input.codeRepositoryPath,
  ];
  if (forbiddenRoots.some((root) => {
    const canonicalRoot = canonicalPath(root);
    return (
      pathContains(root, archivePath) ||
      pathContains(archivePath, root) ||
      pathContains(canonicalRoot, canonicalArchivePath) ||
      pathContains(canonicalArchivePath, canonicalRoot)
    );
  })) {
    throw new Error(
      `Agent archive path is unsafe or overlaps a runtime/source directory: ${archivePath}`,
    );
  }
  if (existsSync(archivePath)) {
    if (!statSync(archivePath).isDirectory()) {
      throw new Error(`Agent archive path is not a directory: ${archivePath}`);
    }
    return archivePath;
  }
  if (!input.create) {
    throw new Error(`Agent archive path does not exist: ${archivePath}`);
  }
  try {
    mkdirSync(archivePath, { recursive: true });
  } catch (error) {
    throw new Error(
      `Agent archive path cannot be created: ${archivePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return archivePath;
}

function syncAgentArchiveTasks(input: AgentArchiveTaskInput): void {
  const createOrUpdate = (
    taskId: string,
    name: string,
    action: "agent.archive.checkpoint" | "agent.archive.push",
    enabled: boolean,
    interval: number | null,
  ) => {
    const existing = getScheduledTask(input.database, taskId);
    if (existing !== null && (existing.kind !== "system" || existing.action !== action)) {
      throw new Error(`System task id is already used: ${taskId}`);
    }
    const task = existing === null
      ? createScheduledTask(input.database, {
          id: taskId,
          name,
          cronExpression: cronForInterval(interval ?? 1_440),
          timezone: input.config.timezone,
          prompt: name,
          workspacePath: input.state.archiveRepositoryPath,
          provider: input.config.agent.defaultProvider,
          model: input.config.agent.defaultModel,
          reasoningEffort: input.config.agent.defaultReasoningEffort,
          kind: "system",
          action,
          enabled: enabled && interval !== null,
        })
      : updateScheduledTask(input.database, taskId, {
          ...(interval === null ? {} : { cronExpression: cronForInterval(interval) }),
          workspacePath: input.state.archiveRepositoryPath,
          timezone: input.config.timezone,
          enabled: enabled && interval !== null,
        });
    input.scheduler.refresh(task.id);
  };
  createOrUpdate(
    "system_agent_archive_checkpoint",
    "Agent archive export",
    "agent.archive.checkpoint",
    input.state.enabled,
    input.state.exportIntervalMinutes ?? null,
  );
  createOrUpdate(
    "system_agent_archive_push",
    "Agent archive push",
    "agent.archive.push",
    input.state.automaticPush,
    input.state.pushIntervalMinutes ?? null,
  );
}

function ensureAgentArchiveTasks(input: AgentArchiveTaskInput): void {
  const ensure = (
    taskId: string,
    name: string,
    action: "agent.archive.checkpoint" | "agent.archive.push",
    enabled: boolean,
    interval: number | null,
  ) => {
    const existing = getScheduledTask(input.database, taskId);
    if (existing !== null) {
      if (existing.kind !== "system" || existing.action !== action) {
        throw new Error(`System task id is already used: ${taskId}`);
      }
      if (existing.workspacePath !== input.state.archiveRepositoryPath) {
        updateScheduledTask(input.database, taskId, {
          workspacePath: input.state.archiveRepositoryPath,
        });
      }
      return;
    }
    const task = createScheduledTask(input.database, {
      id: taskId,
      name,
      cronExpression: cronForInterval(interval ?? 1_440),
      timezone: input.config.timezone,
      prompt: name,
      workspacePath: input.state.archiveRepositoryPath,
      provider: input.config.agent.defaultProvider,
      model: input.config.agent.defaultModel,
      reasoningEffort: input.config.agent.defaultReasoningEffort,
      kind: "system",
      action,
      enabled: enabled && interval !== null,
    });
    input.scheduler.refresh(task.id);
  };
  ensure(
    "system_agent_archive_checkpoint",
    "Agent archive export",
    "agent.archive.checkpoint",
    input.state.enabled,
    input.state.exportIntervalMinutes ?? null,
  );
  ensure(
    "system_agent_archive_push",
    "Agent archive push",
    "agent.archive.push",
    input.state.automaticPush,
    input.state.pushIntervalMinutes ?? null,
  );
}

function agentArchiveStatus(
  database: DatabaseClient,
  state: AgentArchiveSettings,
): AgentArchiveSettings {
  const exportTask = getScheduledTask(database, "system_agent_archive_checkpoint");
  const pushTask = getScheduledTask(database, "system_agent_archive_push");
  const runs = [
    ...(exportTask === null ? [] : listScheduledTaskRuns(database, exportTask.id)),
    ...(pushTask === null ? [] : listScheduledTaskRuns(database, pushTask.id)),
  ].sort((left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor));
  const exportRun = exportTask === null
    ? undefined
    : listScheduledTaskRuns(database, exportTask.id).find((run) => run.status === "completed");
  const pushRun = pushTask === null
    ? undefined
    : listScheduledTaskRuns(database, pushTask.id).find((run) => run.status === "completed");
  const latestFailure = runs.find((run) => run.status === "failed");
  return {
    ...state,
    enabled: exportTask?.enabled ?? state.enabled,
    exportIntervalMinutes: exportTask?.enabled
      ? intervalFromCron(exportTask.cronExpression)
      : state.exportIntervalMinutes,
    nextExportAt: exportTask?.nextRunAt ?? null,
    automaticPush: pushTask?.enabled ?? state.automaticPush,
    pushIntervalMinutes: pushTask?.enabled
      ? intervalFromCron(pushTask.cronExpression)
      : state.pushIntervalMinutes,
    nextPushAt: pushTask?.nextRunAt ?? null,
    lastExportAt: exportRun?.finishedAt ?? state.lastExportAt,
    lastPushAt: pushRun?.finishedAt ?? state.lastPushAt,
    lastError: latestFailure?.error ?? null,
  };
}
