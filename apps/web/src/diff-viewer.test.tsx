import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffViewerProps } from "./diff-viewer";

interface FakeModel {
  value: string;
  language: string;
  dispose: ReturnType<typeof vi.fn>;
}

interface EditorMocks {
  createDiffEditor: ReturnType<typeof vi.fn>;
  createModel: ReturnType<typeof vi.fn>;
  updateOptions: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  disposeEditor: ReturnType<typeof vi.fn>;
  layout: ReturnType<typeof vi.fn>;
  onDidUpdateDiff: ReturnType<typeof vi.fn>;
  getOriginalEditor: ReturnType<typeof vi.fn>;
  getModifiedEditor: ReturnType<typeof vi.fn>;
}

function makeEditorMocks(): EditorMocks {
  const mocks: EditorMocks = {
    createDiffEditor: vi.fn(),
    createModel: vi.fn(),
    updateOptions: vi.fn(),
    setModel: vi.fn(),
    getModel: vi.fn(),
    disposeEditor: vi.fn(),
    layout: vi.fn(),
    onDidUpdateDiff: vi.fn(),
    getOriginalEditor: vi.fn(),
    getModifiedEditor: vi.fn(),
  };

  let pair: { original: FakeModel; modified: FakeModel } | null = null;
  mocks.createModel.mockImplementation((value: string, language: string) => {
    const model: FakeModel = { value, language, dispose: vi.fn() };
    return model;
  });
  mocks.setModel.mockImplementation(
    (next: { original: FakeModel; modified: FakeModel }) => {
      pair = next;
    },
  );
  mocks.getModel.mockImplementation(() => pair);
  const disposable = { dispose: vi.fn() };
  const originalEditor = {
    getContentHeight: vi.fn(() => 120),
    onDidContentSizeChange: vi.fn(() => disposable),
  };
  const modifiedEditor = {
    getContentHeight: vi.fn(() => 160),
    onDidContentSizeChange: vi.fn(() => disposable),
  };
  mocks.getOriginalEditor.mockReturnValue(originalEditor);
  mocks.getModifiedEditor.mockReturnValue(modifiedEditor);
  mocks.onDidUpdateDiff.mockReturnValue(disposable);
  mocks.createDiffEditor.mockReturnValue({
    setModel: mocks.setModel,
    updateOptions: mocks.updateOptions,
    dispose: mocks.disposeEditor,
    getModel: mocks.getModel,
    layout: mocks.layout,
    onDidUpdateDiff: mocks.onDidUpdateDiff,
    getOriginalEditor: mocks.getOriginalEditor,
    getModifiedEditor: mocks.getModifiedEditor,
  });
  return mocks;
}

function contentCalls(mocks: EditorMocks): Array<[string, string]> {
  return mocks.createModel.mock.calls.filter(
    (call): call is [string, string] =>
      typeof call[0] === "string" && (call[0] as string).length > 0,
  );
}

function baseProps(): DiffViewerProps {
  return {
    original: "",
    modified: "",
    path: "src/a.ts",
    fullFile: false,
  };
}

function loadDiffViewer(
  factory: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<typeof import("./diff-viewer")> {
  vi.resetModules();
  vi.doMock("monaco-editor", factory);
  vi.doMock(
    "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js",
    () => ({}),
  );
  return import("./diff-viewer");
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unmock("monaco-editor");
  vi.unmock(
    "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js",
  );
  vi.restoreAllMocks();
});

