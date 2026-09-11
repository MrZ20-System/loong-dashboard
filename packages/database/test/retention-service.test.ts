import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  archiveBatch,
  createMaintenanceRun,
  createDomainRule,
  getMaintenanceRun,
  getPullRequestDetail,
  listCurrentPullRequestEnrichmentStates,
  listIssues,
  listMergedPullRequests,
  listPullRequests,
  listPullRequestsNeedingFileEnrichment,
  openDatabase,
  previewArchive,
  reconcileRepositories,
  replaceIssueDetailCache,
  replacePullRequestFiles,
  restoreIssue,
  restorePullRequest,
  updateMaintenanceRun,
  upsertIssuePage,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type IssueMetadata,
  type PullRequestMetadata,
} from "../src/index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-retention-db-"));
  directories.push(directory);
  return join(directory, "loongboard.sqlite3");
}

function repository(key = "repo"): ConfiguredRepository {
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
    stateRaw: "CLOSED",
    status: "closed",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    closedAt: "2026-01-02T00:00:00.000Z",
    mergedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headSha: `${number}`.padStart(40, "0"),
    additions: 11,
    deletions: 7,
    changedFilesCount: 9,
    detailBody: `body-${number}`,
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
    authorLogin: "author",
    status: "closed",
    commentsCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    closedAt: "2026-01-02T00:00:00.000Z",
    detailBody: `issue-body-${number}`,
    ...overrides,
  };
}

