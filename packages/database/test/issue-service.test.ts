import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  comment,
  databasePath,
  issue,
  repository,
  withDatabase,
} from "./support.js";
import {
  getIssueDetail,
  getIssueDetailCacheState,
  InvalidCursorError,
  listIssues,
  reconcileRepositories,
  replaceIssueDetailCache,
  upsertIssuePage,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

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

      expect(getIssueDetailCacheState(database, "repo", 7)?.syncedUpdatedAt).toBe(
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

      expect(getIssueDetailCacheState(database, "repo", 7)?.syncedUpdatedAt).toBe(
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

describe("Issue metadata queries", () => {
  it("replays summary pages idempotently while updating issue state", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertIssuePage(database, "repo", [issue(4, "2026-09-03T00:00:00.000Z")]);
      upsertIssuePage(database, "repo", [
        issue(4, "2026-09-03T00:00:00.000Z", {
          status: "closed",
          title: "Closed issue",
        }),
      ]);

      const result = listIssues(database, "repo", { calendarTimeZone: "UTC" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ title: "Closed issue", status: "closed" });
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
});
