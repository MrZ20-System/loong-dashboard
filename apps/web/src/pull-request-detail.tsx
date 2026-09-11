import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ChangedFileEntry,
  DomainTag,
  PullRequestDetail,
} from "@loongboard/contracts";
import { AgentChatPanel } from "./agent-chat";
import { ChangedFilesTree } from "./components/pr/ChangedFilesTree";
import {
  ContinuousChanges,
  FilePathCopyButton,
  scrollToDiffFile,
  type ChangesViewMode,
} from "./components/pr/ContinuousChanges";
import { ChangeFileIcon } from "./components/pr/ChangeFileIcon";
import { Codicon } from "./components/pr/codicon";
import { RepositoryTree } from "./components/pr/RepositoryTree";
import {
  PanelCollapseButton,
  ResizableSidePanel,
} from "./components/pr/ResizableSidePanel";
import {
  fetchLocalCommand,
  fetchPullRequestDetail,
  fetchRepositoryTree,
  preparePullRequest,
} from "./diff-client";
import { ApiRequestError } from "./metadata-client";
import { fetchSinglePullRequest, fetchSyncRun } from "./sync-client";
import { restorePullRequestMetadata } from "./retention-client";
import {
  prefetchChangedFileContents,
  prFileQueryOptions,
  PR_FILE_CACHE_TIME_MS,
} from "./pr-file-cache";

const DiffViewer = lazy(() =>
  import("./diff-viewer").then((module) => ({ default: module.DiffViewer })),
);

type WorkbenchMode = "changes" | "full";

const DEFAULT_CODE_FONT_SIZE = 13;
const MIN_CODE_FONT_SIZE = 10;
const MAX_CODE_FONT_SIZE = 20;

function usePullRequestPage(
  repositoryId: string,
  number: number,
  enabled: boolean,
) {
  const detail = useQuery({
    queryKey: ["pr", repositoryId, number],
    enabled,
    queryFn: ({ signal }) =>
      fetchPullRequestDetail(repositoryId, number, signal),
  });
  const prepare = useQuery({
    queryKey: ["pr-prepare", repositoryId, number],
    enabled,
    queryFn: ({ signal }) => preparePullRequest(repositoryId, number, signal),
  });
  return { detail, prepare };
}

function DomainChips({ domains }: { domains: DomainTag[] }) {
  if (domains.length === 0) return null;
  return (
    <span className="domain-chips">
      {domains.map((tag) => (
        <span
          key={tag.id}
          className="domain-chip"
          style={{ backgroundColor: tag.color }}
        >
          {tag.name}
        </span>
      ))}
    </span>
  );
}

interface SideState {
  kind: "text" | "binary" | "too-large" | "empty";
  text: string;
  sizeBytes: number;
}

const EMPTY_SIDE: SideState = { kind: "empty", text: "", sizeBytes: 0 };

function resolveSide(
  response:
    | { binary: boolean; tooLarge: boolean; content: string | null; sizeBytes: number }
    | undefined,
  pending: boolean,
): SideState {
  if (response === undefined) {
    return pending ? EMPTY_SIDE : EMPTY_SIDE;
  }
  if (response.binary) {
    return { kind: "binary", text: "", sizeBytes: response.sizeBytes };
  }
  if (response.tooLarge) {
    return { kind: "too-large", text: "", sizeBytes: response.sizeBytes };
  }
  return {
    kind: "text",
    text: response.content ?? "",
    sizeBytes: response.sizeBytes,
  };
}

function labelForFile(file: ChangedFileEntry): string {
  return file.changeType === "renamed" && file.previousPath !== null
    ? `${file.previousPath} → ${file.path}`
    : file.path;
}

/**
 * Content-only diff used by the continuous Changes list. The surrounding
 * ContinuousChanges card owns the visible path, status, copy, and collapse
 * controls. Immutable content is normally warm before this component mounts.
 */
