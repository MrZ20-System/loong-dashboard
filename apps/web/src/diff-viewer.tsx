import { useContext, useEffect, useRef } from "react";
import EditorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import type { editor } from "monaco-editor";
import { AppThemeContext, type AppTheme } from "./knowledge-editor";

/**
 * One shared Monaco diff editor for both view modes. Changes
 * mode enables `hideUnchangedRegions`; Full File mode disables it. The
 * editor and worker load lazily after mount so the component never blocks
 * first paint and stays a no-op under jsdom tests. Changes mode renders
 * side-by-side whenever Split is selected; Full File mode always renders
 * inline so identical base/head content reads as a normal file.
 *
 * Note on module paths: monaco-editor 0.56 exports only the package root
 * ("./esm/vs/index.js") and maps every subpath through its own exports map,
 * which makes `monaco-editor/esm/vs/...` bare specifiers unresolvable by
 * bundlers. We therefore import the ESM files by explicit relative paths,
 * which bypasses the exports map.
 */
export type DiffViewerMode = "unified" | "split";

export interface DiffViewerProps {
  readonly original: string;
  readonly modified: string;
  readonly path: string;
  readonly fullFile: boolean;
  /**
   * Changes-mode layout override. Split requests side-by-side regardless of
   * pane width; Unified always renders inline. Full File ignores this setting
   * and always renders inline.
   */
  readonly viewMode?: DiffViewerMode;
  /**
   * Continuous-document mode: the host is resized to Monaco's rendered diff
   * content height, the vertical scrollbar is hidden, and vertical wheel/touch
   * scrolling stays with the outer .pr-diff-main scroller. Full File keeps
   * its own internal file scroll and never uses this mode.
   */
  readonly autoHeight?: boolean;
  /** Shared code font size selected from the PR workbench settings. */
  readonly fontSize?: number;
}

const DEFAULT_FONT_SIZE = 13;

export function shouldRenderSideBySide(
  fullFile: boolean,
  viewMode: DiffViewerMode = "split",
): boolean {
  return !fullFile && viewMode === "split";
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go",
  h: "cpp", hpp: "cpp", html: "html", htm: "html", java: "java", js: "javascript",
  jsx: "javascript", json: "json", md: "markdown", mjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", sh: "shell", sql: "sql",
  ts: "typescript", tsx: "typescript", vue: "html", xml: "xml", yaml: "yaml", yml: "yaml",
};

function languageForPath(path: string): string {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? path;
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

const DIFF_THEME_LIGHT = "loongboard-github-diff-light";
const DIFF_THEME_DARK = "loongboard-github-diff-dark";

function diffTheme(theme: AppTheme): string {
  return theme === "dark" ? DIFF_THEME_DARK : DIFF_THEME_LIGHT;
}

function registerDiffThemes(editorApi: typeof import("monaco-editor").editor): void {
  if (typeof editorApi.defineTheme !== "function") return;
  editorApi.defineTheme(DIFF_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "diffEditor.insertedLineBackground": "#e6ffec",
      "diffEditor.removedLineBackground": "#ffebe9",
      "diffEditor.insertedTextBackground": "#abf2bc80",
      "diffEditor.removedTextBackground": "#ff818266",
      "diffEditorGutter.insertedLineBackground": "#ccffd8",
      "diffEditorGutter.removedLineBackground": "#ffd7d5",
    },
  });
  editorApi.defineTheme(DIFF_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "diffEditor.insertedLineBackground": "#12261e",
      "diffEditor.removedLineBackground": "#2d1618",
      "diffEditor.insertedTextBackground": "#2ea04366",
      "diffEditor.removedTextBackground": "#f8514966",
      "diffEditorGutter.insertedLineBackground": "#1b4721",
      "diffEditorGutter.removedLineBackground": "#5a1e22",
    },
  });
}

