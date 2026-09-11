import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  message,
  useI18n,
  type LocalizedMessage,
  type MessageValues,
} from "./i18n";
import { AgentChatPanel } from "./agent-chat";
import { KnowledgeEditor } from "./knowledge-editor";
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

const knowledgeMessages = {
  knowledge: message("Knowledge", "知识库"),
  markdownRepository: message("Markdown repository", "Markdown 知识库"),
  documents: message("Documents", "文档"),
  newDocument: message("New", "新建"),
  pathMd: message("Path (.md)", "路径（.md）"),
  newDocumentPath: message("New document path", "新文档路径"),
  title: message("Title", "标题"),
  newDocumentTitle: message("New document title", "新文档标题"),
  newDocumentTitlePlaceholder: message("Idea", "想法"),
  create: message("Create", "创建"),
  loadingTree: message("Loading tree…", "正在加载目录树…"),
  unableLoadTree: message(
    "Unable to load knowledge: {detail}",
    "无法加载知识库：{detail}",
  ),
  noDocuments: message("No Markdown documents yet.", "暂无 Markdown 文档。"),
  selectOrCreate: message("Select or create a document", "选择或创建文档"),
  treeDescription: message(
    "Markdown files under the knowledge root appear in the tree. Use the New button to create one with a stable document id.",
    "知识库根目录下的 Markdown 文件会显示在目录树中。使用“新建”按钮创建带有稳定文档 ID 的文件。",
  ),
  loadingDocument: message("Loading document…", "正在加载文档…"),
  unableLoadDocument: message(
    "Unable to load document: {detail}",
    "无法加载文档：{detail}",
  ),
  viewMode: message("View mode", "查看模式"),
  preview: message("Preview", "预览"),
  edit: message("Edit", "编辑"),
  history: message("History", "历史版本"),
  saving: message("Saving…", "正在保存…"),
  save: message("Save", "保存"),
  delete: message("Delete", "删除"),
  deleteConfirm: message("Delete {path}?", "删除 {path}？"),
  move: message("Move…", "移动…"),
  newPath: message("New path", "新路径"),
  movePath: message("Move path", "移动路径"),
  moveSubmit: message("Move", "移动"),
  loadingHistory: message("Loading history…", "正在加载历史版本…"),
  unableLoadHistory: message(
    "Unable to load history: {detail}",
    "无法加载历史版本：{detail}",
  ),
  noVersions: message("No saved versions yet.", "暂无已保存版本。"),
  restoreVersion: message("Restore v{version}?", "恢复版本 v{version}？"),
  restore: message("Restore", "恢复"),
  documentSaved: message("Document saved.", "文档已保存。"),
  documentSavedWithId: message("Document saved ({id}).", "文档已保存（{id}）。"),
  documentMoved: message("Document moved.", "文档已移动。"),
  restoredVersion: message("Restored a previous version.", "已恢复之前的版本。"),
  documentChat: message("Document chat", "文档对话"),
  saveFailed: message("Unable to save document: {detail}", "无法保存文档：{detail}"),
  createFailed: message("Unable to create document: {detail}", "无法创建文档：{detail}"),
  deleteFailed: message("Unable to delete document: {detail}", "无法删除文档：{detail}"),
  moveFailed: message("Unable to move document: {detail}", "无法移动文档：{detail}"),
  restoreFailed: message("Unable to restore version: {detail}", "无法恢复版本：{detail}"),
} as const;

type Mode = "preview" | "edit" | "history";

type Feedback = {
  message: LocalizedMessage;
  values?: MessageValues;
};

/**
 * Knowledge page: file tree on the left, document center with
 * Preview/Edit/History, and the default document chat on the right. Markdown
 * files are the source of truth; editing uses a plain source editor, and the
 * first save of a front-matter-less file adopts it.
 */
