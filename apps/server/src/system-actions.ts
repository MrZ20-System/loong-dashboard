import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  AgentArchiveSettings,
  CodeBackupSettings,
  RepositoryRetentionSettings,
  ScheduledSystemAction,
} from "@loongboard/contracts";
import {
  getRepository,
  type DatabaseClient,
  type ScheduledTaskRow,
} from "@loongboard/database";
import { pushBackupRef, runCheckpoint } from "@loongboard/git-workspace";

import type { KnowledgeController } from "./knowledge.js";
import { AgentArchiveExporter } from "./agent-archive.js";
import type { MetadataMaintenanceService } from "./metadata-maintenance.js";
import type {
  SchedulerExecutor,
  SchedulerSystemExecutionContext,
} from "./scheduler.js";
import type { RepositorySyncCoordinator } from "./sync-coordinator.js";
import type { SystemConfig } from "./config.js";
import type { WorktreeMaintenanceService } from "./worktree-maintenance.js";
import { GitRepositoryLock } from "./git-repository-lock.js";
import { CODE_BACKUP_UNAVAILABLE_MESSAGE } from "./settings.js";

/** Runtime-only state updated by successful backup/checkpoint actions. */
export interface SystemActionState {
  checkpoint: {
    automaticCheckpoint: boolean;
    automaticPush: boolean;
    remote: string;
    sourceRef: string;
    remoteBranch: string;
    checkpointCron: string;
    pushCron: string;
    nextRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  codeBackup: CodeBackupSettings;
  agentArchive: AgentArchiveSettings;
}

export interface SystemActionExecutorOptions {
  database: DatabaseClient;
  config: SystemConfig;
  coordinator: RepositorySyncCoordinator;
  metadataMaintenance: MetadataMaintenanceService;
  worktreeMaintenance: WorktreeMaintenanceService;
  repositorySettings: (repositoryId: string) => {
    retention: RepositoryRetentionSettings;
  } | undefined;
  knowledge: KnowledgeController;
  codeRepositoryPath: string;
  state: SystemActionState;
  gitRepositoryLock?: GitRepositoryLock;
  now?: () => Date;
}

/** The canonical action names implemented by the server-side registry. */
export const SYSTEM_ACTIONS = [
  "repository.sync",
  "repository.metadata-maintenance",
  "repository.worktrees.cleanup",
  "personal-data.checkpoint",
  "personal-data.push",
  "git.checkpoint",
  "git.push",
  "agent.archive.checkpoint",
  "agent.archive.push",
] as const satisfies readonly ScheduledSystemAction[];

type SystemActionHandler = (
  context: SchedulerSystemExecutionContext,
) => Promise<void>;

/**
 * Create the one registry used by SchedulerEngine for all system actions.
 * Handlers own resource-specific coordination; the scheduler only dispatches
 * a persisted task and records the result.
 */
export function createSystemActionExecutor(
  options: SystemActionExecutorOptions,
): SchedulerExecutor {
  const now = options.now ?? (() => new Date());
  const lock = options.gitRepositoryLock ?? new GitRepositoryLock();

  const handlers: ReadonlyMap<string, SystemActionHandler> = new Map([
    ["repository.sync", async ({ task }) => {
      const repositoryId = requireRepositoryId(task, "Repository sync");
      const run = options.coordinator.start(repositoryId, "system");
      const completed = await options.coordinator.waitForRun(run.syncRunId);
      if (completed.status === "failed" || completed.status === "partial") {
        throw new Error(completed.error ?? `Repository sync failed for ${repositoryId}`);
      }
    }],
    ["repository.metadata-maintenance", async ({ task }) => {
      const repositoryId = requireRepositoryId(task, "Metadata maintenance");
      const repositorySettings = options.repositorySettings(repositoryId);
      if (repositorySettings === undefined) {
        throw new Error(`Repository settings are unavailable: ${repositoryId}`);
      }
      const purge = await options.metadataMaintenance.runRuntimeHistoryAndWait(
        repositoryId,
        {},
        "automatic",
      );
      if (purge.status !== "completed") {
        throw new Error(
          purge.error ?? `Runtime history purge ${purge.status} for ${repositoryId}`,
        );
      }
      if (repositorySettings.retention.automaticArchiveEnabled) {
        const archive = await options.metadataMaintenance.runAndWait(
          repositoryId,
          options.metadataMaintenance.automaticRequest(repositorySettings.retention),
          "automatic",
        );
        if (archive.status !== "completed") {
          throw new Error(
            archive.error ?? `Metadata archive ${archive.status} for ${repositoryId}`,
          );
        }
      }
    }],
    ["repository.worktrees.cleanup", async ({ task }) => {
      const repositoryId = requireRepositoryId(task, "Worktree cleanup");
      const repository = getRepository(options.database, repositoryId);
      if (repository === null) {
        throw new Error(`Repository is missing or disabled: ${repositoryId}`);
      }
      await options.worktreeMaintenance.reconcile({
        repositoryId: repository.id,
        repositoryKey: repository.key,
        mainRepositoryPath: repository.localPath,
        fallbackSlots: repository.worktreeSlots,
      });
    }],
    ["personal-data.checkpoint", async () => {
      const result = await lock.run(options.config.personalData.path, () =>
        options.knowledge.runCheckpointNow({ push: false }),
      );
      if (result.error !== undefined) throw new Error(result.error);
      options.state.checkpoint = {
        ...options.state.checkpoint,
        lastSuccessAt: timestamp(now),
        lastError: null,
      };
    }],
    ["personal-data.push", async () => {
      const result = await lock.run(options.config.personalData.path, () =>
        options.knowledge.runPushNow(),
      );
      if (result.error !== undefined) throw new Error(result.error);
      options.state.checkpoint = {
        ...options.state.checkpoint,
        lastSuccessAt: timestamp(now),
        lastError: null,
      };
    }],
    ["git.checkpoint", async () => {
      const state = options.state.codeBackup;
      if (!state.available) {
        throw new Error(CODE_BACKUP_UNAVAILABLE_MESSAGE);
      }
      const result = await lock.run(state.repositoryPath, () =>
        runCheckpoint({
          repositoryPath: state.repositoryPath,
          message: `chore: automatic checkpoint ${timestamp(now)}`,
          sourceRef: state.sourceRef,
        }),
      );
      if (result.error !== undefined) throw new Error(result.error);
      options.state.codeBackup = {
        ...options.state.codeBackup,
        lastCheckpointAt: timestamp(now),
        lastError: null,
      };
    }],
    ["git.push", async () => {
      const state = options.state.codeBackup;
      if (!state.available) {
        throw new Error(CODE_BACKUP_UNAVAILABLE_MESSAGE);
      }
      const result = await lock.run(state.repositoryPath, () =>
        pushBackupRef({
          repositoryPath: state.repositoryPath,
          remote: state.remote,
          sourceRef: state.sourceRef,
          remoteBranch: state.remoteBranch,
        }),
      );
      if (!result.pushed) throw new Error(result.error ?? "Code backup push failed");
      options.state.codeBackup = {
        ...options.state.codeBackup,
        lastPushAt: timestamp(now),
        lastError: null,
      };
    }],
    ["agent.archive.checkpoint", async () => {
      const state = options.state.agentArchive;
      const result = await lock.run(state.archiveRepositoryPath, async () => {
        validateAgentArchivePath({
          archivePath: state.archiveRepositoryPath,
          statePath: options.config.runtime.statePath,
          worktreesPath: options.config.runtime.worktreesPath,
          personalDataPath: options.config.personalData.path,
          codeRepositoryPath: options.codeRepositoryPath,
          create: false,
        });
        new AgentArchiveExporter({
          database: options.database,
          archiveRoot: state.archiveRepositoryPath,
        }).export();
        return runCheckpoint({
          repositoryPath: state.archiveRepositoryPath,
          message: `chore(agent-archive): export ${timestamp(now)}`,
          sourceRef: state.sourceRef,
        });
      });
      if (result.error !== undefined) {
        throw new Error(`Agent archive checkpoint failed: ${result.error}`);
      }
      options.state.agentArchive = {
        ...options.state.agentArchive,
        lastExportAt: timestamp(now),
        lastError: null,
      };
    }],
    ["agent.archive.push", async () => {
      const state = options.state.agentArchive;
      const result = await lock.run(state.archiveRepositoryPath, async () => {
        validateAgentArchivePath({
          archivePath: state.archiveRepositoryPath,
          statePath: options.config.runtime.statePath,
          worktreesPath: options.config.runtime.worktreesPath,
          personalDataPath: options.config.personalData.path,
          codeRepositoryPath: options.codeRepositoryPath,
          create: false,
        });
        return pushBackupRef({
          repositoryPath: state.archiveRepositoryPath,
          remote: state.remote,
          sourceRef: state.sourceRef,
          remoteBranch: state.remoteBranch,
        });
      });
      if (!result.pushed) {
        throw new Error(`Agent archive push failed: ${result.error ?? "unknown Git error"}`);
      }
      options.state.agentArchive = {
        ...options.state.agentArchive,
        lastPushAt: timestamp(now),
        lastError: null,
      };
    }],
  ]);

  return {
    executeSystem: async (context) => {
      const action = context.task.action;
      const handler = action === null ? undefined : handlers.get(action);
      if (handler === undefined) {
        throw new Error(`Unknown system scheduled action: ${action ?? ""}`);
      }
      await handler(context);
    },
  };
}

function requireRepositoryId(task: ScheduledTaskRow, label: string): string {
  if (task.repositoryId === null) {
    throw new Error(`${label} task is missing repositoryId`);
  }
  return task.repositoryId;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("System action clock returned an invalid Date");
  }
  return value.toISOString();
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
  personalDataPath?: string;
  /** @deprecated Use personalDataPath; retained for existing callers only. */
  knowledgePath?: string;
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
    input.personalDataPath ?? input.knowledgePath ?? "",
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
