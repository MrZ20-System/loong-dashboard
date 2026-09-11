import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GitCommandError,
  WorktreeJanitor,
  WorktreePool,
  type WorktreeSlotMetadata,
  type WorktreeSlotUsage,
} from "../src/index.js";

let root: string;
let main: string;
let sha: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd });
  return result.stdout.trim();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-maintenance-"));
  main = path.join(root, "main");
  fs.mkdirSync(main);
  await git(main, ["init", "-b", "main", "."]);
  await git(main, ["config", "user.email", "t@e.c"]);
  await git(main, ["config", "user.name", "T"]);
  await git(main, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(main, "tracked.txt"), "tracked");
  await git(main, ["add", "-A"]);
  await git(main, ["commit", "-qm", "seed"]);
  sha = await git(main, ["rev-parse", "HEAD"]);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function seedSlots(
  poolRoot: string,
  count: number,
  lastUsedAt = "2026-09-01T00:00:00.000Z",
): Promise<{ pool: WorktreePool; rows: Map<string, WorktreeSlotMetadata> }> {
  const pool = new WorktreePool();
  const rows = new Map<string, WorktreeSlotMetadata>();
  for (let index = 1; index <= count; index += 1) {
    await pool.allocate({
      mainRepositoryPath: main,
      poolRoot,
      slotCount: count,
      prNumber: index,
      targetSha: sha,
      busySlotPaths: [],
      slots: [...rows.values()],
      onUsed: (usage: WorktreeSlotUsage) => {
        rows.set(usage.slotPath, { ...usage, lastUsedAt });
      },
    });
  }
  return { pool, rows };
}

function input(
  poolRoot: string,
  rows: Map<string, WorktreeSlotMetadata>,
  configuredSlots: number,
  busySlotPaths: readonly string[] = [],
  ttlMs = 86_400_000,
) {
  return {
    mainRepositoryPath: main,
    poolRoot,
    configuredSlots,
    idleCleanupTtlMs: ttlMs,
    busySlotPaths,
    slots: [...rows.values()],
    now: new Date("2026-09-10T00:00:00.000Z"),
  };
}

describe("WorktreeJanitor", () => {
  it("reconciles capacity without deleting busy or dirty over-capacity slots", async () => {
    const poolRoot = path.join(root, "capacity");
    const { pool, rows } = await seedSlots(poolRoot, 5);
    const slot4 = path.join(poolRoot, "slot-04");
    const slot5 = path.join(poolRoot, "slot-05");
    fs.writeFileSync(path.join(slot5, "keep.txt"), "dirty");

    const result = await new WorktreeJanitor(pool).cleanup(
      input(poolRoot, rows, 2, [slot4], 365 * 86_400_000),
    );

    expect(result.removed).toEqual([path.join(poolRoot, "slot-03")]);
    expect(result.physicalSlots).toBe(4);
    expect(result.active).toBe(1);
    expect(result.idle).toBe(2);
    expect(result.dirty).toBe(1);
    expect(result.pendingRetirement).toBe(2);
    expect(fs.existsSync(path.join(poolRoot, "slot-03"))).toBe(false);
    expect(fs.existsSync(path.join(slot5, "keep.txt"))).toBe(true);
  });

  it("removes clean slots after TTL and lets explicit cleanup ignore TTL", async () => {
    const ttlRoot = path.join(root, "ttl");
    const { pool, rows } = await seedSlots(ttlRoot, 1);
    const janitor = new WorktreeJanitor(pool);
    const expired = await janitor.cleanup(input(ttlRoot, rows, 1, [], 60_000));
    expect(expired.removed).toEqual([path.join(ttlRoot, "slot-01")]);

    const manualRoot = path.join(root, "manual");
    const manualSeed = await seedSlots(manualRoot, 1, "2026-09-09T23:59:59.000Z");
    const manual = await new WorktreeJanitor(manualSeed.pool).cleanupUnused(
      input(manualRoot, manualSeed.rows, 1, [], 365 * 86_400_000),
    );
    expect(manual.removed).toEqual([path.join(manualRoot, "slot-01")]);
  });

  it("fails closed when status cannot be read", async () => {
    const poolRoot = path.join(root, "status-failure");
    const { rows } = await seedSlots(poolRoot, 1);
    class StatusFailingPool extends WorktreePool {
      override async isClean(slotPath: string): Promise<boolean> {
        throw new GitCommandError(slotPath, ["status", "--porcelain"], 128, "simulated failure");
      }
    }

    const result = await new WorktreeJanitor(new StatusFailingPool()).cleanup(
      input(poolRoot, rows, 1, [], 0),
    );
    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(path.join(poolRoot, "slot-01"))).toBe(true);
  });
});
