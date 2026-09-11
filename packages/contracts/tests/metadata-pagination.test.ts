import { describe, expect, it } from "vitest";

import {
  decodeUpdatedCursor,
  encodeUpdatedCursor,
  mergedPullRequestsQuerySchema,
  mergedPullRequestsResponseSchema,
  issuesQuerySchema,
  pullRequestsQuerySchema,
  pullRequestsResponseSchema,
} from "../src/index.js";

const pullRequest = {
  repositoryId: "repo",
  number: 7,
  title: "A pull request",
  url: "https://github.com/acme/repo/pull/7",
  authorLogin: "author",
  status: "open" as const,
  updatedAt: "2026-09-10T00:00:00.000Z",
  changedFilesCount: 2,
  additions: 4,
  deletions: 1,
  domains: [],
};

describe("metadata page pagination contracts", () => {
  it("preprocesses page and limit query strings for PR and Merged", () => {
    expect(pullRequestsQuerySchema.parse({
      page: "2",
      limit: "25",
      sort: "number",
      from: "2026-09-01",
      to: "2026-09-10",
    })).toMatchObject({ page: 2, limit: 25, sort: "number" });
    expect(mergedPullRequestsQuerySchema.parse({
      page: "3",
      limit: "50",
      domain: "dom_ci",
    })).toMatchObject({ page: 3, limit: 50, domain: ["dom_ci"] });
    expect(pullRequestsQuerySchema.parse({})).not.toHaveProperty("cursor");
    expect(mergedPullRequestsQuerySchema.parse({})).not.toHaveProperty("cursor");
  });

  it("rejects invalid page controls and cursor fields", () => {
    expect(pullRequestsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(pullRequestsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(mergedPullRequestsQuerySchema.safeParse({ page: "-1" }).success).toBe(false);
    expect(pullRequestsQuerySchema.safeParse({ page: String(Number.MAX_SAFE_INTEGER) }).success).toBe(true);
    expect(pullRequestsQuerySchema.safeParse({ page: "9007199254740992" }).success).toBe(false);
    expect(mergedPullRequestsQuerySchema.safeParse({ page: "9007199254740993" }).success).toBe(false);
    expect(mergedPullRequestsQuerySchema.safeParse({ cursor: "legacy" }).success).toBe(false);
    expect(pullRequestsQuerySchema.safeParse({ date: "2026-09-03" }).success).toBe(false);
    expect(issuesQuerySchema.safeParse({ date: "2026-09-03" }).success).toBe(false);
  });

  it("accepts canonical Issue date ranges without page controls", () => {
    expect(issuesQuerySchema.parse({ from: "2026-09-01", to: "2026-09-03", limit: "25" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-03",
      limit: 25,
    });
  });

  it("uses one updated cursor payload and rejects legacy sort payloads", () => {
    const cursor = encodeUpdatedCursor({ updatedAt: "2026-09-10T00:00:00.000Z", number: 7 });
    expect(decodeUpdatedCursor(cursor)).toEqual({
      updatedAt: "2026-09-10T00:00:00.000Z",
      number: 7,
    });
    const legacy = btoa(JSON.stringify({
      version: 1,
      sort: "number",
      number: 7,
    })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(() => decodeUpdatedCursor(legacy)).toThrow("Invalid list cursor");
  });

  it("requires page metadata in PR and Merged responses", () => {
    const page = {
      items: [pullRequest],
      page: 1,
      pageSize: 100,
      totalCount: 1,
      totalPages: 1,
      calendarTimeZone: "UTC",
    };
    expect(pullRequestsResponseSchema.parse(page)).toEqual(page);
    expect(mergedPullRequestsResponseSchema.parse({
      ...page,
      items: [{ ...pullRequest, status: "merged", mergedAt: "2026-09-09T00:00:00.000Z" }],
    })).toMatchObject({ page: 1, pageSize: 100, totalCount: 1, totalPages: 1 });
    expect(pullRequestsResponseSchema.safeParse({ ...page, nextCursor: null }).success).toBe(false);
  });
});
