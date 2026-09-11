import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  WorktreePool,
  type WorktreeSlotMetadata,
} from "./worktree-pool.js";

/** Runtime operational policy for one repository's worktree pool. */
export interface WorktreeMaintenanceInput {
  readonly mainRepositoryPath: string;
  readonly poolRoot: string;
  /** User-facing operational override, falling back to system.yaml at the server boundary. */
  readonly configuredSlots: number;
  /** Milliseconds after the last recorded use before an idle slot may be removed. */
  readonly idleCleanupTtlMs: number;
  /** Live ownership from WorkspaceRunCoordinator/agent session state. */
  readonly busySlotPaths: readonly string[];
  /** SQLite affinity/LRU rows; never used as live ownership. */
  readonly slots?: readonly WorktreeSlotMetadata[];
  readonly now?: Date;
}

export interface WorktreeMaintenanceSlot {
  readonly slotName: string;
  readonly slotPath: string;
  readonly busy: boolean;
  readonly clean: boolean | null;
  readonly retiring: boolean;
  readonly lastUsedAt: string | null;
  readonly error: string | null;
}

export interface WorktreeMaintenanceResult {
  readonly configuredSlots: number;
  readonly physicalSlots: number;
  /** Physical slots currently owned by a live Agent session. */
  readonly active: number;
  /** Clean, non-busy physical slots. */
  readonly idle: number;
  /** Physical slots whose successful Git status is dirty. */
  readonly dirty: number;
  /** Over-capacity slots waiting for a busy/dirty/unknown slot to become removable. */
  readonly pendingRetirement: number;
  readonly pendingRetirementPaths: readonly string[];
  readonly removed: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly busyPaths: readonly string[];
  readonly errors: readonly { slotPath: string; message: string }[];
  readonly slots: readonly WorktreeMaintenanceSlot[];
}

export interface WorktreeCleanupOptions {
  /** Manual cleanup ignores TTL, but still never removes busy/dirty/unknown slots. */
  readonly manual?: boolean;
}

interface PhysicalSlot {
  readonly slotName: string;
  readonly slotPath: string;
}

type MutableMaintenanceSlot = {
  -readonly [Key in keyof WorktreeMaintenanceSlot]: WorktreeMaintenanceSlot[Key];
};

function slotIndex(slotName: string): number {
  const match = /^slot-(\d+)$/.exec(slotName);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function listPhysicalSlots(poolRoot: string): PhysicalSlot[] {
  if (!existsSync(poolRoot)) return [];
  return readdirSync(poolRoot)
    .filter((entry) => /^slot-\d{2}$/.test(entry))
    .sort()
    .map((slotName) => ({ slotName, slotPath: join(poolRoot, slotName) }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Low-frequency maintenance for a WorktreePool.
 *
 * This class deliberately does not own scheduling or database writes. The
 * server supplies the resolved settings and live busy paths, and removes the
 * matching slot row after a successful `cleanup` call. That keeps settings
 * authority and WorkspaceRunCoordinator ownership outside the Git package.
 */
export class WorktreeJanitor {
  constructor(private readonly pool: WorktreePool = new WorktreePool()) {}

  async inspect(input: WorktreeMaintenanceInput): Promise<WorktreeMaintenanceResult> {
    const metadataByPath = new Map<string, WorktreeSlotMetadata>();
    for (const metadata of input.slots ?? []) {
      if (metadata.slotPath === join(input.poolRoot, metadata.slotName)) {
        metadataByPath.set(metadata.slotPath, metadata);
      }
    }
    const busyPaths = new Set(input.busySlotPaths);
    const slotStates: MutableMaintenanceSlot[] = [];
    const errors: Array<{ slotPath: string; message: string }> = [];

    for (const slot of listPhysicalSlots(input.poolRoot)) {
      const busy = busyPaths.has(slot.slotPath);
      let clean: boolean | null = null;
      let error: string | null = null;
      // A busy slot is active by definition. Avoid an unnecessary Git probe
      // and, more importantly, never make ownership depend on Git status.
      if (!busy) {
        try {
          clean = await this.pool.isClean(slot.slotPath);
        } catch (cause) {
          error = errorMessage(cause);
          errors.push({ slotPath: slot.slotPath, message: error });
        }
      }
      const metadata = metadataByPath.get(slot.slotPath);
      slotStates.push({
        slotName: slot.slotName,
        slotPath: slot.slotPath,
        busy,
        clean,
        retiring: slotIndex(slot.slotName) > input.configuredSlots,
        lastUsedAt: metadata?.lastUsedAt ?? null,
        error,
      });
    }

    return this.summarize(input.configuredSlots, slotStates, errors, []);
  }

  /** Run capacity reconciliation and TTL cleanup in one low-frequency pass. */
  async cleanup(
    input: WorktreeMaintenanceInput,
    options: WorktreeCleanupOptions = {},
  ): Promise<WorktreeMaintenanceResult> {
    const inspected = await this.inspect(input);
    const nowMs = (input.now ?? new Date()).getTime();
    const removed: string[] = [];
    const errors = [...inspected.errors];
    const states = inspected.slots.map((slot) => ({ ...slot }));

    for (const slot of states) {
      if (slot.busy || slot.clean !== true) continue;
      const overCapacity = slot.retiring;
      const manual = options.manual === true;
      const expired = this.isExpired(slot.lastUsedAt, nowMs, input.idleCleanupTtlMs);
      if (!overCapacity && !manual && !expired) continue;

      try {
        // removeCleanSlot performs a second status check immediately before
        // the destructive Git operation, preserving fail-closed behavior if
        // the workspace changes between inspect and remove.
        await this.pool.removeCleanSlot(input.mainRepositoryPath, slot.slotPath);
        removed.push(slot.slotPath);
        slot.clean = null;
      } catch (cause) {
        const message = errorMessage(cause);
        slot.error = message;
        // The second status probe may have observed a race or failed. Keep
        // the result out of the idle bucket until a later pass proves clean.
        slot.clean = null;
        errors.push({ slotPath: slot.slotPath, message });
      }
    }

    const remaining = states.filter((slot) => !removed.includes(slot.slotPath));
    return this.summarize(input.configuredSlots, remaining, errors, removed);
  }

  /** Explicit "Clean unused worktrees now" operation. */
  async cleanupUnused(input: WorktreeMaintenanceInput): Promise<WorktreeMaintenanceResult> {
    return this.cleanup(input, { manual: true });
  }

  private isExpired(lastUsedAt: string | null, nowMs: number, ttlMs: number): boolean {
    if (lastUsedAt === null || ttlMs < 0) return false;
    const lastUsedMs = Date.parse(lastUsedAt);
    return Number.isFinite(lastUsedMs) && nowMs - lastUsedMs > ttlMs;
  }

  private summarize(
    configuredSlots: number,
    slots: readonly MutableMaintenanceSlot[],
    errors: readonly { slotPath: string; message: string }[],
    removed: readonly string[],
  ): WorktreeMaintenanceResult {
    const pending = slots.filter((slot) => slot.retiring);
    const dirty = slots.filter((slot) => slot.clean === false);
    return {
      configuredSlots,
      physicalSlots: slots.length,
      active: slots.filter((slot) => slot.busy).length,
      idle: slots.filter((slot) => !slot.busy && slot.clean === true).length,
      dirty: dirty.length,
      pendingRetirement: pending.length,
      pendingRetirementPaths: pending.map((slot) => slot.slotPath),
      removed,
      dirtyPaths: dirty.map((slot) => slot.slotPath),
      busyPaths: slots.filter((slot) => slot.busy).map((slot) => slot.slotPath),
      errors,
      slots,
    };
  }
}
