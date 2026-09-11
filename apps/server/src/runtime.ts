import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  recoverInterruptedAgentSessions,
  getScheduledTask,
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
} from "./settings.js";
import { WorktreeMaintenanceService } from "./worktree-maintenance.js";
import { AuthService } from "./auth.js";
import { MetadataMaintenanceService } from "./metadata-maintenance.js";
import { createSystemActionExecutor } from "./system-actions.js";
import { createSystemScheduleProjector, SYSTEM_TASK_IDS } from "./system-schedules.js";
import { isGitRepository } from "@loongboard/git-workspace";
import { createRuntimeSettingsAdapters } from "./runtime-settings-adapters.js";

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
    // The code backup target is the installed LoongBoard repository itself,
    // independent of the shell cwd used to launch the server.
    const codeRepositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    let worktreeMaintenance: WorktreeMaintenanceService | undefined;
    let agentChat: AgentChatController;
    const runtimeSettingsAdapters = createRuntimeSettingsAdapters({
      database,
      config,
      systemRoot,
      codeRepositoryPath,
      codeBackupAvailable: isGitRepository(codeRepositoryPath),
      getSettingsController: () => settingsController,
      getWorktreeMaintenance: () => worktreeMaintenance,
      getAgentChat: () => agentChat,
    });
    worktreeMaintenance = new WorktreeMaintenanceService({
      database,
      worktreesPath: config.runtime.worktreesPath,
      policyResolver: runtimeSettingsAdapters.worktreePolicyResolver,
      liveBusyWorkspacePaths: () => workspaceRuns.busyPaths(),
    });
    agentChat = new AgentChatController({
      database,
      workspaceRuns,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      domainWorkspaceRoot: systemRoot,
      worktreeSlotCapacity: runtimeSettingsAdapters.worktreeSlotCapacityResolver,
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
    const actionState = runtimeSettingsAdapters.state;
    const executor = createSystemActionExecutor({
      database,
      config,
      coordinator,
      metadataMaintenance,
      worktreeMaintenance: worktreeMaintenance!,
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

    const runtimeBridges = runtimeSettingsAdapters.createBridges({
      knowledge,
      scheduler,
      projector,
    });

    const settings = new SettingsController({
      database,
      systemRoot,
      statePath: config.runtime.statePath,
      environment: options.environment ?? process.env,
      github: provider,
      credential,
      agent: runtimeSettingsAdapters.agentBridge,
      repositorySchedules: runtimeBridges.repositorySchedules,
      worktrees: runtimeSettingsAdapters.worktreeBridge,
      checkpoint: runtimeBridges.checkpoint,
      codeBackup: runtimeBridges.codeBackup,
      agentArchive: runtimeBridges.agentArchive,
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

    runtimeSettingsAdapters.hydratePolicy(settings);
    knowledge.updateCheckpoint(actionState.checkpoint);
    projector.projectAll({
      repositories: config.repositories.map((repository) => ({
        repository,
        settings: settings.repositorySettingsSync(repository.key),
      })),
      knowledge: actionState.checkpoint,
      codeBackup: actionState.codeBackup,
      agentArchive: actionState.agentArchive,
    });
    runtimeSettingsAdapters.setCheckpointNextRunAt(
      getScheduledTask(database, SYSTEM_TASK_IDS.knowledgeCheckpoint)?.nextRunAt ?? null,
    );
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
        // SchedulerEngine disarms timers and waits for active scheduled Agent
        // runs. Close it before the Agent controller/runtime host so those
        // runs can finish against a live dependency graph.
        await scheduler.close();
        await agentChat.close();
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
