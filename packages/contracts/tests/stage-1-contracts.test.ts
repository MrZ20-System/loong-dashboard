import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  activityDaysQuerySchema,
  activityDaysResponseSchema,
  activityDaySchema,
  apiErrorSchema,
  calendarDateSchema,
  decodeListCursor,
  encodeListCursor,
  issuesQuerySchema,
  issuesResponseSchema,
  issueListItemSchema,
  listCursorPayloadSchema,
  opaqueCursorSchema,
  pullRequestsQuerySchema,
  pullRequestsResponseSchema,
  pullRequestListItemSchema,
  repositoryParamsSchema,
  repositoriesResponseSchema,
  repositorySummarySchema,
  syncAcceptedResponseSchema,
  syncStatusResponseSchema,
  syncStreamStateSchema,
  utcDateTimeSchema,
} from "../src/index.js";

const repository = {
  id: "loong-dashboard",
  key: "loong-dashboard",
  displayName: "LoongBoard",
  githubOwner: "MrZ20",
  githubName: "loong-dashboard",
  localPath: "/Users/lonng/Mrz20/loong-dashboard",
  remoteName: "origin",
  defaultBranch: "main",
  worktreeSlots: 2,
  enabled: true,
};

const streamState = {
  entityKind: "pull_request" as const,
  status: "idle" as const,
  watermarkUpdatedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  rateLimitRemaining: null,
  rateLimitResetAt: null,
};

const issueStreamState = { ...streamState, entityKind: "issue" as const };

const pullRequest = {
  repositoryId: repository.id,
  number: 42,
  title: "Add metadata synchronization",
  url: "https://github.com/MrZ20/loong-dashboard/pull/42",
  authorLogin: "octocat",
  status: "open" as const,
  updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 0,
  additions: 10,
  deletions: 2,
  domains: [{ id: "dom_ci", name: "CI", color: "#5b8def" }],
};

const issue = {
  repositoryId: repository.id,
  number: 7,
  title: "Track activity days",
  url: "https://github.com/MrZ20/loong-dashboard/issues/7",
  authorLogin: null,
  status: "closed" as const,
  commentsCount: 0,
  updatedAt: "2026-09-02T12:00:00Z",
};

