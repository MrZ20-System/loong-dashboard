import type {
  AgentRuntimeSettingsBridge,
  AgentArchiveBridge,
  CodeBackupBridge,
  KnowledgeCheckpointBridge,
  RepositorySettingsBridge,
  RepositoryWorktreeBridge,
  SettingsController,
} from "./settings.js";
import type {
  AgentArchiveSettings,
  CodeBackupSettings,
  RepositoryWorktreeSettings,
} from "@loongboard/contracts";
import {
  getRepository,
  getScheduledTask,
  listScheduledTaskRuns,
  type DatabaseClient,
} from "@loongboard/database";
import type { AgentChatController } from "./agent-chat.js";
import type { KnowledgeController } from "./knowledge.js";
import type { SchedulerEngine } from "./scheduler.js";
import type { SystemConfig } from "./config.js";
import type { SystemActionState } from "./system-actions.js";
import {
  SYSTEM_TASK_IDS,
  type SystemScheduleProjector,
} from "./system-schedules.js";
import { validateAgentArchivePath } from "./system-actions.js";
import type { WorktreeMaintenanceService } from "./worktree-maintenance.js";
import { resolve } from "node:path";

export interface RuntimeSettingsAdapterOptions {
  database: DatabaseClient;
  config: SystemConfig;
  systemRoot: string;
  codeRepositoryPath: string;
  codeBackupAvailable: boolean;
  getSettingsController: () => SettingsController | null;
  getWorktreeMaintenance: () => WorktreeMaintenanceService | undefined;
  getAgentChat: () => AgentChatController;
}

export interface RuntimeSettingsBridges {
  repositorySchedules: RepositorySettingsBridge;
  checkpoint: KnowledgeCheckpointBridge;
  codeBackup: CodeBackupBridge;
  agentArchive: AgentArchiveBridge;
}

export interface RuntimeSettingsAdapters {
  readonly state: SystemActionState;
  readonly worktreePolicyResolver: (repositoryId: string, fallbackSlots: number) => {
    configuredSlots: number;
    idleCleanupTtlMs: number;
  };
  readonly worktreeSlotCapacityResolver: (repositoryId: string, fallbackSlots: number) => number;
  readonly worktreeBridge: RepositoryWorktreeBridge;
  readonly agentBridge: AgentRuntimeSettingsBridge;
  createBridges(input: {
    knowledge: KnowledgeController;
    scheduler: SchedulerEngine;
    projector: SystemScheduleProjector;
  }): RuntimeSettingsBridges;
  hydratePolicy(settings: SettingsController): void;
  setCheckpointNextRunAt(nextRunAt: string | null): void;
}

/**
 * Keep Settings' runtime bridges and mutable backup projections together.
 * The composition root supplies concrete services and only wires the returned
 * adapters; it does not own their policy/runtime merge logic.
 */
