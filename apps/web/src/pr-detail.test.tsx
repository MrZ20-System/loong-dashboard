import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "./App";

vi.mock("./diff-viewer", () => ({
  DiffViewer: ({ fullFile, path }: { fullFile: boolean; path: string }) =>
    <div data-testid="mock-diff" data-fullfile={fullFile ? "1" : "0"} data-path={path} />,
}));

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

const detail = {
  repositoryId: "repo", number: 5, title: "Add diff workspace", url: "https://github.com/acme/project/pull/5",
  authorLogin: "author", status: "open", updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 2, additions: 4, deletions: 1,
  domains: [{ id: "dom_ci", name: "CI", color: "#5b8def" }],
  createdAt: "2026-09-03T00:00:00.000Z", closedAt: null, mergedAt: null,
  baseRefName: "main", headRefName: "feature", headSha, detailBody: null,
};

const files = [
  { path: "src/a.ts", previousPath: null, changeType: "modified", additions: 3, deletions: 1, binary: false },
  { path: "src/new.ts", previousPath: null, changeType: "added", additions: 1, deletions: 0, binary: false },
  { path: "data.bin", previousPath: null, changeType: "added", additions: null, deletions: null, binary: true },
];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi() {
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    if (url.pathname === "/api/repositories") return json({ items: [] });
    if (url.pathname.endsWith("/prepare")) {
      return json({ repositoryId: "repo", number: 5, headSha, mergeBase: baseSha, fetched: false, files });
    }
    if (url.pathname.endsWith("/local-command")) {
      const command = ["git", "fetch", "origin pull/5/head:pr-5", "&&", "git", "switch", "pr-5"].join(" ");
      return json({ command });
    }
    if (url.pathname.endsWith("/pulls/5")) return json(detail);
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      const ref = url.searchParams.get("ref");
      if (path === "data.bin") return json({ path, ref, binary: true, tooLarge: false, sizeBytes: 8, content: null });
      return json({ path, ref, binary: false, tooLarge: false, sizeBytes: 5, content: "line one" });
    }
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function renderDetail(path = "/repositories/repo/pulls/5") {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe("Stage 3 PR detail page", () => {
  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("renders the PR header, changed file tree, and the first file diff", async () => {
    const { calls } = mockApi();
    renderDetail();
    expect(await screen.findByRole("heading", { name: "Add diff workspace" })).toBeInTheDocument();
    expect(screen.getByText("by author · open · updated 2026-09-03T02:03:04.000Z · main ← feature")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    // first file auto-selected: base and head contents fetched
    await waitFor(() => expect(calls.some((call) => call.includes(`path=src%2Fa.ts&ref=${baseSha}`))).toBe(true));
    expect(calls.some((call) => call.includes(`path=src%2Fa.ts&ref=${headSha}`))).toBe(true);
    expect(await screen.findByTestId("mock-diff")).toHaveAttribute("data-path", "src/a.ts");
  });

  it("switches between Changes and Full File view modes", async () => {
    mockApi();
    renderDetail();
    const changes = await screen.findByRole("button", { name: "Changes" });
    expect(changes).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Full File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Full File" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("mock-diff")).toHaveAttribute("data-fullfile", "1");
  });

  it("flags binary files instead of showing an editable diff", async () => {
    mockApi();
    renderDetail();
    await screen.findByRole("heading", { name: "Add diff workspace" });
    fireEvent.click(screen.getByRole("button", { name: /data.bin/ }));
    expect(await screen.findByText(/Binary file/)).toBeInTheDocument();
  });
});
