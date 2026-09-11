import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  pullRequest,
  repository,
  withDatabase,
} from "./support.js";
import {
  createDomainRule,
  getPullRequestDetail,
  listMergedPullRequests,
  listPullRequests,
  reconcileRepositories,
  upsertPullRequestPage,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

describe("pull request query service", () => {
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
      database
        .prepare("UPDATE pull_requests SET archived_at = ? WHERE repository_id = ? AND number IN (?, ?)")
        .run("2026-09-11T00:00:00.000Z", "repo", 9, 7);

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

  it("replays PR pages idempotently while retaining cached detail", () => {
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
      expect(listPullRequests(database, "repo", { calendarTimeZone: "UTC" }).totalCount).toBe(1);
      expect(getPullRequestDetail(database, "repo", 1)).toMatchObject({
        title: "Updated title",
        additions: 12,
        detailBody: "Keep this body",
      });
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
});
