import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { runGitOptionalText, runGitText } from "./git-command.js";

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
 * order: reuse an exact-target non-busy slot, create the next free slot,
 * recycle the least-recently-used clean non-busy slot, otherwise fail with a
 * clear error. Only `reset --hard` + `clean -fd` are used on recycle;
 * ignored files are kept (no `-x`).
 */
export class WorktreePool {
  private slotMtimes = new Map<string, number>();

  async allocate(input: AllocateSlotInput): Promise<AllocatedSlot> {
    if (input.slotCount < 1) {
      throw new WorktreePoolError("Repository has no worktree slots configured");
    }
    mkdirSync(input.poolRoot, { recursive: true });
    const busy = new Set(input.busySlotPaths);
    let existing = this.listSlots(input.poolRoot, input.slotCount);

    // Repair slots whose worktree registration is broken (plan 12: an
    // initialization failure is repaired by deleting and re-adding the
    // worktree). A leftover directory from an interrupted `worktree add`
    // otherwise occupies its slot forever.
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      if ((await this.revision(slot.path)) !== null) continue;
      await this.removeBrokenSlot(input.mainRepositoryPath, slot.path);
    }
    existing = this.listSlots(input.poolRoot, input.slotCount);

    // 1. Reuse a slot already on the target revision (never reset: the slot
    //    may hold unsaved agent work and is already correct).
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      const head = await this.revision(slot.path);
      if (head === input.targetSha) {
        return { slotName: slot.name, slotPath: slot.path, created: false };
      }
    }

    // 2. Create the next unused slot.
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
      return { slotName: name, slotPath, created: true };
    }

    // 3. Recycle the least-recently-used clean, non-busy slot.
    const recyclable = [];
    for (const slot of existing) {
      if (busy.has(slot.path)) continue;
      if (!(await this.isClean(slot.path))) continue;
      recyclable.push(slot);
    }
    if (recyclable.length > 0) {
      recyclable.sort((left, right) => (this.mtime(left.path) ?? 0) - (this.mtime(right.path) ?? 0));
      const victim = recyclable[0];
      if (victim === undefined) throw new WorktreePoolError("No recyclable worktree slot");
      await runGitText(victim.path, ["reset", "--hard", input.targetSha]);
      await runGitText(victim.path, ["clean", "-fd"]);
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

  /** True when `git status --porcelain` is empty (plan 12.2 protection). */
  async isClean(slotPath: string): Promise<boolean> {
    const output = await runGitOptionalText(slotPath, ["status", "--porcelain"]);
    return output === null || output.trim().length === 0;
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

  private mtime(slotPath: string): number | null {
    const cached = this.slotMtimes.get(slotPath);
    if (cached !== undefined) return cached;
    try {
      const value = statSync(slotPath).mtimeMs;
      this.slotMtimes.set(slotPath, value);
      return value;
    } catch {
      return null;
    }
  }
}
