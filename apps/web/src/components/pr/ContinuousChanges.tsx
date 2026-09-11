import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChangedFileEntry } from "@loongboard/contracts";
import { ChangeFileIcon } from "./ChangeFileIcon";
import { Codicon } from "./codicon";
import "./continuous-changes.css";

export const DIFF_RENDER_AHEAD_MARGIN_PX = 1_600;
export const DEFAULT_EXPANDED_CHANGE_LINE_LIMIT = 400;

/**
 * Changes-mode viewer preference. Full File mode is a separate ordinary
 * single-file view and does not use this type.
 */
export type ChangesViewMode = "unified" | "split";

/** DiffViewer mode options for one Changes card. */
export interface ChangesDiffOptions {
  readonly fullFile: false;
  readonly renderSideBySide: boolean;
}

/**
 * Maps the typed view mode to DiffViewer options. Split always requests
 * side-by-side; Unified always requests inline.
 */
export function resolveChangesDiffOptions(viewMode: ChangesViewMode): ChangesDiffOptions {
  return {
    fullFile: false,
    renderSideBySide: viewMode === "split",
  };
}

export interface DiffRenderContext {
  readonly viewMode: ChangesViewMode;
  /** Changes cards are never Full File mode. */
  readonly fullFile: false;
}

export interface ContinuousChangesProps {
  /** Every changed file rendered as one independently expandable card. */
  readonly files: readonly ChangedFileEntry[];
  /** Unified (default) or Split; each expanded card receives this mode. */
  readonly viewMode?: ChangesViewMode;
  /**
   * Deferred editor renderer. It is invoked only for expanded cards that are
   * near the viewport or selected; immutable file content may already be warm.
   */
  readonly renderFileDiff?: (
    file: ChangedFileEntry,
    context: DiffRenderContext,
  ) => ReactNode;
  readonly selectedPath?: string | null;
  /** Overrides the default small/non-deleted expansion policy. */
  readonly initialExpandedPaths?: readonly string[];
  /** Toolbar-issued request to expand or collapse every diff card. */
  readonly bulkExpansion?: {
    readonly id: number;
    readonly expanded: boolean;
  } | null;
}

export function diffAnchorId(path: string): string {
  return `pr-continuous-diff-${encodeURIComponent(path)}`;
}

export function scrollToDiffFile(
  path: string,
  behavior: ScrollBehavior = "smooth",
): boolean {
  const element = document.getElementById(diffAnchorId(path));
  if (element === null) return false;
  element.scrollIntoView({ behavior, block: "start" });
  return true;
}

export async function copyFilePathToClipboard(
  path: string,
  clipboard: Pick<Clipboard, "writeText">,
): Promise<void> {
  await clipboard.writeText(path);
}

export function shouldExpandChangedFileByDefault(
  file: ChangedFileEntry,
): boolean {
  if (file.changeType === "removed") return false;
  if (file.additions === null || file.deletions === null) return true;
  return (
    file.additions + file.deletions <= DEFAULT_EXPANDED_CHANGE_LINE_LIMIT
  );
}

