import { describe, expect, it, vi } from "vitest";
import {
  buildListUrl,
  fetchList,
  fetchRepositories,
  isValidDate,
  readDateRange,
  readMetadataFilters,
} from "./metadata-client";

describe("metadata client", () => {
  it("constructs encoded local list queries without hidden GitHub calls", () => {
    expect(buildListUrl("acme/project", "pulls", { from: "2026-09-03", to: "2026-09-10", status: "open", cursor: "opaque+cursor" })).toBe(
      "/api/repositories/acme%2Fproject/pulls?from=2026-09-03&to=2026-09-10&status=open&cursor=opaque%2Bcursor",
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-09-03")).toBe(true);
    expect(isValidDate("2026-9-3")).toBe(false);
  });

  it("uses the shared query/status schemas while ignoring invalid URL filters", () => {
    const params = new URLSearchParams("date=2026-02-29&status=unknown");
    expect(readMetadataFilters("pulls", params)).toEqual({ from: null, to: null, status: null, domains: [] });
    expect(readMetadataFilters("issues", new URLSearchParams("date=2026-09-03&status=closed"))).toEqual({ from: "2026-09-03", to: "2026-09-03", status: "closed", domains: [] });
    const domainParams = new URLSearchParams("from=2026-09-03&to=2026-09-10&domain=dom_a&domain=dom_b&domain=");
    expect(readMetadataFilters("pulls", domainParams)).toEqual({ from: "2026-09-03", to: "2026-09-10", status: null, domains: ["dom_a", "dom_b"] });
    expect(buildListUrl("repo", "pulls", { domains: ["dom_a", "dom_b"] })).toBe("/api/repositories/repo/pulls?domain=dom_a&domain=dom_b");
  });

  it("canonicalizes legacy date URLs and rejects reversed ranges", () => {
    expect(readDateRange(new URLSearchParams("date=2026-09-03"), { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-03", to: "2026-09-03" });
    expect(readDateRange(new URLSearchParams("from=2026-09-10&to=2026-09-03"), { from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-09-01", to: "2026-09-30" });
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