function comment(id: number) {
  return {
    id,
    authorLogin: "author",
    body: `comment-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: `https://github.com/example/repo/issues/2#issuecomment-${id}`,
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

describe("metadata retention", () => {
  it("previews and archives only selected terminal entities while pruning heavy payloads", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository()]);
      const cutoff = "2026-09-01T00:00:00.000Z";
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-08-01T00:00:00.000Z", {
          status: "open",
          stateRaw: "OPEN",
          isDraft: false,
          closedAt: null,
          detailBody: "open body",
        }),
        pullRequest(2, "2026-08-01T00:00:00.000Z", {
          status: "draft",
          stateRaw: "OPEN",
          isDraft: true,
          closedAt: null,
          detailBody: "draft body",
        }),
        pullRequest(3, "2026-08-01T00:00:00.000Z"),
        pullRequest(4, "2026-08-01T00:00:00.000Z", {
          status: "merged",
          stateRaw: "MERGED",
          mergedAt: "2026-01-03T00:00:00.000Z",
        }),
        pullRequest(5, cutoff),
        pullRequest(6, "2026-09-02T00:00:00.000Z"),
      ]);
      upsertIssuePage(database, "repo", [
        issue(1, "2026-08-01T00:00:00.000Z", {
          status: "open",
          closedAt: null,
          detailBody: "open issue body",
          commentsCount: 0,
        }),
        issue(2, "2026-08-01T00:00:00.000Z"),
        issue(3, cutoff),
      ]);

      replacePullRequestFiles(database, "repo", 3, pullRequest(3, cutoff).headSha, [{
        path: "src/a.ts",
        previousPath: null,
        changeType: "added",
        additions: 3,
        deletions: 0,
      }], true);
      replacePullRequestFiles(database, "repo", 4, pullRequest(4, cutoff).headSha, [{
        path: "src/b.ts",
        previousPath: null,
        changeType: "modified",
        additions: 2,
        deletions: 1,
      }], false);
      const domain = createDomainRule(database, "repo", {
        name: "Keep last classification",
        includePatterns: ["src/**"],
      });
      database.prepare(
        `INSERT INTO pull_request_domains
           (repository_id, pr_number, domain_rule_id, classification_key)
         VALUES (?, ?, ?, ?)`,
      ).run("repo", 3, domain.id, "before-retention");
      replaceIssueDetailCache(database, "repo", {
        number: 2,
        title: "Issue 2",
        url: "https://github.com/example/repo/issues/2",
        state: "closed",
        authorLogin: "author",
        commentsCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        closedAt: "2026-01-02T00:00:00.000Z",
        body: "cached issue body",
        comments: [comment(1)],
      });

      expect(previewArchive(database, {
        repositoryId: "repo",
        cutoff: "2026-09-01T00:00:00Z",
        includeMergedPrs: true,
        includeClosedPrs: true,
        includeClosedIssues: true,
      })).toEqual({
        repositoryId: "repo",
        cutoff,
        includeMergedPrs: true,
        includeClosedPrs: true,
        includeClosedIssues: true,
        scopes: ["merged_prs", "closed_prs", "closed_issues"],
        mergedPrCount: 1,
        closedPrCount: 1,
        closedIssueCount: 1,
        prFileRows: 2,
        issueCommentRows: 1,
        prPayloadCount: 2,
        issuePayloadCount: 1,
      });

      const archived = archiveBatch(database, {
        repositoryId: "repo",
        cutoff,
        archiveAt: "2026-09-11T00:00:00Z",
        includeMergedPrs: true,
        includeClosedPrs: true,
        includeClosedIssues: true,
        prune: true,
      });
      expect(archived).toMatchObject({
        cutoff,
        archiveAt: "2026-09-11T00:00:00.000Z",
        batchSize: 250,
        prCount: 2,
        issueCount: 1,
        filesDeleted: 2,
        commentsDeleted: 1,
        prPayloadPruned: 2,
        issuePayloadPruned: 1,
        hasMore: false,
      });

      expect(database.prepare(
        `SELECT number, archived_at, payload_pruned_at, detail_body,
                files_truncated, additions, deletions, changed_files_count, head_sha
         FROM pull_requests ORDER BY number`,
      ).all()).toEqual([
        expect.objectContaining({ number: 1, archived_at: null, payload_pruned_at: null }),
        expect.objectContaining({ number: 2, archived_at: null, payload_pruned_at: null }),
        expect.objectContaining({ number: 3, archived_at: "2026-09-11T00:00:00.000Z", payload_pruned_at: "2026-09-11T00:00:00.000Z", detail_body: null, files_truncated: 0, additions: 11, deletions: 7, changed_files_count: 9 }),
        expect.objectContaining({ number: 4, archived_at: "2026-09-11T00:00:00.000Z", payload_pruned_at: "2026-09-11T00:00:00.000Z", detail_body: null, files_truncated: 0, head_sha: pullRequest(4, cutoff).headSha }),
        expect.objectContaining({ number: 5, archived_at: null }),
        expect.objectContaining({ number: 6, archived_at: null }),
      ]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM pull_request_files WHERE repository_id = 'repo'",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM pull_request_domains WHERE repository_id = 'repo' AND pr_number = 3",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT number, archived_at, payload_pruned_at, detail_body,
                detail_synced_updated_at, comments_count
         FROM issues ORDER BY number`,
      ).all()).toEqual([
        expect.objectContaining({ number: 1, archived_at: null }),
        expect.objectContaining({ number: 2, archived_at: "2026-09-11T00:00:00.000Z", payload_pruned_at: "2026-09-11T00:00:00.000Z", detail_body: null, detail_synced_updated_at: null, comments_count: 1 }),
        expect.objectContaining({ number: 3, archived_at: null }),
      ]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM issue_comments WHERE repository_id = 'repo'",
      ).get()).toEqual({ count: 0 });

      expect(listPullRequests(database, "repo", { calendarTimeZone: "UTC" }).items.map((item) => item.number)).toEqual([6, 5, 2, 1]);
      expect(listPullRequests(database, "repo", { calendarTimeZone: "UTC", archive: "archived" }).items.map((item) => item.number)).toEqual([4, 3]);
      expect(listPullRequests(database, "repo", { calendarTimeZone: "UTC", archive: "all" }).totalCount).toBe(6);
      expect(listIssues(database, "repo", { calendarTimeZone: "UTC" }).items.map((item) => item.number)).toEqual([3, 1]);
      expect(listIssues(database, "repo", { calendarTimeZone: "UTC", archive: "archived" }).items.map((item) => item.number)).toEqual([2]);
      expect(listIssues(database, "repo", { calendarTimeZone: "UTC", archive: "all" }).items.map((item) => item.number)).toEqual([3, 2, 1]);
      expect(listMergedPullRequests(database, "repo", { calendarTimeZone: "UTC" }).items.map((item) => item.number)).toEqual([4]);

      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [3, 4])).toEqual([
        { number: 3, headSha: pullRequest(3, cutoff).headSha, enriched: true },
        { number: 4, headSha: pullRequest(4, cutoff).headSha, enriched: true },
      ]);
      expect(listPullRequestsNeedingFileEnrichment(database, "repo", [3, 4])).toEqual([]);

      expect(restorePullRequest(database, "repo", 3)).toEqual({
        repositoryId: "repo",
        entityKind: "pull_request",
        number: 3,
        archivedAt: null,
        payloadPrunedAt: "2026-09-11T00:00:00.000Z",
      });
      expect(restoreIssue(database, "repo", 2)).toEqual({
        repositoryId: "repo",
        entityKind: "issue",
        number: 2,
        archivedAt: null,
        payloadPrunedAt: "2026-09-11T00:00:00.000Z",
      });
      expect(database.prepare(
        `SELECT archived_at, payload_pruned_at
         FROM pull_requests WHERE repository_id = 'repo' AND number = 3`,
      ).get()).toEqual({
        archived_at: null,
        payload_pruned_at: "2026-09-11T00:00:00.000Z",
      });
      expect(database.prepare(
        `SELECT archived_at, payload_pruned_at
         FROM issues WHERE repository_id = 'repo' AND number = 2`,
      ).get()).toEqual({
        archived_at: null,
        payload_pruned_at: "2026-09-11T00:00:00.000Z",
      });
      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [3])).toEqual([
        { number: 3, headSha: pullRequest(3, cutoff).headSha, enriched: false },
      ]);
      expect(listPullRequestsNeedingFileEnrichment(database, "repo", [3])).toHaveLength(1);
      upsertPullRequestPage(database, "repo", [pullRequest(3, "2026-09-11T00:00:00.000Z", {
        detailBody: "refetched PR body",
      })]);
      expect(getPullRequestDetail(database, "repo", 3)?.payloadPrunedAt).toBe(
        "2026-09-11T00:00:00.000Z",
      );
      replacePullRequestFiles(database, "repo", 3, pullRequest(3, cutoff).headSha, [], false);
      expect(getPullRequestDetail(database, "repo", 3)?.payloadPrunedAt).toBeNull();
      replaceIssueDetailCache(database, "repo", {
        number: 2,
        title: "Issue 2 restored",
        url: "https://github.com/example/repo/issues/2",
        state: "closed",
        authorLogin: "author",
        commentsCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
        closedAt: "2026-01-02T00:00:00.000Z",
        body: "refetched",
        comments: [],
      });
      expect(listIssues(database, "repo", { calendarTimeZone: "UTC", archive: "current" }).items.find((item) => item.number === 2)?.payloadPrunedAt).toBeNull();
    });
  });

  it("canonicalizes Issue current filtering, reopen unarchive, and payload marker independence", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository()]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-08-01T00:00:00.000Z", {
          status: "merged",
          stateRaw: "MERGED",
          mergedAt: "2026-01-02T00:00:00.000Z",
        }),
        pullRequest(2, "2026-08-01T00:00:00.000Z"),
      ]);
      upsertIssuePage(database, "repo", [issue(1, "2026-08-01T00:00:00.000Z")]);
      archiveBatch(database, {
        repositoryId: "repo",
        cutoff: "2026-09-01T00:00:00.000Z",
        archiveAt: "2026-09-11T00:00:00.000Z",
        includeMergedPrs: true,
        includeClosedPrs: true,
        includeClosedIssues: true,
        prune: true,
      });
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-09-10T00:00:00.000Z", {
          status: "merged",
          stateRaw: "MERGED",
          mergedAt: "2026-01-02T00:00:00.000Z",
        }),
        pullRequest(2, "2026-09-10T00:00:00.000Z", {
          status: "open",
          stateRaw: "OPEN",
          isDraft: false,
          closedAt: null,
          mergedAt: null,
        }),
      ]);
      upsertIssuePage(database, "repo", [
        issue(1, "2026-09-10T00:00:00.000Z", {
          status: "open",
          closedAt: null,
        }),
      ]);
      expect(database.prepare(
        "SELECT number, archived_at FROM pull_requests ORDER BY number",
      ).all()).toEqual([
        { number: 1, archived_at: "2026-09-11T00:00:00.000Z" },
        { number: 2, archived_at: null },
      ]);
      expect(database.prepare(
        "SELECT number, archived_at FROM issues",
      ).all()).toEqual([{ number: 1, archived_at: null }]);
      expect(listIssues(database, "repo", { calendarTimeZone: "UTC" }).items.map((item) => item.number)).toEqual([1]);
      expect(database.prepare(
        "SELECT archived_at, payload_pruned_at FROM issues WHERE repository_id = 'repo' AND number = 1",
      ).get()).toEqual({ archived_at: null, payload_pruned_at: "2026-09-11T00:00:00.000Z" });
    });
  });

  it("processes exactly the bounded default batch and reports remaining work", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository()]);
      upsertPullRequestPage(database, "repo", Array.from({ length: 251 }, (_, index) =>
        pullRequest(index + 1, "2026-08-01T00:00:00.000Z"),
      ));
      const input = {
        repositoryId: "repo",
        cutoff: "2026-09-01T00:00:00.000Z",
        archiveAt: "2026-09-11T00:00:00.000Z",
        includeMergedPrs: false,
        includeClosedPrs: true,
        includeClosedIssues: false,
      } as const;
      expect(archiveBatch(database, input)).toMatchObject({
        batchSize: 250,
        prCount: 250,
        issueCount: 0,
        hasMore: true,
      });
      expect(archiveBatch(database, input)).toMatchObject({
        batchSize: 250,
        prCount: 1,
        issueCount: 0,
        hasMore: false,
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM pull_requests WHERE archived_at IS NOT NULL",
      ).get()).toEqual({ count: 251 });
    });
  });
});

describe("maintenance run typed API", () => {
  it("persists selectors and only permits valid state transitions", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository()]);
      const run = createMaintenanceRun(database, {
        id: "maintenance-1",
        repositoryId: "repo",
        kind: "archive",
        trigger: "manual",
        cutoff: "2026-09-01T00:00:00Z",
        selector: {
          includeMergedPrs: true,
          includeClosedPrs: false,
          includeClosedIssues: true,
        },
        requestedAt: "2026-09-11T01:00:00Z",
      });
      expect(run).toEqual({
        id: "maintenance-1",
        repositoryId: "repo",
        kind: "archive",
        trigger: "manual",
        status: "queued",
        cutoff: "2026-09-01T00:00:00.000Z",
        selector: {
          includeMergedPrs: true,
          includeClosedPrs: false,
          includeClosedIssues: true,
        },
        requestedAt: "2026-09-11T01:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        prCount: 0,
        issueCount: 0,
        filesDeleted: 0,
        commentsDeleted: 0,
        error: null,
      });
      expect(getMaintenanceRun(database, "maintenance-1")).toEqual(run);
      expect(updateMaintenanceRun(database, "maintenance-1", {
        status: "running",
        startedAt: "2026-09-11T01:01:00Z",
        prCount: 2,
      })).toMatchObject({
        status: "running",
        startedAt: "2026-09-11T01:01:00.000Z",
        prCount: 2,
      });
      expect(updateMaintenanceRun(database, "maintenance-1", {
        status: "completed",
        finishedAt: "2026-09-11T01:02:00Z",
        filesDeleted: 3,
      })).toMatchObject({
        status: "completed",
        finishedAt: "2026-09-11T01:02:00.000Z",
        filesDeleted: 3,
      });
      expect(() => updateMaintenanceRun(database, "maintenance-1", {
        status: "running",
      })).toThrow(/Invalid maintenance run transition/);

      const queued = createMaintenanceRun(database, {
        repositoryId: "repo",
        kind: "optimize",
        trigger: "automatic",
      });
      expect(() => updateMaintenanceRun(database, queued.id, {
        status: "completed",
      })).toThrow(/Invalid maintenance run transition/);
    });
  });
});