function resolveSelfWorker(): void {
  const globalScope = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
  };
  globalScope.MonacoEnvironment ??= {
    getWorker: (_moduleId: string, _label: string) => new EditorWorker(),
  };
}

/** Registers the bundled basic languages once (monaco 0.56 single file). */
async function registerBasicLanguages(): Promise<void> {
  // monaco-editor 0.56 declares no types for its contribution side-effect
  // module; the import path is widened so TypeScript skips module typings.
  await (import(
    "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js" as string
  ) as Promise<unknown>);
}

export function DiffViewer(props: DiffViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const theme = useContext(AppThemeContext);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const outerScrollTopRef = useRef<number | null>(null);
  const autoHeightRef = useRef(props.autoHeight ?? false);
  autoHeightRef.current = props.autoHeight ?? false;
  const fullFileRef = useRef(props.fullFile);
  fullFileRef.current = props.fullFile;
  const viewModeRef = useRef<DiffViewerMode>(props.viewMode ?? "split");
  viewModeRef.current = props.viewMode ?? "split";
  const measuredWidthRef = useRef<number | null>(null);
  const autoHeightCleanupRef = useRef<Array<() => void>>([]);
  // Latest props captured at commit time. Monaco may finish lazy-loading after
  // several prop updates; editor creation must apply what the component shows
  // now, not the props captured by the mount effect's first render.
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;

  // Create the editor once. Monaco is imported lazily so jsdom test
  // environments never execute its worker setup.
  useEffect(() => {
    let disposed = false;
    async function createEditor(): Promise<void> {
      resolveSelfWorker();
      const monaco = await import("monaco-editor");
      await registerBasicLanguages();
      if (disposed || hostRef.current === null) return;
      registerDiffThemes(monaco.editor);
      const created = monaco.editor.createDiffEditor(hostRef.current, {
        readOnly: true,
        domReadOnly: true,
        editContext: false,
        theme: diffTheme(themeRef.current),
        automaticLayout: !autoHeightRef.current,
        scrollBeyondLastLine: false,
        renderSideBySide: shouldRenderSideBySide(
          fullFileRef.current,
          viewModeRef.current,
        ),
        // Split must remain side-by-side even when the center pane is narrow.
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        contextmenu: false,
        links: false,
        occurrencesHighlight: "off",
        selectionHighlight: false,
        renderLineHighlight: "none",
        hover: { enabled: "off" },
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false },
        codeLens: false,
        folding: false,
        glyphMargin: false,
        // Monaco diff editors draw their own wide overview ruler unless
        // disabled; leaving it enabled keeps a ~29px grey track even when the
        // minimap and scrollbar are narrow. Change indicators still render in
        // the content/gutter, so the ruler is not needed.
        renderOverviewRuler: false,
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        // +/- change markers are shown in the diff gutter/content, so the
        // overview ruler can be removed without losing change indication.
        renderIndicators: true,
        scrollbar: {
          verticalScrollbarSize: autoHeightRef.current ? 0 : 8,
          horizontalScrollbarSize: 10,
          useShadows: false,
          ...(autoHeightRef.current ? { vertical: "hidden" as const } : {}),
          ...(autoHeightRef.current
            ? {
                handleMouseWheel: false,
                alwaysConsumeMouseWheel: false,
              }
            : {}),
        },
        fontSize: latestPropsRef.current.fontSize ?? DEFAULT_FONT_SIZE,
        hideUnchangedRegions: {
          enabled: !fullFileRef.current,
          contextLineCount: 5,
          minimumLineCount: 8,
          revealLineCount: 20,
        },
      });
      editorRef.current = created;
      if (autoHeightRef.current) {
        subscribeAutoHeight(
          created,
          hostRef.current,
          autoHeightCleanupRef.current,
        );
      }
      created.setModel({
        original: monaco.editor.createModel("", "plaintext"),
        modified: monaco.editor.createModel("", "plaintext"),
      });
      applyContent(created, monaco.editor, latestPropsRef.current);
      if (autoHeightRef.current) {
        scheduleAutoHeight(created, hostRef.current);
      }
    }
    void createEditor();
    return () => {
      disposed = true;
      const current = editorRef.current;
      editorRef.current = null;
      if (current !== null) {
        const originalModel = current.getModel()?.original;
        const modifiedModel = current.getModel()?.modified;
        current.dispose();
        originalModel?.dispose();
        modifiedModel?.dispose();
      }
      for (const dispose of autoHeightCleanupRef.current.splice(0)) dispose();
    };
    // The editor is created once for the life of the component.
  }, []);

  useEffect(() => {
    if (editorRef.current === null) return;
    void import("monaco-editor").then((monaco) => {
      if (editorRef.current === null) return;
      registerDiffThemes(monaco.editor);
      if (typeof monaco.editor.setTheme === "function") {
        monaco.editor.setTheme(diffTheme(theme));
      }
    });
  }, [theme]);

  // Font-size changes are presentation-only. Update the live editor without
  // replacing its immutable models or resetting the current scroll position.
  useEffect(() => {
    const editorInstance = editorRef.current;
    if (editorInstance === null) return;
    editorInstance.updateOptions({
      fontSize: props.fontSize ?? DEFAULT_FONT_SIZE,
    });
    if (props.autoHeight === true) {
      scheduleAutoHeight(editorInstance, hostRef.current);
    }
  }, [props.fontSize, props.autoHeight]);

  // Keep side-by-side/inline switching in sync with the actual pane width
  // (the layout flexes when the file or chat rails collapse).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const editorInstance = editorRef.current;
      if (editorInstance === null) return;
      const host = hostRef.current;
      const width = host?.clientWidth ?? 0;
      editorInstance.updateOptions({
        renderSideBySide: shouldRenderSideBySide(
          latestPropsRef.current.fullFile,
          latestPropsRef.current.viewMode ?? "split",
        ),
        ...(latestPropsRef.current.autoHeight === true
          ? {
              scrollbar: {
                handleMouseWheel: false,
                vertical: "hidden" as const,
                verticalScrollbarSize: 0,
              },
            }
          : {}),
      });
      if (
        latestPropsRef.current.autoHeight === true &&
        host !== null &&
        measuredWidthRef.current !== null &&
        measuredWidthRef.current !== width
      ) {
        scheduleAutoHeight(editorInstance, host);
      }
      measuredWidthRef.current = width;
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Stream model and view-mode changes into the live editor.
  useEffect(() => {
    const editorInstance = editorRef.current;
    if (editorInstance === null) return;
    void import("monaco-editor").then((monaco) => {
      const current = editorRef.current;
      if (current === null) return;
      // Apply the newest props: a newer render may have committed while the
      // import was still pending, and React would not schedule another run of
      // this effect for a value we already read.
      applyContent(
        current,
        monaco.editor,
        latestPropsRef.current,
      );
      if (latestPropsRef.current.autoHeight === true) {
        scheduleAutoHeight(current, hostRef.current);
      }
    });
  }, [
    props.original,
    props.modified,
    props.path,
    props.fullFile,
    props.viewMode,
    props.autoHeight,
  ]);

  const className = props.autoHeight
    ? "diff-viewer diff-viewer--auto-height"
    : "diff-viewer";
  return (
    <div
      className={className}
      ref={hostRef}
      aria-label={`Diff for ${props.path}`}
      aria-readonly="true"
      onPointerDownCapture={() => {
        const scroller = hostRef.current?.closest<HTMLElement>(".pr-diff-main");
        outerScrollTopRef.current = scroller?.scrollTop ?? null;
      }}
      onPointerUpCapture={() => {
        window.requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && hostRef.current?.contains(active)) {
            active.blur();
          }
          const saved = outerScrollTopRef.current;
          const scroller = hostRef.current?.closest<HTMLElement>(".pr-diff-main");
          if (saved !== null && scroller != null && scroller.scrollTop !== saved) {
            scroller.scrollTop = saved;
          }
        });
      }}
    />
  );
}

