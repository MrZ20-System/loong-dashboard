import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "./App";
import { diffAnchorId } from "./components/pr/ContinuousChanges";

vi.mock("./diff-viewer", () => ({
  DiffViewer: ({
    fullFile,
    path,
    viewMode,
    autoHeight,
    fontSize,
  }: {
    fullFile: boolean;
    path: string;
    viewMode?: string;
    autoHeight?: boolean;
    fontSize?: number;
  }) => (
    <div
      data-testid="mock-diff"
      data-fullfile={fullFile ? "1" : "0"}
      data-path={path}
      data-viewmode={viewMode ?? "split"}
      data-autoheight={autoHeight ? "1" : "0"}
      data-fontsize={fontSize ?? 13}
    />
  ),
}));

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

const detail = {
  repositoryId: "repo",
  number: 5,
  title: "Add diff workspace",
  url: "https://github.com/acme/project/pull/5",
  authorLogin: "author",
  status: "open",
  updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 6,
  additions: 4,
  deletions: 1,
  domains: [{ id: "dom_ci", name: "CI", color: "#5b8def" }],
  createdAt: "2026-09-03T00:00:00.000Z",
  closedAt: null,
  mergedAt: null,
  baseRefName: "main",
  headRefName: "feature",
  headSha,
  detailBody: null,
};

const files = [
  { path: "src/a.ts", previousPath: null, changeType: "modified", additions: 3, deletions: 1, binary: false },
  { path: "src/new.ts", previousPath: null, changeType: "added", additions: 1, deletions: 0, binary: false },
  { path: "src/components/pr/badge.tsx", previousPath: null, changeType: "added", additions: 2, deletions: 0, binary: false },
  { path: "docs/guide.md", previousPath: null, changeType: "modified", additions: 1, deletions: 1, binary: false },
  { path: "docs/deleted.md", previousPath: null, changeType: "removed", additions: 0, deletions: 4, binary: false },
  { path: "data.bin", previousPath: null, changeType: "added", additions: null, deletions: null, binary: true },
];

const headFiles = [
  "README.md",
  "src/a.ts",
  "src/new.ts",
  "src/components/pr/badge.tsx",
  "docs/guide.md",
  "docs/README.md",
  "data.bin",
  "src/keep.ts",
];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let savedScrollIntoView: PropertyDescriptor | undefined;
let savedInnerWidth: PropertyDescriptor | undefined;

function stubInnerWidth(width: number) {
  savedInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function restoreInnerWidth() {
  if (savedInnerWidth === undefined) {
    Reflect.deleteProperty(window, "innerWidth");
  } else {
    Object.defineProperty(window, "innerWidth", savedInnerWidth);
  }
  savedInnerWidth = undefined;
}

function stubScrollIntoView() {
  savedScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}

function restoreScrollIntoView() {
  if (savedScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(Element.prototype, "scrollIntoView", savedScrollIntoView);
  }
  savedScrollIntoView = undefined;
}

class NoopIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
}