export function createRuntimeSettingsAdapters(
  options: RuntimeSettingsAdapterOptions,
): RuntimeSettingsAdapters {
  const state: SystemActionState = {
    checkpoint: {
      autoCommit: options.config.knowledge.checkpoint?.autoCommit ?? false,
      autoPush: options.config.knowledge.checkpoint?.autoPush ?? false,
      remote: options.config.knowledge.checkpoint?.remote ?? "origin",
      sourceRef: options.config.knowledge.checkpoint?.sourceRef ?? "main",
      remoteBranch:
        options.config.knowledge.checkpoint?.remoteBranch ??
        "loongboard-knowledge-backup",
      checkpointIntervalMinutes: null,
      pushIntervalMinutes: null,
      nextRunAt: null,
      lastSuccessAt: null,
      lastError: null,
    },
    codeBackup: {
      repositoryPath: options.codeRepositoryPath,
      available: options.codeBackupAvailable,
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
      archiveRepositoryPath: resolve(options.systemRoot, "agent-history"),
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

  const worktreePolicyResolver = (repositoryId: string, fallbackSlots: number) => {
    const settings = options.getSettingsController()?.repositorySettingsSync(repositoryId);
    return {
      configuredSlots:
        settings?.worktrees.configuredSlots ?? Math.min(8, Math.max(1, fallbackSlots)),
      idleCleanupTtlMs:
        (settings?.worktrees.idleCleanupTtlHours ?? 24) * 60 * 60 * 1_000,
    };
  };
  const worktreeSlotCapacityResolver = (repositoryId: string, fallbackSlots: number) =>
    worktreePolicyResolver(repositoryId, fallbackSlots).configuredSlots;

  const worktreeRef = (repositoryId: string) => {
    const repository = getRepository(options.database, repositoryId);
    if (repository === null) {
      throw new Error(`Repository is missing or disabled: ${repositoryId}`);
    }
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
      errors: result.errors.map((error) => ({
        slotPath: error.slotPath,
        message: error.message,
      })),
    };
  };

  const worktreeBridge: RepositoryWorktreeBridge = {
    inspect: async (repositoryId) => {
      const maintenance = options.getWorktreeMaintenance();
      if (maintenance === undefined) {
        throw new Error("Worktree maintenance is not configured");
      }
      const result = await maintenance.inspect(worktreeRef(repositoryId));
      return projectWorktreeResult(repositoryId, result);
    },
    reconcile: async (repositoryId) => {
      const maintenance = options.getWorktreeMaintenance();
      if (maintenance === undefined) {
        throw new Error("Worktree maintenance is not configured");
      }
      const result = await maintenance.reconcile(worktreeRef(repositoryId));
      return projectWorktreeResult(repositoryId, result);
    },
    cleanupUnused: async (repositoryId) => {
      const maintenance = options.getWorktreeMaintenance();
      if (maintenance === undefined) {
        throw new Error("Worktree maintenance is not configured");
      }
      const result = await maintenance.cleanupUnused(worktreeRef(repositoryId));
      return projectWorktreeResult(repositoryId, result);
    },
  };

  const agentBridge: AgentRuntimeSettingsBridge = {
    snapshot: async () => {
      const agentChat = options.getAgentChat();
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
      options.getAgentChat().updateRuntimeSettings(patch);
    },
  };

  const createBridges = (input: {
    knowledge: KnowledgeController;
    scheduler: SchedulerEngine;
    projector: SystemScheduleProjector;
  }): RuntimeSettingsBridges => {
    const repositorySchedules: RepositorySettingsBridge = {
      get: (repositoryId) => input.projector.repositoryStatus(repositoryId),
      update: (repositoryId, patch) => {
        const repository = getRepository(options.database, repositoryId);
        if (repository === null) {
          throw new Error(`Repository is missing or disabled: ${repositoryId}`);
        }
        const persistedPolicy = options
          .getSettingsController()
          ?.repositorySettingsSync(repositoryId);
        if (persistedPolicy === undefined) {
          throw new Error(`Repository settings are unavailable: ${repositoryId}`);
        }
        input.projector.projectRepository(repository, {
          automaticSync: patch.automaticSync ?? persistedPolicy.automaticSync,
          syncFrequencyMinutes:
            patch.syncFrequencyMinutes ?? persistedPolicy.syncFrequencyMinutes,
          retention: {
            ...persistedPolicy.retention,
            ...(patch.retention ?? {}),
          },
        });
        return input.projector.repositoryStatus(repositoryId);
      },
    };

    const checkpoint: KnowledgeCheckpointBridge = {
      get: () => {
        const task = getScheduledTask(
          options.database,
          SYSTEM_TASK_IDS.knowledgeCheckpoint,
        );
        const pushTask = getScheduledTask(
          options.database,
          SYSTEM_TASK_IDS.knowledgePush,
        );
        const runs = [
          ...(task === null
            ? []
            : listScheduledTaskRuns(options.database, SYSTEM_TASK_IDS.knowledgeCheckpoint)),
          ...(pushTask === null
            ? []
            : listScheduledTaskRuns(options.database, SYSTEM_TASK_IDS.knowledgePush)),
        ];
        return input.projector.checkpointRuntimeStatus(
          task,
          runs,
          state.checkpoint,
        );
      },
      update: (settings) => {
        state.checkpoint = {
          ...state.checkpoint,
          ...(settings.autoCommit === undefined
            ? {}
            : { autoCommit: settings.autoCommit }),
          ...(settings.autoPush === undefined
            ? {}
            : { autoPush: settings.autoPush }),
          ...(settings.remote === undefined ? {} : { remote: settings.remote }),
          ...(settings.sourceRef === undefined
            ? {}
            : { sourceRef: settings.sourceRef }),
          ...(settings.remoteBranch === undefined
            ? {}
            : { remoteBranch: settings.remoteBranch }),
          ...(settings.checkpointIntervalMinutes === undefined
            ? {}
            : { checkpointIntervalMinutes: settings.checkpointIntervalMinutes }),
          ...(settings.pushIntervalMinutes === undefined
            ? {}
            : { pushIntervalMinutes: settings.pushIntervalMinutes }),
          nextRunAt: null,
        };
        input.knowledge.updateCheckpoint(state.checkpoint);
        const tasks = input.projector.projectKnowledge(
          state.checkpoint,
          options.config.knowledge.path,
        );
        state.checkpoint.nextRunAt = tasks.checkpoint.nextRunAt;
        const pushTask = getScheduledTask(
          options.database,
          SYSTEM_TASK_IDS.knowledgePush,
        );
        const runs = [
          ...listScheduledTaskRuns(
            options.database,
            SYSTEM_TASK_IDS.knowledgeCheckpoint,
          ),
          ...(pushTask === null
            ? []
            : listScheduledTaskRuns(options.database, SYSTEM_TASK_IDS.knowledgePush)),
        ];
        return input.projector.checkpointRuntimeStatus(
          tasks.checkpoint,
          runs,
          state.checkpoint,
        );
      },
      run: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.knowledgeCheckpoint);
      },
      push: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.knowledgePush);
      },
    };

    const codeBackup: CodeBackupBridge = {
      get: () => input.projector.codeBackupStatus(state.codeBackup),
      update: (patch) => {
        state.codeBackup = {
          ...state.codeBackup,
          ...patch,
          available: state.codeBackup.available,
        };
        input.projector.projectCodeBackup(state.codeBackup);
        return input.projector.codeBackupStatus(state.codeBackup);
      },
      runCheckpoint: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.codeCheckpoint);
      },
      runPush: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.codePush);
      },
    };

    const agentArchive: AgentArchiveBridge = {
      get: () => input.projector.agentArchiveStatus(state.agentArchive),
      update: (patch) => {
        const next: AgentArchiveSettings = { ...state.agentArchive, ...patch };
        const archiveRepositoryPath = validateAgentArchivePath({
          archivePath: next.archiveRepositoryPath,
          statePath: options.config.runtime.statePath,
          worktreesPath: options.config.runtime.worktreesPath,
          knowledgePath: options.config.knowledge.path,
          codeRepositoryPath: options.codeRepositoryPath,
          create: true,
        });
        state.agentArchive = { ...next, archiveRepositoryPath };
        input.projector.projectAgentArchive(state.agentArchive);
        return input.projector.agentArchiveStatus(state.agentArchive);
      },
      runExport: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.agentArchiveCheckpoint);
      },
      runPush: async () => {
        await input.scheduler.runNow(SYSTEM_TASK_IDS.agentArchivePush);
      },
    };

    return { repositorySchedules, checkpoint, codeBackup, agentArchive };
  };

  const hydratePolicy = (settings: SettingsController): void => {
    state.checkpoint = {
      ...state.checkpoint,
      ...settings.checkpointSettingsSync(),
    };
    state.codeBackup = {
      ...settings.codeBackupSettingsSync(),
      repositoryPath: options.codeRepositoryPath,
      available: options.codeBackupAvailable,
    };
    const persistedArchive = settings.agentArchiveSettingsSync();
    const archiveRepositoryPath = validateAgentArchivePath({
      archivePath: persistedArchive.archiveRepositoryPath,
      statePath: options.config.runtime.statePath,
      worktreesPath: options.config.runtime.worktreesPath,
      knowledgePath: options.config.knowledge.path,
      codeRepositoryPath: options.codeRepositoryPath,
      create: true,
    });
    state.agentArchive = { ...persistedArchive, archiveRepositoryPath };
  };

  return {
    state,
    worktreePolicyResolver,
    worktreeSlotCapacityResolver,
    worktreeBridge,
    agentBridge,
    createBridges,
    hydratePolicy,
    setCheckpointNextRunAt(nextRunAt) {
      state.checkpoint.nextRunAt = nextRunAt;
    },
  };
}
