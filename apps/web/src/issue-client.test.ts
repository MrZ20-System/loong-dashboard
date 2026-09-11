import { describe, expect, it, vi } from "vitest";

import { fetchIssueDetail, refreshIssueDetail } from "./issue-client";
import { AUTH_REQUIRED_EVENT } from "./auth-required-event";

const detail = {
  repositoryId: "repo",
  number: 7,
  title: "Issue detail",
  url: "https://github.com/acme/repo/issues/7",
  authorLogin: "author",
  status: "open" as const,
  commentsCount: 1,
  updatedAt: "2026-09-03T02:03:04.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  closedAt: null,
  detailBody: "Body",
  comments: [
    {
      id: 1,
      authorLogin: "alice",
      body: "Comment",
      createdAt: "2026-09-03T02:04:00.000Z",
      updatedAt: "2026-09-03T02:04:00.000Z",
      url: "https://github.com/acme/repo/issues/7#issuecomment-1",
    },
  ],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchIssueDetail", () => {
  it("returns the validated detail including Markdown comments", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(detail));

    await expect(fetchIssueDetail("repo", 7, fetchImpl)).resolves.toEqual(detail);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/repositories/repo/issues/7",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("rejects summary-shaped responses that omit comments", async () => {
    const { comments: _comments, ...summary } = detail;
    const fetchImpl = vi.fn<typeof fetch>(async () => json(summary));

    await expect(fetchIssueDetail("repo", 7, fetchImpl)).rejects.toThrow(
      "returned an invalid response",
    );
  });

  it("uses the explicit refresh endpoint and validates the refreshed detail", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(detail));

    await expect(refreshIssueDetail("repo", 7, fetchImpl)).resolves.toEqual(detail);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/repositories/repo/issues/7/refresh",
      expect.objectContaining({ method: "POST", headers: { Accept: "application/json" } }),
    );
  });

  it("dispatches auth-required for a matching 401 while preserving the Issue error", async () => {
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    const fetchImpl = vi.fn<typeof fetch>(async () => json(
      { error: { code: "AUTH_REQUIRED", message: "Unlock required" } },
      401,
    ));
    try {
      await expect(fetchIssueDetail("repo", 7, fetchImpl)).rejects.toThrow(
        "GET issue #7 failed with HTTP 401",
      );
      expect(onAuthRequired).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    }
  });
});
