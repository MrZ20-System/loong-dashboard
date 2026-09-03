import {
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ChangedFileEntry, DomainTag, PullRequestDetail } from "@loongboard/contracts";
import {
  fetchFileContent,
  fetchLocalCommand,
  fetchPullRequestDetail,
  preparePullRequest,
} from "./diff-client";

const DiffViewer = lazy(() =>
  import("./diff-viewer").then((module) => ({ default: module.DiffViewer })),
);

const changeTypeLabels: Record<ChangedFileEntry["changeType"], string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
};

function usePullRequestPage(repositoryId: string, number: number, enabled: boolean) {
  const detail = useQuery({
    queryKey: ["pr", repositoryId, number],
    enabled,
    queryFn: ({ signal }) => fetchPullRequestDetail(repositoryId, number, signal),
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
  return <span className="domain-chips">{domains.map((tag) => <span key={tag.id} className="domain-chip" style={{ backgroundColor: tag.color }}>{tag.name}</span>)}</span>;
}

function FileSidebar({ files, selected, onSelect }: {
  files: ChangedFileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return <div className="pr-file-tree" aria-label="Changed files">
    <h3>Changed files ({files.length})</h3>
    <ul>{files.map((file) => {
      const label = file.changeType === "renamed" && file.previousPath !== null
        ? `${file.previousPath} → ${file.path}`
        : file.path;
      return <li key={file.path}>
        <button type="button" className={selected === file.path ? "pr-file selected" : "pr-file"} onClick={() => onSelect(file.path)}>
          <span className={`change-badge change-${file.changeType}`} aria-label={file.changeType}>{changeTypeLabels[file.changeType]}</span>
          <span className="pr-file-path" title={label}>{file.path}</span>
          {file.binary && <span className="pr-file-meta">binary</span>}
          {!file.binary && file.additions !== null && <span className="pr-file-meta">+{file.additions} −{file.deletions ?? 0}</span>}
        </button>
      </li>;
    })}</ul>
  </div>;
}

interface SideState {
  kind: "text" | "binary" | "too-large" | "empty";
  text: string;
  sizeBytes: number;
}

const EMPTY_SIDE: SideState = { kind: "empty", text: "", sizeBytes: 0 };

function resolveSide(
  kind: "base" | "head",
  file: ChangedFileEntry,
  response: { binary: boolean; tooLarge: boolean; content: string | null; sizeBytes: number } | undefined,
  pending: boolean,
): SideState {
  if (response === undefined) {
    return pending ? EMPTY_SIDE : kind === "base" ? { ...EMPTY_SIDE, kind: "empty" } : EMPTY_SIDE;
  }
  if (response.binary) return { kind: "binary", text: "", sizeBytes: response.sizeBytes };
  if (response.tooLarge) return { kind: "too-large", text: "", sizeBytes: response.sizeBytes };
  return { kind: "text", text: response.content ?? "", sizeBytes: response.sizeBytes };
}

function FilePane({ repositoryId, number, file, mergeBase, headSha, fullFile, onFileLabel }: {
  repositoryId: string;
  number: number;
  file: ChangedFileEntry;
  mergeBase: string;
  headSha: string;
  fullFile: boolean;
  onFileLabel: (label: string) => void;
}) {
  const hasBase = file.changeType !== "added";
  const hasHead = file.changeType !== "removed";
  const basePath = file.previousPath ?? file.path;
  const base = useQuery({
    queryKey: ["pr-file", repositoryId, number, "base", mergeBase, basePath],
    enabled: hasBase,
    queryFn: ({ signal }) => fetchFileContent(repositoryId, number, basePath, mergeBase, signal),
    placeholderData: keepPreviousData,
  });
  const head = useQuery({
    queryKey: ["pr-file", repositoryId, number, "head", headSha, file.path],
    enabled: hasHead,
    queryFn: ({ signal }) => fetchFileContent(repositoryId, number, file.path, headSha, signal),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    onFileLabel(file.changeType === "renamed" && file.previousPath !== null
      ? `${file.previousPath} → ${file.path}`
      : file.path);
  }, [file, onFileLabel]);

  const baseSide = hasBase ? resolveSide("base", file, base.data, base.isPending) : EMPTY_SIDE;
  const headSide = hasHead ? resolveSide("head", file, head.data, head.isPending) : EMPTY_SIDE;
  const degraded = baseSide.kind === "binary" || headSide.kind === "binary"
    ? "binary"
    : baseSide.kind === "too-large" || headSide.kind === "too-large"
      ? "too-large"
      : null;

  return <div className="pr-diff-pane">
    {degraded !== null && <p role="status" className="file-degraded-notice">{degraded === "binary" ? "Binary file — open it locally to inspect." : "File too large for the editor — open it locally."}</p>}
    <DiffViewer
      original={baseSide.kind === "text" ? baseSide.text : ""}
      modified={headSide.kind === "text" ? headSide.text : ""}
      path={file.path}
      fullFile={fullFile}
    />
  </div>;
}

function CopyLocalCommand({ repositoryId, number }: { repositoryId: string; number: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const { command } = await fetchLocalCommand(repositoryId, number);
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <span className="copy-command"><button type="button" onClick={() => void copy()}>Copy local command</button>{copied && <span role="status" className="copied-hint">Copied</span>}</span>;
}

export function PullRequestDetailPage() {
  const { repositoryId = "", number: rawNumber = "" } = useParams();
  const number = Number(rawNumber);
  const enabled = repositoryId.length > 0 && Number.isInteger(number) && number > 0;
  const { detail, prepare } = usePullRequestPage(repositoryId, enabled ? number : 0, enabled);
  const [mode, setMode] = useState<"changes" | "full">("changes");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLabel, setFileLabel] = useState("");

  const files = prepare.data?.files ?? [];
  useEffect(() => {
    if (selectedPath === null && files.length > 0) setSelectedPath(files[0]?.path ?? null);
  }, [files, selectedPath]);
  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  if (!enabled) return <p role="alert">Invalid pull request number.</p>;
  if (detail.isPending) return <p role="status">Loading pull request…</p>;
  if (detail.isError) {
    const notFound = detail.error instanceof Error && /not found/i.test(detail.error.message);
    return <section><h2>Pull request unavailable</h2><p role="alert">{detail.error.message}</p>{notFound && <Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>Back to pull requests</Link>}</section>;
  }
  const pr = detail.data as PullRequestDetail;
  return <section className="pr-detail" aria-labelledby="pr-title">
    <div className="page-heading pr-heading">
      <div>
        <p className="eyebrow">{repositoryId} · PR #{pr.number}</p>
        <h2 id="pr-title">{pr.title}</h2>
        <p className="pr-meta">by {pr.authorLogin ?? "unknown"} · {pr.status} · updated {pr.updatedAt} · {pr.baseRefName} ← {pr.headRefName}</p>
        <DomainChips domains={pr.domains} />
      </div>
      <div className="pr-heading-actions"><CopyLocalCommand repositoryId={repositoryId} number={pr.number} /><Link to={`/repositories/${encodeURIComponent(repositoryId)}/pulls`}>Back to list</Link></div>
    </div>
    {prepare.isPending && <p role="status">Preparing local Git objects…</p>}
    {prepare.isError && <p role="alert">Unable to prepare diff: {prepare.error.message}</p>}
    {!prepare.isPending && !prepare.isError && prepare.data !== undefined && <div className="pr-workspace">
      <FileSidebar files={files} selected={selectedPath} onSelect={setSelectedPath} />
      <div className="pr-diff-main">
        <div className="diff-toolbar">
          <div className="segmented" role="group" aria-label="Diff view mode">
            <button type="button" aria-pressed={mode === "changes"} onClick={() => setMode("changes")}>Changes</button>
            <button type="button" aria-pressed={mode === "full"} onClick={() => setMode("full")}>Full File</button>
          </div>
          {prepare.data.fetched && <span role="status" className="fetch-hint">Fetched missing Git objects</span>}
          <span className="diff-file-label">{fileLabel}</span>
        </div>
        {selectedFile !== null
          ? <Suspense fallback={<p role="status">Loading editor…</p>}>
            <FilePane repositoryId={repositoryId} number={pr.number} file={selectedFile} mergeBase={prepare.data.mergeBase} headSha={pr.headSha} fullFile={mode === "full"} onFileLabel={setFileLabel} />
          </Suspense>
          : <p role="status">No changed files for this pull request.</p>}
      </div>
    </div>}
  </section>;
}
