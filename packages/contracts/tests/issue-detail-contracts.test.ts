import { describe, expect, it } from "vitest";

import {
  issueCommentSchema,
  issueDetailSchema,
  issueListItemSchema,
  issuesResponseSchema,
} from "../src/index.js";

const issue = {
  repositoryId: "repo",
  number: 7,
  title: "Issue detail cache",
  url: "https://github.com/acme/repo/issues/7",
  authorLogin: "author",
  status: "open" as const,
  commentsCount: 2,
  updatedAt: "2026-09-03T02:03:04.000Z",
};

const firstComment = {
  id: 11,
  authorLogin: "alice",
  body: "First **comment**.",
  createdAt: "2026-09-03T02:04:00.000Z",
  updatedAt: "2026-09-03T02:05:00.000Z",
  url: "https://github.com/acme/repo/issues/7#issuecomment-11",
};

const secondComment = {
  id: 12,
  authorLogin: null,
  body: "Second comment.",
  createdAt: "2026-09-03T03:00:00.000Z",
  updatedAt: "2026-09-03T03:00:00.000Z",
  url: "https://github.com/acme/repo/issues/7#issuecomment-12",
};

describe("Issue detail contracts", () => {
  it("keeps list summaries free of body and comment fields", () => {
    expect(issueListItemSchema.parse(issue)).toEqual(issue);
    expect(issuesResponseSchema.parse({
      items: [issue],
      nextCursor: null,
      calendarTimeZone: "UTC",
    })).toEqual({
      items: [issue],
      nextCursor: null,
      calendarTimeZone: "UTC",
    });
    expect(
      issueListItemSchema.safeParse({ ...issue, body: "hidden" }).success,
    ).toBe(false);
    expect(
      issueListItemSchema.safeParse({ ...issue, comments: [] }).success,
    ).toBe(false);
    expect(
      issueListItemSchema.safeParse({ ...issue, detailBody: "hidden" }).success,
    ).toBe(false);
  });

  it("parses full Issue details with sorted comment objects", () => {
    const detail = {
      ...issue,
      createdAt: "2026-09-01T00:00:00.000Z",
      closedAt: null,
      detailBody: "# Problem\n\nBody text.",
      comments: [secondComment, firstComment],
    };
    expect(issueCommentSchema.parse(firstComment)).toEqual(firstComment);
    expect(issueDetailSchema.parse(detail)).toEqual(detail);
  });

  it("rejects malformed comments and summary-only detail responses", () => {
    expect(
      issueCommentSchema.safeParse({ ...firstComment, body: 7 }).success,
    ).toBe(false);
    expect(
      issueCommentSchema.safeParse({ ...firstComment, url: "not-a-url" }).success,
    ).toBe(false);
    expect(
      issueDetailSchema.safeParse({
        ...issue,
        createdAt: "2026-09-01T00:00:00.000Z",
        closedAt: null,
        detailBody: null,
      }).success,
    ).toBe(false);
    expect(
      issueDetailSchema.safeParse({
        ...issue,
        createdAt: "2026-09-01T00:00:00.000Z",
        closedAt: null,
        detailBody: null,
        comments: [{ ...firstComment, unexpected: true }],
      }).success,
    ).toBe(false);
  });
});
