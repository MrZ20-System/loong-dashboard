import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  recoverInterruptedAgentSessions,
  getRepository,
  getScheduledTask,
  listScheduledTaskRuns,
  recoverInterruptedSyncStates,
  type DatabaseClient,
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
import type { RepositoryWorktreeSettings } from "@loongboard/contracts";
import { WorktreeMaintenanceService } from "./worktree-maintenance.js";
import { AuthService } from "./auth.js";
import { MetadataMaintenanceService } from "./metadata-maintenance.js";
import {
  createSystemActionExecutor,
  type SystemActionState,
  validateAgentArchivePath,
} from "./system-actions.js";
import {
  createSystemScheduleProjector,
  SYSTEM_TASK_IDS,
} from "./system-schedules.js";

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
  readonly metadataMaintenance: MetadataMaintenanceService;
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
    const metadataMaintenance = new MetadataMaintenanceService({
      database,
      calendarTimeZone: config.timezone,
      now: options.now,
      isSyncActive: (repositoryId) => coordinator.isRepositorySyncActive(repositoryId),
      setRepositoryMaintenanceActive: (repositoryId, active) =>
        coordinator.setRepositoryMaintenanceActive(repositoryId, active),
      logger: options.coordinatorLogger,
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
    const actionState: SystemActionState = {
      checkpoint: {
        autoCommit: config.knowledge.checkpoint?.autoCommit ?? false,
        autoPush: config.knowledge.checkpoint?.autoPush ?? false,
        remote: config.knowledge.checkpoint?.remote ?? "origin",
        sourceRef: config.knowledge.checkpoint?.sourceRef ?? "main",
        remoteBranch: config.knowledge.checkpoint?.remoteBranch ?? "loongboard-knowledge-backup",
        checkpointIntervalMinutes: null as number | null,
        pushIntervalMinutes: null as number | null,
        nextRunAt: null as string | null,
        lastSuccessAt: null as string | null,
        lastError: null as string | null,
      },
      codeBackup: {
        repositoryPath: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
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
      },
      agentArchive: {
        archiveRepositoryPath: resolve(
          resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
          "..",
          "agent-archive",
        ),
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
      },
    };
    // The code backup target is the installed LoongBoard repository itself,
    // independent of the shell cwd used to launch the server.
    const codeRepositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

    const executor = createSystemActionExecutor({
      database,
      config,
      coordinator,
      metadataMaintenance,
      worktreeMaintenance,
      repositorySettings: (repositoryId) => settingsController?.repositorySettingsSync(repositoryId),
      knowledge,
      codeRepositoryPath,
      state: actionState,
      now: options.now,
    });

    const scheduler = new SchedulerEngine({
      database,
      chats: agentChat,
      workspaceRuns,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      executor,
    });
    const projector = createSystemScheduleProjector({ database, scheduler, config });

    const repositorySchedules: RepositorySettingsBridge = {
      get: (repositoryId) => projector.repositoryStatus(repositoryId),
      update: (repositoryId, patch) => {
        const repository = getRepository(database, repositoryId);
        if (repository === null) throw new Error(`Repository is missing or disabled: ${repositoryId}`);
        // Settings writes the V2 policy before invoking this bridge. Read the
        // persisted policy for omitted fields so an existing task never
        // becomes the fallback authority for enabled/cadence.
        const persistedPolicy = settingsController?.repositorySettingsSync(repositoryId);
        if (persistedPolicy === undefined) {
          throw new Error(`Repository settings are unavailable: ${repositoryId}`);
        }
        projector.projectRepository(repository, {
          automaticSync: patch.automaticSync ?? persistedPolicy.automaticSync,
          syncFrequencyMinutes: patch.syncFrequencyMinutes ?? persistedPolicy.syncFrequencyMinutes,
          retention: {
            ...persistedPolicy.retention,
            ...(patch.retention ?? {}),
          },
        });
        return projector.repositoryStatus(repositoryId);
      },
    };

    const checkpointBridge: KnowledgeCheckpointBridge = {
      get: () => {
        const task = getScheduledTask(database, SYSTEM_TASK_IDS.knowledgeCheckpoint);
        const pushTask = getScheduledTask(database, SYSTEM_TASK_IDS.knowledgePush);
        const runs = [
          ...(task === null ? [] : listScheduledTaskRuns(database, SYSTEM_TASK_IDS.knowledgeCheckpoint)),
          ...(pushTask === null ? [] : listScheduledTaskRuns(database, SYSTEM_TASK_IDS.knowledgePush)),
        ];
        return projector.checkpointRuntimeStatus(task, runs, actionState.checkpoint);
      },
      update: (settings) => {
        actionState.checkpoint = {
          ...actionState.checkpoint,
          ...(settings.autoCommit === undefined ? {} : { autoCommit: settings.autoCommit }),
          ...(settings.autoPush === undefined ? {} : { autoPush: settings.autoPush }),
          ...(settings.remote === undefined ? {} : { remote: settings.remote }),
          ...(settings.sourceRef === undefined ? {} : { sourceRef: settings.sourceRef }),
          ...(settings.remoteBranch === undefined ? {} : { remoteBranch: settings.remoteBranch }),
          ...(settings.checkpointIntervalMinutes === undefined
            ? {}
            : { checkpointIntervalMinutes: settings.checkpointIntervalMinutes }),
          ...(settings.pushIntervalMinutes === undefined
            ? {}
            : { pushIntervalMinutes: settings.pushIntervalMinutes }),
          nextRunAt: null,
        };
        knowledge.updateCheckpoint({
          autoCommit: actionState.checkpoint.autoCommit,
          autoPush: actionState.checkpoint.autoPush,
          remote: actionState.checkpoint.remote,
          sourceRef: actionState.checkpoint.sourceRef,
          remoteBranch: actionState.checkpoint.remoteBranch,
          checkpointIntervalMinutes: actionState.checkpoint.checkpointIntervalMinutes,
          pushIntervalMinutes: actionState.checkpoint.pushIntervalMinutes,
        });
        const tasks = projector.projectKnowledge(actionState.checkpoint, config.knowledge.path);
        actionState.checkpoint.nextRunAt = tasks.checkpoint.nextRunAt;
        const pushTask = getScheduledTask(database, SYSTEM_TASK_IDS.knowledgePush);
        const runs = [
          ...listScheduledTaskRuns(database, SYSTEM_TASK_IDS.knowledgeCheckpoint),
          ...(pushTask === null ? [] : listScheduledTaskRuns(database, SYSTEM_TASK_IDS.knowledgePush)),
        ];
        return projector.checkpointRuntimeStatus(tasks.checkpoint, runs, actionState.checkpoint);
      },
      run: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.knowledgeCheckpoint);
      },
      push: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.knowledgePush);
      },
    };

    const codeBackupBridge: CodeBackupBridge = {
      get: () => projector.codeBackupStatus(actionState.codeBackup),
      update: (patch) => {
        actionState.codeBackup = { ...actionState.codeBackup, ...patch };
        projector.projectCodeBackup(actionState.codeBackup);
        return projector.codeBackupStatus(actionState.codeBackup);
      },
      runCheckpoint: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.codeCheckpoint);
      },
      runPush: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.codePush);
      },
    };

    const agentArchiveBridge: AgentArchiveBridge = {
      get: () => projector.agentArchiveStatus(actionState.agentArchive),
      update: (patch) => {
        const next = { ...actionState.agentArchive, ...patch };
        const archiveRepositoryPath = validateAgentArchivePath({
          archivePath: next.archiveRepositoryPath,
          statePath: config.runtime.statePath,
          worktreesPath: config.runtime.worktreesPath,
          knowledgePath: config.knowledge.path,
          codeRepositoryPath,
          create: true,
        });
        actionState.agentArchive = { ...next, archiveRepositoryPath };
        projector.projectAgentArchive(actionState.agentArchive);
        return projector.agentArchiveStatus(actionState.agentArchive);
      },
      runExport: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.agentArchiveCheckpoint);
      },
      runPush: async () => {
        await scheduler.runNow(SYSTEM_TASK_IDS.agentArchivePush);
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
    actionState.checkpoint = {
      ...actionState.checkpoint,
      autoCommit: persistedCheckpoint.autoCommit,
      autoPush: persistedCheckpoint.autoPush,
      remote: persistedCheckpoint.remote,
      sourceRef: persistedCheckpoint.sourceRef ?? "main",
      remoteBranch: persistedCheckpoint.remoteBranch ?? config.knowledge.checkpoint?.remoteBranch ?? "loongboard-knowledge-backup",
      checkpointIntervalMinutes: persistedCheckpoint.checkpointIntervalMinutes ?? null,
      pushIntervalMinutes: persistedCheckpoint.pushIntervalMinutes ?? null,
    };
    knowledge.updateCheckpoint(actionState.checkpoint);
    const persistedCode = settings.codeBackupSettingsSync();
    // The code repository is installation topology, not Settings policy.
    // Keep the runtime-resolved checkout even when the HTTP Settings
    // projection exposes a different/default display path.
    actionState.codeBackup = { ...persistedCode, repositoryPath: codeRepositoryPath };
    const persistedArchive = settings.agentArchiveSettingsSync();
    actionState.agentArchive = { ...persistedArchive };
    const archiveRepositoryPath = validateAgentArchivePath({
      archivePath: actionState.agentArchive.archiveRepositoryPath,
      statePath: config.runtime.statePath,
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      codeRepositoryPath,
      create: true,
    });
    actionState.agentArchive = { ...actionState.agentArchive, archiveRepositoryPath };
    projector.projectAll({
      repositories: config.repositories.map((repository) => ({
        repository,
        settings: settings.repositorySettingsSync(repository.key),
      })),
      knowledge: actionState.checkpoint,
      codeBackup: actionState.codeBackup,
      agentArchive: actionState.agentArchive,
    });
    actionState.checkpoint.nextRunAt =
      getScheduledTask(database, SYSTEM_TASK_IDS.knowledgeCheckpoint)?.nextRunAt ?? null;
    metadataMaintenance.recoverInterruptedRuns();
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
        metadataMaintenance,
      },
      options.appOptions,
    );

    let closePromise: Promise<void> | undefined;
    app.addHook("onClose", async () => {
      closePromise ??= (async () => {
        await metadataMaintenance.close();
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
      metadataMaintenance,
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
