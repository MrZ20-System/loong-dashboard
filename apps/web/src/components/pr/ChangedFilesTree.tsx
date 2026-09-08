import { useEffect, useMemo, useState } from "react";
import type { ChangedFileEntry } from "@loongboard/contracts";
import { Codicon } from "./codicon";
import { ChangeFileIcon, changeFileLabel } from "./ChangeFileIcon";

interface TreeFile extends ChangedFileEntry {
  readonly name: string;
}

interface TreeNode {
  readonly name: string;
  /** Full directory path for folders, full file path for files. */
  readonly path: string;
  readonly kind: "folder" | "file";
  readonly children: TreeNode[];
  readonly file: TreeFile | null;
}

function buildTree(files: ChangedFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const foldersByPath = new Map<string, TreeNode>();
  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const fileName = segments.pop() ?? file.path;
    let parent: TreeNode[] = roots;
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
          file: null,
        };
        foldersByPath.set(prefix, folder);
        parent.push(folder);
      }
      parent = folder.children;
    }
    parent.push({
      name: fileName,
      path: file.path,
      kind: "file",
      children: [],
      file: { ...file, name: fileName },
    });
  }
  sortTree(roots);
  return roots;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  for (const node of nodes) sortTree(node.children);
}

function collectFolderPaths(nodes: TreeNode[], output: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.kind === "folder") {
      output.add(node.path);
      collectFolderPaths(node.children, output);
    }
  }
  return output;
}

function matchesFilter(file: ChangedFileEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    file.path.toLowerCase().includes(needle) ||
    (file.previousPath !== null && file.previousPath.toLowerCase().includes(needle))
  );
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim();
  if (needle.length === 0) return nodes;
  const kept: TreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      const children = filterTree(node.children, query);
      if (children.length > 0) kept.push({ ...node, children });
    } else if (node.file !== null && matchesFilter(node.file, query)) {
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
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const file = node.file;
  if (file === null) return null;
  const isSelected = selected === node.path;
  const statusLabel = changeFileLabel(file.changeType);
  return (
    <li
      className="pr-tree-item pr-tree-item--file"
      role="treeitem"
      aria-selected={isSelected}
      aria-level={depth + 1}
    >
      <button
        type="button"
        className={isSelected ? "pr-file selected pr-tree-file" : "pr-file pr-tree-file"}
        data-change-type={file.changeType}
        aria-label={`${statusLabel} ${fileLabel(file)}`}
        title={fileLabel(file)}
        onClick={() => onSelect(node.path)}
      >
        <ChangeFileIcon
          changeType={file.changeType}
          className="pr-tree-file-icon"
        />
        <span className="pr-tree-name">{file.name}</span>
        {!file.binary && file.additions !== null && (
          <span className="pr-file-meta pr-tree-stats">
            <span className="diff-stat-add">+{file.additions}</span>
            <span className="diff-stat-del">−{file.deletions ?? 0}</span>
          </span>
        )}
      </button>
    </li>
  );
}

function BranchRow({
  node,
  depth,
  query,
  openPaths,
  onToggleFolder,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  query: string;
  openPaths: Set<string>;
  onToggleFolder: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.kind === "file") {
    return (
      <FileRow node={node} depth={depth} selected={selected} onSelect={onSelect} />
    );
  }
  const open = query.trim().length > 0 || openPaths.has(node.path);
  return (
    <li
      className="pr-tree-item pr-tree-item--folder"
      role="treeitem"
      aria-expanded={open}
      aria-level={depth + 1}
    >
      <button
        type="button"
        className={`pr-tree-folder pr-tree-row${open ? " pr-tree-folder--open" : ""}`}
        aria-expanded={open}
        aria-label={node.name}
        title={node.path}
        onClick={() => onToggleFolder(node.path)}
      >
        <Codicon name={open ? "chevron-down" : "chevron-right"} className="pr-tree-chevron" />
        <Codicon name={open ? "folder-opened" : "folder"} className="pr-tree-folder-icon" />
        <span className="pr-tree-name">{node.name}</span>
      </button>
      {open && (
        <ul className="pr-tree-children" role="group">
          {node.children.map((child) => (
            <BranchRow
              key={child.path}
              node={child}
              depth={depth + 1}
              query={query}
              openPaths={openPaths}
              onToggleFolder={onToggleFolder}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ChangedFilesTree({
  files,
  selected,
  onSelect,
}: {
  files: ChangedFileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [openPaths, setOpenPaths] = useState<Set<string>>(
    () => collectFolderPaths(buildTree(files)),
  );

  useEffect(() => {
    setOpenPaths((previous) => {
      const next = new Set(previous);
      for (const path of collectFolderPaths(buildTree(files))) next.add(path);
      return next;
    });
  }, [files]);

  const visibleNodes = useMemo(
    () => filterTree(buildTree(files), query),
    [files, query],
  );

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
      className="pr-file-tree"
      aria-label="Changed files"
      id="pr-file-panel"
    >
      <header className="pr-file-tree-header">
        <h3>Changed files ({files.length})</h3>
      </header>
      <div className="pr-file-filter">
        <Codicon name="search" className="pr-file-filter-icon" />
        <input
          type="search"
          aria-label="Filter files"
          placeholder="Filter by file path"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button
            type="button"
            className="pr-file-filter-clear"
            aria-label="Clear file filter"
            onClick={() => setQuery("")}
          >
            <Codicon name="close" className="pr-file-filter-clear-icon" />
          </button>
        )}
      </div>
      {visibleNodes.length === 0 ? (
        <p role="status" className="pr-tree-empty">
          No files match “{query}”.
        </p>
      ) : (
        <ul className="pr-tree" role="tree" aria-label="Changed files">
          {visibleNodes.map((node) => (
            <BranchRow
              key={node.path}
              node={node}
              depth={0}
              query={query}
              openPaths={openPaths}
              onToggleFolder={toggleFolder}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