function mockApi(options: { prepare?: Promise<unknown> } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    if (url.pathname === "/api/auth/status") return json({ enabled: false, unlocked: true });
    if (url.pathname === "/api/repositories") return json({ items: [] });
    if (url.pathname.endsWith("/prepare")) {
      if (options.prepare !== undefined) await options.prepare;
      return json({
        repositoryId: "repo",
        number: 5,
        headSha,
        mergeBase: baseSha,
        fetched: false,
        files,
      });
    }
    if (url.pathname.endsWith("/pulls/5/tree")) {
      return json({
        repositoryId: "repo",
        number: 5,
        ref: headSha,
        files: headFiles,
      });
    }
    if (url.pathname.endsWith("/local-command")) {
      const command = [
        "git",
        "fetch",
        "origin pull/5/head:pr-5",
        "&&",
        "git",
        "switch",
        "pr-5",
      ].join(" ");
      return json({ command });
    }
    if (url.pathname.endsWith("/pulls/5")) return json(detail);
    const sessionScope = {
      kind: "pr",
      repositoryId: "repo",
      prNumber: 5,
      targetSha: headSha,
    };
    const sessionView = {
      session: {
        id: "sess_open",
        scope: sessionScope,
        workspacePath: "/tmp/pr-worktree",
        dshHomePath: "/tmp/dsh-home",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        status: "idle",
        dshSessionId: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        lastUsedAt: "2026-09-03T00:00:00.000Z",
      },
      targetRevision: headSha,
      workspaceRevision: headSha,
    };
    if (url.pathname === "/api/agent-sessions") {
      return json(
        (init?.method ?? "GET") === "POST" ? sessionView : { items: [] },
      );
    }
    const sessionMatch =
      /^\/api\/agent-sessions\/([^/]+)(?:\/(messages))?$/.exec(
        url.pathname,
      );
    if (sessionMatch !== null) {
      return json(sessionMatch[2] === "messages" ? { items: [] } : sessionView);
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path");
      const ref = url.searchParams.get("ref");
      if (path === "data.bin") {
        return json({
          path,
          ref,
          binary: true,
          tooLarge: false,
          sizeBytes: 8,
          content: null,
        });
      }
      return json({
        path,
        ref,
        binary: false,
        tooLarge: false,
        sizeBytes: 9,
        content: path === "src/keep.ts" ? "keep head" : "line one",
      });
    }
    return json(
      { error: { code: "INTERNAL_ERROR", message: "not found" } },
      404,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  return { fetchMock, calls };
}

function renderDetail(path = "/repositories/repo/pulls/5") {
  stubScrollIntoView();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function workbenchToolbar() {
  return screen.getByRole("group", { name: "Workbench controls" });
}

function diffSettings() {
  const summary = screen.getByLabelText("Diff settings");
  const details = summary.closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Diff settings menu is missing");
  }
  if (!details.open) fireEvent.click(summary);
  return within(details);
}

describe("PR detail workbench", () => {
  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreScrollIntoView();
    restoreInnerWidth();
  });

  it("renders resizable panels and a continuous expanded Changes document", async () => {
    const { calls } = mockApi();
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: /Add diff workspace/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open pull request #5 on GitHub" }),
    ).toHaveAttribute("href", "https://github.com/acme/project/pull/5");
    const toolbar = workbenchToolbar();
    expect(
      within(toolbar).getByRole("button", { name: "Collapse changed files" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole("button", { name: "Collapse PR chat" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByLabelText("Diff settings"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize Changed files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize PR chat" }),
    ).toBeInTheDocument();

    expect(screen.getByRole("tree", { name: "Changed files" })).toBeInTheDocument();
    for (const changedFile of files.filter(
      (file) => file.changeType !== "removed",
    )) {
      expect(
        screen.getByRole("button", {
          name: `Collapse diff for ${changedFile.path}`,
        }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", {
        name: "Expand diff for docs/deleted.md",
      }),
    ).toBeInTheDocument();

    // The selected file mounts immediately while every immutable text side is
    // warmed in the background for later scrolling.
    await waitFor(() =>
      expect(
        calls.some((call) => call.includes(`path=src%2Fa.ts&ref=${baseSha}`)),
      ).toBe(true),
    );
    expect(
      calls.some((call) => call.includes(`path=src%2Fa.ts&ref=${headSha}`)),
    ).toBe(true);
    await waitFor(() =>
      expect(
        calls.some((call) => call.includes(`path=docs%2Fguide.md&ref=`)),
      ).toBe(true),
    );
    expect(await screen.findByTestId("mock-diff")).toHaveAttribute(
      "data-path",
      "src/a.ts",
    );
    expect(screen.getByTestId("mock-diff")).toHaveAttribute(
      "data-autoheight",
      "1",
    );

    fireEvent.click(diffSettings().getByRole("button", { name: "Collapse all" }));
    expect(screen.getAllByRole("button", { name: /^Expand diff for / })).toHaveLength(
      files.length,
    );
    fireEvent.click(diffSettings().getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByRole("button", { name: /^Collapse diff for / })).toHaveLength(
      files.length,
    );
  });

  it("passes the Changes Split control through as split without narrow-width degradation", async () => {
    stubInnerWidth(665);
    const { calls } = mockApi();
    renderDetail();

    await screen.findByTestId("mock-diff");
    const settings = diffSettings();
    const changes = settings.getByRole("button", { name: "Changes" });
    expect(
      settings.getAllByRole("button").slice(-2).map((button) => button.textContent?.trim()),
    ).toEqual(["Changes", "Full File"]);
    expect(changes).toHaveAttribute("aria-pressed", "true");
    expect(
      settings.getByRole("button", { name: "Split" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      settings.getByRole("button", { name: "Unified" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-viewmode",
        "unified",
      ),
    );
    fireEvent.click(
      settings.getByRole("button", { name: "Split" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-viewmode",
        "split",
      ),
    );
    expect(
      settings.getByRole("button", { name: "Split" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(settings.getByRole("button", { name: "Full File" }));
    await waitFor(() =>
      expect(settings.getByRole("button", { name: "Full File" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(settings.getByRole("button", { name: "Unified" })).toBeDisabled();
    expect(settings.getByRole("button", { name: "Split" })).toBeDisabled();
    await waitFor(() =>
      expect(calls.some((call) => call.endsWith("/pulls/5/tree"))).toBe(true),
    );
    expect(
      await screen.findByRole("tree", { name: "Repository files" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-fullfile",
        "1",
      ),
    );
    expect(screen.getByTestId("mock-diff")).toHaveAttribute(
      "data-autoheight",
      "0",
    );
  });

  it("applies one code font size setting across Changes and Full File", async () => {
    mockApi();
    renderDetail();

    expect(await screen.findByTestId("mock-diff")).toHaveAttribute(
      "data-fontsize",
      "13",
    );
    const settings = diffSettings();
    expect(settings.getByLabelText("Code font size")).toHaveTextContent("13 px");

    fireEvent.click(
      settings.getByRole("button", { name: "Increase code font size" }),
    );
    expect(settings.getByLabelText("Code font size")).toHaveTextContent("14 px");
    expect(screen.getByTestId("mock-diff")).toHaveAttribute(
      "data-fontsize",
      "14",
    );

    fireEvent.click(settings.getByRole("button", { name: "Full File" }));
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-fullfile",
        "1",
      ),
    );
    expect(screen.getByTestId("mock-diff")).toHaveAttribute(
      "data-fontsize",
      "14",
    );
  });

  it("uses ChangedFilesTree in Changes mode and RepositoryTree in Full File mode", async () => {
    mockApi();
    renderDetail();

    expect(
      await screen.findByRole("tree", { name: "Changed files" }),
    ).toBeInTheDocument();
    const srcFolder = await screen.findByRole("button", { name: "src" });
    expect(srcFolder).not.toHaveAttribute("data-change-tone");

    fireEvent.click(diffSettings().getByRole("button", { name: "Full File" }));
    expect(
      await screen.findByRole("tree", { name: "Repository files" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tree", { name: "Changed files" }),
    ).not.toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "Deleted docs/deleted.md" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Deleted docs/deleted.md" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-path",
        "docs/deleted.md",
      ),
    );
    const keep = screen.getByRole("button", { name: "src/keep.ts" });
    expect(keep).not.toHaveAttribute("data-change-type");
  });

  it("renders a normal unchanged head file with one head fetch in Full File mode", async () => {
    const { calls } = mockApi();
    renderDetail();
    await screen.findByTestId("mock-diff");
    fireEvent.click(diffSettings().getByRole("button", { name: "Full File" }));

    const keep = await screen.findByRole("button", { name: "src/keep.ts" });
    fireEvent.click(keep);

    await waitFor(() =>
      expect(
        screen.getByTestId("mock-diff"),
      ).toHaveAttribute("data-path", "src/keep.ts"),
    );
    expect(
      calls.some((call) =>
        call.includes(`path=src%2Fkeep.ts&ref=${headSha}`),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.includes(`path=src%2Fkeep.ts&ref=${baseSha}`),
      ),
    ).toBe(false);
    expect(screen.getByTestId("mock-diff")).toHaveAttribute(
      "data-fullfile",
      "1",
    );
  });

  it("shows one file-panel control in the panel or persistent toolbar", async () => {
    mockApi();
    renderDetail();

    await screen.findByRole("heading", { name: /Add diff workspace/ });
    const toolbar = workbenchToolbar();
    const collapse = within(toolbar).getByRole("button", {
      name: "Collapse changed files",
    });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getAllByRole("button", { name: "Collapse changed files" }),
    ).toHaveLength(1);
    expect(document.querySelector(".pr-resize-panel--left")).not.toBeNull();

    fireEvent.click(collapse);
    const expand = await within(toolbar).findByRole("button", {
      name: "Expand changed files",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".pr-resize-panel--left")).toBeNull();
    expect(
      screen.queryByRole("tree", { name: "Changed files" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Expand changed files" }),
    ).toHaveLength(1);

    fireEvent.click(expand);
    expect(
      await screen.findByRole("tree", { name: "Changed files" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".pr-resize-panel--left")).not.toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Collapse changed files" }),
    ).toHaveLength(1);
  });

  it("shows one chat-panel control in the panel or persistent toolbar", async () => {
    mockApi();
    renderDetail();

    await screen.findByRole("heading", { name: /Add diff workspace/ });
    const toolbar = workbenchToolbar();
    const collapseChat = within(toolbar).getByRole("button", {
      name: "Collapse PR chat",
    });
    expect(
      screen.getAllByRole("button", { name: "Collapse PR chat" }),
    ).toHaveLength(1);
    await screen.findByRole("textbox", { name: "Message the agent" });

    fireEvent.click(collapseChat);
    const expandChat = await within(toolbar).findByRole("button", {
      name: "Expand PR chat",
    });
    expect(expandChat).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".pr-resize-panel--right")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Message the agent" }),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector(".agent-panel.collapsed"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Expand PR chat" }),
    ).toHaveLength(1);

    fireEvent.click(expandChat);
    expect(
      await screen.findByRole("textbox", { name: "Message the agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Collapse PR chat" }),
    ).toHaveLength(1);
  });

  it("keeps prepare-before-chat ordering", async () => {
    let releasePrepare = () => {};
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const { fetchMock } = mockApi({ prepare: prepareGate });
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: /Add diff workspace/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Preparing local Git objects…")).toBeInTheDocument();

    const agentSessionPosts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes("/api/agent-sessions") &&
          init?.method === "POST",
      ).length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(agentSessionPosts()).toBe(0);

    releasePrepare();
    await waitFor(() => expect(agentSessionPosts()).toBe(1));
    expect(
      await screen.findByRole("textbox", { name: "Message the agent" }),
    ).toBeInTheDocument();
  });

  it("scrolls to and selects the continuous card from changed-tree selection", async () => {
    mockApi();
    renderDetail();

    const tree = await screen.findByRole("tree", { name: "Changed files" });
    const guide = await within(tree).findByRole("button", {
      name: "Modified docs/guide.md",
    });
    fireEvent.click(guide);

    const card = document.getElementById(diffAnchorId("docs/guide.md"));
    expect(card).toHaveAttribute("aria-current", "true");
    const scrollIntoView = Element.prototype
      .scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({
      behavior: "smooth",
      block: "start",
    });
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-path",
        "docs/guide.md",
      ),
    );
  });

  it("keeps selection per mode when switching back", async () => {
    mockApi();
    renderDetail();

    const tree = await screen.findByRole("tree", { name: "Changed files" });
    fireEvent.click(
      await within(tree).findByRole("button", {
        name: "Added data.bin",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-path",
        "data.bin",
      ),
    );
    expect(await screen.findByText(/Binary file/)).toBeInTheDocument();

    fireEvent.click(diffSettings().getByRole("button", { name: "Full File" }));
    const repositoryTree = await screen.findByRole("tree", {
      name: "Repository files",
    });
    fireEvent.click(
      await within(repositoryTree).findByRole("button", {
        name: "Added src/new.ts",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mock-diff")).toHaveAttribute(
        "data-path",
        "src/new.ts",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    const dataBinCard = await waitFor(() => {
      const anchor = document.getElementById(diffAnchorId("data.bin"));
      expect(anchor).not.toBeNull();
      return anchor as HTMLElement;
    });
    expect(dataBinCard).toHaveAttribute("aria-current", "true");
  });

  it("keeps the PR route in the chrome-free full-screen focus shell", async () => {
    mockApi();
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: /Add diff workspace/ }),
    ).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeNull();
    expect(document.querySelector("#app-sidebar")).toBeNull();
    expect(document.querySelector(".app-footer")).toBeNull();
    expect(document.querySelector(".app-shell")).toHaveClass(
      "app-shell--pr-focus",
    );
    expect(document.querySelector(".main-canvas")).toHaveClass(
      "main-canvas--pr-focus",
    );
    expect(document.querySelector(".app-content")).toHaveClass(
      "app-content--pr-focus",
    );
  });
});
