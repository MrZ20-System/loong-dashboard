import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  archiveBatch,
  beginQueuedForwardSync,
  completeSyncStream,
  createDomainRule,
  createSyncRun,
  failSyncStream,
  getSyncRun,
  getIssueActivityDays,
  getIssueDetail,
  getIssueDetailSyncedUpdatedAt,
  getPullRequestActivityDays,
  getRepositorySyncStatus,
  getRepositorySyncState,
  InvalidCursorError,
  listIssues,
  listCurrentPullRequestEnrichmentStates,
  listMergedPullRequests,
  listPullRequests,
  markSyncRunStarted,
  openDatabase,
  reconcileRepositories,
  replacePullRequestFiles,
  replaceIssueDetailCache,
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
      const run = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
        attemptStartedAt: "2026-09-03T01:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: run.syncRunId,
        startedAt: "2026-09-03T01:00:00.000Z",
      });
      expect(run).toEqual({
        repositoryId: "alpha",
        syncRunId: expect.any(String),
        startedAt: "2026-09-03T01:00:00.000Z",
        kind: "forward",
        trigger: "manual",
      });
      const overlap = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
      });
      expect(() => beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: overlap.syncRunId,
      })).toThrow(/already running/);

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

      const second = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
        attemptStartedAt: "2026-09-03T02:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: second.syncRunId,
        startedAt: "2026-09-03T02:00:00.000Z",
      });
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
    const run = createSyncRun(first, {
      repositoryId: "alpha",
      kind: "forward",
      attemptStartedAt: "2026-09-03T01:00:00.000Z",
    });
    beginQueuedForwardSync(first, {
      repositoryId: "alpha",
      runId: run.syncRunId,
      startedAt: "2026-09-03T01:00:00.000Z",
    });
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

  it("uses the persisted attempt timestamp when completing a stream", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const run = createSyncRun(database, {
        repositoryId: "repo",
        kind: "forward",
        attemptStartedAt: "2026-09-03T01:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "repo",
        runId: run.syncRunId,
        startedAt: "2026-09-03T01:00:00.000Z",
      });

      completeSyncStream(database, {
        repositoryId: "repo",
        entityKind: "pull_request",
        completedAt: "2026-09-03T01:01:00.000Z",
        // This is deliberately an untyped external payload. Completion must
        // ignore it and use the persisted last_attempt_at value.
        attemptStartedAt: "2099-01-01T00:00:00.000Z",
      } as never);

      expect(getRepositorySyncState(database, "repo", "pull_request")).toEqual(
        expect.objectContaining({
          watermarkUpdatedAt: "2026-09-03T01:00:00.000Z",
          lastAttemptAt: "2026-09-03T01:00:00.000Z",
        }),
      );
    });
  });

  it("recovers durable queued/running runs as interrupted without deleting progress", () => {
    const path = databasePath();
    const first = openDatabase(path);
    reconcileRepositories(first, [repository("alpha")], "2026-09-03T00:00:00.000Z");
    const run = createSyncRun(first, {
      repositoryId: "alpha",
      kind: "history",
      trigger: "manual",
      entityKinds: ["pull_request", "issue"],
    });
    markSyncRunStarted(first, run.syncRunId, "2026-09-03T01:00:00.000Z");
    first
      .prepare("UPDATE repository_sync_run_streams SET items_seen = 3 WHERE run_id = ? AND entity_kind = 'pull_request'")
      .run(run.syncRunId);
    first.close();

    const reopened = openDatabase(path);
    try {
      expect(getSyncRun(reopened, run.syncRunId)).toMatchObject({
        status: "interrupted",
        streams: expect.arrayContaining([
          expect.objectContaining({ entityKind: "pull_request", status: "interrupted", itemsSeen: 3 }),
          expect.objectContaining({ entityKind: "issue", status: "interrupted" }),
        ]),
      });
    } finally {
      reopened.close();
    }
  });
});

