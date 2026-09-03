import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AgentChatPanel } from "./agent-chat";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  ensureDocumentChat,
  fetchKnowledgeDocument,
  fetchKnowledgeTree,
  fetchKnowledgeVersions,
  moveKnowledgeDocument,
  restoreKnowledgeVersion,
  saveKnowledgeDocument,
} from "./knowledge-client";
import { MarkdownView } from "./markdown";

type Mode = "preview" | "edit" | "history";

/**
 * Knowledge page (plan 15, 18.3): file tree on the left, document center with
 * Preview/Edit/History, and the default document chat on the right. Markdown
 * files are the source of truth; editing uses a plain source editor, and the
 * first save of a front-matter-less file adopts it (plan 15.2).
 */
export function KnowledgePage() {
  const navigate = useNavigate();
  const { documentId: rawDocumentId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const pathParam = searchParams.get("path") ?? "";
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tree = useQuery({
    queryKey: ["knowledge-tree"],
    queryFn: () => fetchKnowledgeTree(),
    refetchInterval: 15_000,
  });

  const selected = useMemo(
    () => tree.data?.items.find((item) => item.documentId === rawDocumentId) ?? null,
    [tree.data, rawDocumentId],
  );
  const activePath = selected?.path ?? (rawDocumentId === "" ? pathParam || undefined : undefined);

  const document = useQuery({
    queryKey: ["knowledge-doc", activePath],
    enabled: activePath !== undefined,
    queryFn: () => fetchKnowledgeDocument(activePath as string),
  });

  useEffect(() => {
    setDraft(document.data?.content ?? null);
    setMode("preview");
  }, [document.data?.content]);

  // Adopt-by-path documents redirect to their stable id URL after the first
  // fetch, so history/delete/chat become addressable.
  useEffect(() => {
    const id = document.data?.id;
    if (typeof id === "string" && id.length > 0 && rawDocumentId === "") {
      navigate(`/knowledge/${encodeURIComponent(id)}`, { replace: true });
    }
  }, [document.data?.id, navigate, rawDocumentId]);

  const versions = useQuery({
    queryKey: ["knowledge-versions", rawDocumentId],
    enabled: rawDocumentId.length > 0,
    queryFn: () => fetchKnowledgeVersions(rawDocumentId),
  });

  // Ensure the default chat mapping when a document with an id is opened.
  useEffect(() => {
    if (rawDocumentId.length === 0) return;
    void ensureDocumentChat(rawDocumentId).catch(() => undefined);
  }, [rawDocumentId]);

  const save = useMutation({
    mutationFn: () => saveKnowledgeDocument(activePath as string, draft ?? ""),
    onSuccess: (doc) => {
      setMessage(doc.id === null ? "Document saved." : `Document saved (${doc.id}).`);
      setDraft(doc.content);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-doc", doc.path] });
      if (doc.id !== null && rawDocumentId !== doc.id) {
        navigate(`/knowledge/${encodeURIComponent(doc.id)}`, { replace: true });
      }
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeDocument(id),
    onSuccess: () => {
      navigate("/knowledge", { replace: true });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const move = useMutation({
    mutationFn: (path: string) => moveKnowledgeDocument(rawDocumentId, path),
    onSuccess: () => {
      setMessage("Document moved.");
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const restore = useMutation({
    mutationFn: (versionId: string) => restoreKnowledgeVersion(rawDocumentId, versionId),
    onSuccess: (doc) => {
      setDraft(doc.content);
      setMessage("Restored a previous version.");
      void queryClient.invalidateQueries({ queryKey: ["knowledge-doc", doc.path] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-versions", rawDocumentId] });
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const [newPath, setNewPath] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const [showNew, setShowNew] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createKnowledgeDocument({ path: newPath.trim(), title: newTitle.trim(), content: "" }),
    onSuccess: (doc) => {
      setShowNew(false);
      setNewPath("");
      setNewTitle("");
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
      navigate(`/knowledge/${encodeURIComponent(doc.id as string)}`);
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const content = draft ?? document.data?.content ?? "";
  const canSave = activePath !== undefined && draft !== null;

  return (
    <section className="knowledge-page" aria-labelledby="knowledge-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Knowledge</p>
          <h2 id="knowledge-heading">Markdown repository</h2>
        </div>
        <Link to="/">Board</Link>
      </div>
      {error !== null && <p role="alert" className="agent-error">{error}</p>}
      {message !== null && <p role="status" className="agent-note">{message}</p>}
      <div className="knowledge-layout">
        <aside className="knowledge-tree" aria-label="Knowledge tree">
          <div className="knowledge-tree-header">
            <h3>Documents</h3>
            <button type="button" onClick={() => { setError(null); setShowNew((value) => !value); }}>New</button>
          </div>
          {showNew && (
            <form
              className="knowledge-new"
              onSubmit={(event) => { event.preventDefault(); create.mutate(); }}
            >
              <label>Path (.md)<input aria-label="New document path" value={newPath} placeholder="notes/idea.md" onChange={(event) => setNewPath(event.target.value)} /></label>
              <label>Title<input aria-label="New document title" value={newTitle} placeholder="Idea" onChange={(event) => setNewTitle(event.target.value)} /></label>
              <button type="submit" disabled={newPath.trim().length === 0 || newTitle.trim().length === 0}>Create</button>
            </form>
          )}
          {tree.isPending && <p role="status">Loading tree…</p>}
          {tree.isError && <p role="alert">Unable to load knowledge: {tree.error.message}</p>}
          {tree.data !== undefined && tree.data.items.length === 0 && (
            <p role="status">No Markdown documents yet.</p>
          )}
          <ul>
            {tree.data?.items.map((item) => (
              <li key={item.path}>
                {item.documentId !== null ? (
                  <Link
                    to={`/knowledge/${encodeURIComponent(item.documentId)}`}
                    className={item.path === activePath ? "knowledge-file selected" : "knowledge-file"}
                  >
                    {item.path}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={item.path === activePath ? "knowledge-file selected" : "knowledge-file"}
                    onClick={() => navigate(`/knowledge?path=${encodeURIComponent(item.path)}`, { replace: true })}
                  >
                    {item.path}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>
        <main className="knowledge-document">
          {activePath === undefined && (
            <div className="knowledge-empty">
              <h3>Select or create a document</h3>
              <p>Markdown files under the knowledge root appear in the tree. Use the New button to create one with a stable document id.</p>
            </div>
          )}
          {activePath !== undefined && document.isPending && <p role="status">Loading document…</p>}
          {activePath !== undefined && document.isError && <p role="alert">{document.error.message}</p>}
          {activePath !== undefined && document.data !== undefined && (
            <>
              <header className="knowledge-doc-header">
                <div>
                  <h3>{document.data.title}</h3>
                  <p className="knowledge-path">{document.data.path}</p>
                </div>
                <div className="knowledge-actions">
                  <div className="segmented" role="group" aria-label="View mode">
                    <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
                    <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit</button>
                    {rawDocumentId.length > 0 && <button type="button" aria-pressed={mode === "history"} onClick={() => setMode("history")}>History</button>}
                  </div>
                  {canSave && mode === "edit" && (
                    <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                      {save.isPending ? "Saving…" : "Save"}
                    </button>
                  )}
                  {rawDocumentId.length > 0 && (
                    <>
                      <button type="button" onClick={() => { if (window.confirm(`Delete ${document.data.path}?`)) remove.mutate(rawDocumentId); }} disabled={remove.isPending}>Delete</button>
                      <button type="button" onClick={() => setMoveTarget(document.data.path)}>Move…</button>
                    </>
                  )}
                </div>
              </header>
              {moveTarget.length > 0 && (
                <form className="knowledge-move" onSubmit={(event) => { event.preventDefault(); move.mutate(moveTarget.trim()); setMoveTarget(""); }}>
                  <label>New path
                    <input aria-label="Move path" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)} />
                  </label>
                  <button type="submit">Move</button>
                </form>
              )}
              {mode === "preview" && <div className="knowledge-body"><MarkdownView text={content} /></div>}
              {mode === "edit" && (
                <textarea
                  aria-label="Markdown source"
                  className="knowledge-editor"
                  value={content}
                  onChange={(event) => { setDraft(event.target.value); setError(null); }}
                  spellCheck={false}
                />
              )}
              {mode === "history" && rawDocumentId.length > 0 && (
                <div className="knowledge-versions">
                  {versions.isPending && <p role="status">Loading history…</p>}
                  {versions.isError && <p role="alert">{versions.error.message}</p>}
                  {versions.data?.items.length === 0 && <p role="status">No saved versions yet.</p>}
                  <ul>
                    {versions.data?.items.map((version) => (
                      <li key={version.id}>
                        <span>v{version.versionNumber} · {version.source} · {version.createdAt}</span>
                        <button type="button" onClick={() => { if (window.confirm(`Restore v${version.versionNumber}?`)) restore.mutate(version.id); }} disabled={restore.isPending}>Restore</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </main>
        {rawDocumentId.length > 0 && (
          <AgentChatPanel
            scope={{ kind: "knowledge", knowledgeDocumentId: rawDocumentId }}
            heading="Document chat"
          />
        )}
      </div>
    </section>
  );
}
