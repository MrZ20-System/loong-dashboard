import { describe, expect, it } from "vitest";

import {
  deleteWorktreeSlot,
  listWorktreeSlots,
  openDatabase,
  reconcileRepositories,
  recordWorktreeSlotUse,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type PullRequestMetadata,
} from "../src/index.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T1 = "2026-09-01T00:00:00.000Z";
const T2 = "2026-09-02T00:00:00.000Z";

function repository(key: string): ConfiguredRepository {
  return {
    key,
    name: key,
    github: `example/${key}`,
    path: `/workspace/${key}`,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

function pullRequest(number: number): PullRequestMetadata {
  return {
    nodeId: `pr-node-${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    authorLogin: "author",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headSha: SHA_A,
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
  };
}

function freshDatabase() {
  const database = openDatabase(":memory:");
  reconcileRepositories(database, [repository("alpha")]);
  upsertPullRequestPage(database, "alpha", [pullRequest(1), pullRequest(2)]);
  return database;
}

describe("worktree slot service", () => {
  it("records one row per slot and updates pr/target/lastUsed on reuse", () => {
    const database = freshDatabase();
    try {
      expect(listWorktreeSlots(database, "alpha")).toEqual([]);

      const first = recordWorktreeSlotUse(database, {
        repositoryId: "alpha",
        slotName: "slot-01",
        path: "/worktrees/alpha/slot-01",
        prNumber: 1,
        targetSha: SHA_A,
        lastUsedAt: T1,
      });
      expect(first.id).toMatch(/^wslot_/);
      expect(listWorktreeSlots(database, "alpha")).toEqual([first]);

      const reused = recordWorktreeSlotUse(database, {
        repositoryId: "alpha",
        slotName: "slot-01",
        path: "/worktrees/alpha/slot-01",
        prNumber: 1,
        targetSha: SHA_B,
        lastUsedAt: T2,
      });
      expect(reused.id).toBe(first.id);
      expect(reused.prNumber).toBe(1);
      expect(reused.targetSha).toBe(SHA_B);
      expect(reused.lastUsedAt).toBe(T2);
      expect(listWorktreeSlots(database, "alpha")).toEqual([reused]);
    } finally {
      database.close();
    }
  });

  it("returns rows only for the requested repository", () => {
    const database = freshDatabase();
    try {
      recordWorktreeSlotUse(database, {
        repositoryId: "alpha",
        slotName: "slot-01",
        path: "/worktrees/alpha/slot-01",
        prNumber: 1,
        targetSha: SHA_A,
        lastUsedAt: T1,
      });
      expect(listWorktreeSlots(database, "alpha")).toHaveLength(1);
      expect(listWorktreeSlots(database, "other")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("deletes only exact physical slot metadata after janitor removal", () => {
    const database = freshDatabase();
    try {
      const row = recordWorktreeSlotUse(database, {
        repositoryId: "alpha",
        slotName: "slot-01",
        path: "/worktrees/alpha/slot-01",
        prNumber: 1,
        targetSha: SHA_A,
        lastUsedAt: T1,
      });
      expect(
        deleteWorktreeSlot(database, "alpha", "slot-01", "/worktrees/alpha/other"),
      ).toBe(false);
      expect(deleteWorktreeSlot(database, "alpha", "slot-01", row.path)).toBe(true);
      expect(listWorktreeSlots(database, "alpha")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects metadata for a PR that was never synchronized", () => {
    const database = openDatabase(":memory:");
    reconcileRepositories(database, [repository("alpha")]);
    try {
      expect(() =>
        recordWorktreeSlotUse(database, {
          repositoryId: "alpha",
          slotName: "slot-01",
          path: "/worktrees/alpha/slot-01",
          prNumber: 999,
          targetSha: SHA_A,
          lastUsedAt: T1,
        }),
      ).toThrowError(/FOREIGN KEY constraint failed/);
      expect(listWorktreeSlots(database, "alpha")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