function DiffCardContent({
  repositoryId,
  number,
  file,
  mergeBase,
  headSha,
  fullFile,
  viewMode,
  fontSize,
}: {
  repositoryId: string;
  number: number;
  file: ChangedFileEntry;
  mergeBase: string;
  headSha: string;
  fullFile: boolean;
  viewMode?: ChangesViewMode;
  fontSize: number;
}) {
  const hasBase = file.changeType !== "added";
  const hasHead = file.changeType !== "removed";
  const basePath = file.previousPath ?? file.path;
  const base = useQuery({
    ...prFileQueryOptions(
      repositoryId,
      number,
      basePath,
      mergeBase,
      hasBase && !file.binary,
    ),
    placeholderData: keepPreviousData,
  });
  const head = useQuery({
    ...prFileQueryOptions(
      repositoryId,
      number,
      file.path,
      headSha,
      hasHead && !file.binary,
    ),
    placeholderData: keepPreviousData,
  });

  const baseSide = hasBase
    ? resolveSide(base.data, base.isPending)
    : EMPTY_SIDE;
  const headSide = hasHead
    ? resolveSide(head.data, head.isPending)
    : EMPTY_SIDE;
  const degraded =
    file.binary || baseSide.kind === "binary" || headSide.kind === "binary"
      ? "binary"
      : baseSide.kind === "too-large" || headSide.kind === "too-large"
        ? "too-large"
        : null;

  return (
    <>
      {degraded !== null && (
        <p role="status" className="file-degraded-notice">
          {degraded === "binary"
            ? "Binary file — open it locally to inspect."
            : "File too large for the editor — open it locally."}
        </p>
      )}
      <Suspense fallback={<p role="status">Loading editor…</p>}>
        <DiffViewer
          original={baseSide.kind === "text" ? baseSide.text : ""}
          modified={headSide.kind === "text" ? headSide.text : ""}
          path={file.path}
          fullFile={fullFile}
          autoHeight={!fullFile}
          fontSize={fontSize}
          {...(fullFile ? {} : { viewMode })}
        />
      </Suspense>
    </>
  );
}

/** Full File single-card chrome plus the complete-file diff behavior. */
function FullChangedFilePane({
  repositoryId,
  number,
  file,
  mergeBase,
  headSha,
  fontSize,
}: {
  repositoryId: string;
  number: number;
  file: ChangedFileEntry;
  mergeBase: string;
  headSha: string;
  fontSize: number;
}) {
  const label = labelForFile(file);
  return (
    <div className="pr-diff-card pr-diff-card--full">
      <header className="pr-diff-card-header">
        <span className="pr-diff-card-file">
          <ChangeFileIcon
            changeType={file.changeType}
            className="pr-diff-card-file-icon"
          />
          <span className="pr-diff-card-title" title={label}>
            {label}
          </span>
          <FilePathCopyButton path={file.path} />
        </span>
        <span className="pr-diff-card-stats">
          {file.binary ? (
            <span className="pr-file-meta">binary</span>
          ) : (
            file.additions !== null && (
              <>
                <span className="diff-stat-add">+{file.additions}</span>
                <span className="diff-stat-del">−{file.deletions ?? 0}</span>
              </>
            )
          )}
        </span>
      </header>
      <div className="pr-diff-card-body">
        <DiffCardContent
          repositoryId={repositoryId}
          number={number}
          file={file}
          mergeBase={mergeBase}
          headSha={headSha}
          fullFile
          fontSize={fontSize}
        />
      </div>
    </div>
  );
}

/**
 * Unchanged head file in Full File mode: one head fetch is mirrored into both
 * Monaco sides so it renders as a normal file, not a fake diff.
 */
function FullHeadFilePane({
  repositoryId,
  number,
  path,
  headSha,
  fontSize,
}: {
  repositoryId: string;
  number: number;
  path: string;
  headSha: string;
  fontSize: number;
}) {
  const head = useQuery({
    ...prFileQueryOptions(repositoryId, number, path, headSha),
    placeholderData: keepPreviousData,
  });
  const side = resolveSide(head.data, head.isPending);
  const degraded =
    side.kind === "binary"
      ? "binary"
      : side.kind === "too-large"
        ? "too-large"
        : null;
  const text = side.kind === "text" ? side.text : "";

  return (
    <div className="pr-diff-card pr-diff-card--full">
      <header className="pr-diff-card-header">
        <span className="pr-diff-card-file">
          <Codicon
            name="file-code"
            className="pr-diff-card-file-icon"
          />
          <span className="pr-diff-card-title" title={path}>
            {path}
          </span>
          <FilePathCopyButton path={path} />
        </span>
        <span className="pr-diff-card-stats pr-file-meta">head file</span>
      </header>
      <div className="pr-diff-card-body">
        {degraded !== null && (
          <p role="status" className="file-degraded-notice">
            {degraded === "binary"
              ? "Binary file — open it locally to inspect."
              : "File too large for the editor — open it locally."}
          </p>
        )}
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <DiffViewer
            original={text}
            modified={text}
            path={path}
            fullFile
            fontSize={fontSize}
          />
        </Suspense>
      </div>
    </div>
  );
}

