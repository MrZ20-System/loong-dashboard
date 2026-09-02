import { describe, expect, it, vi } from "vitest";
import {
  buildListUrl,
  fetchList,
  fetchRepositories,
  isValidDate,
  readMetadataFilters,
} from "./metadata-client";

describe("metadata client", () => {
  it("constructs encoded local list queries without hidden GitHub calls", () => {
    expect(buildListUrl("acme/project", "pulls", { date: "2026-09-03", status: "open", cursor: "opaque+cursor" })).toBe(
      "/api/repositories/acme%2Fproject/pulls?date=2026-09-03&status=open&cursor=opaque%2Bcursor",
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-09-03")).toBe(true);
    expect(isValidDate("2026-9-3")).toBe(false);
  });

  it("uses the shared query/status schemas while ignoring invalid URL filters", () => {
    const params = new URLSearchParams("date=2026-02-29&status=unknown");
    expect(readMetadataFilters("pulls", params)).toEqual({ date: null, status: null });
    expect(readMetadataFilters("issues", new URLSearchParams("date=2026-09-03&status=closed"))).toEqual({ date: "2026-09-03", status: "closed" });
  });

  it("passes AbortSignal through and reports malformed responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    await expect(fetchList("repo", "issues", {}, new AbortController().signal, fetchImpl)).rejects.toThrow("invalid response");
  });

  it("accepts the final strict repository response fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [{ id: "repo", key: "repo", displayName: "Project", githubOwner: "acme", githubName: "project", localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true }] }), { status: 200 }));
    await expect(fetchRepositories(undefined, fetchImpl)).resolves.toEqual({ items: [{ id: "repo", key: "repo", displayName: "Project", githubOwner: "acme", githubName: "project", localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true }] });
  });
});
