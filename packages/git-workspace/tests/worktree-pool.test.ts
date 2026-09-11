import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitCommandError,
  WorktreePool,
  WorktreePoolError,
  type WorktreeSlotMetadata,
  type WorktreeSlotUsage,
} from "../src/index.js";

/**
 * Worktree allocation against a real seeded repository. The main
 * checkout gains detached worktrees under disposable pool roots, while an
 * in-memory slot store mirrors the server's SQLite worktree_slots callbacks.
 */
let root: string;
let main: string;
let shaA = "";
let shaB = "";

async function git(cwd: string, args: string[]) {
  const result = await execa("git", args, { cwd });
  return result.stdout.trim();
}

async function writeFile(repo: string, name: string, content: string) {
  fs.writeFileSync(path.join(repo, name), content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", `commit ${name}`]);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loongboard-worktrees-"));
  main = path.join(root, "main");
  fs.mkdirSync(main);
  await git(main, ["init", "-b", "main", "."]);
  await git(main, ["config", "user.email", "t@e.c"]);
  await git(main, ["config", "user.name", "T"]);
  await git(main, ["config", "commit.gpgsign", "false"]);
  await writeFile(main, "a.txt", "a1");
  shaA = await git(main, ["rev-parse", "HEAD"]);
  await writeFile(main, "b.txt", "b1");
  shaB = await git(main, ["rev-parse", "HEAD"]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T1 = "2026-09-01T00:00:00.000Z";
const T2 = "2026-09-02T00:00:00.000Z";

interface AllocateRequest {
  poolRoot: string;
  slotCount: number;
  prNumber: number;
  targetSha: string;
  busySlotPaths?: readonly string[];
}

/**
 * Minimal in-memory replacement for SQLite worktree_slots: rows are seeded to
 * the pool before allocation and updated through the onUsed callback.
 */
function createStore(): {
  rows: Map<string, WorktreeSlotMetadata>;
  allocate: (
    pool: WorktreePool,
    request: AllocateRequest,
  ) => Promise<{ slotName: string; slotPath: string; created: boolean }>;
  bind: (
    poolRoot: string,
    index: number,
    metadata: {
      prNumber: number;
      targetSha: string;
      lastUsedAt: string;
    },
  ) => string;
} {
  const rows = new Map<string, WorktreeSlotMetadata>();
  return {
    rows,
    allocate: (pool, request) =>
      pool.allocate({
        mainRepositoryPath: main,
        poolRoot: request.poolRoot,
        slotCount: request.slotCount,
        prNumber: request.prNumber,
        targetSha: request.targetSha,
        busySlotPaths: request.busySlotPaths ?? [],
        slots: [...rows.values()],
        onUsed: (usage: WorktreeSlotUsage) => {
          rows.set(usage.slotPath, { ...usage });
        },
      }),
    bind: (poolRoot, index, metadata) => {
      const name = `slot-${String(index).padStart(2, "0")}`;
      const slotPath = path.join(poolRoot, name);
      rows.set(slotPath, {
        slotName: name,
        slotPath,
        prNumber: metadata.prNumber,
        targetSha: metadata.targetSha,
        lastUsedAt: metadata.lastUsedAt,
      });
      return slotPath;
    },
  };
}

describe("WorktreePool", () => {
  it("creates slots and reuses the DB-bound exact-target non-busy slot", async () => {
    const poolRoot = path.join(root, ".worktrees", "exact");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 1,
      targetSha: shaA,
    });
    expect(first.created).toBe(true);
    expect(await pool.revision(first.slotPath)).toBe(shaA);
    expect(store.rows.get(first.slotPath)).toMatchObject({
      prNumber: 1,
      targetSha: shaA,
    });

    const again = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 1,
      targetSha: shaA,
    });
    expect(again.slotPath).toBe(first.slotPath);
    expect(again.created).toBe(false);
    expect(store.rows.size).toBe(1);
  });

  it("preserves PR affinity across a pool restart through slot metadata", async () => {
    const poolRoot = path.join(root, ".worktrees", "restart-affinity");
    const store = createStore();
    const firstControllerPool = new WorktreePool();
    const first = await store.allocate(firstControllerPool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaA,
    });

    // A fresh pool instance has no in-memory state; the DB rows drive reuse.
    const restartedControllerPool = new WorktreePool();
    const restarted = await store.allocate(restartedControllerPool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaA,
    });
    expect(restarted.slotPath).toBe(first.slotPath);
    expect(restarted.created).toBe(false);
    expect(store.rows.size).toBe(1);
  });

  it("switches the same PR slot to a new target when clean", async () => {
    const poolRoot = path.join(root, ".worktrees", "same-pr-switch");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 1,
      prNumber: 8,
      targetSha: shaA,
    });

    const switched = await store.allocate(pool, {
      poolRoot,
      slotCount: 1,
      prNumber: 8,
      targetSha: shaB,
    });
    expect(switched.slotPath).toBe(first.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaB);
    expect(store.rows.get(first.slotPath)).toMatchObject({
      prNumber: 8,
      targetSha: shaB,
    });

    const switchedBack = await store.allocate(pool, {
      poolRoot,
      slotCount: 1,
      prNumber: 8,
      targetSha: shaA,
    });
    expect(switchedBack.slotPath).toBe(first.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaA);
  });

  it("never switches a busy same-PR slot", async () => {
    const poolRoot = path.join(root, ".worktrees", "same-pr-busy");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 8,
      targetSha: shaA,
    });
    store.bind(poolRoot, 1, { prNumber: 7, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 8, targetSha: shaA, lastUsedAt: T2 });

    const switched = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaB,
      busySlotPaths: [first.slotPath],
    });
    // The busy PR-affine slot is untouched; another clean slot is recycled.
    expect(switched.slotPath).toBe(second.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaA);
    expect(await pool.revision(second.slotPath)).toBe(shaB);
    expect(store.rows.get(first.slotPath)).toMatchObject({
      prNumber: 7,
      targetSha: shaA,
    });
  });

  it("never switches a dirty same-PR slot", async () => {
    const poolRoot = path.join(root, ".worktrees", "same-pr-dirty");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 8,
      targetSha: shaA,
    });
    store.bind(poolRoot, 1, { prNumber: 7, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 8, targetSha: shaA, lastUsedAt: T2 });
    fs.writeFileSync(path.join(first.slotPath, "agent-work.txt"), "keep");

    const switched = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 7,
      targetSha: shaB,
    });
    expect(switched.slotPath).toBe(second.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaA);
    expect(fs.existsSync(path.join(first.slotPath, "agent-work.txt"))).toBe(true);
    expect(await pool.revision(second.slotPath)).toBe(shaB);
  });

  it("recycles the oldest last_used_at clean non-busy slot (DB LRU)", async () => {
    const poolRoot = path.join(root, ".worktrees", "db-lru");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 101,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 102,
      targetSha: shaA,
    });
    store.bind(poolRoot, 1, { prNumber: 101, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 102, targetSha: shaA, lastUsedAt: T2 });

    const victim = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 103,
      targetSha: shaB,
    });
    expect(victim.slotPath).toBe(first.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaB);
    expect(await pool.revision(second.slotPath)).toBe(shaA);
    expect(store.rows.get(first.slotPath)).toMatchObject({
      prNumber: 103,
      targetSha: shaB,
    });
  });

  it("skips busy and dirty slots when ordering DB LRU victims", async () => {
    const poolRoot = path.join(root, ".worktrees", "db-lru-guards");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 201,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 202,
      targetSha: shaA,
    });
    store.bind(poolRoot, 1, { prNumber: 201, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 202, targetSha: shaA, lastUsedAt: T2 });

    // The older slot is busy, so the newer clean slot must be recycled.
    const recycled = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 203,
      targetSha: shaB,
      busySlotPaths: [first.slotPath],
    });
    expect(recycled.slotPath).toBe(second.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaA);

    // Dirty the older slot and confirm it is skipped for a clean newer one.
    fs.writeFileSync(path.join(first.slotPath, "agent-work.txt"), "keep");
    const dirtyVictim = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 204,
      targetSha: shaA,
    });
    expect(dirtyVictim.slotPath).toBe(second.slotPath);
    expect(fs.existsSync(path.join(first.slotPath, "agent-work.txt"))).toBe(true);
    expect(await pool.revision(first.slotPath)).toBe(shaA);

    // With every path busy, allocation fails without touching any slot.
    await expect(
      store.allocate(pool, {
        poolRoot,
        slotCount: 2,
        prNumber: 205,
        targetSha: shaB,
        busySlotPaths: [first.slotPath, second.slotPath],
      }),
    ).rejects.toBeInstanceOf(WorktreePoolError);
  });

  it("fails clearly when every slot is busy", async () => {
    const poolRoot = path.join(root, ".worktrees", "busy");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 11,
      targetSha: shaB,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 12,
      targetSha: shaB,
      busySlotPaths: [first.slotPath],
    });
    expect(second.created).toBe(true);
    await expect(
      store.allocate(pool, {
        poolRoot,
        slotCount: 2,
        prNumber: 99,
        targetSha: shaB,
        busySlotPaths: [first.slotPath, second.slotPath],
      }),
    ).rejects.toBeInstanceOf(WorktreePoolError);
  });

  it("repairs a broken leftover slot directory on the next allocation", async () => {
    const poolRoot = path.join(root, ".worktrees", "broken");
    const store = createStore();
    const pool = new WorktreePool();
    // Simulate an interrupted `worktree add`: the slot directory exists but
    // is not a registered worktree.
    const broken = path.join(poolRoot, "slot-01");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "stale.txt"), "leftover");
    const allocated = await store.allocate(pool, {
      poolRoot,
      slotCount: 1,
      prNumber: 21,
      targetSha: shaA,
    });
    expect(allocated.created).toBe(true);
    expect(allocated.slotPath).toBe(broken);
    expect(await pool.revision(broken)).toBe(shaA);
    expect(fs.existsSync(path.join(broken, "stale.txt"))).toBe(false);
    expect(store.rows.get(broken)).toMatchObject({
      prNumber: 21,
      targetSha: shaA,
    });
  });
});