export function KnowledgePage() {
  const { t, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const { documentId: rawDocumentId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const pathParam = searchParams.get("path") ?? "";
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<Feedback | null>(null);
  const [error, setError] = useState<Feedback | null>(null);

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
      setMessage(doc.id === null
        ? { message: knowledgeMessages.documentSaved }
        : { message: knowledgeMessages.documentSavedWithId, values: { id: doc.id } });
      setDraft(doc.content);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-doc", doc.path] });
      if (doc.id !== null && rawDocumentId !== doc.id) {
        navigate(`/knowledge/${encodeURIComponent(doc.id)}`, { replace: true });
      }
    },
    onError: (failure: Error) => setError({ message: knowledgeMessages.saveFailed, values: { detail: failure.message } }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeDocument(id),
    onSuccess: () => {
      navigate("/knowledge", { replace: true });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
    },
    onError: (failure: Error) => setError({ message: knowledgeMessages.deleteFailed, values: { detail: failure.message } }),
  });

  const move = useMutation({
    mutationFn: (path: string) => moveKnowledgeDocument(rawDocumentId, path),
    onSuccess: () => {
      setMessage({ message: knowledgeMessages.documentMoved });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-tree"] });
    },
    onError: (failure: Error) => setError({ message: knowledgeMessages.moveFailed, values: { detail: failure.message } }),
  });

  const restore = useMutation({
    mutationFn: (versionId: string) => restoreKnowledgeVersion(rawDocumentId, versionId),
    onSuccess: (doc) => {
      setDraft(doc.content);
      setMessage({ message: knowledgeMessages.restoredVersion });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-doc", doc.path] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-versions", rawDocumentId] });
    },
    onError: (failure: Error) => setError({ message: knowledgeMessages.restoreFailed, values: { detail: failure.message } }),
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
    onError: (failure: Error) => setError({ message: knowledgeMessages.createFailed, values: { detail: failure.message } }),
  });

  const content = draft ?? document.data?.content ?? "";
  const canSave = activePath !== undefined && draft !== null;

  return (
    <section className="knowledge-page" aria-labelledby="knowledge-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t(knowledgeMessages.knowledge)}</p>
          <h2 id="knowledge-heading">{t(knowledgeMessages.markdownRepository)}</h2>
        </div>
      </div>
      {error !== null && <p role="alert" className="agent-error">{t(error.message, error.values)}</p>}
      {message !== null && <p role="status" className="agent-note">{t(message.message, message.values)}</p>}
      <div className="knowledge-layout">
        <aside className="knowledge-tree" aria-label={t(knowledgeMessages.knowledge)}>
          <div className="knowledge-tree-header">
            <h3>{t(knowledgeMessages.documents)}</h3>
            <button type="button" onClick={() => { setError(null); setShowNew((value) => !value); }}>{t(knowledgeMessages.newDocument)}</button>
          </div>
          {showNew && (
            <form
              className="knowledge-new"
              onSubmit={(event) => { event.preventDefault(); create.mutate(); }}
            >
              <label>{t(knowledgeMessages.pathMd)}<input aria-label={t(knowledgeMessages.newDocumentPath)} value={newPath} placeholder="notes/idea.md" onChange={(event) => setNewPath(event.target.value)} /></label>
              <label>{t(knowledgeMessages.title)}<input aria-label={t(knowledgeMessages.newDocumentTitle)} value={newTitle} placeholder={t(knowledgeMessages.newDocumentTitlePlaceholder)} onChange={(event) => setNewTitle(event.target.value)} /></label>
              <button type="submit" disabled={newPath.trim().length === 0 || newTitle.trim().length === 0}>{t(knowledgeMessages.create)}</button>
            </form>
          )}
          {tree.isPending && <p role="status">{t(knowledgeMessages.loadingTree)}</p>}
          {tree.isError && <p role="alert">{t(knowledgeMessages.unableLoadTree, { detail: tree.error.message })}</p>}
          {tree.data !== undefined && tree.data.items.length === 0 && (
            <p role="status">{t(knowledgeMessages.noDocuments)}</p>
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
              <h3>{t(knowledgeMessages.selectOrCreate)}</h3>
              <p>{t(knowledgeMessages.treeDescription)}</p>
            </div>
          )}
          {activePath !== undefined && document.isPending && <p role="status">{t(knowledgeMessages.loadingDocument)}</p>}
          {activePath !== undefined && document.isError && <p role="alert">{t(knowledgeMessages.unableLoadDocument, { detail: document.error.message })}</p>}
          {activePath !== undefined && document.data !== undefined && (
            <>
              <header className="knowledge-doc-header">
                <div>
                  <h3>{document.data.title}</h3>
                  <p className="knowledge-path">{document.data.path}</p>
                </div>
                <div className="knowledge-actions">
                  <div className="segmented" role="group" aria-label={t(knowledgeMessages.viewMode)}>
                    <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>{t(knowledgeMessages.preview)}</button>
                    <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>{t(knowledgeMessages.edit)}</button>
                    {rawDocumentId.length > 0 && <button type="button" aria-pressed={mode === "history"} onClick={() => setMode("history")}>{t(knowledgeMessages.history)}</button>}
                  </div>
                  {canSave && mode === "edit" && (
                    <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                      {save.isPending ? t(knowledgeMessages.saving) : t(knowledgeMessages.save)}
                    </button>
                  )}
                  {rawDocumentId.length > 0 && (
                    <>
                      <button type="button" onClick={() => { if (window.confirm(t(knowledgeMessages.deleteConfirm, { path: document.data.path }))) remove.mutate(rawDocumentId); }} disabled={remove.isPending}>{t(knowledgeMessages.delete)}</button>
                      <button type="button" onClick={() => setMoveTarget(document.data.path)}>{t(knowledgeMessages.move)}</button>
                    </>
                  )}
                </div>
              </header>
              {moveTarget.length > 0 && (
                <form className="knowledge-move" onSubmit={(event) => { event.preventDefault(); move.mutate(moveTarget.trim()); setMoveTarget(""); }}>
                  <label>{t(knowledgeMessages.newPath)}
                    <input aria-label={t(knowledgeMessages.movePath)} value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)} />
                  </label>
                  <button type="submit">{t(knowledgeMessages.moveSubmit)}</button>
                </form>
              )}
              {mode === "preview" && (
                <div className="knowledge-body">
                  <MarkdownView text={content} documentPath={document.data.path} />
                </div>
              )}
              {mode === "edit" && (
                <KnowledgeEditor
                  key={activePath}
                  value={content}
                  onChange={(next) => {
                    setDraft(next);
                    setError(null);
                  }}
                />
              )}
              {mode === "history" && rawDocumentId.length > 0 && (
                <div className="knowledge-versions">
                  {versions.isPending && <p role="status">{t(knowledgeMessages.loadingHistory)}</p>}
                  {versions.isError && <p role="alert">{t(knowledgeMessages.unableLoadHistory, { detail: versions.error.message })}</p>}
                  {versions.data?.items.length === 0 && <p role="status">{t(knowledgeMessages.noVersions)}</p>}
                  <ul>
                    {versions.data?.items.map((version) => (
                      <li key={version.id}>
                        <span>v{version.versionNumber} · {version.source} · {formatDateTime(version.createdAt)}</span>
                        <button type="button" onClick={() => { if (window.confirm(t(knowledgeMessages.restoreVersion, { version: version.versionNumber }))) restore.mutate(version.id); }} disabled={restore.isPending}>{t(knowledgeMessages.restore)}</button>
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
            heading={t(knowledgeMessages.documentChat)}
          />
        )}
      </div>
    </section>
  );
}
