import { useEffect, useMemo, useState } from "react";
import type { ChangedFileEntry } from "@loongboard/contracts";
import { Codicon } from "./codicon";
import { ChangeFileIcon, changeFileLabel } from "./ChangeFileIcon";
import "./repository-tree.css";

/** VS Code Explorer-like compact indentation for one tree level. */
export const REPOSITORY_TREE_INDENT_PX = 8;

export type RepositoryTreeFolderTone = "added" | "removed" | "modified";

export interface RepositoryTreeNode {
  readonly name: string;
  /** Full repository-relative path of the folder or file. */
  readonly path: string;
  readonly kind: "folder" | "file";
  readonly children: RepositoryTreeNode[];
  /** Exact changed-file entry when this head file row changed. */
  readonly change: ChangedFileEntry | null;
  /** Dot tone for folders containing any changed path. */
  tone: RepositoryTreeFolderTone | null;
}

export interface RepositoryTreeProps {
  /** Every file path at the prepared PR head ref. */
  readonly headFiles: readonly string[];
  /** Decoration source; removed paths are retained as selectable base files. */
  readonly changedFiles: readonly ChangedFileEntry[];
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  /** Extra folders to open initially; defaults to the top-level folders. */
  readonly defaultExpandedPaths?: readonly string[];
  readonly panelId?: string;
}

function folderToneFor(types: readonly ChangedFileEntry["changeType"][]): RepositoryTreeFolderTone {
  let added = false;
  let removed = false;
  for (const type of types) {
    if (type === "removed") removed = true;
    else if (type === "added") added = true;
  }
  if (removed) return "removed";
  if (added) return "added";
  return "modified";
}

function ancestorPrefixes(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const prefixes: string[] = [];
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    prefixes.push(prefix);
  }
  return prefixes;
}

function sortTree(nodes: RepositoryTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  for (const node of nodes) sortTree(node.children);
}

/** Build the head tree and retain removed files from the base revision. */
export function buildRepositoryTree(
  headFiles: readonly string[],
  changedFiles: readonly ChangedFileEntry[],
): RepositoryTreeNode[] {
  const changedByPath = new Map(
    changedFiles.map((file) => [file.path, file] as const),
  );
  const roots: RepositoryTreeNode[] = [];
  const foldersByPath = new Map<string, RepositoryTreeNode>();

  const treePaths = [...headFiles];
  const knownPaths = new Set(headFiles);
  for (const file of changedFiles) {
    if (file.changeType === "removed" && !knownPaths.has(file.path)) {
      knownPaths.add(file.path);
      treePaths.push(file.path);
    }
  }

  for (const filePath of treePaths) {
    const segments = filePath
      .split("/")
      .filter((segment) => segment.length > 0);
    const fileName = segments.pop() ?? filePath;
    let parent: RepositoryTreeNode[] = roots;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      let folder = foldersByPath.get(prefix);
      if (folder === undefined) {
        folder = {
          name: segment,
          path: prefix,
          kind: "folder",
          children: [],
          change: null,
          tone: null,
        };
        foldersByPath.set(prefix, folder);
        parent.push(folder);
      }
      parent = folder.children;
    }
    parent.push({
      name: fileName,
      path: filePath,
      kind: "file",
      children: [],
      change: changedByPath.get(filePath) ?? null,
      tone: null,
    });
  }

  const folderTypes = new Map<string, ChangedFileEntry["changeType"][]>();
  for (const file of changedFiles) {
    for (const prefix of ancestorPrefixes(file.path)) {
      const existing = folderTypes.get(prefix) ?? [];
      existing.push(file.changeType);
      folderTypes.set(prefix, existing);
    }
  }
  for (const [folderPath, node] of foldersByPath) {
    const types = folderTypes.get(folderPath);
    if (types !== undefined && types.length > 0) {
      node.tone = folderToneFor(types);
    }
  }

  sortTree(roots);
  return roots;
}

function topLevelFolderPaths(nodes: readonly RepositoryTreeNode[]): string[] {
  return nodes
    .filter((node) => node.kind === "folder")
    .map((node) => node.path);
}

function matchesQuery(
  file: ChangedFileEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    file.path.toLowerCase().includes(needle) ||
    (file.previousPath !== null &&
      file.previousPath.toLowerCase().includes(needle))
  );
}

function filterTree(
  nodes: readonly RepositoryTreeNode[],
  query: string,
): RepositoryTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...nodes];
  const kept: RepositoryTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      const children = filterTree(node.children, query);
      if (children.length > 0) {
        kept.push({ ...node, children });
      }
    } else if (
      node.change !== null
        ? matchesQuery(node.change, query)
        : node.path.toLowerCase().includes(needle)
    ) {
      kept.push(node);
    }
  }
  return kept;
}

function fileLabel(file: ChangedFileEntry): string {
  return file.changeType === "renamed" && file.previousPath !== null
    ? `${file.previousPath} → ${file.path}`
    : file.path;
}

function FileRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: RepositoryTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const change = node.change;
  const label = change === null ? node.path : fileLabel(change);
  const accessibleName =
    change === null
      ? node.path
      : `${changeFileLabel(change.changeType)} ${label}`;
  const isSelected = selected === node.path;
  return (
    <li
      className="repository-tree__item"
      role="treeitem"
      aria-selected={isSelected}
      aria-level={depth + 1}
    >
      <button
        type="button"
        className={`repository-tree__file${isSelected ? " repository-tree__file--selected" : ""}`}
        data-change-type={change?.changeType}
        aria-label={accessibleName}
        title={label}
        onClick={() => onSelect(node.path)}
      >
        <span
          className="repository-tree__indent"
          style={{ width: depth * REPOSITORY_TREE_INDENT_PX }}
          aria-hidden="true"
        />
        {change === null ? (
          <Codicon name="file-code" className="repository-tree__file-icon" />
        ) : (
          <ChangeFileIcon
            changeType={change.changeType}
            className="repository-tree__file-icon"
          />
        )}
        <span className="repository-tree__name">{node.name}</span>
        {change !== null && !change.binary && change.additions !== null && (
          <span className="repository-tree__stats">
            <span className="diff-stat-add">+{change.additions}</span>
            <span className="diff-stat-del">−{change.deletions ?? 0}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function BranchRow({
  node,
  depth,
  filtering,
  openPaths,
  onToggle,
  selected,
  onSelect,
}: {
  node: RepositoryTreeNode;
  depth: number;
  filtering: boolean;
  openPaths: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.kind === "file") {
    return (
      <FileRow
        node={node}
        depth={depth}
        selected={selected}
        onSelect={onSelect}
      />
    );
  }
  const open = filtering || openPaths.has(node.path);
  return (
    <li
      className="repository-tree__item"
      role="treeitem"
      aria-expanded={open}
      aria-level={depth + 1}
    >
      <button
        type="button"
        className="repository-tree__folder"
        aria-expanded={open}
        data-change-tone={node.tone ?? undefined}
        aria-label={node.path}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <span
          className="repository-tree__indent"
          style={{ width: depth * REPOSITORY_TREE_INDENT_PX }}
          aria-hidden="true"
        />
        <Codicon
          name={open ? "chevron-down" : "chevron-right"}
          className="repository-tree__chevron"
        />
        <Codicon
          name={open ? "folder-opened" : "folder"}
          className="repository-tree__folder-icon"
        />
        <span className="repository-tree__name">{node.name}</span>
        {node.tone !== null && (
          <span
            className="repository-tree__dot codicon codicon-circle-filled"
            data-change-tone={node.tone}
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <ul className="repository-tree__children" role="group">
          {node.children.map((child) => (
            <BranchRow
              key={child.path}
              node={child}
              depth={depth + 1}
              filtering={filtering}
              openPaths={openPaths}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function RepositoryTree({
  headFiles,
  changedFiles,
  selectedPath,
  onSelect,
  defaultExpandedPaths,
  panelId,
}: RepositoryTreeProps) {
  const [query, setQuery] = useState("");
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => {
    const tree = buildRepositoryTree(headFiles, changedFiles);
    const initial =
      defaultExpandedPaths !== undefined
        ? [...defaultExpandedPaths]
        : topLevelFolderPaths(tree);
    return new Set(initial);
  });

  useEffect(() => {
    if (selectedPath === null) return;
    setOpenPaths((previous) => {
      const next = new Set(previous);
      for (const prefix of ancestorPrefixes(selectedPath)) next.add(prefix);
      return next;
    });
  }, [selectedPath]);

  const tree = useMemo(
    () => buildRepositoryTree(headFiles, changedFiles),
    [headFiles, changedFiles],
  );
  const visibleNodes = useMemo(
    () => filterTree(tree, query),
    [tree, query],
  );
  const filtering = query.trim().length > 0;

  const toggleFolder = (path: string) => {
    setOpenPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section
      className="repository-tree"
      aria-label="Repository files"
      {...(panelId !== undefined ? { id: panelId } : {})}
    >
      <div className="repository-tree__filter">
        <Codicon name="search" className="repository-tree__filter-icon" />
        <input
          type="search"
          aria-label="Filter repository files"
          placeholder="Filter by file path"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button
            type="button"
            className="repository-tree__filter-clear"
            aria-label="Clear repository file filter"
            onClick={() => setQuery("")}
          >
            <Codicon name="close" className="repository-tree__filter-clear-icon" />
          </button>
        )}
      </div>
      {visibleNodes.length === 0 ? (
        <p role="status" className="repository-tree__empty">
          {headFiles.length === 0 && !filtering
            ? "No files at this revision."
            : `No files match “${query}”.`}
        </p>
      ) : (
        <ul className="repository-tree__list" role="tree" aria-label="Repository files">
          {visibleNodes.map((node) => (
            <BranchRow
              key={node.path}
              node={node}
              depth={0}
              filtering={filtering}
              openPaths={openPaths}
              onToggle={toggleFolder}
              selected={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