describe("shared validation primitives", () => {
  it("accepts real leap and non-leap dates", () => {
    expect(calendarDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(calendarDateSchema.safeParse("2026-09-03").success).toBe(true);
  });

  it("rejects malformed and impossible dates", () => {
    for (const value of [
      "2026-02-29",
      "2024-02-30",
      "2026-04-31",
      "2026-13-01",
      "0000-01-01",
      "2026-9-03",
      "2026-09-03T00:00:00Z",
    ]) {
      expect(calendarDateSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts only UTC timestamps", () => {
    expect(utcDateTimeSchema.safeParse("2026-09-03T02:03:04.000Z").success).toBe(
      true,
    );
    for (const value of [
      "2026-09-03",
      "2026-09-03T02:03:04",
      "2026-09-03T02:03:04+08:00",
      "not-a-timestamp",
    ]) {
      expect(utcDateTimeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts opaque nonblank cursors and rejects blank values", () => {
    expect(opaqueCursorSchema.safeParse("opaque-token").success).toBe(true);
    expect(opaqueCursorSchema.safeParse("").success).toBe(false);
    expect(opaqueCursorSchema.safeParse("   ").success).toBe(false);
  });
});

describe("repository and sync contracts", () => {
  it("parses strict repository and path parameter responses", () => {
    expect(repositorySummarySchema.parse(repository)).toEqual(repository);
    expect(repositoriesResponseSchema.parse({ items: [repository] })).toEqual({
      items: [repository],
    });
    expect(repositoryParamsSchema.parse({ id: repository.id })).toEqual({
      id: repository.id,
    });
    expect(repositoryParamsSchema.safeParse({ id: "repo", extra: true }).success).toBe(
      false,
    );
  });

  it("rejects repository extras and invalid identities", () => {
    expect(
      repositorySummarySchema.safeParse({ ...repository, extra: true }).success,
    ).toBe(false);
    expect(repositorySummarySchema.safeParse({ ...repository, id: "" }).success).toBe(
      false,
    );
    expect(repositorySummarySchema.safeParse({ ...repository, enabled: "yes" }).success).toBe(
      false,
    );
    expect(
      repositorySummarySchema.safeParse({ ...repository, key: "another-repository" }).success,
    ).toBe(false);
  });

  it("parses accepted sync and database-backed status records", () => {
    expect(
      syncAcceptedResponseSchema.parse({
        repositoryId: repository.id,
        syncRunId: "sync-1",
        status: "accepted",
      }),
    ).toEqual({ repositoryId: repository.id, syncRunId: "sync-1", status: "accepted" });

    expect(
      syncStatusResponseSchema.parse({
        repositoryId: repository.id,
        status: "idle",
        pullRequests: streamState,
        issues: issueStreamState,
      }),
    ).toEqual({
      repositoryId: repository.id,
      status: "idle",
      pullRequests: streamState,
      issues: issueStreamState,
    });
  });

  it("rejects invalid sync statuses, metrics, timestamps, and extras", () => {
    expect(syncStreamStateSchema.safeParse({ ...streamState, status: "succeeded" }).success).toBe(
      false,
    );
    expect(
      syncStreamStateSchema.safeParse({ ...streamState, rateLimitRemaining: -1 }).success,
    ).toBe(false);
    expect(
      syncStreamStateSchema.safeParse({ ...streamState, lastAttemptAt: "tomorrow" }).success,
    ).toBe(false);
    expect(
      syncStatusResponseSchema.safeParse({
        repositoryId: repository.id,
        status: "idle",
        pullRequests: streamState,
        issues: issueStreamState,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("metadata list and query contracts", () => {
  it("parses PR, Issue, activity-day, and list responses", () => {
    expect(pullRequestListItemSchema.parse(pullRequest)).toEqual(pullRequest);
    expect(issueListItemSchema.parse(issue)).toEqual(issue);
    expect(activityDaySchema.parse({ date: "2026-09-03", count: 0 })).toEqual({
      date: "2026-09-03",
      count: 0,
    });
    expect(
      pullRequestsResponseSchema.parse({
        items: [pullRequest],
        nextCursor: "opaque-token",
        calendarTimeZone: "Asia/Shanghai",
      }).items,
    ).toEqual([pullRequest]);
    expect(
      issuesResponseSchema.parse({
        items: [issue],
        nextCursor: null,
        calendarTimeZone: "Asia/Shanghai",
      }).nextCursor,
    ).toBeNull();
    expect(
      activityDaysResponseSchema.parse({
        days: [{ date: "2026-09-03", count: 0 }],
        calendarTimeZone: "Asia/Shanghai",
      }).days,
    ).toHaveLength(1);
  });

  it("parses query filters and validates date ranges", () => {
    expect(
      pullRequestsQuerySchema.parse({
        date: "2026-09-03",
        status: "merged",
        cursor: "opaque-token",
      }),
    ).toEqual({ date: "2026-09-03", status: "merged", cursor: "opaque-token" });
    expect(issuesQuerySchema.parse({ status: "open" })).toEqual({ status: "open" });
    expect(activityDaysQuerySchema.parse({ from: "2026-09-01", to: "2026-09-03" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-03",
    });
    expect(
      activityDaysQuerySchema.safeParse({ from: "2026-09-04", to: "2026-09-03" }).success,
    ).toBe(false);
  });

  it("rejects invalid metadata values and every object family rejects extras", () => {
    expect(pullRequestListItemSchema.safeParse({ ...pullRequest, additions: -1 }).success).toBe(
      false,
    );
    expect(issueListItemSchema.safeParse({ ...issue, commentsCount: -1 }).success).toBe(false);
    expect(activityDaySchema.safeParse({ date: "2026-02-30", count: 1 }).success).toBe(false);
    expect(pullRequestsQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
    expect(issuesQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(
      pullRequestsResponseSchema.safeParse({
        items: [],
        nextCursor: null,
        calendarTimeZone: "UTC",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      activityDaysResponseSchema.safeParse({ days: [], calendarTimeZone: "UTC", extra: true })
        .success,
    ).toBe(false);
  });
});

describe("versioned list cursors", () => {
  it("round-trips the stable ordering key", () => {
    const cursor = encodeListCursor({
      updatedAt: "2026-09-03T02:03:04.000Z",
      number: 42,
    });
    expect(opaqueCursorSchema.safeParse(cursor).success).toBe(true);
    expect(decodeListCursor(cursor)).toEqual({
      version: 1,
      updatedAt: "2026-09-03T02:03:04.000Z",
      number: 42,
    });
  });

  it("round-trips generated canonical UTC timestamps and positive numbers", () => {
    const timestampArbitrary = fc
      .date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2100-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString());
    const numberArbitrary = fc.integer({ min: 1, max: 1_000_000 });

    fc.assert(
      fc.property(timestampArbitrary, numberArbitrary, (updatedAt, number) => {
        const cursor = encodeListCursor({ updatedAt, number });
        expect(decodeListCursor(cursor)).toEqual({ version: 1, updatedAt, number });
      }),
      { numRuns: 100, seed: 20260903 },
    );
  });

  it("rejects malformed, unsupported, and extra cursor payloads", () => {
    expect(() => decodeListCursor("not a cursor")).toThrow("Invalid list cursor");
    const encode = (payload: unknown) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    for (const payload of [
      { version: 2, updatedAt: "2026-09-03T00:00:00Z", number: 1 },
      { version: 1, updatedAt: "not-a-timestamp", number: 1 },
      { version: 1, updatedAt: "2026-09-03T00:00:00Z", number: 0 },
      { version: 1, updatedAt: "2026-09-03T00:00:00Z", number: 1, extra: true },
    ]) {
      expect(() => decodeListCursor(encode(payload))).toThrow("Invalid list cursor");
      expect(listCursorPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("API errors", () => {
  it("parses the strict frozen error envelope", () => {
    expect(
      apiErrorSchema.parse({
        error: { code: "INVALID_CURSOR", message: "Cursor is invalid" },
      }),
    ).toEqual({ error: { code: "INVALID_CURSOR", message: "Cursor is invalid" } });
  });

  it("rejects unknown codes, empty messages, and extra fields", () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: "UNKNOWN", message: "bad" } }).success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({ error: { code: "INVALID_REQUEST", message: "" } }).success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({
        error: { code: "INVALID_REQUEST", message: "bad", extra: true },
      }).success,
    ).toBe(false);
    expect(apiErrorSchema.safeParse({ error: { code: "INVALID_REQUEST", message: "bad" }, extra: true }).success).toBe(
      false,
    );
  });
});
