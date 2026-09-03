import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/** One Markdown file under the knowledge root (plan 15.1/15.2). */
export interface KnowledgeFileInfo {
  /** Repository-relative POSIX path, e.g. `notes/foo.md`. */
  path: string;
  /** Stable front-matter id (`doc_...`) or null before first LoongBoard save. */
  documentId: string | null;
  title: string;
  sizeBytes: number;
  /** ISO-8601 mtime of the file. */
  updatedAt: string;
}

export interface ParsedDocument {
  documentId: string | null;
  title: string | null;
  /** Raw content without the front matter (the Markdown body). */
  body: string;
  /** The complete file content (front matter + body). */
  raw: string;
}

/** Directories excluded from the knowledge tree (plan 15.1). */
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".loong"]);

const isMarkdown = (path: string): boolean =>
  [".md", ".markdown"].includes(extname(path).toLowerCase());

export function documentId(): string {
  return `doc_${randomBytes(10).toString("hex")}`;
}

/** True when `path` stays inside `root` (both absolute). */
export function isWithinRoot(root: string, path: string): boolean {
  const rootAbsolute = resolve(root);
  const absolute = resolve(path);
  return absolute === rootAbsolute || absolute.startsWith(`${rootAbsolute}${sep}`);
}

/**
 * Recursively list Markdown files under `root` (plan 15.1). Document titles
 * come from the front matter heading when present, otherwise the file name.
 */
export function scanKnowledgeFiles(root: string): KnowledgeFileInfo[] {
  const entries: KnowledgeFileInfo[] = [];
  const walk = (directory: string): void => {
    let children: string[] = [];
    try {
      children = readdirSync(directory);
    } catch {
      return;
    }
    children.sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      if (EXCLUDED_DIRECTORIES.has(child)) continue;
      const absolute = join(directory, child);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stats.isFile() || !isMarkdown(child)) continue;
      const repositoryPath = toPosix(relative(root, absolute));
      const parsed = parseMarkdown(readUtf8(absolute));
      const fallbackTitle = repositoryPath.split("/").at(-1)?.replace(/\.md$/, "") ?? repositoryPath;
      entries.push({
        path: repositoryPath,
        documentId: parsed.documentId,
        title: parsed.title ?? fallbackTitle,
        sizeBytes: stats.size,
        updatedAt: new Date(stats.mtimeMs).toISOString(),
      });
    }
  };
  walk(resolve(root));
  return entries;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function firstHeadingTitle(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null) return (match[1] ?? "").trim();
  }
  return null;
}

/**
 * Parse the standard YAML-ish front matter used for the stable document id
 * (plan 15.2). Only `key: value` scalar lines are interpreted; everything
 * else is left untouched by save operations.
 */
export function parseMarkdown(raw: string): ParsedDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) {
    return { documentId: null, title: null, body: raw, raw };
  }
  const header = match[1] ?? "";
  const body = raw.slice((match[0] ?? "").length);
  const fields = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const field = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (field !== null) fields.set(field[1] ?? "", (field[2] ?? "").trim());
  }
  return {
    documentId: fields.get("loongboard_id") ?? null,
    title: firstHeadingTitle(body),
    body,
    raw,
  };
}

/** Serialize a body with a minimal front matter carrying the document id. */
export function serializeDocument(documentIdValue: string, body: string): string {
  return `---\nloongboard_id: ${documentIdValue}\n---\n\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

/** Create a brand-new document body with its id and an optional heading. */
export function createMarkdown(
  documentIdValue: string,
  title: string | null,
  body: string,
): string {
  const hasHeading = title !== null && title.length > 0;
  const headingPrefix = hasHeading ? `# ${title}\n\n` : "";
  const normalizedBody = body.startsWith("# ") ? body : body;
  return serializeDocument(documentIdValue, `${headingPrefix}${normalizedBody}`);
}

/** Insert a front-matter id into Markdown that has none (first LoongBoard save). */
export function ensureDocumentId(
  raw: string,
  preferredId: string = documentId(),
): { content: string; documentId: string } {
  const parsed = parseMarkdown(raw);
  if (parsed.documentId !== null) {
    return { content: raw, documentId: parsed.documentId };
  }
  const withoutFrontMatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return {
    content: serializeDocument(preferredId, withoutFrontMatter),
    documentId: preferredId,
  };
}

/**
 * Write by temp file + rename so readers never observe a partial document
 * (plan 15.3). Parent directories are created when needed.
 */
export function atomicWrite(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, absolutePath);
}

export function readDocument(absolutePath: string): ParsedDocument {
  return parseMarkdown(readUtf8(absolutePath));
}