describe("Issue detail cache", () => {
  it("replaces body/comments transactionally, sorts them, and keeps lists summary-only", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertIssuePage(database, "repo", [
        issue(7, "2026-09-03T00:00:00.000Z"),
      ]);
      replaceIssueDetailCache(database, "repo", {
        number: 7,
        title: "Issue 7",
        url: "https://github.com/example/repo/issues/7",
        state: "open",
        authorLogin: "author",
        commentsCount: 3,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        closedAt: null,
        body: "The issue body.",
        comments: [
          comment(3, "2026-09-03T00:02:00.000Z", "third"),
          comment(1, "2026-09-03T00:01:00.000Z", "first"),
          comment(2, "2026-09-03T00:01:00.000Z", "second"),
        ],
      });

      expect(getIssueDetailSyncedUpdatedAt(database, "repo", 7)).toBe(
        "2026-09-03T00:00:00.000Z",
      );
      expect(getIssueDetail(database, "repo", 7)).toMatchObject({
        number: 7,
        title: "Issue 7",
        detailBody: "The issue body.",
        commentsCount: 3,
        comments: [
          { id: 1, authorLogin: "alice", body: "first" },
          { id: 2, authorLogin: "bob", body: "second" },
          { id: 3, authorLogin: null, body: "third" },
        ],
      });

      const list = listIssues(database, "repo", { calendarTimeZone: "UTC" });
      expect(list.items[0]).toEqual({
        repositoryId: "repo",
        number: 7,
        title: "Issue 7",
        url: "https://github.com/example/repo/issues/7",
        authorLogin: "author",
        status: "open",
        commentsCount: 3,
        updatedAt: "2026-09-03T00:00:00.000Z",
        archivedAt: null,
        payloadPrunedAt: null,
      });
      expect(JSON.stringify(list)).not.toContain("comment body text");
      expect(JSON.stringify(list)).not.toContain("issue_body_marker");
    });
  });

  it("keeps the cached body/comments when a later summary upsert advances updated_at", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertIssuePage(database, "repo", [
        issue(7, "2026-09-03T00:00:00.000Z"),
      ]);
      replaceIssueDetailCache(database, "repo", {
        number: 7,
        title: "Issue 7",
        url: "https://github.com/example/repo/issues/7",
        state: "open",
        authorLogin: "author",
        commentsCount: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        closedAt: null,
        body: "cached body marker",
        comments: [comment(1, "2026-09-02T00:00:00.000Z", "cached comment")],
      });

      upsertIssuePage(database, "repo", [
        issue(7, "2026-09-04T00:00:00.000Z", {
          title: "Updated by sync",
          commentsCount: 5,
        }),
      ]);

      expect(getIssueDetailSyncedUpdatedAt(database, "repo", 7)).toBe(
        "2026-09-03T00:00:00.000Z",
      );
      expect(getIssueDetail(database, "repo", 7)).toMatchObject({
        title: "Updated by sync",
        updatedAt: "2026-09-04T00:00:00.000Z",
        detailBody: "cached body marker",
        comments: [{ id: 1, body: "cached comment" }],
      });
    });
  });

  it("cascades comment rows when the owning Issue is deleted", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertIssuePage(database, "repo", [
        issue(7, "2026-09-03T00:00:00.000Z"),
      ]);
      replaceIssueDetailCache(database, "repo", {
        number: 7,
        title: "Issue 7",
        url: "https://github.com/example/repo/issues/7",
        state: "open",
        authorLogin: "author",
        commentsCount: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        closedAt: null,
        body: "body",
        comments: [comment(1, "2026-09-02T00:00:00.000Z")],
      });

      database
        .prepare("DELETE FROM issues WHERE repository_id = ? AND number = ?")
        .run("repo", 7);

      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM issue_comments WHERE repository_id = ? AND issue_number = ?",
          )
          .get("repo", 7),
      ).toEqual({ count: 0 });
    });
  });
});

