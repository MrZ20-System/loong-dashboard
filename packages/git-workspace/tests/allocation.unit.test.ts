import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorktreePool,
  WorktreePoolError,
  type WorktreeSlotUsage,
} from "../src/index.js";

class CountingPool extends WorktreePool {
  readonly revisionCalls = new Map<string, number>();
  readonly cleanCalls = new Map<string, number>();

  constructor(
    private readonly heads: ReadonlyMap<string, string | null>,
    private readonly clean: ReadonlyMap<string, boolean> = new Map(),
  ) {
    super();
  }

  override async revision(path: string): Promise<string | null> {
    this.revisionCalls.set(path, (this.revisionCalls.get(path) ?? 0) + 1);
    return this.heads.get(path) ?? null;
  }

  override async isClean(path: string): Promise<boolean> {
    this.cleanCalls.set(path, (this.cleanCalls.get(path) ?? 0) + 1);
    return this.clean.get(path) ?? false;
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function poolWithSlots(count: number): {
  root: string;
  slots: Array<{ name: string; path: string }>;
} {
  const root = mkdtempSync(join(tmpdir(), "loongboard-pool-unit-"));
  roots.push(root);
  const slots = Array.from({ length: count }, (_, index) => {
    const name = `slot-${String(index + 1).padStart(2, "0")}`;
    const path = join(root, name);
    mkdirSync(path);
    return { name, path };
  });
  return { root, slots };
}

describe("WorktreePool allocation inspection", () => {
  it("inspects every existing slot revision at most once per allocation", async () => {
    const { root, slots } = poolWithSlots(3);
    const target = "a".repeat(40);
    const pool = new CountingPool(
      new Map(slots.map((slot, index) => [slot.path, index === 1 ? target : "b".repeat(40)])),
    );
    let usage: WorktreeSlotUsage | undefined;

    const allocated = await pool.allocate({
      mainRepositoryPath: root,
      poolRoot: root,
      slotCount: 3,
      prNumber: 42,
      targetSha: target,
      busySlotPaths: [],
      slots: slots.map((slot, index) => ({
        slotName: slot.name,
        slotPath: slot.path,
        prNumber: index === 1 ? 42 : index + 1,
        targetSha: index === 1 ? target : "b".repeat(40),
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      })),
      onUsed: (next) => {
        usage = next;
      },
    });

    expect(allocated.slotPath).toBe(slots[1]?.path);
    expect(usage?.targetSha).toBe(target);
    expect([...pool.revisionCalls.values()]).toEqual([1, 1, 1]);
  });

  it("reuses a dirty result when a slot reaches multiple selection phases", async () => {
    const { root, slots } = poolWithSlots(1);
    const slot = slots[0]!;
    const pool = new CountingPool(
      new Map([[slot.path, "b".repeat(40)]]),
      new Map([[slot.path, false]]),
    );

    await expect(
      pool.allocate({
        mainRepositoryPath: root,
        poolRoot: root,
        slotCount: 1,
        prNumber: 42,
        targetSha: "a".repeat(40),
        busySlotPaths: [],
        slots: [{
          slotName: slot.name,
          slotPath: slot.path,
          prNumber: 42,
          targetSha: "b".repeat(40),
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        }],
      }),
    ).rejects.toBeInstanceOf(WorktreePoolError);
    expect(pool.cleanCalls.get(slot.path)).toBe(1);
  });
});
