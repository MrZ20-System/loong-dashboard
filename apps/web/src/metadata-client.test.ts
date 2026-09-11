import { describe, expect, it, vi } from "vitest";
import {
  buildListUrl,
  fetchMergedPullRequests,
  fetchList,
  fetchRepositories,
  isValidDate,
  readDateRange,
  readMetadataFilters,
} from "./metadata-client";

describe("metadata client", () => {
  it("constructs encoded local list queries without hidden GitHub calls", () => {
    expect(buildListUrl("acme/project", "pulls", { from: "2026-09-03", to: "2026-09-10", status: "open", page: 2, limit: 100 })).toBe(
      "/api/repositories/acme%2Fproject/pulls?from=2026-09-03&to=2026-09-10&status=open&limit=100&page=2",
    );
  });

  it("never sends page parameters to the cursor-based Issues endpoint", () => {
    expect(buildListUrl("repo", "issues", { page: 4, limit: 100, cursor: "next" })).toBe(
      "/api/repositories/repo/issues?limit=100&cursor=next",
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-09-03")).toBe(true);
    expect(isValidDate("2026-9-3")).toBe(false);
  });

  it("uses the shared query/status schemas while ignoring invalid URL filters", () => {
    const params = new URLSearchParams("date=2026-02-29&status=unknown");
    expect(readMetadataFilters("pulls", params)).toEqual({ from: null, to: null, status: null, search: "", domains: [] });
    expect(readMetadataFilters("issues", new URLSearchParams("date=2026-09-03&status=closed"))).toEqual({ from: "2026-09-03", to: "2026-09-03", status: "closed", search: "", domains: [] });
    const domainParams = new URLSearchParams("from=2026-09-03&to=2026-09-10&domain=dom_a&domain=dom_b&domain=");
    expect(readMetadataFilters("pulls", domainParams)).toEqual({ from: "2026-09-03", to: "2026-09-10", status: null, search: "", domains: ["dom_a", "dom_b"] });
    expect(buildListUrl("repo", "pulls", { domains: ["dom_a", "dom_b"] })).toBe("/api/repositories/repo/pulls?domain=dom_a&domain=dom_b");
  });

  it("canonicalizes legacy date URLs and rejects reversed ranges", () => {
    expect(readDateRange(new URLSearchParams("date=2026-09-03"), { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-03", to: "2026-09-03" });
    expect(readDateRange(new URLSearchParams("from=2026-09-10&to=2026-09-03"), { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("passes AbortSignal through and reports malformed responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ items: [], page: 1, pageSize: 100, totalCount: 0, totalPages: 1, calendarTimeZone: "Asia/Shanghai" }), { status: 200 });
    });
    await expect(fetchList("repo", "issues", {}, new AbortController().signal, fetchImpl)).rejects.toThrow("invalid response");
  });

  it("accepts the final strict repository response fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [{ id: "repo", key: "repo", displayName: "Project", githubOwner: "acme", githubName: "project", localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true, mergedPullRequestCount: 0 }] }), { status: 200 }));
    await expect(fetchRepositories(undefined, fetchImpl)).resolves.toEqual({ items: [{ id: "repo", key: "repo", displayName: "Project", githubOwner: "acme", githubName: "project", localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true, mergedPullRequestCount: 0 }] });
  });

  it("requests the merged projection with page pagination", async () => {
    const item = {
      repositoryId: "repo",
      number: 7,
      title: "Merged change",
      url: "https://github.com/acme/project/pull/7",
      authorLogin: "author",
      status: "merged",
      updatedAt: "2026-09-10T00:00:00.000Z",
      mergedAt: "2026-09-09T00:00:00.000Z",
      changedFilesCount: 2,
      additions: 4,
      deletions: 1,
      domains: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/repositories/repo/merged");
      expect(url.searchParams.get("search")).toBe("merged");
      expect(url.searchParams.get("domain")).toBe("dom_a");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("page")).toBe("2");
      return new Response(JSON.stringify({ items: [item], page: 2, pageSize: 100, totalCount: 101, totalPages: 2, calendarTimeZone: "Asia/Shanghai" }), { status: 200 });
    });
    await expect(fetchMergedPullRequests("repo", { search: "merged", domains: ["dom_a"], page: 2, limit: 100 }, undefined, fetchImpl)).resolves.toMatchObject({ items: [item], page: 2, totalPages: 2 });
  });
});
