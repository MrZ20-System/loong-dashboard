import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runGitOptionalText, runGitText } from "./git-command.js";

/** DB-backed affinity metadata for one physical slot (worktree_slots row). */
export interface WorktreeSlotMetadata {
  readonly slotName: string;
  readonly slotPath: string;
  readonly prNumber: number | null;
  readonly targetSha: string | null;
  readonly lastUsedAt: string | null;
}

/** Metadata persisted after every successful allocation/reuse/sync. */
export interface WorktreeSlotUsage extends WorktreeSlotMetadata {
  readonly prNumber: number;
  readonly targetSha: string;
  readonly lastUsedAt: string;
}

export interface AllocateSlotInput {
  /** Main repository checkout that owns the worktrees. */
  readonly mainRepositoryPath: string;
  /** Directory holding this repository's slots (system/.worktrees/<key>). */
  readonly poolRoot: string;
  /** Number of slots configured for the repository. */
  readonly slotCount: number;
  readonly prNumber: number;
  readonly targetSha: string;
  /** Slots occupied by live sessions; never recycled (plan 12.2). */
  readonly busySlotPaths: readonly string[];
  /**
   * Slot metadata from SQLite worktree_slots. It is the selection source for
   * PR affinity and LRU ordering; filesystem timestamps are never used.
   */
  readonly slots?: readonly WorktreeSlotMetadata[];
  /**
   * Persist pr_number/target_sha/last_used_at after a successful create,
   * reuse, or switch. The caller (server) owns the SQLite write.
   */
  readonly onUsed?: (usage: WorktreeSlotUsage) => void | Promise<void>;
}

export interface AllocatedSlot {
  readonly slotName: string;
  readonly slotPath: string;
  readonly created: boolean;
}

export class WorktreePoolError extends Error {
  readonly code = "WORKTREE_POOL_EXHAUSTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorktreePoolError";
  }
}

function slotName(index: number): string {
  return `slot-${String(index).padStart(2, "0")}`;
}

/**
 * Disposable detached-worktree pool (plan 12). Allocation follows the frozen
 * order: reuse the same PR's exact-target non-busy slot, switch the same PR's
 * old target when clean/nonbusy, create the next free slot, then recycle the
 * least-recently-used clean non-busy slot from worktree_slots.last_used_at.
 * Only `reset --hard` + `clean -fd` are used on recycle; ignored files are
 * kept (no `-x`). Actual revision/cleanliness always come from Git, and a Git
 * inspection failure throws before any destructive reset/clean.
 */
export class WorktreePool {
  async allocate(input: AllocateSlotInput): Promise<AllocatedSlot> {
    if (input.slotCount < 1) {
      throw new WorktreePoolError("Repository has no worktree slots configured");
    }
    mkdirSync(input.poolRoot, { recursive: true });
    const busy = new Set(input.busySlotPaths);
    let existing = this.listSlots(input.poolRoot, input.slotCount);
    const revisions = new Map<string, string | null>();
    const cleanliness = new Map<string, boolean>();
    const revisionFor = async (path: string): Promise<string | null> => {
      if (revisions.has(path)) return revisions.get(path) ?? null;
      const revision = await this.revision(path);
      revisions.set(path, revision);
      return revision;
    };
    const isClean = async (path: string): Promise<boolean> => {
      const cached = cleanliness.get(path);
      if (cached !== undefined) return cached;
      const clean = await this.isClean(path);
      cleanliness.set(path, clean);
      return clean;
    };

    // Repair slots whose worktree registration is broken (plan 12: an
    // initialization failure is repaired by deleting and re-adding the
    // worktree). A leftover directory from an interrupted `worktree add`
    // otherwise occupies its slot forever.
    await Promise.all(
      existing
        .filter((slot) => !busy.has(slot.path))
        .map(async (slot) => {
          revisions.set(slot.path, await this.revision(slot.path));
        }),
    );
    for (const slot of existing) {
      if (busy.has(slot.path) || revisions.get(slot.path) !== null) continue;
      await this.removeBrokenSlot(input.mainRepositoryPath, slot.path);
      revisions.delete(slot.path);
      cleanliness.delete(slot.path);
    }
    existing = this.listSlots(input.poolRoot, input.slotCount);

    // Only rows whose stored path is this pool's computed path can select
    // this pool's physical slots (a stale row from a moved config is free).
    const metadataByPath = new Map<string, WorktreeSlotMetadata>();
    for (const metadata of input.slots ?? []) {
      if (metadata.slotPath !== join(input.poolRoot, metadata.slotName)) {
        continue;
      }
      metadataByPath.set(metadata.slotPath, metadata);
    }
    const metadataFor = (slot: { name: string; path: string }): WorktreeSlotMetadata =>
      metadataByPath.get(slot.path) ?? {
        slotName: slot.name,
        slotPath: slot.path,
        prNumber: null,
        targetSha: null,
        lastUsedAt: null,
      };
    const usedAt = new Date().toISOString();
    const recordUse = async (slot: { name: string; path: string }): Promise<void> => {
      await input.onUsed?.({
        slotName: slot.name,
        slotPath: slot.path,
        prNumber: input.prNumber,
        targetSha: input.targetSha,
        lastUsedAt: usedAt,
      });
    };

    // 1. Reuse the same PR's exact-target slot (DB target must match and Git
    //    must confirm the actual revision). Never reset: it is already correct.
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      const metadata = metadataFor(slot);
      if (metadata.prNumber !== input.prNumber) continue;
      if (metadata.targetSha !== input.targetSha) continue;
      const head = await revisionFor(slot.path);
      if (head !== input.targetSha) continue;
      await recordUse(slot);
      return { slotName: slot.name, slotPath: slot.path, created: false };
    }

