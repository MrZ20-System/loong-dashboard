import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "./App";

const repository = {
  id: "repo", key: "repo", displayName: "LoongBoard", githubOwner: "acme", githubName: "project",
  localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true, mergedPullRequestCount: 0,
};

const ciRule = { id: "dom_ci", repositoryId: "repo", name: "CI", color: "#5b8def", position: 0, enabled: true, includePatterns: [".github/**"], excludePatterns: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };
const docsRule = { id: "dom_docs", repositoryId: "repo", name: "Docs", color: "#2fbf71", position: 1, enabled: true, includePatterns: ["docs/**"], excludePatterns: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };

const pull = (number: number, domains: Array<{ id: string; name: string; color: string }>) => ({
  repositoryId: "repo", number, title: `Pull ${number}`, url: `https://github.com/acme/project/pull/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 1, additions: 2, deletions: 1, domains,
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { pulls?: unknown[]; domains?: unknown[]; reclassification?: { running: boolean; pendingCount: number | null } } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/status") return json({ enabled: false, unlocked: true });
    if (url.pathname === "/api/repositories") return json({ items: [repository] });
    if (url.pathname.endsWith("/domains")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; color: string; includePatterns: string[]; excludePatterns: string[]; enabled: boolean };
        return json({
          item: { id: "dom_new", repositoryId: "repo", position: 0, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z", ...body },
          reclassification: { running: true, pendingCount: 1 },
        });
      }
      return json({ items: options.domains ?? [], reclassification: options.reclassification ?? { running: false, pendingCount: null } });
    }
    if (url.pathname.endsWith("/pulls")) return json({ items: options.pulls ?? [], page: 1, pageSize: 100, totalCount: (options.pulls ?? []).length, totalPages: 1, calendarTimeZone: "Asia/Shanghai" });
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe("Stage 2 domain UI", () => {
  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("renders domain chips on PR rows and toggles repeated domain URL filters", async () => {
    const fetchMock = mockApi({
      pulls: [pull(2, [{ id: "dom_ci", name: "CI", color: "#5b8def" }]), pull(1, [])],
      domains: [ciRule, docsRule],
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 2")).toBeInTheDocument();
    expect(screen.getByText("CI")).toBeInTheDocument();
    const domainsFilter = await screen.findByRole("button", { name: /Domains All domains/ });
    fireEvent.click(domainsFilter);
    fireEvent.click(screen.getByRole("option", { name: /Docs/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("domain=dom_docs"))).toBe(true));
    expect(screen.getByRole("option", { name: /Docs/ })).toHaveAttribute("aria-selected", "true");
    // selecting two rules keeps both repeated params (ANY semantics)
    fireEvent.click(screen.getByRole("option", { name: /CI/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("domain=dom_ci&domain=dom_docs") || String(input).includes("domain=dom_docs&domain=dom_ci"))).toBe(true));
  });

  it("shows the reclassification hint only while a run is active", async () => {
    mockApi({ pulls: [pull(2, [])], domains: [ciRule], reclassification: { running: true, pendingCount: 3 } });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    expect(await screen.findByText("重新分类中…")).toBeInTheDocument();
  });

  it("creates a domain rule from the settings page", async () => {
    const fetchMock = mockApi({ domains: [] });
    renderApp("/settings/domains");
    expect(await screen.findByRole("heading", { name: "Domain rules" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Documentation")).toBeInTheDocument();
    expect(screen.getByLabelText("Include patterns")).toHaveAttribute(
      "placeholder",
      "docs/**\nREADME.md",
    );
    expect(screen.getByLabelText("Exclude patterns")).toHaveAttribute(
      "placeholder",
      "docs/generated/**\n**/*.snap",
    );
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "CI" } });
    fireEvent.change(screen.getByLabelText("Include patterns"), { target: { value: ".github/**\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/domains") && init?.method === "POST");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "CI", color: expect.any(String), includePatterns: [".github/**"], excludePatterns: [], enabled: true });
    });
    expect(await screen.findByText("Rule created.")).toBeInTheDocument();
  });
});
