import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMergedDay, mergedCalendarDay, MergedPage } from "./MergedPage";
import { formatDate } from "../../i18n";

const repository = { id: "repo", key: "repo", displayName: "Example", githubOwner: "acme", githubName: "project", localPath: "/tmp/project", remoteName: "origin", defaultBranch: "main", worktreeSlots: 1, enabled: true, mergedPullRequestCount: 4 };
const merged = (number: number, mergedAt: string, title = `Merged ${number}`) => ({ repositoryId: "repo", number, title, url: `https://github.com/acme/project/pull/${number}`, authorLogin: "author", status: "merged" as const, updatedAt: "2026-09-12T00:00:00.000Z", mergedAt, changedFilesCount: 2, additions: 10, deletions: 3, domains: [] });

afterEach(() => vi.unstubAllGlobals());

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

describe("MergedPage", () => {
  it("preserves invalid mergedAt values and localizes valid day headings", () => {
    expect(mergedCalendarDay("not-a-date", "Asia/Shanghai")).toBe("not-a-date");
    expect(
      formatMergedDay(
        "not-a-date",
        (value, options, timeZone) => formatDate("en", value, options, timeZone),
        "Asia/Shanghai",
      ),
    ).toBe("not-a-date");
    expect(
      formatMergedDay(
        "2026-09-10",
        (value, options, timeZone) => formatDate("en", value, options, timeZone),
        "Asia/Shanghai",
      ),
    ).toBe("Sep 10, 2026");
    expect(
      formatMergedDay(
        "2026-09-10",
        (value, options, timeZone) => formatDate("zh-CN", value, options, timeZone),
        "Asia/Shanghai",
      ),
    ).toBe("2026年9月10日");
  });

  it("groups current-page mergedAt values by configured timezone and uses page pagination", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url);
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      if (url.pathname.endsWith("/merged")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return new Response(JSON.stringify({ items: page === 1 ? [merged(5, "2026-09-10T08:00:00.000Z"), merged(4, "2026-09-10T01:00:00.000Z")] : [merged(3, "2026-09-10T00:30:00.000Z"), merged(2, "2026-09-09T08:00:00.000Z")], page, pageSize: 100, totalCount: 4, totalPages: 2, calendarTimeZone: "Asia/Shanghai" }));
      }
      return new Response(JSON.stringify({ items: [], page: 1, pageSize: 100, totalCount: 0, totalPages: 1, calendarTimeZone: "Asia/Shanghai" }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter initialEntries={["/repositories/repo/merged?page=1"]}><QueryClientProvider client={client}><Routes><Route path="/repositories/:repositoryId/merged" element={<MergedPage />} /></Routes><LocationProbe /></QueryClientProvider></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Merged" })).toBeInTheDocument();
    expect(await screen.findByText("Merged 5")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Merged on Sep 10, 2026" })).toBeInTheDocument();
    expect(document.querySelectorAll(".merged-row__icon")).toHaveLength(2);
    expect(screen.queryByText("✓")).not.toBeInTheDocument();
    expect(document.querySelector(".codicon-git-merge")).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent("page=1"));
    expect(screen.getByRole("button", { name: "Go to page 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to page 2" }));
    await waitFor(() => expect(screen.getByText("Merged 2")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Merged on Sep 9, 2026" })).toBeInTheDocument();
    expect(screen.queryByText("Merged 5")).not.toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent("page=2");
    expect(calls.some((url) => url.pathname.endsWith("/merged") && url.searchParams.get("page") === "2" && url.searchParams.get("limit") === "100")).toBe(true);
  });

  it("redirects an out-of-range URL page to the last merged page", async () => {
    const calls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(url);
      if (url.pathname === "/api/repositories") return new Response(JSON.stringify({ items: [repository] }));
      if (url.pathname.endsWith("/domains")) return new Response(JSON.stringify({ items: [], reclassification: { running: false, pendingCount: null } }));
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ items: [merged(page, "2026-09-09T08:00:00.000Z", `Merged page ${page}`)], page, pageSize: 100, totalCount: 101, totalPages: 2, calendarTimeZone: "Asia/Shanghai" }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter initialEntries={["/repositories/repo/merged?page=8"]}><QueryClientProvider client={client}><Routes><Route path="/repositories/:repositoryId/merged" element={<MergedPage />} /></Routes></QueryClientProvider></MemoryRouter>);
    expect(await screen.findByText("Merged page 2")).toBeInTheDocument();
    expect(calls.some((url) => url.pathname.endsWith("/merged") && url.searchParams.get("page") === "8")).toBe(true);
    expect(calls.some((url) => url.pathname.endsWith("/merged") && url.searchParams.get("page") === "2")).toBe(true);
  });
});
