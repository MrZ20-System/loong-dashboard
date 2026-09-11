import type {
  AgentArchiveSettings,
  CodeBackupSettings,
  KnowledgeCheckpointSettings,
  RepositoryRetentionSettings,
} from "@loongboard/contracts";
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTaskRuns,
  updateScheduledTask,
  type DatabaseClient,
  type RepositoryRecord,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from "@loongboard/database";

import type { SystemConfig } from "./config.js";
import type { SchedulerEngine } from "./scheduler.js";

type SchedulerRefresher = Pick<SchedulerEngine, "refresh">;
type ConfiguredRepository = SystemConfig["repositories"][number];
type ScheduleRepository = ConfiguredRepository | RepositoryRecord;

export const SYSTEM_TASK_IDS = {
  knowledgeCheckpoint: "system_knowledge_checkpoint",
  knowledgePush: "system_knowledge_push",
  codeCheckpoint: "system_code_checkpoint",
  codePush: "system_code_push",
  agentArchiveCheckpoint: "system_agent_archive_checkpoint",
  agentArchivePush: "system_agent_archive_push",
  repositorySync: (repositoryId: string) =>
    `system_repository_sync_${encodeURIComponent(repositoryId)}`,
  metadataMaintenance: (repositoryId: string) =>
    `system_repository_metadata_maintenance_${encodeURIComponent(repositoryId)}`,
  worktreeCleanup: (repositoryId: string) =>
    `system_repository_worktrees_cleanup_${encodeURIComponent(repositoryId)}`,
} as const;

export interface RepositorySchedulePolicy {
  automaticSync: boolean;
  syncFrequencyMinutes: number;
  retention: RepositoryRetentionSettings;
}

export interface KnowledgeSchedulePolicy {
  autoCommit: boolean;
  autoPush: boolean;
  remote: string;
  sourceRef: string;
  remoteBranch: string;
  checkpointIntervalMinutes: number | null;
  pushIntervalMinutes: number | null;
}

export interface SystemScheduleProjection {
  repositories: readonly {
    repository: ConfiguredRepository;
    settings: RepositorySchedulePolicy;
  }[];
  knowledge: KnowledgeSchedulePolicy;
  codeBackup: CodeBackupSettings;
  agentArchive: AgentArchiveSettings;
}

export interface SystemScheduleProjector {
  projectAll(input: SystemScheduleProjection): void;
  projectRepository(
    repository: ScheduleRepository,
    settings: RepositorySchedulePolicy,
  ): ScheduledTaskRow;
  projectKnowledge(
    settings: KnowledgeSchedulePolicy,
    workspacePath: string,
  ): { checkpoint: ScheduledTaskRow; push: ScheduledTaskRow };
  projectCodeBackup(state: CodeBackupSettings): void;
  projectAgentArchive(state: AgentArchiveSettings): void;
  repositoryStatus(repositoryId: string): Partial<{
    nextSyncAt: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }> | null;
  checkpointRuntimeStatus(
    checkpointTask: ScheduledTaskRow | null,
    runs: readonly ScheduledRunRow[],
    state: Pick<KnowledgeCheckpointSettings, "nextRunAt" | "lastSuccessAt" | "lastError">,
  ): Partial<KnowledgeCheckpointSettings>;
  codeBackupStatus(state: CodeBackupSettings): Partial<CodeBackupSettings>;
  agentArchiveStatus(state: AgentArchiveSettings): Partial<AgentArchiveSettings>;
}

/** Convert the Settings minute policy into the single task engine's cron form. */
export function cronForInterval(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error("Sync frequency must be positive");
  }
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < 1_440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  if (minutes % 1_440 === 0) return "0 0 * * *";
  throw new Error("Sync frequency must be a whole number of hours or days");
}

/**
 * Project Settings policy into stable scheduled task rows. The projector is
 * deliberately the only place that knows system task IDs and cadence rules.
 */
