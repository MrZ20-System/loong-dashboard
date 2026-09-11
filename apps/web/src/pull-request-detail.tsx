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
import { useI18n } from "./i18n";
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
import { prMessages } from "./components/pr/messages";

const DiffViewer = lazy(() =>
  import("./diff-viewer").then((module) => ({ default: module.DiffViewer })),
);

type WorkbenchMode = "changes" | "full";

const DEFAULT_CODE_FONT_SIZE = 13;
const MIN_CODE_FONT_SIZE = 10;
const MAX_CODE_FONT_SIZE = 20;
const PR_DUAL_PANEL_BREAKPOINT = 1280;

function isNarrowPrViewport(): boolean {
  // Keep the narrow, single-rail layout as the safe server/test default. The
  // browser effect below upgrades it when the real viewport is wide enough.
  return typeof window === "undefined" || window.innerWidth <= PR_DUAL_PANEL_BREAKPOINT;
}

function useNarrowPrViewport(): boolean {
  const [narrow, setNarrow] = useState(isNarrowPrViewport);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setNarrow(isNarrowPrViewport());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return narrow;
}

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
  const { t } = useI18n();
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
            ? t(prMessages.binaryFile)
            : t(prMessages.tooLargeFile)}
        </p>
      )}
      <Suspense fallback={<p role="status">{t(prMessages.loadingEditor)}</p>}>
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
  const { t, formatNumber } = useI18n();
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
            <span className="pr-file-meta">{t(prMessages.binary)}</span>
          ) : (
            file.additions !== null && (
              <>
                <span className="diff-stat-add">+{formatNumber(file.additions)}</span>
                <span className="diff-stat-del">−{formatNumber(file.deletions ?? 0)}</span>
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
  const { t } = useI18n();
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
        <span className="pr-diff-card-stats pr-file-meta">
          {t(prMessages.headFile)}
        </span>
      </header>
      <div className="pr-diff-card-body">
        {degraded !== null && (
          <p role="status" className="file-degraded-notice">
          {degraded === "binary"
            ? t(prMessages.binaryFile)
            : t(prMessages.tooLargeFile)}
          </p>
        )}
        <Suspense fallback={<p role="status">{t(prMessages.loadingEditor)}</p>}>
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
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    setFailed(false);
    try {
      const { command } = await fetchLocalCommand(repositoryId, number);
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
    }
  };
  return (
    <span className="copy-command">
      <button type="button" onClick={() => void copy()}>
        {t(prMessages.copyLocalCommand)}
      </button>
      {copied && (
        <span role="status" className="copied-hint">
          {t(prMessages.copied)}
        </span>
      )}
      {failed && (
        <span role="alert" className="copied-hint">
          {t(prMessages.copyFailed)}
        </span>
      )}
    </span>
  );
}

