import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  recoverInterruptedAgentSessions,
  createScheduledTask,
  getScheduledTask,
  getRepository,
  getRepositorySyncStatus,
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
import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { buildApp } from "./app.js";
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
  type AgentRuntimeSettingsBridge,
  type KnowledgeCheckpointBridge,
  type RepositorySettingsBridge,
} from "./settings.js";
import type { SchedulerExecutor } from "./scheduler.js";

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
  appOptions?: FastifyServerOptions;
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
  const config = options.config ?? loadSystemConfig(resolvedConfigPath);
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
      now: options.now,
      logger: options.coordinatorLogger,
      enricher,
      lookbackDaysForRepository: (repositoryId) =>
        settingsController?.repositorySettingsSync(repositoryId).syncLookbackDays ?? 30,
    });
    const reclassification = new DomainReclassificationService({ database });
    const workspaceRuns = new WorkspaceRunCoordinator();
    const agentChat = new AgentChatController({
      database,
      workspaceRuns,
      agentSessionsPath: join(config.runtime.statePath, "agent-sessions"),
      worktreesPath: config.runtime.worktreesPath,
      knowledgePath: config.knowledge.path,
      domainWorkspaceRoot: systemRoot,
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
    const repositoryTaskId = (repositoryId: string) =>
      `system_repository_sync_${encodeURIComponent(repositoryId)}`;
    let checkpointState = {
      autoCommit: config.knowledge.checkpoint?.autoCommit ?? false,
      autoPush: config.knowledge.checkpoint?.autoPush ?? false,
      remote: config.knowledge.checkpoint?.remote ?? "origin",
      branch: config.knowledge.checkpoint?.branch ?? "main",
      intervalMinutes: null as number | null,
      nextRunAt: null as string | null,
      lastSuccessAt: null as string | null,
      lastError: null as string | null,
    };

    const executor: SchedulerExecutor = {
      executeSystem: async ({ task }) => {
        if (task.action === "repository.sync") {
          if (task.repositoryId === null) {
            throw new Error("Repository sync task is missing repositoryId");
          }
          coordinator.start(task.repositoryId);
          await coordinator.waitForIdle();
          const sync = getRepositorySyncStatus(database, task.repositoryId);
          const failed = [sync.pullRequests, sync.issues].find(
            (state) => state.status === "failed",
          );
          if (failed !== undefined) {
            throw new Error(
              failed.lastError ??
                `Repository sync failed for ${task.repositoryId}/${failed.entityKind}`,
            );
          }
          return;
        }
        if (task.action === "knowledge.checkpoint") {
          // Let Knowledge apply its configured autoPush behavior.
          const result = await knowledge.runCheckpointNow();
          if (result.error !== undefined) throw new Error(result.error);
          checkpointState = {
            ...checkpointState,
            lastSuccessAt: new Date().toISOString(),
            lastError: null,
          };
          return;
        }
        if (task.action === "knowledge.push") {
          const result = await knowledge.runCheckpointNow({ push: true });
          if (result.error !== undefined) throw new Error(result.error);
          checkpointState = {
            ...checkpointState,
            lastSuccessAt: new Date().toISOString(),
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
        if (task === null) {
          return checkpointState.intervalMinutes === null
            ? checkpointState
            : { ...checkpointState, autoCommit: false, intervalMinutes: null, nextRunAt: null };
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
          // A disabled stable task still has a placeholder cron so Run now
          // can use the same scheduler path. Preserve the user's nullable
          // interval while it is disabled.
          intervalMinutes: task.enabled
            ? intervalFromCron(task.cronExpression)
            : checkpointState.intervalMinutes,
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
      checkpoint: checkpointBridge,
      defaults: {
        defaultProvider: config.agent.defaultProvider,
        defaultModel: config.agent.defaultModel,
        defaultReasoning: config.agent.defaultReasoningEffort,
        retentionMinutes: config.agent.idleProcessMinutes,
        checkpoint: config.knowledge.checkpoint,
      },
    });
    settingsController = settings;

    const persistedCheckpoint = settings.checkpointSettingsSync();
    checkpointState = {
      ...checkpointState,
      ...persistedCheckpoint,
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
        intervalMinutes: persistedCheckpoint.intervalMinutes ?? null,
      },
      config,
      workspacePath: config.knowledge.path,
    });
    ensureKnowledgePushTask({
      database,
      taskId: knowledgePushTaskId,
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
    knowledge.updateCheckpoint(checkpointState);
    for (const repository of config.repositories) {
      const repositorySettings = settings.repositorySettingsSync(repository.key);
      if (repositorySettings.automaticSync && getScheduledTask(database, repositoryTaskId(repository.key)) === null) {
        repositorySchedules.update?.(repository.key, repositorySettings);
      }
    }
    knowledge.start();
    scheduler.start();
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
  const shouldSchedule = input.settings.autoCommit && input.settings.intervalMinutes !== null;
  const task =
    existing === null
      ? createScheduledTask(input.database, {
          id: input.taskId,
          name: "Knowledge checkpoint",
          cronExpression: cronForInterval(input.settings.intervalMinutes ?? 1_440),
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
          ...(input.settings.intervalMinutes === null
            ? {}
            : { cronExpression: cronForInterval(input.settings.intervalMinutes) }),
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
  taskId: string;
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
  return createScheduledTask(input.database, {
    id: input.taskId,
    name: "Knowledge push",
    cronExpression: "0 0 * * *",
    timezone: input.config.timezone,
    prompt: "Push the Knowledge repository checkpoint.",
    workspacePath: input.workspacePath,
    provider: input.config.agent.defaultProvider,
    model: input.config.agent.defaultModel,
    reasoningEffort: input.config.agent.defaultReasoningEffort,
    kind: "system",
    action: "knowledge.push",
    enabled: false,
  });
}