function useNearViewport(
  enabled: boolean,
): { cardRef: RefObject<HTMLLIElement | null>; near: boolean } {
  const cardRef = useRef<HTMLLIElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setNear(false);
      return;
    }
    const node = cardRef.current;
    if (node === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: `${DIFF_RENDER_AHEAD_MARGIN_PX}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);
  return { cardRef, near };
}

export function FilePathCopyButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setFailed(false);
    try {
      await copyFilePathToClipboard(path, navigator.clipboard);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <span className="continuous-changes__copy-wrap">
      <button
        type="button"
        className="continuous-changes__copy"
        aria-label={`Copy path for ${path}`}
        onClick={() => void copy()}
      >
        <Codicon name="copy" className="continuous-changes__copy-icon" />
      </button>
      {copied && (
        <span role="status" className="continuous-changes__copied">
          Copied
        </span>
      )}
      {failed && (
        <span role="alert" className="continuous-changes__copy-error">
          Copy failed
        </span>
      )}
    </span>
  );
}

function DiffCard({
  file,
  viewMode,
  expanded,
  onToggle,
  selected,
  renderFileDiff,
}: {
  file: ChangedFileEntry;
  viewMode: ChangesViewMode;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  renderFileDiff: ContinuousChangesProps["renderFileDiff"];
}) {
  const { cardRef, near } = useNearViewport(expanded);
  const anchorId = diffAnchorId(file.path);
  const bodyId = `${anchorId}-body`;
  const context: DiffRenderContext = { viewMode, fullFile: false };
  const mounted =
    expanded &&
    (near || selected) &&
    renderFileDiff !== undefined;
  const label =
    file.changeType === "renamed" && file.previousPath !== null
      ? `${file.previousPath} → ${file.path}`
      : file.path;

  return (
    <li
      ref={cardRef}
      id={anchorId}
      className="continuous-changes__card"
      role="listitem"
      data-view-mode={viewMode}
      aria-current={selected ? "true" : undefined}
    >
      <header className="continuous-changes__card-header">
        <span className="continuous-changes__file">
          <ChangeFileIcon
            changeType={file.changeType}
            className="continuous-changes__file-icon"
          />
          <span className="continuous-changes__path" title={label}>
            {label}
          </span>
          <FilePathCopyButton path={file.path} />
        </span>
        <span className="continuous-changes__stats">
          {file.binary ? (
            <span className="continuous-changes__binary">binary</span>
          ) : (
            file.additions !== null && (
              <>
                <span className="diff-stat-add">+{file.additions}</span>
                <span className="diff-stat-del">−{file.deletions ?? 0}</span>
              </>
            )
          )}
        </span>
        <button
          type="button"
          className="continuous-changes__action"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          aria-label={
            expanded
              ? `Collapse diff for ${file.path}`
              : `Expand diff for ${file.path}`
          }
          onClick={onToggle}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </header>
      {expanded && (
        <div
          id={bodyId}
          className="continuous-changes__card-body"
          data-view-mode={viewMode}
        >
          {mounted && renderFileDiff !== undefined
            ? renderFileDiff(file, context)
            : !renderFileDiff
              ? null
              : (
                <p role="status" className="continuous-changes__waiting">
                  Preparing diff…
                </p>
              )}
        </div>
      )}
    </li>
  );
}

export function ContinuousChanges({
  files,
  viewMode = "unified",
  renderFileDiff,
  selectedPath = null,
  initialExpandedPaths,
  bulkExpansion = null,
}: ContinuousChangesProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () =>
      new Set(
        initialExpandedPaths === undefined
          ? files
              .filter(shouldExpandChangedFileByDefault)
              .map((file) => file.path)
          : initialExpandedPaths,
      ),
  );
  const previousSelectedRef = useRef<string | null>(null);
  const previousBulkExpansionRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      bulkExpansion === null ||
      previousBulkExpansionRef.current === bulkExpansion.id
    ) {
      return;
    }
    previousBulkExpansionRef.current = bulkExpansion.id;
    setExpandedPaths(
      bulkExpansion.expanded
        ? new Set(files.map((file) => file.path))
        : new Set(),
    );
  }, [bulkExpansion, files]);

  useEffect(() => {
    const previous = previousSelectedRef.current;
    previousSelectedRef.current = selectedPath;
    if (selectedPath === null || selectedPath === previous) return;
    setExpandedPaths((current) => {
      if (current.has(selectedPath)) return current;
      const next = new Set(current);
      next.add(selectedPath);
      return next;
    });
  }, [selectedPath]);

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="continuous-changes" aria-label="Changed file diffs">
      <h3 className="continuous-changes__heading">
        Changed files ({files.length})
      </h3>
      <ul className="continuous-changes__list" role="list">
        {files.map((file) => {
          const path = file.path;
          const expanded = expandedPaths.has(path);
          return (
            <DiffCard
              key={path}
              file={file}
              viewMode={viewMode}
              expanded={expanded}
              onToggle={() => toggle(path)}
              selected={selectedPath === path}
              renderFileDiff={renderFileDiff}
            />
          );
        })}
      </ul>
    </section>
  );
}