    // 2. Same PR affinity: the row target may be stale (actual revision
    //    already matches) or old (clean switch to the requested target).
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      const metadata = metadataFor(slot);
      if (metadata.prNumber !== input.prNumber) continue;
      const head = await revisionFor(slot.path);
      if (head === input.targetSha) {
        await recordUse(slot);
        return { slotName: slot.name, slotPath: slot.path, created: false };
      }
      if (!(await isClean(slot.path))) continue;
      await this.switchTo(slot.path, input.targetSha);
      await recordUse(slot);
      return { slotName: slot.name, slotPath: slot.path, created: false };
    }

    // 3. Create the next unused slot.
    const usedNames = new Set(existing.map((slot) => slot.name));
    for (let index = 1; index <= input.slotCount; index += 1) {
      const name = slotName(index);
      if (usedNames.has(name)) continue;
      const slotPath = join(input.poolRoot, name);
      await runGitText(input.mainRepositoryPath, [
        "worktree",
        "add",
        "--detach",
        slotPath,
        input.targetSha,
      ]);
      await recordUse({ name, path: slotPath });
      return { slotName: name, slotPath, created: true };
    }

    // 4. Legacy unbound physical slots (worktree dirs with no DB row yet) are
    //    free when clean; recycle them before bound LRU candidates.
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      const metadata = metadataFor(slot);
      if (metadata.prNumber !== null || metadata.targetSha !== null) continue;
      if (!(await isClean(slot.path))) continue;
      await this.switchTo(slot.path, input.targetSha);
      await recordUse(slot);
      return { slotName: slot.name, slotPath: slot.path, created: false };
    }

    // 5. True database-backed LRU: oldest last_used_at clean, non-busy slot.
    const recyclable = [];
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      const metadata = metadataFor(slot);
      if (metadata.prNumber === null) continue;
      if (!(await isClean(slot.path))) continue;
      recyclable.push({ slot, lastUsed: this.metadataAgeMs(metadata.lastUsedAt) });
    }
    if (recyclable.length > 0) {
      recyclable.sort((left, right) => left.lastUsed - right.lastUsed);
      const victim = recyclable[0]?.slot;
      if (victim === undefined) throw new WorktreePoolError("No recyclable worktree slot");
      await this.switchTo(victim.path, input.targetSha);
      await recordUse(victim);
      return { slotName: victim.name, slotPath: victim.path, created: false };
    }

    throw new WorktreePoolError(
      `No available worktree slot for ${input.mainRepositoryPath} ` +
        `(configured ${input.slotCount}); increase worktreeSlots or free a busy/dirty slot`,
    );
  }

  async revision(slotPath: string): Promise<string | null> {
    const output = await runGitOptionalText(slotPath, ["rev-parse", "HEAD"]);
    return output === null ? null : output.trim();
  }

  /**
   * True when `git status --porcelain` succeeds with empty output (plan 12.2
   * protection). A git status failure throws instead of being treated as
   * clean, so allocation fails before any destructive reset/clean recycle.
   */
  async isClean(slotPath: string): Promise<boolean> {
    const output = await runGitText(slotPath, ["status", "--porcelain"]);
    return output.trim().length === 0;
  }

  /**
   * Remove one clean worktree from its owning repository. The status check is
   * repeated immediately before `git worktree remove` so janitor races fail
   * closed instead of deleting a newly dirty slot.
   */
  async removeCleanSlot(mainRepositoryPath: string, slotPath: string): Promise<void> {
    if (!(await this.isClean(slotPath))) {
      throw new WorktreePoolError(`Refusing to remove dirty worktree slot ${slotPath}`);
    }
    await runGitText(mainRepositoryPath, ["worktree", "remove", slotPath]);
  }

  /**
   * Unregister a broken slot worktree and remove its leftover directory so
   * the slot can be re-created by the next allocation (plan 12 repair).
   */
  private async removeBrokenSlot(mainRepositoryPath: string, slotPath: string): Promise<void> {
    try {
      await runGitOptionalText(mainRepositoryPath, [
        "worktree",
        "remove",
        "--force",
        slotPath,
      ]);
    } catch {
      // The directory may not be a registered worktree at all.
    }
    try {
      rmSync(slotPath, { recursive: true, force: true });
    } catch {
      // Best effort; the next allocation retries the repair.
    }
  }

  /** Move one slot to the requested revision; `clean -fd` keeps ignored files. */
  private async switchTo(slotPath: string, targetSha: string): Promise<void> {
    await runGitText(slotPath, ["reset", "--hard", targetSha]);
    await runGitText(slotPath, ["clean", "-fd"]);
  }

  private listSlots(poolRoot: string, slotCount: number): Array<{ name: string; path: string }> {
    if (!existsSync(poolRoot)) return [];
    const names = new Set(
      readdirSync(poolRoot).filter((entry) => /^slot-\d{2}$/.test(entry)),
    );
    const slots: Array<{ name: string; path: string }> = [];
    for (let index = 1; index <= slotCount; index += 1) {
      const name = slotName(index);
      if (names.has(name)) slots.push({ name, path: join(poolRoot, name) });
    }
    return slots;
  }

  private metadataAgeMs(value: string | null): number {
    if (value === null) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