export function PullRequestDetailPage() {
  const { t, formatDateTime } = useI18n();
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
  const refreshActive =
    fetchPullRequest.isPending ||
    (fetchRunId !== null &&
      (fetchRun.isPending ||
        fetchRun.data?.status === "queued" ||
        fetchRun.data?.status === "running"));
  const refreshFailed =
    fetchRun.data !== undefined &&
    fetchRun.data.status !== "completed" &&
    !refreshActive;
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
  const narrowViewport = useNarrowPrViewport();
  const [filesOpen, setFilesOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(() => !isNarrowPrViewport());
  const [bulkExpansion, setBulkExpansion] = useState<{
    id: number;
    expanded: boolean;
  } | null>(null);

  useEffect(() => {
    // Preserve the file tree as the useful default when a wide workbench is
    // resized into a viewport that cannot support both rails.
    if (narrowViewport && filesOpen && chatOpen) setChatOpen(false);
  }, [chatOpen, filesOpen, narrowViewport]);

  const toggleFiles = () => {
    const next = !filesOpen;
    setFilesOpen(next);
    if (next && narrowViewport) setChatOpen(false);
  };

  const toggleChat = () => {
    const next = !chatOpen;
    setChatOpen(next);
    if (next && narrowViewport) setFilesOpen(false);
  };

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
          <h2 id="pr-unavailable-title">{t(prMessages.pullRequestUnavailable)}</h2>
          <p role="alert">{t(prMessages.invalidPullRequestNumber)}</p>
        </div>
      </section>
    );
  }
  if (detail.isPending) {
    return (
      <section className="pr-detail pr-detail--focus pr-detail--unavailable" aria-labelledby="pr-unavailable-title">
        <div className="pr-unavailable-card">
          <h2 id="pr-unavailable-title">{t(prMessages.pullRequest)}</h2>
          <p role="status">{t(prMessages.loadingPullRequest)}</p>
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
        <h2 id="pr-unavailable-title">{t(prMessages.pullRequestUnavailable)}</h2>
        {notFound ? <p role="alert">{t(prMessages.prNotAvailableLocally, { number })}</p> : <p role="alert">{t(prMessages.unableLoadPullRequest, { detail: detail.error.message })}</p>}
        {notFound && (
          <div className="pr-fetch-missing">
            <button type="button" className="button-primary" onClick={() => fetchPullRequest.mutate()} disabled={fetchPullRequest.isPending || activeFetch}>
              {fetchPullRequest.isPending || activeFetch ? t(prMessages.fetchingPr) : t(prMessages.fetchPr)}
            </button>
            {fetchPullRequest.isError && <p role="alert">{t(prMessages.unableFetchPr)} {fetchPullRequest.error.message}</p>}
            {fetchRun.isError && <p role="alert">{t(prMessages.unableCheckFetchRun)} {fetchRun.error.message}</p>}
            {activeFetch && <p role="status">{t(prMessages.fetchingPrFromGithub)}</p>}
            {fetchRun.data?.status === "completed" && <p role="status">{t(prMessages.prFetchedRefreshing)}</p>}
            {fetchFailed && <p role="alert">{t(prMessages.fetchPrFailed, { detail: fetchRun.data?.error ?? `run ${fetchRun.data?.status}` })}</p>}
          </div>
        )}
        {notFound && (
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>
            {t(prMessages.backToPullRequests)}
          </Link>
        )}
        </div>
      </section>
    );
  }
  const pr = detail.data as PullRequestDetail;
  const isArchived = pr.archivedAt != null;
  const isPayloadPruned = pr.payloadPrunedAt != null;
  const fileTreeLabel =
    t(mode === "changes" ? prMessages.changedFilesPanel : prMessages.repositoryFilesPanel);
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
              aria-label={t(prMessages.openPullRequestOnGithub, { number: pr.number })}
            >
              #{pr.number}
            </a>
          </h2>
          <p className="pr-meta pr-meta--github">
            <span className={`pr-status-pill pr-status-pill--${pr.status}`}>
              {pr.status}
            </span>
            <strong>{pr.authorLogin ?? t(prMessages.unknown)}</strong>
            <span>{t(prMessages.wantsToMergeInto)}</span>
            <span className="pr-ref-chip">{pr.baseRefName}</span>
            <span>{t(prMessages.from)}</span>
            <span className="pr-ref-chip">{pr.headRefName}</span>
            <span className="pr-updated">{t(prMessages.updated, { value: formatDateTime(pr.updatedAt) })}</span>
          </p>
          <DomainChips domains={pr.domains} />
        </div>
        <div className="pr-heading-actions">
          <CopyLocalCommand repositoryId={repositoryId} number={pr.number} />
          <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>
            {t(prMessages.backToList)}
          </Link>
        </div>
      </div>
      {isArchived && (
        <aside className="metadata-archive-banner" role="status">
          <strong>{t(prMessages.archived)}</strong>
          <button type="button" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? t(prMessages.restoring) : t(prMessages.restore)}
          </button>
          {restore.isError && <span role="alert">{t(prMessages.unableRestore)} {restore.error.message}</span>}
        </aside>
      )}
      {isPayloadPruned && (
        <aside className="metadata-archive-banner" role="status">
          <strong>{t(prMessages.cachedDetailsCleaned)}</strong>
          <button type="button" onClick={() => fetchPullRequest.mutate()} disabled={refreshActive}>
            {refreshActive ? t(prMessages.refreshing) : t(prMessages.refreshFromGithub)}
          </button>
          {fetchPullRequest.isError && <span role="alert">{t(prMessages.unableRefresh)} {fetchPullRequest.error.message}</span>}
          {fetchRun.isError && <span role="alert">{t(prMessages.unableCheckRefreshRun)} {fetchRun.error.message}</span>}
          {refreshFailed && <span role="alert">{t(prMessages.unableRefresh)} {fetchRun.data.error ?? `fetch run ${fetchRun.data.status}`}</span>}
        </aside>
      )}
      {prepare.isPending && (
        <p role="status" className="pr-workbench-status">
          {t(prMessages.preparingLocalObjects)}
        </p>
      )}
      {prepare.isError && (
        <p role="alert" className="pr-workbench-status">
          {t(prMessages.unablePrepareDiff)} {prepare.error.message}
        </p>
      )}
      {!prepare.isPending && !prepare.isError && prepare.data !== undefined && (
        <div className="pr-workbench">
          <div className="pr-workbench-toolbar">
            <div className="pr-workbench-toolbar__status">
              {prepare.data.fetched && (
                <span role="status" className="pr-workbench-fetch-hint">
                  {t(prMessages.fetchedMissingObjects)}
                </span>
              )}
            </div>
            <div
              className="pr-workbench-toolbar__controls"
              role="group"
              aria-label={t(prMessages.workbenchControls)}
            >
              <PanelCollapseButton
                panelId="pr-file-panel"
                label={fileTreeLabel}
                expanded={filesOpen}
                side="left"
                onToggle={toggleFiles}
              />
              <PanelCollapseButton
                panelId="pr-chat-panel"
                label={t(prMessages.prChat)}
                expanded={chatOpen}
                side="right"
                onToggle={toggleChat}
              />
              <details className="pr-diff-settings">
                <summary aria-label={t(prMessages.diffSettings)} title={t(prMessages.diffSettings)}>
                  <Codicon name="settings-gear" />
                </summary>
                <div className="pr-diff-settings__menu">
                  <section>
                    <h3>{t(prMessages.layout)}</h3>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      aria-pressed={changesViewMode === "unified"}
                      onClick={() => setChangesViewMode("unified")}
                    >
                      <Codicon name="check" /> {t(prMessages.unified)}
                    </button>
                    <button
                      type="button"
                      disabled={mode !== "changes"}
                      aria-pressed={changesViewMode === "split"}
                      onClick={() => setChangesViewMode("split")}
                    >
                      <Codicon name="check" /> {t(prMessages.split)}
                    </button>
                  </section>
                  <section>
                    <h3>{t(prMessages.changedFiles)}</h3>
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
                      {t(prMessages.expandAll)}
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
                      {t(prMessages.collapseAll)}
                    </button>
                  </section>
                  <section>
                    <h3>{t(prMessages.codeFontSize)}</h3>
                    <div
                      className="pr-diff-settings__font-size"
                      role="group"
                      aria-label={t(prMessages.codeFontSizeControls)}
                    >
                      <button
                        type="button"
                        aria-label={t(prMessages.decreaseCodeFontSize)}
                        disabled={codeFontSize <= MIN_CODE_FONT_SIZE}
                        onClick={() =>
                          setCodeFontSize((size) =>
                            Math.max(MIN_CODE_FONT_SIZE, size - 1),
                          )
                        }
                      >
                        −
                      </button>
                      <output aria-label={t(prMessages.codeFontSize)}>
                        {codeFontSize} px
                      </output>
                      <button
                        type="button"
                        aria-label={t(prMessages.increaseCodeFontSize)}
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
                    <h3>{t(prMessages.view)}</h3>
                    <button
                      type="button"
                      aria-pressed={mode === "changes"}
                      onClick={() => setMode("changes")}
                    >
                      <Codicon name="check" /> {t(prMessages.changes)}
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "full"}
                      onClick={() => setMode("full")}
                    >
                      <Codicon name="check" /> {t(prMessages.fullFile)}
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
                  {t(prMessages.unableLoadRepositoryFiles)} {repositoryTree.error.message}
                </p>
              ) : repositoryTree.isPending || repositoryTree.data === undefined ? (
                <p role="status" className="pr-workbench-main-status">
                  {t(prMessages.loadingRepositoryFiles)}
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
                  {t(prMessages.noFilesAtRevision)}
                </p>
              )}
            </div>
            <ResizableSidePanel
              panelId="pr-chat-panel"
              side="right"
              open={chatOpen}
              label={t(prMessages.prChat)}
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
                  heading={t(prMessages.prChat)}
                  collapsed={false}
                  panelId="pr-chat-panel"
                  showCollapseControl={false}
                />
              ) : (
                <p role="status" className="pr-workbench-panel-status">
                  {t(prMessages.openingPrWorkspace)}
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
  const { t } = useI18n();
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
        {t(prMessages.unableLoadRepositoryFiles)} {treeState.error?.message ?? ""}
      </p>
    );
  } else if (treeState.isPending || treeState.data === undefined) {
    content = (
      <p role="status" className="pr-workbench-panel-status">
        {t(prMessages.loadingRepositoryFiles)}
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
      label={t(mode === "changes" ? prMessages.changedFiles : prMessages.repositoryFiles)}
      defaultWidth={290}
      minWidth={220}
      maxWidth={560}
    >
      {content}
    </ResizableSidePanel>
  );
}