/**
 * Pool whose status check always fails. Mirrors a real `git status` failure
 * (the non-repository probe below) so every switch/recycle aborts before
 * reset/clean.
 */
class StatusFailingPool extends WorktreePool {
  override async isClean(slotPath: string): Promise<boolean> {
    throw new GitCommandError(
      slotPath,
      ["status", "--porcelain"],
      128,
      "simulated git status failure",
    );
  }
}

describe("WorktreePool fail-closed Git safety", () => {
  it("isClean reports clean and dirty, and rejects when git status fails", async () => {
    const pool = new WorktreePool();
    const poolRoot = path.join(root, ".worktrees", "probe");
    const slot = await pool.allocate({
      mainRepositoryPath: main,
      poolRoot,
      slotCount: 1,
      prNumber: 41,
      targetSha: shaA,
      busySlotPaths: [],
    });
    expect(await pool.isClean(slot.slotPath)).toBe(true);

    fs.writeFileSync(path.join(slot.slotPath, "dirty.txt"), "x");
    expect(await pool.isClean(slot.slotPath)).toBe(false);

    // A git status failure must not be interpreted as clean.
    const notARepo = path.join(poolRoot, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    await expect(pool.isClean(notARepo)).rejects.toBeInstanceOf(GitCommandError);
  });

  it("recycles only a clean DB slot and leaves a dirty slot untouched", async () => {
    const poolRoot = path.join(root, ".worktrees", "recycle");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 51,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 52,
      targetSha: shaB,
    });
    await git(second.slotPath, ["reset", "--hard", shaA]);
    fs.writeFileSync(path.join(second.slotPath, "agent-work.txt"), "keep");
    store.bind(poolRoot, 1, { prNumber: 51, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 52, targetSha: shaB, lastUsedAt: T2 });

    const recycled = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 53,
      targetSha: shaB,
    });
    expect(recycled.slotPath).toBe(first.slotPath);
    expect(await pool.revision(first.slotPath)).toBe(shaB);
    // The dirty slot was not reset or cleaned.
    expect(await pool.revision(second.slotPath)).toBe(shaA);
    expect(fs.existsSync(path.join(second.slotPath, "agent-work.txt"))).toBe(true);
  });

  it("aborts a same-PR switch before reset when git status fails", async () => {
    const poolRoot = path.join(root, ".worktrees", "status-switch");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 1,
      prNumber: 71,
      targetSha: shaA,
    });

    const failing = new StatusFailingPool();
    await expect(
      store.allocate(failing, {
        poolRoot,
        slotCount: 1,
        prNumber: 71,
        targetSha: shaB,
      }),
    ).rejects.toThrow(/git status --porcelain failed/);
    expect(await pool.revision(first.slotPath)).toBe(shaA);
    expect(store.rows.get(first.slotPath)).toMatchObject({
      prNumber: 71,
      targetSha: shaA,
    });
  });

  it("rejects allocation when a status check fails before any reset or clean", async () => {
    const poolRoot = path.join(root, ".worktrees", "status-allocate");
    const store = createStore();
    const pool = new WorktreePool();
    const first = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 61,
      targetSha: shaA,
    });
    const second = await store.allocate(pool, {
      poolRoot,
      slotCount: 2,
      prNumber: 62,
      targetSha: shaB,
    });
    await git(second.slotPath, ["reset", "--hard", shaA]);
    fs.writeFileSync(path.join(first.slotPath, "agent-work.txt"), "keep");
    fs.writeFileSync(path.join(second.slotPath, "agent-work.txt"), "keep");
    store.bind(poolRoot, 1, { prNumber: 61, targetSha: shaA, lastUsedAt: T1 });
    store.bind(poolRoot, 2, { prNumber: 62, targetSha: shaB, lastUsedAt: T2 });

    const failing = new StatusFailingPool();
    await expect(
      store.allocate(failing, {
        poolRoot,
        slotCount: 2,
        prNumber: 63,
        targetSha: shaB,
      }),
    ).rejects.toThrow(/git status --porcelain failed/);

    // No destructive recycle ran: revisions are unchanged and untracked work
    // was neither reset away nor cleaned.
    expect(await pool.revision(first.slotPath)).toBe(shaA);
    expect(await pool.revision(second.slotPath)).toBe(shaA);
    expect(fs.existsSync(path.join(first.slotPath, "agent-work.txt"))).toBe(true);
    expect(fs.existsSync(path.join(second.slotPath, "agent-work.txt"))).toBe(true);
  });
});