export function createSystemScheduleProjector(options: {
  database: DatabaseClient;
  scheduler: SchedulerRefresher;
  config: SystemConfig;
}): SystemScheduleProjector {
  const projectRepository = (
    repository: ScheduleRepository,
    settings: RepositorySchedulePolicy,
  ): ScheduledTaskRow => {
    const repositoryId = repository.key;
    const repositoryName = "displayName" in repository ? repository.displayName : repository.name;
    const repositoryPath = "localPath" in repository ? repository.localPath : repository.path;
    const syncTask = projectRepositorySync(repository, settings);
    projectMetadataMaintenance(repository, settings.retention);
    projectWorktreeCleanup(repository);
    return syncTask;

    function projectRepositorySync(
      input: ScheduleRepository,
      policy: RepositorySchedulePolicy,
    ): ScheduledTaskRow {
      const taskId = SYSTEM_TASK_IDS.repositorySync(input.key);
      const existing = getScheduledTask(options.database, taskId);
      const cronExpression = cronForInterval(policy.syncFrequencyMinutes);
      if (
        existing !== null &&
        (existing.kind !== "system" || existing.action !== "repository.sync")
      ) {
        throw new Error(`System task id is already used: ${taskId}`);
      }
      const task = existing === null
        ? createScheduledTask(options.database, {
            id: taskId,
            name: `Sync ${repositoryName}`,
            cronExpression,
            timezone: options.config.timezone,
            prompt: `Synchronize repository metadata for ${repositoryId}.`,
            workspacePath: repositoryPath,
            provider: options.config.agent.defaultProvider,
            model: options.config.agent.defaultModel,
            reasoningEffort: options.config.agent.defaultReasoningEffort,
            kind: "system",
            action: "repository.sync",
            repositoryId,
            enabled: policy.automaticSync,
          })
        : updateScheduledTask(options.database, existing.id, {
            cronExpression,
            workspacePath: repositoryPath,
            timezone: options.config.timezone,
            enabled: policy.automaticSync,
            kind: "system",
            action: "repository.sync",
            repositoryId,
          });
      options.scheduler.refresh(task.id);
      return getScheduledTask(options.database, task.id) ?? task;
    }

    function projectMetadataMaintenance(
      input: ScheduleRepository,
      _retention: RepositoryRetentionSettings,
    ): ScheduledTaskRow {
      const taskId = SYSTEM_TASK_IDS.metadataMaintenance(input.key);
      const existing = getScheduledTask(options.database, taskId);
      if (
        existing !== null &&
        (existing.kind !== "system" || existing.action !== "repository.metadata-maintenance")
      ) {
        throw new Error(`System task id is already used: ${taskId}`);
      }
      const task = existing === null
        ? createScheduledTask(options.database, {
            id: taskId,
            name: `Maintain metadata ${repositoryName}`,
            cronExpression: "0 3 * * *",
            timezone: options.config.timezone,
            prompt: `Maintain repository metadata and runtime history for ${repositoryId}.`,
            workspacePath: repositoryPath,
            provider: options.config.agent.defaultProvider,
            model: options.config.agent.defaultModel,
            reasoningEffort: options.config.agent.defaultReasoningEffort,
            kind: "system",
            action: "repository.metadata-maintenance",
            repositoryId,
            // Runtime history cleanup remains enabled even when metadata
            // archive policy is disabled; the action checks retention at run time.
            enabled: true,
          })
        : updateScheduledTask(options.database, existing.id, {
            name: `Maintain metadata ${repositoryName}`,
            cronExpression: "0 3 * * *",
            timezone: options.config.timezone,
            prompt: `Maintain repository metadata and runtime history for ${repositoryId}.`,
            workspacePath: repositoryPath,
            provider: existing.provider,
            model: existing.model,
            reasoningEffort: existing.reasoningEffort,
            kind: "system",
            action: "repository.metadata-maintenance",
            repositoryId,
            enabled: true,
          });
      options.scheduler.refresh(task.id);
      return getScheduledTask(options.database, task.id) ?? task;
    }

    function projectWorktreeCleanup(input: ScheduleRepository): ScheduledTaskRow {
      const taskId = SYSTEM_TASK_IDS.worktreeCleanup(input.key);
      const existing = getScheduledTask(options.database, taskId);
      if (
        existing !== null &&
        (existing.kind !== "system" || existing.action !== "repository.worktrees.cleanup")
      ) {
        throw new Error(`System task id is already used: ${taskId}`);
      }
      const task = existing === null
        ? createScheduledTask(options.database, {
            id: taskId,
            name: `Clean worktrees ${repositoryName}`,
            cronExpression: "0 */6 * * *",
            timezone: options.config.timezone,
            prompt: `Reconcile idle worktrees for repository ${repositoryId}.`,
            workspacePath: repositoryPath,
            provider: options.config.agent.defaultProvider,
            model: options.config.agent.defaultModel,
            reasoningEffort: options.config.agent.defaultReasoningEffort,
            kind: "system",
            action: "repository.worktrees.cleanup",
            repositoryId,
            enabled: true,
          })
        : updateScheduledTask(options.database, existing.id, {
            // Worktree maintenance is a fixed low-frequency system schedule.
            name: `Clean worktrees ${repositoryName}`,
            cronExpression: "0 */6 * * *",
            timezone: options.config.timezone,
            prompt: `Reconcile idle worktrees for repository ${repositoryId}.`,
            workspacePath: repositoryPath,
            provider: existing.provider,
            model: existing.model,
            reasoningEffort: existing.reasoningEffort,
            kind: "system",
            action: "repository.worktrees.cleanup",
            repositoryId,
            enabled: true,
          });
      options.scheduler.refresh(task.id);
      return getScheduledTask(options.database, task.id) ?? task;
    }
  };

  const projectKnowledge = (
    settings: KnowledgeSchedulePolicy,
    workspacePath: string,
  ): { checkpoint: ScheduledTaskRow; push: ScheduledTaskRow } => {
    const checkpointInterval = settings.checkpointIntervalMinutes;
    const checkpointTaskId = SYSTEM_TASK_IDS.knowledgeCheckpoint;
    const existingCheckpoint = getScheduledTask(options.database, checkpointTaskId);
    if (
      existingCheckpoint !== null &&
      (existingCheckpoint.kind !== "system" || existingCheckpoint.action !== "knowledge.checkpoint")
    ) {
      throw new Error(`System task id is already used: ${checkpointTaskId}`);
    }
    const checkpoint = existingCheckpoint === null
      ? createScheduledTask(options.database, {
          id: checkpointTaskId,
          name: "Knowledge checkpoint",
          cronExpression: cronForInterval(checkpointInterval ?? 1_440),
          timezone: options.config.timezone,
          prompt: "Run the Knowledge repository checkpoint.",
          workspacePath,
          provider: options.config.agent.defaultProvider,
          model: options.config.agent.defaultModel,
          reasoningEffort: options.config.agent.defaultReasoningEffort,
          kind: "system",
          action: "knowledge.checkpoint",
          repositoryId: null,
          enabled: settings.autoCommit && checkpointInterval !== null,
        })
      : updateScheduledTask(options.database, existingCheckpoint.id, {
          cronExpression: cronForInterval(checkpointInterval ?? 1_440),
          enabled: settings.autoCommit && checkpointInterval !== null,
          workspacePath,
          timezone: options.config.timezone,
          kind: "system",
          action: "knowledge.checkpoint",
          repositoryId: null,
        });
    options.scheduler.refresh(checkpoint.id);

    const pushTaskId = SYSTEM_TASK_IDS.knowledgePush;
    const existingPush = getScheduledTask(options.database, pushTaskId);
    if (
      existingPush !== null &&
      (existingPush.kind !== "system" || existingPush.action !== "knowledge.push")
    ) {
      throw new Error(`System task id is already used: ${pushTaskId}`);
    }
    const push = existingPush === null
      ? createScheduledTask(options.database, {
          id: pushTaskId,
          name: "Knowledge push",
          cronExpression: cronForInterval(settings.pushIntervalMinutes ?? 1_440),
          timezone: options.config.timezone,
          prompt: "Push the Knowledge repository checkpoint.",
          workspacePath,
          provider: options.config.agent.defaultProvider,
          model: options.config.agent.defaultModel,
          reasoningEffort: options.config.agent.defaultReasoningEffort,
          kind: "system",
          action: "knowledge.push",
          repositoryId: null,
          enabled: settings.autoPush && settings.pushIntervalMinutes !== null,
        })
      : updateScheduledTask(options.database, existingPush.id, {
          cronExpression: cronForInterval(settings.pushIntervalMinutes ?? 1_440),
          enabled: settings.autoPush && settings.pushIntervalMinutes !== null,
          workspacePath,
          timezone: options.config.timezone,
          kind: "system",
          action: "knowledge.push",
          repositoryId: null,
        });
    options.scheduler.refresh(push.id);
    return {
      checkpoint: getScheduledTask(options.database, checkpoint.id) ?? checkpoint,
      push: getScheduledTask(options.database, push.id) ?? push,
    };
  };

  const projectBackupPair = (
    workspacePath: string,
    first: {
      taskId: string;
      name: string;
      action: "git.checkpoint" | "git.push" | "agent.archive.checkpoint" | "agent.archive.push";
      enabled: boolean;
      interval: number | null;
    },
    second: {
      taskId: string;
      name: string;
      action: "git.checkpoint" | "git.push" | "agent.archive.checkpoint" | "agent.archive.push";
      enabled: boolean;
      interval: number | null;
    },
  ): void => {
    for (const item of [first, second]) {
      const existing = getScheduledTask(options.database, item.taskId);
      if (existing !== null && (existing.kind !== "system" || existing.action !== item.action)) {
        throw new Error(`System task id is already used: ${item.taskId}`);
      }
      const task = existing === null
        ? createScheduledTask(options.database, {
            id: item.taskId,
            name: item.name,
            cronExpression: cronForInterval(item.interval ?? 1_440),
            timezone: options.config.timezone,
            prompt: item.name,
            workspacePath,
            provider: options.config.agent.defaultProvider,
            model: options.config.agent.defaultModel,
            reasoningEffort: options.config.agent.defaultReasoningEffort,
            kind: "system",
            action: item.action,
            repositoryId: null,
            enabled: item.enabled && item.interval !== null,
          })
        : updateScheduledTask(options.database, existing.id, {
            cronExpression: cronForInterval(item.interval ?? 1_440),
            workspacePath,
            timezone: options.config.timezone,
            enabled: item.enabled && item.interval !== null,
            kind: "system",
            action: item.action,
            repositoryId: null,
          });
      options.scheduler.refresh(task.id);
    }
  };

  const projectCodeBackup = (state: CodeBackupSettings): void => {
    projectBackupPair(
      state.repositoryPath,
      {
        taskId: SYSTEM_TASK_IDS.codeCheckpoint,
        name: "Code checkpoint",
        action: "git.checkpoint",
        enabled: state.automaticCheckpoint,
        interval: state.checkpointIntervalMinutes ?? null,
      },
      {
        taskId: SYSTEM_TASK_IDS.codePush,
        name: "Code push",
        action: "git.push",
        enabled: state.automaticPush,
        interval: state.pushIntervalMinutes ?? null,
      },
    );
  };

  const projectAgentArchive = (state: AgentArchiveSettings): void => {
    projectBackupPair(
      state.archiveRepositoryPath,
      {
        taskId: SYSTEM_TASK_IDS.agentArchiveCheckpoint,
        name: "Agent archive export",
        action: "agent.archive.checkpoint",
        enabled: state.enabled,
        interval: state.exportIntervalMinutes ?? null,
      },
      {
        taskId: SYSTEM_TASK_IDS.agentArchivePush,
        name: "Agent archive push",
        action: "agent.archive.push",
        enabled: state.automaticPush,
        interval: state.pushIntervalMinutes ?? null,
      },
    );
  };

  const projectAll = (input: SystemScheduleProjection): void => {
    projectKnowledge(input.knowledge, options.config.knowledge.path);
    projectCodeBackup(input.codeBackup);
    projectAgentArchive(input.agentArchive);
    for (const repository of input.repositories) {
      projectRepository(repository.repository, repository.settings);
    }
  };

  return {
    projectAll,
    projectRepository,
    projectKnowledge,
    projectCodeBackup,
    projectAgentArchive,
    repositoryStatus(repositoryId) {
      const task = getScheduledTask(options.database, SYSTEM_TASK_IDS.repositorySync(repositoryId));
      if (task === null || task.kind !== "system" || task.action !== "repository.sync") return null;
      const latestTerminal = latestTerminalRun(listScheduledTaskRuns(options.database, task.id));
      const status: {
        nextSyncAt: string | null;
        lastSyncAt?: string | null;
        lastError?: string | null;
      } = { nextSyncAt: task.nextRunAt };
      if (latestTerminal !== undefined) {
        status.lastError = latestTerminal.status === "failed" ? latestTerminal.error : null;
        if (latestTerminal.status === "completed") status.lastSyncAt = latestTerminal.finishedAt;
      }
      return status;
    },
    checkpointRuntimeStatus(checkpointTask, runs, state) {
      const latestTerminal = latestTerminalRun(runs);
      const latestCompleted = latestCompletedRun(runs);
      return {
        nextRunAt: checkpointTask?.nextRunAt ?? state.nextRunAt,
        lastSuccessAt: latestCompleted?.finishedAt ?? state.lastSuccessAt,
        lastError:
          latestTerminal === undefined
            ? state.lastError
            : latestTerminal.status === "failed"
              ? latestTerminal.error
              : null,
      };
    },
    codeBackupStatus(state) {
      const checkpointTask = getScheduledTask(options.database, SYSTEM_TASK_IDS.codeCheckpoint);
      const pushTask = getScheduledTask(options.database, SYSTEM_TASK_IDS.codePush);
      const checkpointRuns = checkpointTask === null ? [] : listScheduledTaskRuns(options.database, checkpointTask.id);
      const pushRuns = pushTask === null ? [] : listScheduledTaskRuns(options.database, pushTask.id);
      const latestTerminal = latestTerminalRun([...checkpointRuns, ...pushRuns]);
      const checkpointRun = latestCompletedRun(checkpointRuns);
      const pushRun = latestCompletedRun(pushRuns);
      return {
        repositoryPath: state.repositoryPath,
        nextCheckpointAt: checkpointTask?.nextRunAt ?? null,
        nextPushAt: pushTask?.nextRunAt ?? null,
        lastCheckpointAt: checkpointRun?.finishedAt ?? state.lastCheckpointAt,
        lastPushAt: pushRun?.finishedAt ?? state.lastPushAt,
        lastError:
          latestTerminal === undefined
            ? state.lastError
            : latestTerminal.status === "failed"
              ? latestTerminal.error
              : null,
      };
    },
    agentArchiveStatus(state) {
      const exportTask = getScheduledTask(options.database, SYSTEM_TASK_IDS.agentArchiveCheckpoint);
      const pushTask = getScheduledTask(options.database, SYSTEM_TASK_IDS.agentArchivePush);
      const exportRuns = exportTask === null ? [] : listScheduledTaskRuns(options.database, exportTask.id);
      const pushRuns = pushTask === null ? [] : listScheduledTaskRuns(options.database, pushTask.id);
      const latestTerminal = latestTerminalRun([...exportRuns, ...pushRuns]);
      const exportRun = latestCompletedRun(exportRuns);
      const pushRun = latestCompletedRun(pushRuns);
      return {
        archiveRepositoryPath: state.archiveRepositoryPath,
        nextExportAt: exportTask?.nextRunAt ?? null,
        nextPushAt: pushTask?.nextRunAt ?? null,
        lastExportAt: exportRun?.finishedAt ?? state.lastExportAt,
        lastPushAt: pushRun?.finishedAt ?? state.lastPushAt,
        lastError:
          latestTerminal === undefined
            ? state.lastError
            : latestTerminal.status === "failed"
              ? latestTerminal.error
              : null,
      };
    },
  };
}

function runTimestamp(run: Pick<ScheduledRunRow, "finishedAt" | "scheduledFor">): number {
  const timestamp = Date.parse(run.finishedAt ?? run.scheduledFor);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function latestTerminalRun<T extends {
  status: string;
  finishedAt: string | null;
  scheduledFor: string;
}>(runs: readonly T[]): T | undefined {
  return runs
    .filter((run) => run.status !== "running")
    .sort((left, right) => runTimestamp(right) - runTimestamp(left))[0];
}

function latestCompletedRun<T extends {
  status: string;
  finishedAt: string | null;
  scheduledFor: string;
}>(runs: readonly T[]): T | undefined {
  return runs
    .filter((run) => run.status === "completed")
    .sort((left, right) => runTimestamp(right) - runTimestamp(left))[0];
}