describe("DiffViewer Monaco lazy-load race", () => {
  it("applies the props committed before the editor finishes loading", async () => {
    const mocks = makeEditorMocks();
    let releaseEditorLoad = () => {};
    const editorLoad = new Promise<void>((resolve) => {
      releaseEditorLoad = resolve;
    });
    const { DiffViewer } = await loadDiffViewer(async () => {
      await editorLoad;
      return { editor: mocks };
    });

    const view = render(<DiffViewer {...baseProps()} />);
    // Let the mount effect reach the pending Monaco import, then deliver the
    // real file content while editor creation is still blocked.
    await act(async () => {});
    view.rerender(
      <DiffViewer
        original="const base = 1;"
        modified="const head = 2;"
        path="src/a.ts"
        fullFile={false}
      />,
    );
    expect(mocks.createDiffEditor).not.toHaveBeenCalled();

    await act(async () => {
      releaseEditorLoad();
    });
    await waitFor(() =>
      expect(contentCalls(mocks)).toEqual([
        ["const base = 1;", "typescript"],
        ["const head = 2;", "typescript"],
      ]),
    );
  });

  it("does not create an editor after unmount while lazy loading", async () => {
    const mocks = makeEditorMocks();
    let releaseEditorLoad = () => {};
    const editorLoad = new Promise<void>((resolve) => {
      releaseEditorLoad = resolve;
    });
    const { DiffViewer } = await loadDiffViewer(async () => {
      await editorLoad;
      return { editor: mocks };
    });

    const view = render(<DiffViewer {...baseProps()} />);
    await act(async () => {});
    view.unmount();
    await act(async () => {
      releaseEditorLoad();
    });

    expect(mocks.createDiffEditor).not.toHaveBeenCalled();
    expect(mocks.disposeEditor).not.toHaveBeenCalled();
  });

  it("keeps applying later content, path, and full-file updates after creation", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    const view = render(<DiffViewer {...baseProps()} />);
    await waitFor(() => expect(mocks.createDiffEditor).toHaveBeenCalledTimes(1));
    expect(mocks.createDiffEditor.mock.calls[0]?.[1]).toMatchObject({
      readOnly: true,
      domReadOnly: true,
      editContext: false,
      contextmenu: false,
      links: false,
      occurrencesHighlight: "off",
      selectionHighlight: false,
      renderLineHighlight: "none",
      hover: { enabled: "off" },
      minimap: { enabled: false },
      scrollbar: {
        verticalScrollbarSize: 8,
      },
    });

    view.rerender(
      <DiffViewer
        original="print('base')"
        modified="print('head')"
        path="src/app.py"
        fullFile
      />,
    );
    await waitFor(() =>
      expect(contentCalls(mocks)).toContainEqual(["print('head')", "python"]),
    );
    await waitFor(() =>
      expect(mocks.updateOptions).toHaveBeenCalledWith({
        fontSize: 13,
        renderSideBySide: false,
        hideUnchangedRegions: {
          enabled: false,
          contextLineCount: 5,
          minimumLineCount: 8,
          revealLineCount: 20,
        },
      }),
    );

    const pythonModels = mocks.createModel.mock.results
      .map((result) => result.value as FakeModel)
      .filter((model) => model.value === "print('base')" || model.value === "print('head')");
    expect(pythonModels.length).toBe(2);

    view.rerender(
      <DiffViewer
        original="const otherBase = 1;"
        modified="const otherHead = 2;"
        path="src/other.ts"
        fullFile={false}
      />,
    );
    await waitFor(() =>
      expect(contentCalls(mocks)).toContainEqual([
        "const otherHead = 2;",
        "typescript",
      ]),
    );
    await waitFor(() =>
      expect(mocks.updateOptions).toHaveBeenCalledWith({
        fontSize: 13,
        renderSideBySide: true,
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 5,
          minimumLineCount: 8,
          revealLineCount: 20,
        },
      }),
    );
    expect(
      pythonModels.every((model) => model.dispose.mock.calls.length === 1),
    ).toBe(true);
  });

  it("disables the wide diff overview ruler and minimap while keeping an 8px scrollbar", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    render(<DiffViewer {...baseProps()} />);
    await waitFor(() => expect(mocks.createDiffEditor).toHaveBeenCalledTimes(1));
    expect(mocks.createDiffEditor.mock.calls[0]?.[1]).toMatchObject({
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      renderIndicators: true,
      scrollbar: {
        verticalScrollbarSize: 8,
      },
    });
  });

  it("updates code font size without replacing the current models", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    const view = render(<DiffViewer {...baseProps()} fontSize={13} />);
    await waitFor(() => expect(mocks.createDiffEditor).toHaveBeenCalledTimes(1));
    expect(mocks.createDiffEditor.mock.calls[0]?.[1]).toMatchObject({
      fontSize: 13,
    });
    const modelCount = mocks.createModel.mock.calls.length;
    mocks.updateOptions.mockClear();

    view.rerender(<DiffViewer {...baseProps()} fontSize={15} />);

    await waitFor(() =>
      expect(mocks.updateOptions).toHaveBeenCalledWith({ fontSize: 15 }),
    );
    expect(mocks.createModel).toHaveBeenCalledTimes(modelCount);
  });

  it("fits an auto-height host and disables Monaco vertical scrolling", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    const view = render(<DiffViewer {...baseProps()} autoHeight />);
    await waitFor(() => expect(mocks.createDiffEditor).toHaveBeenCalledTimes(1));
    expect(mocks.createDiffEditor.mock.calls[0]?.[1]).toMatchObject({
      automaticLayout: false,
      scrollbar: {
        verticalScrollbarSize: 0,
        vertical: "hidden",
        handleMouseWheel: false,
        alwaysConsumeMouseWheel: false,
      },
    });
    const host = view.container.querySelector(".diff-viewer");
    expect(host).toHaveClass("diff-viewer--auto-height");
    await waitFor(() =>
      expect(mocks.layout).toHaveBeenCalledWith(
        expect.objectContaining({ height: 162 }),
        true,
      ),
    );
    expect(host).toHaveStyle({ height: "162px" });
    expect(mocks.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollbar: expect.objectContaining({
          handleMouseWheel: false,
          vertical: "hidden",
          verticalScrollbarSize: 0,
        }),
      }),
    );
  });

  it("remesures auto-height after later content updates", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    const view = render(<DiffViewer {...baseProps()} autoHeight />);
    await waitFor(() =>
      expect(mocks.layout).toHaveBeenCalledWith(
        expect.objectContaining({ height: 162 }),
        true,
      ),
    );

    const modifiedEditor = mocks.getModifiedEditor.mock.results[0]
      ?.value as {
      getContentHeight: ReturnType<typeof vi.fn>;
    };
    modifiedEditor.getContentHeight.mockReturnValue(300);
    view.rerender(
      <DiffViewer
        original="const base = 1;"
        modified="const head = 1;\nconst extra = 2;"
        path="src/a.ts"
        fullFile={false}
        autoHeight
      />,
    );
    await waitFor(() =>
      expect(mocks.layout).toHaveBeenLastCalledWith(
        expect.objectContaining({ height: 302 }),
        true,
      ),
    );
    expect(view.container.querySelector(".diff-viewer")).toHaveStyle({
      height: "302px",
    });
  });

  it("keeps Monaco's internal scroll mode when autoHeight is omitted", async () => {
    const mocks = makeEditorMocks();
    const { DiffViewer } = await loadDiffViewer(() => ({ editor: mocks }));

    const view = render(<DiffViewer {...baseProps()} />);
    await waitFor(() => expect(mocks.createDiffEditor).toHaveBeenCalledTimes(1));
    expect(mocks.createDiffEditor.mock.calls[0]?.[1]).toMatchObject({
      automaticLayout: true,
      scrollbar: {
        verticalScrollbarSize: 8,
      },
    });
    expect(view.container.querySelector(".diff-viewer")).not.toHaveClass(
      "diff-viewer--auto-height",
    );
  });

  it("maps Changes layout mode directly", async () => {
    const mod = await loadDiffViewer(() => ({ editor: makeEditorMocks() }));
    expect(mod.shouldRenderSideBySide(false, "split")).toBe(true);
    expect(mod.shouldRenderSideBySide(false, "unified")).toBe(false);
    expect(mod.shouldRenderSideBySide(false)).toBe(true);
    // Full File ignores the mode override and always stays inline.
    expect(mod.shouldRenderSideBySide(true, "split")).toBe(false);
  });
});
