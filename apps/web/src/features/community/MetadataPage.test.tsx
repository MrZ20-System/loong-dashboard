import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataPage } from "./MetadataPage";

const repository = {
  id: "repo",
  key: "repo",
  displayName: "Example",
  githubOwner: "acme",
  githubName: "project",
  localPath: "/tmp/project",
  remoteName: "origin",
  defaultBranch: "main",
  worktreeSlots: 1,
  enabled: true,
  mergedPullRequestCount: 0,
};

const pull = (number: number, updatedAt: string, title = `Pull ${number}`) => ({
  repositoryId: "repo",
  number,
  title,
  url: `https://github.com/acme/project/pull/${number}`,
  authorLogin: "author",
  status: "open" as const,
  updatedAt,
  changedFilesCount: 0,
  additions: 0,
  deletions: 0,
  domains: [],
});

function renderPage(path: string, kind: "pulls" | "issues" = "pulls") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes><Route path="/repositories/:repositoryId/:kind" element={<MetadataPage kind={kind} />} /></Routes>
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MetadataPage pull request views", () => {
  it("uses full-dataset search parameters, view sorting, and page navigation", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url);
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      const page = Number(url.searchParams.get("page") ?? "1");
      const search = url.searchParams.get("search");
      const items = page === 2 ? [pull(2, "2026-09-08T01:00:00.000Z")] : search ? [pull(3, "2026-09-09T01:00:00.000Z", "Search result")] : [pull(1, "2026-09-09T01:00:00.000Z"), pull(4, "2026-09-08T01:00:00.000Z")];
      return new Response(JSON.stringify({ items, page, pageSize: 100, totalCount: search ? 1 : 101, totalPages: search ? 1 : 2, calendarTimeZone: "Asia/Shanghai" }));
    }));
    renderPage("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 1")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PR number" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "PR number" }));
    await waitFor(() => expect(calls.some((url) => url.searchParams.get("sort") === "number")).toBe(true));
    const search = screen.getByRole("searchbox", { name: "Search list" });
    fireEvent.change(search, { target: { value: "Search result" } });
    await waitFor(() => expect(calls.some((url) => url.searchParams.get("search") === "Search result")).toBe(true));

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Go to page 2" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(await screen.findByText("Pull 2")).toBeInTheDocument();
    expect(screen.queryByText("Pull 1")).not.toBeInTheDocument();
    expect(screen.getByText(/Page 2/)).toBeInTheDocument();
  });

  it("keeps Pull Requests to the two current-state views", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      return new Response(JSON.stringify({ items: [pull(1, "2026-09-09T01:00:00.000Z")], page: 1, pageSize: 100, totalCount: 1, totalPages: 1, calendarTimeZone: "Asia/Shanghai" }));
    }));
    renderPage("/repositories/repo/pulls");
    expect(await screen.findByRole("button", { name: "Recently updated" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PR number" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Daily" })).not.toBeInTheDocument();
  });

  it("keeps Issues on cursor pagination without sending the PR page parameter", async () => {
    const calls: URL[] = [];
    const issue = { repositoryId: "repo", number: 7, title: "Issue 7", url: "https://github.com/acme/project/issues/7", authorLogin: "author", status: "open" as const, commentsCount: 0, updatedAt: "2026-09-09T01:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url);
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      const cursor = url.searchParams.get("cursor");
      return new Response(JSON.stringify({ items: [cursor ? { ...issue, number: 8, title: "Issue 8" } : issue], nextCursor: cursor ? null : "issue-page-2", calendarTimeZone: "Asia/Shanghai" }));
    }));
    renderPage("/repositories/repo/issues", "issues");
    expect(await screen.findByText("Issue 7")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("") );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Issue 8")).toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent("cursor=issue-page-2");
    const issueCalls = calls.filter((url) => url.pathname.endsWith("/issues"));
    expect(issueCalls[0].searchParams.has("page")).toBe(false);
    expect(issueCalls[1].searchParams.get("cursor")).toBe("issue-page-2");
  });

  it("canonicalizes a PR page beyond totalPages to the last legal page", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url);
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ items: [pull(page, "2026-09-09T01:00:00.000Z", `Pull page ${page}`)], page, pageSize: 100, totalCount: 101, totalPages: 2, calendarTimeZone: "Asia/Shanghai" }));
    }));
    renderPage("/repositories/repo/pulls?page=9");
    expect(await screen.findByText("Pull page 2")).toBeInTheDocument();
    expect(calls.some((url) => url.pathname.endsWith("/pulls") && url.searchParams.get("page") === "9")).toBe(true);
    expect(calls.some((url) => url.pathname.endsWith("/pulls") && url.searchParams.get("page") === "2")).toBe(true);
  });
});
