import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/** One Markdown file under the knowledge root. */
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

/** One scan result, including the bytes already read while parsing metadata. */
export interface KnowledgeFileSnapshot extends KnowledgeFileInfo {
  content: string;
  contentHash: string;
}

export interface ParsedDocument {
  documentId: string | null;
  title: string | null;
  /** Raw content without the front matter (the Markdown body). */
  body: string;
  /** The complete file content (front matter + body). */
  raw: string;
}

/** Directories excluded from the knowledge tree. */
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".loong"]);

const isMarkdown = (path: string): boolean =>
  [".md", ".markdown"].includes(extname(path).toLowerCase());

/**
 * Leading `---` front matter block. Capture groups:
 * 1. line ending after the opening delimiter,
 * 2. header text,
 * 3. line ending before the closing delimiter,
 * 4. optional line ending after the closing delimiter.
 */
const FRONT_MATTER_BLOCK = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n|$)/;

const LOONGBOARD_ID_LINE = /^loongboard_id:[ \t]*(.*)$/;

interface SplitLine {
  text: string;
  ending: string;
}

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
 * Recursively list Markdown files under `root`. Document titles
 * come from the front matter heading when present, otherwise the file name.
 */
export function scanKnowledgeFiles(root: string): KnowledgeFileSnapshot[] {
  const entries: KnowledgeFileSnapshot[] = [];
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
      const content = readUtf8(absolute);
      const parsed = parseMarkdown(content);
      const fallbackTitle = repositoryPath.split("/").at(-1)?.replace(/\.md$/, "") ?? repositoryPath;
      entries.push({
        path: repositoryPath,
        documentId: parsed.documentId,
        title: parsed.title ?? fallbackTitle,
        sizeBytes: stats.size,
        updatedAt: new Date(stats.mtimeMs).toISOString(),
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
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
 * Parse the standard YAML-ish front matter used for the stable document id.
 * Only `key: value` scalar lines are interpreted; everything
 * else is left untouched by save operations.
 */
export function parseMarkdown(raw: string): ParsedDocument {
  const match = FRONT_MATTER_BLOCK.exec(raw);
  if (match === null) {
    return { documentId: null, title: null, body: raw, raw };
  }
  const header = match[2] ?? "";
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

function splitLinesWithEndings(value: string): SplitLine[] {
  const lines: SplitLine[] = [];
  const lineEnding = /\r?\n/g;
  let cursor = 0;
  for (let match = lineEnding.exec(value); match !== null; match = lineEnding.exec(value)) {
    lines.push({ text: value.slice(cursor, match.index), ending: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) lines.push({ text: value.slice(cursor), ending: "" });
  return lines;
}

function joinLinesWithEndings(lines: readonly SplitLine[]): string {
  let joined = "";
  for (const line of lines) joined += line.text + line.ending;
  return joined;
}

function loongboardIdValue(line: string): string | null {
  const match = LOONGBOARD_ID_LINE.exec(line);
  return match === null ? null : (match[1] ?? "").trim();
}

/**
 * Return `raw` with exactly one `loongboard_id` front-matter field set to
 * `id`, preserving every other front matter byte. When the document has no
 * front matter a minimal block is prepended; when the front matter has no id
 * the line is inserted just before the closing delimiter; a matching id
 * leaves `raw` unchanged; a stale id is replaced in place.
 */
export function withDocumentId(raw: string, id: string): string {
  const block = FRONT_MATTER_BLOCK.exec(raw);
  if (block === null) {
    return serializeDocument(id, raw);
  }
  const prefix = block[0] ?? "";
  const lines = splitLinesWithEndings(prefix);
  // The closing delimiter is the last line of the matched prefix.
  const closingLineIndex = lines.length - 1;
  let idLineIndex = -1;
  for (let index = closingLineIndex - 1; index >= 0; index -= 1) {
    if (loongboardIdValue(lines[index]?.text ?? "") !== null) {
      idLineIndex = index;
      break;
    }
  }
  if (idLineIndex === -1) {
    lines.splice(closingLineIndex, 0, {
      text: `loongboard_id: ${id}`,
      ending: block[1] ?? "\n",
    });
    return `${joinLinesWithEndings(lines)}${raw.slice(prefix.length)}`;
  }
  if (loongboardIdValue(lines[idLineIndex]?.text ?? "") === id) return raw;
  lines[idLineIndex] = { text: `loongboard_id: ${id}`, ending: lines[idLineIndex]?.ending ?? "" };
  return `${joinLinesWithEndings(lines)}${raw.slice(prefix.length)}`;
}

/**
 * Ensure Markdown carries a front-matter id. Existing content keeps its id;
 * otherwise `preferredId` is adopted (or generated) without stripping any
 * existing front matter fields.
 */
export function ensureDocumentId(
  raw: string,
  preferredId: string = documentId(),
): { content: string; documentId: string } {
  const parsed = parseMarkdown(raw);
  if (parsed.documentId !== null) {
    return { content: raw, documentId: parsed.documentId };
  }
  return {
    content: withDocumentId(raw, preferredId),
    documentId: preferredId,
  };
}

/**
 * Write by temp file + rename so readers never observe a partial document.
 * Parent directories are created when needed.
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
