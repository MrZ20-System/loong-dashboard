import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  completeSyncStream,
  failSyncStream,
  getIssueActivityDays,
  getPullRequestActivityDays,
  getRepositorySyncStatus,
  getRepositorySyncState,
  listIssues,
  listPullRequests,
  openDatabase,
  reconcileRepositories,
  startRepositorySync,
  upsertIssuePage,
  upsertPullRequestPage,
} from "../src/index.js";
import type {
  ConfiguredRepository,
  IssueMetadata,
  PullRequestMetadata,
} from "../src/index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-stage1-db-"));
  directories.push(directory);
  return join(directory, "loongboard.sqlite3");
}

function repository(key: string, name = key): ConfiguredRepository {
  return {
    key,
    name,
    github: `example/${key}`,
    path: `/workspace/${key}`,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

function pullRequest(
  number: number,
  updatedAt: string,
  overrides: Partial<PullRequestMetadata> = {},
): PullRequestMetadata {
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
    updatedAt,
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headSha: `${number}`.padStart(40, "0"),
    additions: number,
    deletions: number,
    changedFilesCount: number,
    ...overrides,
  };
}

function issue(
  number: number,
  updatedAt: string,
  overrides: Partial<IssueMetadata> = {},
): IssueMetadata {
  return {
    nodeId: `issue-node-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    authorLogin: null,
    status: "open",
    commentsCount: number,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    ...overrides,
  };
}

function withDatabase<T>(callback: (database: ReturnType<typeof openDatabase>) => T): T {
  const database = openDatabase(databasePath());
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("repository persistence", () => {
  it("reconciles config idempotently, updates rows, and disables removed repositories", () => {
    withDatabase((database) => {
      const first = reconcileRepositories(
        database,
        [repository("alpha", "Alpha"), repository("beta", "Beta")],
        "2026-09-03T00:00:00.000Z",
      );
      expect(first.map((item) => [item.id, item.enabled])).toEqual([
        ["alpha", true],
        ["beta", true],
      ]);
      expect(
        database
          .prepare("SELECT repository_id, entity_kind, status FROM repository_sync_state ORDER BY repository_id, entity_kind")
          .all(),
      ).toHaveLength(4);

      upsertPullRequestPage(database, "beta", [pullRequest(7, "2026-09-02T00:00:00.000Z")]);
      const unchanged = reconcileRepositories(
        database,
        [repository("alpha", "Alpha"), repository("beta", "Beta")],
        "2026-09-04T00:00:00.000Z",
      );
      expect(unchanged.find((item) => item.id === "alpha")?.updatedAt).toBe(
        "2026-09-03T00:00:00.000Z",
      );

      const changed = reconcileRepositories(
        database,
        [{ ...repository("alpha", "Alpha v2"), remote: "upstream", worktreeSlots: 4 }],
        "2026-09-05T00:00:00.000Z",
      );
      expect(changed).toEqual([
        expect.objectContaining({
          id: "alpha",
          displayName: "Alpha v2",
          remoteName: "upstream",
          worktreeSlots: 4,
          enabled: true,
          updatedAt: "2026-09-05T00:00:00.000Z",
        }),
        expect.objectContaining({ id: "beta", enabled: false }),
      ]);
      expect(
        database
          .prepare("SELECT number FROM pull_requests WHERE repository_id = 'beta'")
          .get(),
      ).toEqual({ number: 7 });

      reconcileRepositories(
        database,
        [repository("beta", "Beta restored")],
        "2026-09-06T00:00:00.000Z",
      );
      expect(
        database
          .prepare("SELECT enabled, status FROM repositories JOIN repository_sync_state ON repositories.id = repository_sync_state.repository_id WHERE repositories.id = 'beta' AND entity_kind = 'issue'")
          .get(),
      ).toEqual({ enabled: 1, status: "idle" });
    });
  });
});

describe("sync state persistence", () => {
  it("transitions streams, rejects overlap, and preserves a failure watermark", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("alpha")], "2026-09-03T00:00:00.000Z");
      const run = startRepositorySync(database, "alpha", "2026-09-03T01:00:00.000Z");
      expect(run).toEqual({
        repositoryId: "alpha",
        syncRunId: expect.any(String),
        startedAt: "2026-09-03T01:00:00.000Z",
      });
      expect(() => startRepositorySync(database, "alpha")).toThrow(/already running/);

      completeSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "pull_request",
        completedAt: "2026-09-03T01:01:00.000Z",
      });
      failSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "issue",
        error: new Error("GitHub unavailable"),
        failedAt: "2026-09-03T01:02:00.000Z",
      });
      expect(getRepositorySyncStatus(database, "alpha")).toEqual({
        repositoryId: "alpha",
        status: "failed",
        pullRequests: expect.objectContaining({
          status: "idle",
          watermarkUpdatedAt: "2026-09-03T01:00:00.000Z",
          lastSuccessAt: "2026-09-03T01:01:00.000Z",
        }),
        issues: expect.objectContaining({
          status: "failed",
          watermarkUpdatedAt: null,
          lastSuccessAt: null,
          lastAttemptAt: "2026-09-03T01:00:00.000Z",
          lastError: "GitHub unavailable",
        }),
      });

      startRepositorySync(database, "alpha", "2026-09-03T02:00:00.000Z");
      failSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "pull_request",
        error: "second failure",
      });
      expect(getRepositorySyncState(database, "alpha", "pull_request").watermarkUpdatedAt).toBe(
        "2026-09-03T01:00:00.000Z",
      );
    });
  });

  it("recovers running states when a database is reopened", () => {
    const path = databasePath();
    const first = openDatabase(path);
    reconcileRepositories(first, [repository("alpha")], "2026-09-03T00:00:00.000Z");
    startRepositorySync(first, "alpha", "2026-09-03T01:00:00.000Z");
    first.close();

    const reopened = openDatabase(path);
    try {
      expect(getRepositorySyncStatus(reopened, "alpha")).toEqual(
        expect.objectContaining({
          status: "failed",
          pullRequests: expect.objectContaining({
            status: "failed",
            lastAttemptAt: "2026-09-03T01:00:00.000Z",
            lastError: "Sync interrupted before completion",
          }),
          issues: expect.objectContaining({ status: "failed" }),
        }),
      );
    } finally {
      reopened.close();
    }
  });
});

describe("metadata upserts and queries", () => {
  it("replays PR and Issue pages idempotently while updating metadata", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const first = pullRequest(1, "2026-09-03T00:00:00.000Z", { detailBody: "Keep this body" });
      upsertPullRequestPage(database, "repo", [first]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-09-04T00:00:00.000Z", {
          title: "Updated title",
          additions: 12,
          detailBody: undefined,
        }),
      ]);
      upsertIssuePage(database, "repo", [issue(4, "2026-09-03T00:00:00.000Z")]);
      upsertIssuePage(database, "repo", [issue(4, "2026-09-03T00:00:00.000Z", { status: "closed" })]);

      expect(database.prepare("SELECT COUNT(*) AS count FROM pull_requests").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT title, additions, detail_body FROM pull_requests").get()).toEqual({
        title: "Updated title",
        additions: 12,
        detail_body: "Keep this body",
      });
      expect(database.prepare("SELECT state FROM issues").get()).toEqual({ state: "closed" });
    });
  });

  it("orders tied timestamps by number and paginates without duplicates", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(3, "2026-09-03T00:00:00.000Z"),
        pullRequest(2, "2026-09-03T00:00:00.000Z"),
        pullRequest(1, "2026-09-03T00:00:00.000Z"),
        pullRequest(4, "2026-09-02T00:00:00.000Z"),
      ]);
      const first = listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
      });
      expect(first.items.map((item) => item.number)).toEqual([3, 2]);
      expect(first.nextCursor).not.toBeNull();
      const second = listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.number)).toEqual([1, 4]);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("applies status and DST-safe local date filters", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-03-08T04:59:59.999Z"),
        pullRequest(2, "2026-03-08T05:00:00.000Z", { status: "merged" }),
        pullRequest(3, "2026-03-09T04:00:00.000Z", { status: "closed" }),
        pullRequest(4, "2026-03-10T04:00:00.000Z"),
      ]);
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          date: "2026-03-08",
        }).items.map((item) => item.number),
      ).toEqual([2]);
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          status: "merged",
        }).items.map((item) => item.number),
      ).toEqual([2]);
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          date: "2026-03-09",
        }).items.map((item) => item.number),
      ).toEqual([3]);
    });
  });

  it("counts PR and Issue activity days in the requested IANA range", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-03-08T05:00:00.000Z"),
        pullRequest(2, "2026-03-08T07:00:00.000Z"),
        pullRequest(3, "2026-03-09T04:00:00.000Z"),
      ]);
      upsertIssuePage(database, "repo", [
        issue(1, "2026-03-08T06:00:00.000Z"),
        issue(2, "2026-03-10T04:00:00.000Z"),
      ]);
      expect(
        getPullRequestActivityDays(database, "repo", {
          from: "2026-03-08",
          to: "2026-03-09",
          calendarTimeZone: "America/New_York",
        }),
      ).toEqual([
        { date: "2026-03-08", count: 2 },
        { date: "2026-03-09", count: 1 },
      ]);
      expect(
        getIssueActivityDays(database, "repo", {
          from: "2026-03-08",
          to: "2026-03-10",
          calendarTimeZone: "America/New_York",
        }),
      ).toEqual([
        { date: "2026-03-08", count: 1 },
        { date: "2026-03-10", count: 1 },
      ]);
    });
  });
});