function comment(
  id: number,
  createdAt: string,
  body = "comment body text",
): {
  id: number;
  authorLogin: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
} {
  return {
    id,
    authorLogin: id === 1 ? "alice" : id === 2 ? "bob" : null,
    body,
    createdAt,
    updatedAt: createdAt,
    url: `https://github.com/example/repo/issues/7#issuecomment-${id}`,
  };
}

describe("metadata upserts and queries", () => {
  it("canonicalizes PR ordering, current archive filtering, and merged projection", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(10, "2026-09-01T00:00:00.000Z"),
        pullRequest(8, "2026-09-03T00:00:00.000Z"),
        pullRequest(9, "2026-09-02T00:00:00.000Z", {
          status: "merged",
          stateRaw: "MERGED",
          mergedAt: "2026-09-02T00:00:00.000Z",
        }),
        pullRequest(7, "2026-09-01T00:00:00.000Z", {
          status: "merged",
          stateRaw: "MERGED",
          mergedAt: "2026-09-01T00:00:00.000Z",
        }),
      ]);
      archiveBatch(database, {
        repositoryId: "repo",
        cutoff: "2026-09-04T00:00:00.000Z",
        archiveAt: "2026-09-11T00:00:00.000Z",
        includeMergedPrs: true,
        includeClosedPrs: false,
        includeClosedIssues: false,
      });

      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
      }).items.map((item) => item.number)).toEqual([8, 10]);
      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        sort: "number",
      }).items.map((item) => item.number)).toEqual([10, 8]);
      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
      }).items.map((item) => item.number)).toEqual([9, 7]);
    });
  });

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

  it("reports current PR head enrichment through the typed database API", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const first = pullRequest(1, "2026-09-03T00:00:00.000Z", {
        headSha: "a".repeat(40),
      });
      const second = pullRequest(2, "2026-09-03T00:00:00.000Z", {
        headSha: "b".repeat(40),
      });
      upsertPullRequestPage(database, "repo", [first, second]);

      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [1, 2, 999])).toEqual([
        { number: 1, headSha: first.headSha, enriched: false },
        { number: 2, headSha: second.headSha, enriched: false },
      ]);
      replacePullRequestFiles(database, "repo", 1, first.headSha, [{
        path: "README.md",
        previousPath: null,
        changeType: "modified",
        additions: 1,
        deletions: 0,
      }], false);

      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [1, 2])).toEqual([
        { number: 1, headSha: first.headSha, enriched: true },
        { number: 2, headSha: second.headSha, enriched: false },
      ]);
    });
  });

  it("returns stable PR pages and filtered totals for tied timestamps", () => {
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
        page: 1,
      });
      expect(first.items.map((item) => item.number)).toEqual([3, 2]);
      expect(first).toMatchObject({ page: 1, pageSize: 2, totalCount: 4, totalPages: 2 });
      const second = listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        page: 2,
      });
      expect(second.items.map((item) => item.number)).toEqual([1, 4]);
      expect(second).toMatchObject({ page: 2, pageSize: 2, totalCount: 4, totalPages: 2 });
      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        page: 3,
      })).toMatchObject({
        items: [expect.objectContaining({ number: 1 }), expect.objectContaining({ number: 4 })],
        page: 2,
        pageSize: 2,
        totalCount: 4,
        totalPages: 2,
      });
      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        search: "does-not-exist",
        limit: 2,
        page: 99,
      })).toMatchObject({ items: [], page: 1, pageSize: 2, totalCount: 0, totalPages: 0 });
    });
  });

  it("supports number ordering and applies filters to PR pages and totals", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(53906, "2026-09-01T00:00:00.000Z", {
          title: "A middle matching feature",
          authorLogin: "AliceExample",
        }),
        pullRequest(53960, "2026-09-03T00:00:00.000Z", {
          title: "Unrelated 2026 title",
          authorLogin: "other",
        }),
        pullRequest(100, "2026-09-02T00:00:00.000Z", {
          title: "Another issue",
          authorLogin: "feature-owner",
        }),
      ]);

      const first = listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        sort: "number",
        limit: 2,
        page: 1,
      });
      expect(first.items.map((item) => item.number)).toEqual([53960, 53906]);
      expect(first).toMatchObject({ page: 1, pageSize: 2, totalCount: 3, totalPages: 2 });
      const second = listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        sort: "number",
        limit: 2,
        page: 2,
      });
      expect(second.items.map((item) => item.number)).toEqual([100]);
      expect(second).toMatchObject({ page: 2, pageSize: 2, totalCount: 3, totalPages: 2 });

      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "UTC",
          search: "#3906",
          page: 1,
          limit: 10,
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 53906 })], totalCount: 1, totalPages: 1 });
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "UTC",
          search: "matching feat",
          page: 1,
          limit: 10,
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 53906 })], totalCount: 1, totalPages: 1 });
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "UTC",
          search: "OWNER",
          page: 1,
          limit: 10,
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 100 })], totalCount: 1, totalPages: 1 });
      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        search: "2026",
        page: 1,
        limit: 10,
      })).toMatchObject({ items: [expect.objectContaining({ number: 53960 })], totalCount: 1, totalPages: 1 });
    });
  });

  it("projects merged PRs by merge time with stable pages, filtered totals, and partial index", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(12, "2026-09-10T00:00:00.000Z", {
          mergedAt: "2026-09-02T00:00:00.000Z",
        }),
        pullRequest(11, "2026-09-01T00:00:00.000Z", {
          title: "Pull request merged in 2026",
          mergedAt: "2026-09-03T00:00:00.000Z",
        }),
        pullRequest(10, "2026-09-11T00:00:00.000Z", {
          mergedAt: "2026-09-03T00:00:00.000Z",
        }),
        pullRequest(9, "2026-09-12T00:00:00.000Z", { mergedAt: null }),
        pullRequest(8, "2026-09-13T00:00:00.000Z", {
          stateRaw: "CLOSED",
          status: "closed",
          closedAt: "2026-09-13T00:00:00.000Z",
          mergedAt: null,
        }),
      ]);
      const domain = createDomainRule(database, "repo", {
        name: "Merged",
        includePatterns: ["**"],
      });
      database
        .prepare(
          `INSERT INTO pull_request_domains
             (repository_id, pr_number, domain_rule_id, classification_key)
           VALUES (?, ?, ?, ?)`,
        )
        .run("repo", 11, domain.id, "merged-test");

      const first = listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        page: 1,
      });
      expect(first.items.map((item) => item.number)).toEqual([11, 10]);
      expect(first.items.every((item) => item.mergedAt !== undefined)).toBe(true);
      expect(first).toMatchObject({ page: 1, pageSize: 2, totalCount: 3, totalPages: 2 });

      const second = listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        page: 2,
      });
      expect(second.items.map((item) => item.number)).toEqual([12]);
      expect(second).toMatchObject({ page: 2, pageSize: 2, totalCount: 3, totalPages: 2 });
      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        limit: 2,
        page: 3,
      })).toMatchObject({
        items: [expect.objectContaining({ number: 12 })],
        page: 2,
        pageSize: 2,
        totalCount: 3,
        totalPages: 2,
      });
      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        search: "does-not-exist",
        limit: 2,
        page: 99,
      })).toMatchObject({ items: [], page: 1, pageSize: 2, totalCount: 0, totalPages: 0 });
      expect([...first.items, ...second.items].map((item) => item.number)).not.toContain(8);

      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        search: "#11",
        limit: 10,
        page: 1,
      })).toMatchObject({ items: [expect.objectContaining({ number: 11 })], totalCount: 1, totalPages: 1 });
      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        search: "2026",
        limit: 10,
        page: 1,
      })).toMatchObject({ items: [expect.objectContaining({ number: 11 })], totalCount: 1, totalPages: 1 });
      expect(listMergedPullRequests(database, "repo", {
        calendarTimeZone: "UTC",
        domainIds: [domain.id],
        limit: 10,
        page: 1,
      })).toMatchObject({ items: [expect.objectContaining({ number: 11 })], totalCount: 1, totalPages: 1 });

      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT repository_id, number
           FROM pull_requests
           WHERE repository_id = ? AND merged_at IS NOT NULL
           ORDER BY merged_at DESC, number DESC
           LIMIT ?`,
        )
        .all("repo", 100) as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("pull_requests_repository_merged_at_number_idx"))).toBe(true);
    });
  });

  it("paginates tied Issue timestamps within a status filter", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertIssuePage(database, "repo", [
        issue(5, "2026-09-03T00:00:00.000Z", { status: "open", title: "Issue 2026 regression" }),
        issue(4, "2026-09-03T00:00:00.000Z", { status: "closed" }),
        issue(3, "2026-09-03T00:00:00.000Z", { status: "open" }),
        issue(2, "2026-09-03T00:00:00.000Z", { status: "open" }),
      ]);

      const first = listIssues(database, "repo", {
        calendarTimeZone: "UTC",
        status: "open",
        limit: 2,
      });
      expect(first.items.map((item) => item.number)).toEqual([5, 3]);
      expect(first.nextCursor).not.toBeNull();

      const second = listIssues(database, "repo", {
        calendarTimeZone: "UTC",
        status: "open",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.number)).toEqual([2]);
      expect(second.nextCursor).toBeNull();
      expect(listIssues(database, "repo", {
        calendarTimeZone: "UTC",
        search: "2026",
        limit: 10,
      })).toMatchObject({ items: [expect.objectContaining({ number: 5 })] });
    });
  });

  it("rejects disabled repositories and malformed cursors", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      reconcileRepositories(database, []);

      expect(() =>
        listIssues(database, "repo", { calendarTimeZone: "UTC" }),
      ).toThrowError(/Repository is missing or disabled/);
      expect(() =>
        createSyncRun(database, { repositoryId: "repo", kind: "forward" }),
      ).toThrowError(/Repository is missing or disabled/);

      reconcileRepositories(database, [repository("repo")]);
      expect(() =>
        listIssues(database, "repo", { calendarTimeZone: "UTC", cursor: "not-a-cursor" }),
      ).toThrowError(InvalidCursorError);
      const legacySortCursor = btoa(JSON.stringify({
        version: 1,
        sort: "number",
        number: 7,
      })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      expect(() =>
        listIssues(database, "repo", { calendarTimeZone: "UTC", cursor: legacySortCursor }),
      ).toThrowError(InvalidCursorError);
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
          from: "2026-03-08",
          to: "2026-03-08",
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 2 })], totalCount: 1, totalPages: 1 });
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          status: "merged",
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 2 })], totalCount: 1, totalPages: 1 });
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          from: "2026-03-09",
          to: "2026-03-09",
        }),
      ).toMatchObject({ items: [expect.objectContaining({ number: 3 })], totalCount: 1, totalPages: 1 });
      expect(
        listPullRequests(database, "repo", {
          calendarTimeZone: "America/New_York",
          from: "2026-03-08",
          to: "2026-03-09",
        }),
      ).toMatchObject({
        items: [expect.objectContaining({ number: 3 }), expect.objectContaining({ number: 2 })],
        totalCount: 2,
        totalPages: 1,
      });

      const domain = createDomainRule(database, "repo", {
        name: "Merged PRs",
        includePatterns: ["**"],
      });
      database
        .prepare(
          `INSERT INTO pull_request_domains
             (repository_id, pr_number, domain_rule_id, classification_key)
           VALUES (?, ?, ?, ?)`,
        )
        .run("repo", 2, domain.id, "test");
      expect(listPullRequests(database, "repo", {
        calendarTimeZone: "America/New_York",
        domainIds: [domain.id],
        page: 1,
        limit: 10,
      })).toMatchObject({ items: [expect.objectContaining({ number: 2 })], totalCount: 1, totalPages: 1 });
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
