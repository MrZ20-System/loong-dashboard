import { basename, join } from "node:path";

import {
  deleteWorktreeSlot,
  listBusyWorkspacePaths,
  listWorktreeSlots,
  type DatabaseClient,
} from "@loongboard/database";
import {
  WorktreeJanitor,
  WorktreePool,
  type WorktreeMaintenanceInput,
  type WorktreeMaintenanceResult,
} from "@loongboard/git-workspace";

export const MAX_WORKTREE_SLOTS = 16;

export interface WorktreeOperationalPolicy {
  readonly configuredSlots: number;
  readonly idleCleanupTtlMs: number;
}

/** Settings-owned resolver; this service never reads settings.json itself. */
export type WorktreePolicyResolver = (
  repositoryId: string,
  fallbackSlots: number,
) => WorktreeOperationalPolicy | Promise<WorktreeOperationalPolicy>;

export interface WorktreeRepositoryRef {
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly mainRepositoryPath: string;
  /** The system.yaml/database projection fallback when Settings has no override. */
  readonly fallbackSlots: number;
  readonly now?: Date;
}

export interface WorktreeMaintenanceServiceResult extends WorktreeMaintenanceResult {
  /** Number of database affinity rows removed after physical deletion. */
  readonly removedMetadata: number;
}

export interface WorktreeMaintenanceServiceOptions {
  readonly database: DatabaseClient;
  readonly worktreesPath: string;
  readonly policyResolver: WorktreePolicyResolver;
  /** In-process ownership from WorkspaceRunCoordinator and running sessions. */
  readonly liveBusyWorkspacePaths?: (repositoryId: string) => readonly string[];
  readonly worktreePool?: WorktreePool;
}

function validatePolicy(
  repositoryId: string,
  policy: WorktreeOperationalPolicy,
): WorktreeOperationalPolicy {
  if (
    !Number.isInteger(policy.configuredSlots) ||
    policy.configuredSlots < 1 ||
    policy.configuredSlots > MAX_WORKTREE_SLOTS
  ) {
    throw new Error(
      `Invalid worktree slot capacity for repository ${repositoryId}: ` +
        `${String(policy.configuredSlots)} (expected an integer from 1 to ${MAX_WORKTREE_SLOTS})`,
    );
  }
  if (!Number.isInteger(policy.idleCleanupTtlMs) || policy.idleCleanupTtlMs < 0) {
    throw new Error(
      `Invalid worktree cleanup TTL for repository ${repositoryId}: ` +
        `${String(policy.idleCleanupTtlMs)} (expected a non-negative integer in milliseconds)`,
    );
  }
  return policy;
}

/**
 * Server-side adapter around WorktreeJanitor. It owns only DB projection and
 * exact affinity-row cleanup; Settings authority and scheduling stay outside.
 */
export class WorktreeMaintenanceService {
  private readonly janitor: WorktreeJanitor;

  constructor(private readonly options: WorktreeMaintenanceServiceOptions) {
    this.janitor = new WorktreeJanitor(options.worktreePool);
  }

  async inspect(input: WorktreeRepositoryRef): Promise<WorktreeMaintenanceServiceResult> {
    const maintenanceInput = await this.toInput(input);
    const result = await this.janitor.inspect(maintenanceInput);
    return { ...result, removedMetadata: 0 };
  }

  /** Low-frequency capacity reconciliation plus TTL cleanup. */
  async reconcile(input: WorktreeRepositoryRef): Promise<WorktreeMaintenanceServiceResult> {
    const maintenanceInput = await this.toInput(input);
    const result = await this.janitor.cleanup(maintenanceInput);
    return this.removeMetadata(input.repositoryId, result);
  }

  /** Explicit Clean unused now operation; still protects busy/dirty/unknown slots. */
  async cleanupUnused(input: WorktreeRepositoryRef): Promise<WorktreeMaintenanceServiceResult> {
    const maintenanceInput = await this.toInput(input);
    const result = await this.janitor.cleanupUnused(maintenanceInput);
    return this.removeMetadata(input.repositoryId, result);
  }

  /** Naming used by callers that distinguish scheduled low-frequency cleanup. */
  async cleanup(input: WorktreeRepositoryRef): Promise<WorktreeMaintenanceServiceResult> {
    return this.reconcile(input);
  }

  private async toInput(input: WorktreeRepositoryRef): Promise<WorktreeMaintenanceInput> {
    const policy = validatePolicy(
      input.repositoryId,
      await this.options.policyResolver(input.repositoryId, input.fallbackSlots),
    );
    const poolRoot = join(this.options.worktreesPath, input.repositoryKey);
    const slots = listWorktreeSlots(this.options.database, input.repositoryId);
    const busySlotPaths = new Set(listBusyWorkspacePaths(this.options.database, input.repositoryId));
    for (const path of this.options.liveBusyWorkspacePaths?.(input.repositoryId) ?? []) {
      busySlotPaths.add(path);
    }
    return {
      mainRepositoryPath: input.mainRepositoryPath,
      poolRoot,
      configuredSlots: policy.configuredSlots,
      idleCleanupTtlMs: policy.idleCleanupTtlMs,
      busySlotPaths: [...busySlotPaths],
      slots: slots.map((slot) => ({
        slotName: slot.slotName,
        slotPath: slot.path,
        prNumber: slot.prNumber,
        targetSha: slot.targetSha,
        lastUsedAt: slot.lastUsedAt,
      })),
      ...(input.now === undefined ? {} : { now: input.now }),
    };
  }

  private removeMetadata(
    repositoryId: string,
    result: WorktreeMaintenanceResult,
  ): WorktreeMaintenanceServiceResult {
    let removedMetadata = 0;
    for (const path of result.removed) {
      const slotName = basename(path);
      if (!/^slot-\d{2}$/.test(slotName)) {
        throw new Error(`Unexpected removed worktree slot path: ${path}`);
      }
      if (deleteWorktreeSlot(this.options.database, repositoryId, slotName, path)) {
        removedMetadata += 1;
      }
    }
    return { ...result, removedMetadata };
  }
}
