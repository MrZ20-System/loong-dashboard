import { describe, expect, it, vi } from "vitest";
import {
  buildListUrl,
  fetchList,
  fetchRepositories,
  isValidDate,
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

  it("passes AbortSignal through and reports malformed responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    await expect(fetchList("repo", "issues", {}, new AbortController().signal, fetchImpl)).rejects.toThrow("invalid response");
  });

  it("normalizes configured repository display fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [{ id: "repo", displayName: "Project", githubOwner: "acme", githubName: "project" }] }), { status: 200 }));
    await expect(fetchRepositories(undefined, fetchImpl)).resolves.toEqual({ items: [{ id: "repo", key: undefined, name: "Project", github: "acme/project", defaultBranch: undefined, enabled: undefined }] });
  });
});
