import { useEffect, useRef } from "react";
import EditorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import type { editor } from "monaco-editor";

/**
 * Monaco-based Markdown source editor for Knowledge documents (plan 15.3:
 * "编辑：Monaco Editor"). Loaded lazily so jsdom tests and first paint never
 * execute the worker setup; see diff-viewer for the shared module notes.
 */
export function KnowledgeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let disposed = false;
    async function createEditor(): Promise<void> {
      resolveSelfWorker();
      const monaco = await import("monaco-editor");
      await registerBasicLanguages();
      if (disposed || hostRef.current === null) return;
      const editorInstance = monaco.editor.create(hostRef.current, {
        value: valueRef.current,
        language: "markdown",
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        wordWrap: "on",
      });
      editorInstance.onDidChangeModelContent(() => {
        onChangeRef.current(editorInstance.getValue());
      });
      editorRef.current = editorInstance;
    }
    createEditor();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  // Keep the model in sync with external updates (e.g. restore or doc switch)
  // without clobbering the caret while the user types.
  useEffect(() => {
    const instance = editorRef.current;
    if (instance === null || instance.getValue() === value) return;
    instance.setValue(value);
  }, [value]);

  return (
    <div className="knowledge-editor-host" ref={hostRef} aria-label="Markdown source" role="textbox" aria-multiline="true" />
  );
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
  await (import(
    "../node_modules/monaco-editor/esm/vs/basic-languages/monaco.contribution.js" as string
  ) as Promise<unknown>);
}