function subscribeAutoHeight(
  editorInstance: editor.IStandaloneDiffEditor,
  host: HTMLDivElement | null,
  cleanup: Array<() => void>,
): void {
  if (host === null) return;
  const schedule = () => scheduleAutoHeight(editorInstance, host);
  if (typeof editorInstance.onDidUpdateDiff === "function") {
    const disposable = editorInstance.onDidUpdateDiff(schedule);
    if (typeof disposable?.dispose === "function") {
      cleanup.push(() => disposable.dispose());
    }
  }
  for (const codeEditor of [
    editorInstance.getOriginalEditor?.(),
    editorInstance.getModifiedEditor?.(),
  ]) {
    if (
      codeEditor !== undefined &&
      typeof codeEditor.onDidContentSizeChange === "function"
    ) {
      const disposable = codeEditor.onDidContentSizeChange(schedule);
      if (typeof disposable?.dispose === "function") {
        cleanup.push(() => disposable.dispose());
      }
    }
  }
}

/**
 * Fits the host to the largest rendered content side of the diff. Monaco
 * exposes content height on the two internal code editors; DiffEditor itself
 * has no content-height API. The 2px slack keeps rounding from leaving an
 * internal vertical scroll range.
 */
function fitAutoHeight(
  editorInstance: editor.IStandaloneDiffEditor,
  host: HTMLDivElement | null,
): void {
  if (editorInstance === null || host === null) return;
  const heights: number[] = [];
  const originalEditor = editorInstance.getOriginalEditor?.();
  const modifiedEditor = editorInstance.getModifiedEditor?.();
  if (originalEditor !== undefined) {
    const height = originalEditor.getContentHeight?.();
    if (typeof height === "number" && Number.isFinite(height)) {
      heights.push(height);
    }
  }
  if (modifiedEditor !== undefined) {
    const height = modifiedEditor.getContentHeight?.();
    if (typeof height === "number" && Number.isFinite(height)) {
      heights.push(height);
    }
  }
  const contentHeight = Math.max(1, ...heights);
  const hostHeight = Math.ceil(contentHeight) + 2;
  host.style.height = `${hostHeight}px`;
  editorInstance.layout?.(
    { width: Math.max(host.clientWidth, 1), height: hostHeight },
    true,
  );
}