function CopyLocalCommand({
  repositoryId,
  number,
}: {
  repositoryId: string;
  number: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const { command } = await fetchLocalCommand(repositoryId, number);
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="copy-command">
      <button type="button" onClick={() => void copy()}>
        Copy local command
      </button>
      {copied && (
        <span role="status" className="copied-hint">
          Copied
        </span>
      )}
    </span>
  );
}

export function PullRequestDetailPage() {
  const { repositoryId = "", number: rawNumber = "" } = useParams();
  const number = Number(rawNumber);
  const enabled =
    repositoryId.length > 0 && Number.isInteger(number) && number > 0;
  const { detail, prepare } = usePullRequestPage(
    repositoryId,
    enabled ? number : 0,
    enabled,
  );
  const queryClient = useQueryClient();
  const [fetchRunId, setFetchRunId] = useState<string | null>(null);
  const fetchRun = useQuery({
    queryKey: ["sync-run", repositoryId, fetchRunId],
    enabled: fetchRunId !== null,
    queryFn: ({ signal }) => fetchSyncRun(repositoryId, fetchRunId as string, signal),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return fetchRunId !== null && (status === undefined || status === "queued" || status === "running")
        ? 1_000
        : false;
    },
  });
  const fetchPullRequest = useMutation({
    mutationFn: () => fetchSinglePullRequest(repositoryId, number),
    onSuccess: (accepted) => setFetchRunId(accepted.syncRunId),
  });
  const restore = useMutation({
    mutationFn: () => restorePullRequestMetadata(repositoryId, number),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pr", repositoryId, number] });
      void queryClient.invalidateQueries({ queryKey: ["metadata", repositoryId, "pulls"] });
    },
  });
  const [mode, setMode] = useState<WorkbenchMode>("changes");
  const [changesViewMode, setChangesViewMode] =
    useState<ChangesViewMode>("split");
  const [codeFontSize, setCodeFontSize] = useState(DEFAULT_CODE_FONT_SIZE);
  const [changesSelectedPath, setChangesSelectedPath] = useState<string | null>(
    null,
  );
  const [fullSelectedPath, setFullSelectedPath] = useState<string | null>(
    null,
  );
  const [filesOpen, setFilesOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [bulkExpansion, setBulkExpansion] = useState<{
    id: number;
    expanded: boolean;
  } | null>(null);

  const files = prepare.data?.files ?? [];
  useEffect(() => {
    const prepared = prepare.data;
    if (prepared === undefined) return;
    let active = true;
    void prefetchChangedFileContents(queryClient, {
      repositoryId,
      number,
      files: prepared.files,
      mergeBase: prepared.mergeBase,
      headSha: prepared.headSha,
      shouldContinue: () => active,
    });
    return () => {
      active = false;
    };
  }, [number, prepare.data, queryClient, repositoryId]);
  useEffect(() => {
    if (changesSelectedPath === null && files.length > 0) {
      setChangesSelectedPath(files[0]?.path ?? null);
    }
  }, [files, changesSelectedPath]);

  const repositoryTree = useQuery({
    queryKey: [
      "pr-head-tree",
      repositoryId,
      number,
      prepare.data?.headSha ?? null,
    ],
    enabled:
      enabled &&
      mode === "full" &&
      prepare.data !== undefined &&
      !prepare.isError,
    queryFn: ({ signal }) =>
      fetchRepositoryTree(repositoryId, number, signal),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: PR_FILE_CACHE_TIME_MS,
  });
  const headFiles = repositoryTree.data?.files ?? [];
  const headFileSet = useMemo(
    () => new Set(headFiles),
    [headFiles],
  );

  useEffect(() => {
    if (headFiles.length === 0) return;
    const selectedRemovedFile =
      fullSelectedPath !== null &&
      files.some(
        (file) =>
          file.path === fullSelectedPath && file.changeType === "removed",
      );
    if (
      fullSelectedPath !== null &&
      (headFileSet.has(fullSelectedPath) || selectedRemovedFile)
    ) {
      return;
    }
    const changedHeadFile = files.find(
      (file) =>
        file.changeType !== "removed" &&
        headFileSet.has(file.path),
    );
    setFullSelectedPath(changedHeadFile?.path ?? headFiles[0] ?? null);
  }, [files, fullSelectedPath, headFiles, headFileSet]);

  useEffect(() => {
    if (fetchRun.data?.status !== "completed") return;
    void queryClient.invalidateQueries({ queryKey: ["pr", repositoryId, number] });
    void queryClient.invalidateQueries({ queryKey: ["pr-prepare", repositoryId, number] });
  }, [fetchRun.data?.status, number, queryClient, repositoryId]);

  const fullChangedFile =
    fullSelectedPath === null
      ? null
      : files.find((file) => file.path === fullSelectedPath) ?? null;

  if (!enabled) {
    return (
      <section className="pr-detail pr-detail--focus pr-detail--unavailable" aria-labelledby="pr-unavailable-title">
        <div className="pr-unavailable-card">
          <h2 id="pr-unavailable-title">Pull request unavailable</h2>
          <p role="alert">Invalid pull request number.</p>
        </div>
      </section>
    );
  }
  if (detail.isPending) {
    return (
      <section className="pr-detail pr-detail--focus pr-detail--unavailable" aria-labelledby="pr-unavailable-title">
        <div className="pr-unavailable-card">
          <h2 id="pr-unavailable-title">Pull request</h2>
          <p role="status">Loading pull request…</p>
        </div>
      </section>
    );
  }
  if (detail.isError) {
    const notFound =
      (detail.error instanceof ApiRequestError && detail.error.status === 404) ||
      (detail.error instanceof Error && /not found|not available locally/i.test(detail.error.message));
    const activeFetch = fetchPullRequest.isPending || (fetchRunId !== null && (fetchRun.isPending || fetchRun.data?.status === "queued" || fetchRun.data?.status === "running"));
    const fetchFailed = fetchRun.data !== undefined && fetchRun.data.status !== "completed" && !activeFetch;
    return (
      <section className="pr-detail pr-detail--focus pr-detail--unavailable" aria-labelledby="pr-unavailable-title">
        <div className="pr-unavailable-card">
        <h2 id="pr-unavailable-title">Pull request unavailable</h2>
        {notFound ? <p role="alert">PR #{number} isn&apos;t available locally.</p> : <p role="alert">{detail.error.message}</p>}
        {notFound && (
          <div className="pr-fetch-missing">
            <button type="button" className="button-primary" onClick={() => fetchPullRequest.mutate()} disabled={fetchPullRequest.isPending || activeFetch}>
              {fetchPullRequest.isPending || activeFetch ? "Fetching PR…" : "Fetch PR"}
            </button>
            {fetchPullRequest.isError && <p role="alert">Unable to fetch PR: {fetchPullRequest.error.message}</p>}
            {fetchRun.isError && <p role="alert">Unable to check fetch run: {fetchRun.error.message}</p>}
            {activeFetch && <p role="status">Fetching PR from GitHub…</p>}
            {fetchRun.data?.status === "completed" && <p role="status">PR fetched. Refreshing local details…</p>}
            {fetchFailed && <p role="alert">Fetch PR failed: {fetchRun.data?.error ?? `run ${fetchRun.data?.status}`}</p>}
          </div>
        )}
        {notFound && (
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>
            Back to pull requests
          </Link>
        )}
        </div>
      </section>
    );
  }
  const pr = detail.data as PullRequestDetail;
  const fileTreeLabel =
    mode === "changes" ? "changed files" : "repository files";
  const selectChangedFile = (path: string) => {
    setChangesSelectedPath(path);
    scrollToDiffFile(path);
  };

  return (
    <section className="pr-detail pr-detail--focus" aria-labelledby="pr-title">
      <div className="page-heading pr-heading">
        <div className="pr-heading__summary">
          <p className="eyebrow">{repositoryId}</p>
          <h2 id="pr-title">
            {pr.title}{" "}
            <a
              className="pr-number-link"
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open pull request #${pr.number} on GitHub`}
            >
              #{pr.number}
            </a>
          </h2>
          <p className="pr-meta pr-meta--github">
            <span className={`pr-status-pill pr-status-pill--${pr.status}`}>
              {pr.status}
            </span>
            <strong>{pr.authorLogin ?? "unknown"}</strong>
            <span>wants to merge into</span>
            <span className="pr-ref-chip">{pr.baseRefName}</span>
            <span>from</span>
            <span className="pr-ref-chip">{pr.headRefName}</span>
            <span className="pr-updated">updated {pr.updatedAt}</span>
          </p>
          <DomainChips domains={pr.domains} />
        </div>
        <div className="pr-heading-actions">
          <CopyLocalCommand repositoryId={repositoryId} number={pr.number} />
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>
            Back to list
          </Link>
        </div>
      </div>
      {pr.archivedAt && (
        <aside className="metadata-archive-banner" role="status">
          <strong>Archived</strong>
          <span>Payload may have been cleaned.</span>
          <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? "Restoring…" : "Restore"}
          </button>
          {pr.payloadPrunedAt && (
            <button type="button" onClick={() => fetchPullRequest.mutate()} disabled={fetchPullRequest.isPending || fetchRunId !== null}>
              {fetchPullRequest.isPending ? "Refreshing…" : "Refresh from GitHub"}
            </button>
          )}
          {restore.isError && <span role="alert">Unable to restore: {restore.error.message}</span>}
          {fetchPullRequest.isError && <span role="alert">Unable to refresh: {fetchPullRequest.error.message}</span>}
        </aside>
      )}
      {prepare.isPending && (
        <p role="status" className="pr-workbench-status">
          Preparing local Git objects…
        </p>
      )}
      {prepare.isError && (
        <p role="alert" className="pr-workbench-status">
          Unable to prepare diff: {prepare.error.message}
        </p>
      )}
      {!prepare.isPending && !prepare.isError && prepare.data !== undefined && (
        <div className="pr-workbench">
          <div className="pr-workbench-toolbar">
            <div className="pr-workbench-toolbar__status">
              {prepare.data.fetched && (
                <span role="status" className="pr-workbench-fetch-hint">
                  Fetched missing Git objects
                </span>
              )}
            </div>
            <div
              className="pr-workbench-toolbar__controls"
              role="group"
              aria-label="Workbench controls"
            >
              <PanelCollapseButton
                panelId="pr-file-panel"
                label={fileTreeLabel}
                expanded={filesOpen}
                side="left"
                onToggle={() => setFilesOpen((open) => !open)}
              />
              <PanelCollapseButton
                panelId="pr-chat-panel"
                label="PR chat"
                expanded={chatOpen}
                side="right"
                onToggle={() => setChatOpen((open) => !open)}
              />
              <details className="pr-diff-settings">
                <summary aria-label="Diff settings" title="Diff settings">
                  <Codicon name="settings-gear" />
                </summary>
                <div className="pr-diff-settings__menu">
                  <section>
                    <h3>Layout</h3>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      aria-pressed={changesViewMode === "unified"}
                      onClick={() => setChangesViewMode("unified")}
                    >
                      <Codicon name="check" /> Unified
                    </button>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      aria-pressed={changesViewMode === "split"}
                      onClick={() => setChangesViewMode("split")}
                    >
                      <Codicon name="check" /> Split
                    </button>
                  </section>
                  <section>
                    <h3>Changed files</h3>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      onClick={() =>
                        setBulkExpansion((current) => ({
                          id: (current?.id ?? 0) + 1,
                          expanded: true,
                        }))
                      }
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      onClick={() =>
                        setBulkExpansion((current) => ({
                          id: (current?.id ?? 0) + 1,
                          expanded: false,
                        }))
                      }
                    >
                      Collapse all
                    </button>
                  </section>
                  <section>
                    <h3>Code font size</h3>
                    <div
                      className="pr-diff-settings__font-size"
                      role="group"
                      aria-label="Code font size controls"
                    >
                      <button
                        type="button"
                        aria-label="Decrease code font size"
                        disabled={codeFontSize <= MIN_CODE_FONT_SIZE}
                        onClick={() =>
                          setCodeFontSize((size) =>
                            Math.max(MIN_CODE_FONT_SIZE, size - 1),
                          )
                        }
                      >
                        −
                      </button>
                      <output aria-label="Code font size">
                        {codeFontSize} px
                      </output>
                      <button
                        type="button"
                        aria-label="Increase code font size"
                        disabled={codeFontSize >= MAX_CODE_FONT_SIZE}
                        onClick={() =>
                          setCodeFontSize((size) =>
                            Math.min(MAX_CODE_FONT_SIZE, size + 1),
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                  </section>
                  <section>
                    <h3>View</h3>
                    <button
                      type="button"
                      aria-pressed={mode === "changes"}
                      onClick={() => setMode("changes")}
                    >
                      <Codicon name="check" /> Changes
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "full"}
                      onClick={() => setMode("full")}
                    >
                      <Codicon name="check" /> Full File
                    </button>
                  </section>
                </div>
              </details>
            </div>
          </div>
          <div className="pr-workbench__body">
            <ResizableFilePanel
              open={filesOpen}
              mode={mode}
              files={files}
              headFiles={headFiles}
              treeState={repositoryTree}
              changesSelected={changesSelectedPath}
              fullSelected={fullSelectedPath}
              onChangedSelect={selectChangedFile}
              onFullSelect={setFullSelectedPath}
            />
            <div
              className={`pr-diff-main pr-diff-main--${mode}`}
            >
              {mode === "changes" ? (
                <ContinuousChanges
                  files={files}
                  viewMode={changesViewMode}
                  selectedPath={changesSelectedPath}
                  bulkExpansion={bulkExpansion}
                  renderFileDiff={(file, context) => (
                    <DiffCardContent
                      repositoryId={repositoryId}
                      number={pr.number}
                      file={file}
                      mergeBase={prepare.data?.mergeBase ?? ""}
                      headSha={pr.headSha}
                      fullFile={false}
                      viewMode={context.viewMode}
                      fontSize={codeFontSize}
                    />
                  )}
                />
              ) : repositoryTree.isError ? (
                <p role="alert" className="pr-workbench-main-status">
                  Unable to load repository files: {repositoryTree.error.message}
                </p>
              ) : repositoryTree.isPending || repositoryTree.data === undefined ? (
                <p role="status" className="pr-workbench-main-status">
                  Loading repository files…
                </p>
              ) : fullChangedFile !== null ? (
                <FullChangedFilePane
                  repositoryId={repositoryId}
                  number={pr.number}
                  file={fullChangedFile}
                  mergeBase={prepare.data?.mergeBase ?? ""}
                  headSha={pr.headSha}
                  fontSize={codeFontSize}
                />
              ) : fullSelectedPath !== null ? (
                <FullHeadFilePane
                  repositoryId={repositoryId}
                  number={pr.number}
                  path={fullSelectedPath}
                  headSha={pr.headSha}
                  fontSize={codeFontSize}
                />
              ) : (
                <p role="status" className="pr-workbench-main-status">
                  No files at this revision.
                </p>
              )}
            </div>
            <ResizableSidePanel
              panelId="pr-chat-panel"
              side="right"
              open={chatOpen}
              label="PR chat"
              defaultWidth={360}
              minWidth={260}
              maxWidth={560}
            >
              {prepare.data?.headSha === pr.headSha ? (
                <AgentChatPanel
                  scope={{
                    kind: "pr",
                    repositoryId,
                    prNumber: pr.number,
                    targetSha: pr.headSha,
                  }}
                  heading="PR chat"
                  collapsed={false}
                  panelId="pr-chat-panel"
                  showCollapseControl={false}
                />
              ) : (
                <p role="status" className="pr-workbench-panel-status">
                  Opening PR workspace…
                </p>
              )}
            </ResizableSidePanel>
          </div>
        </div>
      )}
    </section>
  );
}

function ResizableFilePanel({
  open,
  mode,
  files,
  headFiles,
  treeState,
  changesSelected,
  fullSelected,
  onChangedSelect,
  onFullSelect,
}: {
  open: boolean;
  mode: WorkbenchMode;
  files: ChangedFileEntry[];
  headFiles: string[];
  treeState: {
    isPending: boolean;
    isError: boolean;
    data?: { files: string[] } | undefined;
    error: Error | null;
  };
  changesSelected: string | null;
  fullSelected: string | null;
  onChangedSelect: (path: string) => void;
  onFullSelect: (path: string) => void;
}) {
  let content: ReactNode;
  if (mode === "changes") {
    content = (
      <ChangedFilesTree
        files={files}
        selected={changesSelected}
        onSelect={onChangedSelect}
      />
    );
  } else if (treeState.isError) {
    content = (
      <p role="alert" className="pr-workbench-panel-status">
        {treeState.error?.message ?? "Unable to load repository files."}
      </p>
    );
  } else if (treeState.isPending || treeState.data === undefined) {
    content = (
      <p role="status" className="pr-workbench-panel-status">
        Loading repository files…
      </p>
    );
  } else {
    content = (
      <RepositoryTree
        headFiles={headFiles}
        changedFiles={files}
        selectedPath={fullSelected}
        onSelect={onFullSelect}
        panelId="pr-file-panel"
      />
    );
  }

  return (
    <ResizableSidePanel
      panelId="pr-file-panel"
      side="left"
      open={open}
      label={mode === "changes" ? "Changed files" : "Repository files"}
      defaultWidth={290}
      minWidth={220}
      maxWidth={560}
    >
      {content}
    </ResizableSidePanel>
  );
}
