import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileEntry } from "@loongboard/contracts";
import {
  ContinuousChanges,
  diffAnchorId,
  resolveChangesDiffOptions,
  scrollToDiffFile,
  shouldExpandChangedFileByDefault,
  type DiffRenderContext,
} from "./ContinuousChanges";

function file(
  path: string,
  overrides: Partial<ChangedFileEntry> = {},
): ChangedFileEntry {
  return {
    path,
    previousPath: null,
    changeType: "modified",
    additions: 2,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

const files = [
  file("src/a.ts"),
  file("docs/guide.md", { changeType: "added", additions: 5, deletions: 0 }),
  file("blob.bin", {
    changeType: "added",
    additions: null,
    deletions: null,
    binary: true,
  }),
];

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly element: Element | null = null;
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    (this as { element: Element | null }).element = element;
  }

  disconnect(): void {}

  trigger(isIntersecting = true): void {
    this.callback(
      [{ isIntersecting, target: this.element } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let savedClipboard: PropertyDescriptor | undefined;

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeIntersectionObserver.instances.length = 0;
  if (savedClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", savedClipboard);
  }
  savedClipboard = undefined;
});

function contentDiv(path: string) {
  return <div data-testid={`content-${path}`}>content</div>;
}

describe("ContinuousChanges", () => {
  it("renders every changed file expanded in one anchored list by default", async () => {
    render(<ContinuousChanges files={files} />);

    for (const changedFile of files) {
      const anchor = document.getElementById(diffAnchorId(changedFile.path));
      expect(anchor).not.toBeNull();
      expect(anchor).toHaveAttribute("data-view-mode", "unified");
      expect(within(anchor as HTMLElement).getByText(changedFile.path)).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: `Collapse diff for ${changedFile.path}`,
        }),
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("button", { name: /Expand diff for / }),
    ).not.toBeInTheDocument();

    const first = document.getElementById(
      diffAnchorId(files[0].path),
    ) as HTMLElement;
    expect(within(first).getByText("+2")).toBeInTheDocument();
    expect(within(first).getByText("−1")).toBeInTheDocument();
    const binary = document.getElementById(
      diffAnchorId(files[2].path),
    ) as HTMLElement;
    expect(within(binary).getByText("binary")).toBeInTheDocument();
  });

  it("collapses deleted and high-change files by default", () => {
    const deleted = file("src/deleted.ts", {
      changeType: "removed",
      additions: 0,
      deletions: 8,
    });
    const large = file("src/large.ts", { additions: 401, deletions: 0 });
    const boundary = file("src/boundary.ts", { additions: 399, deletions: 1 });

    expect(shouldExpandChangedFileByDefault(deleted)).toBe(false);
    expect(shouldExpandChangedFileByDefault(large)).toBe(false);
    expect(shouldExpandChangedFileByDefault(boundary)).toBe(true);
    render(<ContinuousChanges files={[deleted, large, boundary]} />);

    expect(
      screen.getByRole("button", { name: "Expand diff for src/deleted.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand diff for src/large.ts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse diff for src/boundary.ts" }),
    ).toBeInTheDocument();
  });

  it("expands a collapsed card to mount deferred content and collapses again", async () => {
    const renderFileDiff = vi.fn((changedFile: ChangedFileEntry) =>
      contentDiv(changedFile.path),
    );
    render(
      <ContinuousChanges
        files={files}
        initialExpandedPaths={[]}
        renderFileDiff={renderFileDiff}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Expand diff for ${files[0].path}` }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", { name: `Expand diff for ${files[0].path}` }),
    );
    await waitFor(() =>
      expect(renderFileDiff).toHaveBeenCalledWith(
        files[0],
        expect.objectContaining<DiffRenderContext>({
          viewMode: "unified",
          fullFile: false,
        }),
      ),
    );
    expect(
      screen.getByTestId(`content-${files[0].path}`),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Collapse diff for ${files[0].path}`,
      }),
    );
    expect(
      screen.queryByTestId(`content-${files[0].path}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Expand diff for ${files[0].path}` }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("applies toolbar bulk expansion requests without breaking later card toggles", () => {
    const view = render(
      <ContinuousChanges
        files={files}
        initialExpandedPaths={[]}
        bulkExpansion={null}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Expand diff for / })).toHaveLength(
      files.length,
    );

    view.rerender(
      <ContinuousChanges
        files={files}
        initialExpandedPaths={[]}
        bulkExpansion={{ id: 1, expanded: true }}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Collapse diff for / })).toHaveLength(
      files.length,
    );

    view.rerender(
      <ContinuousChanges
        files={files}
        initialExpandedPaths={[]}
        bulkExpansion={{ id: 2, expanded: false }}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Expand diff for / })).toHaveLength(
      files.length,
    );
    fireEvent.click(screen.getByRole("button", { name: `Expand diff for ${files[0].path}` }));
    expect(screen.getByRole("button", { name: `Collapse diff for ${files[0].path}` })).toBeInTheDocument();
  });

  it("passes the typed view mode to every expanded card and remaps on change", () => {
    const renderFileDiff = vi.fn(
      (changedFile: ChangedFileEntry) => contentDiv(changedFile.path),
    );
    const view = render(
      <ContinuousChanges
        files={files}
        viewMode="split"
        renderFileDiff={renderFileDiff}
        initialExpandedPaths={[files[0].path]}
      />,
    );

    expect(renderFileDiff).toHaveBeenCalledWith(
      files[0],
      expect.objectContaining<DiffRenderContext>({
        viewMode: "split",
        fullFile: false,
      }),
    );
    expect(
      document.getElementById(diffAnchorId(files[1].path)),
    ).toHaveAttribute("data-view-mode", "split");
    expect(
      document.getElementById(`${diffAnchorId(files[0].path)}-body`),
    ).toHaveAttribute("data-view-mode", "split");

    view.rerender(
      <ContinuousChanges
        files={files}
        viewMode="unified"
        renderFileDiff={renderFileDiff}
        initialExpandedPaths={[files[0].path]}
      />,
    );
    expect(renderFileDiff).toHaveBeenLastCalledWith(
      files[0],
      expect.objectContaining<DiffRenderContext>({
        viewMode: "unified",
        fullFile: false,
      }),
    );
  });

  it("mounts content only when an expanded card becomes near the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const renderFileDiff = vi.fn(
      (changedFile: ChangedFileEntry) => contentDiv(changedFile.path),
    );
    render(
      <ContinuousChanges files={files} renderFileDiff={renderFileDiff} />,
    );

    await waitFor(() =>
      expect(FakeIntersectionObserver.instances).toHaveLength(files.length),
    );
    expect(renderFileDiff).not.toHaveBeenCalled();
    expect(screen.getAllByText("Preparing diff…")).toHaveLength(files.length);

    const first = FakeIntersectionObserver.instances.find(
      (instance) =>
        instance.element?.id === diffAnchorId(files[0].path),
    );
    expect(first).toBeDefined();
    act(() => first?.trigger(true));

    await waitFor(() =>
      expect(renderFileDiff).toHaveBeenCalledWith(
        files[0],
        expect.objectContaining<DiffRenderContext>({
          viewMode: "unified",
          fullFile: false,
        }),
      ),
    );
    expect(renderFileDiff).not.toHaveBeenCalledWith(files[1], expect.anything());
  });

  it("mounts the selected file immediately even before an observer fires", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const renderFileDiff = vi.fn(
      (changedFile: ChangedFileEntry) => contentDiv(changedFile.path),
    );
    render(
      <ContinuousChanges
        files={files}
        selectedPath={files[1].path}
        renderFileDiff={renderFileDiff}
      />,
    );

    await waitFor(() =>
      expect(renderFileDiff).toHaveBeenCalledWith(
        files[1],
        expect.objectContaining<DiffRenderContext>({
          viewMode: "unified",
          fullFile: false,
        }),
      ),
    );
    expect(
      screen.getByTestId(`content-${files[1].path}`),
    ).toBeInTheDocument();
    expect(renderFileDiff).not.toHaveBeenCalledWith(files[0], expect.anything());
  });

  it("copies the visible path through navigator.clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    render(<ContinuousChanges files={files} />);

    const anchor = document.getElementById(
      diffAnchorId(files[0].path),
    ) as HTMLElement;
    const copyButton = within(anchor).getByRole("button", {
      name: `Copy path for ${files[0].path}`,
    });
    expect(
      copyButton.querySelector(".codicon-copy"),
    ).not.toBeNull();
    const pathLabel = within(anchor).getByText(files[0].path);
    const stats = within(anchor).getByText("+2");
    expect(pathLabel.compareDocumentPosition(copyButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(copyButton.compareDocumentPosition(stats)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(
      copyButton,
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(files[0].path),
    );
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("keeps stable anchors and scrolls the exported helper to a card", () => {
    render(<ContinuousChanges files={files} />);
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      expect(scrollToDiffFile(files[0].path)).toBe(true);
      expect(scrollToDiffFile("missing.ts")).toBe(false);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(
          Element.prototype,
          "scrollIntoView",
          original,
        );
      }
    }
  });

  it("maps each view mode directly to DiffViewer options", () => {
    expect(resolveChangesDiffOptions("unified")).toEqual({
      fullFile: false,
      renderSideBySide: false,
    });
    expect(resolveChangesDiffOptions("split")).toEqual({
      fullFile: false,
      renderSideBySide: true,
    });
  });
});