function scheduleAutoHeight(
  editorInstance: editor.IStandaloneDiffEditor,
  host: HTMLDivElement | null,
): void {
  const fit = () => fitAutoHeight(editorInstance, host);
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(fit);
  } else {
    fit();
  }
}

function applyContent(
  editorInstance: editor.IStandaloneDiffEditor,
  editorApi: typeof import("monaco-editor").editor,
  props: DiffViewerProps,
): void {
  const language = languageForPath(props.path);
  const model = editorInstance.getModel();
  const originalModel = model?.original;
  const modifiedModel = model?.modified;
  const original = editorApi.createModel(props.original, language);
  const modified = editorApi.createModel(props.modified, language);
  editorInstance.setModel({ original, modified });
  editorInstance.updateOptions({
    fontSize: props.fontSize ?? DEFAULT_FONT_SIZE,
    renderSideBySide: shouldRenderSideBySide(
      props.fullFile,
      props.viewMode ?? "split",
    ),
    hideUnchangedRegions: {
      enabled: !props.fullFile,
      contextLineCount: 5,
      minimumLineCount: 8,
      revealLineCount: 20,
    },
    ...(props.autoHeight === true
      ? {
          scrollbar: {
            handleMouseWheel: false,
            vertical: "hidden" as const,
            verticalScrollbarSize: 0,
          },
        }
      : {}),
  });
  originalModel?.dispose();
  modifiedModel?.dispose();
}
