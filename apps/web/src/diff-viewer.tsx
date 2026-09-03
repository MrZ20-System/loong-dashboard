import { useEffect, useRef } from "react";
import EditorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import type { editor } from "monaco-editor";

/**
 * One shared Monaco diff editor for both view modes (plan 11.3). Changes
 * mode enables `hideUnchangedRegions`; Full File mode disables it. The
 * editor and worker load lazily after mount so the component never blocks
 * first paint and stays a no-op under jsdom tests.
 *
 * Note on module paths: monaco-editor 0.56 exports only the package root
 * ("./esm/vs/index.js") and maps every subpath through its own exports map,
 * which makes `monaco-editor/esm/vs/...` bare specifiers unresolvable by
 * bundlers. We therefore import the ESM files by explicit relative paths,
 * which bypasses the exports map.
 */
export interface DiffViewerProps {
  readonly original: string;
  readonly modified: string;
  readonly path: string;
  readonly fullFile: boolean;
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
  const fullFileRef = useRef(props.fullFile);
  fullFileRef.current = props.fullFile;

  // Create the editor once. Monaco is imported lazily so jsdom test
  // environments never execute its worker setup.
  useEffect(() => {
    let disposed = false;
    async function createEditor(): Promise<void> {
      resolveSelfWorker();
      const monaco = await import("monaco-editor");
      await registerBasicLanguages();
      if (disposed || hostRef.current === null) return;
      const created = monaco.editor.createDiffEditor(hostRef.current, {
        readOnly: true,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderSideBySide: false,
        minimap: { enabled: true },
        fontSize: 13,
        hideUnchangedRegions: {
          enabled: !fullFileRef.current,
          contextLineCount: 5,
          minimumLineCount: 8,
          revealLineCount: 20,
        },
      });
      editorRef.current = created;
      created.setModel({
        original: monaco.editor.createModel("", "plaintext"),
        modified: monaco.editor.createModel("", "plaintext"),
      });
      applyContent(created, monaco.editor, props);
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
    };
    // The editor is created once for the life of the component.
  }, []);

  // Stream model and view-mode changes into the live editor.
  useEffect(() => {
    const editorInstance = editorRef.current;
    if (editorInstance === null) return;
    void import("monaco-editor").then((monaco) => {
      const current = editorRef.current;
      if (current === null) return;
      applyContent(current, monaco.editor, props);
    });
  }, [props.original, props.modified, props.path, props.fullFile]);

  return <div className="diff-viewer" ref={hostRef} aria-label={`Diff for ${props.path}`} />;
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
    hideUnchangedRegions: {
      enabled: !props.fullFile,
      contextLineCount: 5,
      minimumLineCount: 8,
      revealLineCount: 20,
    },
  });
  originalModel?.dispose();
  modifiedModel?.dispose();
}
