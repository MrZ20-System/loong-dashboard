import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreePool, WorktreePoolError } from "../src/index.js";

/**
 * Worktree allocation against a real seeded repository (plan 12). The main
 * checkout gains two detached worktrees under a disposable pool root.
 */
let root: string;
let main: string;
let shaA = "";
let shaB = "";
let poolRoot: string;

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
  poolRoot = path.join(root, ".worktrees", "main");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WorktreePool", () => {
  it("creates slots and reuses an exact-target non-busy slot", async () => {
    const pool = new WorktreePool();
    const first = await pool.allocate({ mainRepositoryPath: main, poolRoot, slotCount: 2, prNumber: 1, targetSha: shaA, busySlotPaths: [] });
    expect(first.created).toBe(true);
    expect(await pool.revision(first.slotPath)).toBe(shaA);

    const again = await pool.allocate({ mainRepositoryPath: main, poolRoot, slotCount: 2, prNumber: 1, targetSha: shaA, busySlotPaths: [] });
    expect(again.slotPath).toBe(first.slotPath);
    expect(again.created).toBe(false);
  });

  it("recycles the least-recently-used clean slot for a new revision", async () => {
    const pool = new WorktreePool();
    // Fill both slots with shaA by allocating twice with slotCount 2.
    const first = await pool.allocate({ mainRepositoryPath: main, poolRoot, slotCount: 2, prNumber: 1, targetSha: shaA, busySlotPaths: [] });
    await pool.allocate({ mainRepositoryPath: main, poolRoot, slotCount: 2, prNumber: 2, targetSha: shaA, busySlotPaths: [] });
    // Dirty the second slot; recycle the first (clean) slot to shaB.
    fs.writeFileSync(path.join(first.slotPath, "dirty.txt"), "x");
    const second = await pool.allocate({ mainRepositoryPath: main, poolRoot, slotCount: 2, prNumber: 3, targetSha: shaB, busySlotPaths: [] });
    expect(second.slotPath).not.toBe(first.slotPath);
    expect(await pool.revision(second.slotPath)).toBe(shaB);
  });

  it("fails clearly when every slot is busy", async () => {
    const pool = new WorktreePool();
    // Fresh pool root so earlier tests cannot satisfy an allocation.
    const busyPoolRoot = path.join(root, ".worktrees", "busy");
    const first = await pool.allocate({ mainRepositoryPath: main, poolRoot: busyPoolRoot, slotCount: 2, prNumber: 11, targetSha: shaB, busySlotPaths: [] });
    const second = await pool.allocate({ mainRepositoryPath: main, poolRoot: busyPoolRoot, slotCount: 2, prNumber: 12, targetSha: shaB, busySlotPaths: [first.slotPath] });
    expect(second.created).toBe(true);
    await expect(
      pool.allocate({ mainRepositoryPath: main, poolRoot: busyPoolRoot, slotCount: 2, prNumber: 99, targetSha: shaB, busySlotPaths: [first.slotPath, second.slotPath] }),
    ).rejects.toBeInstanceOf(WorktreePoolError);
  });

  it("repairs a broken leftover slot directory on the next allocation", async () => {
    const pool = new WorktreePool();
    const brokenPoolRoot = path.join(root, ".worktrees", "broken");
    // Simulate an interrupted `worktree add`: the slot directory exists but
    // is not a registered worktree (plan 12 repair).
    const broken = path.join(brokenPoolRoot, "slot-01");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "stale.txt"), "leftover");
    const allocated = await pool.allocate({ mainRepositoryPath: main, poolRoot: brokenPoolRoot, slotCount: 1, prNumber: 21, targetSha: shaA, busySlotPaths: [] });
    expect(allocated.created).toBe(true);
    expect(allocated.slotPath).toBe(broken);
    expect(await pool.revision(broken)).toBe(shaA);
    expect(fs.existsSync(path.join(broken, "stale.txt"))).toBe(false);
  });
});
