import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import {
  getDomainRule,
  listDomainRules,
  replaceDomainRulesFromFile,
  type DatabaseClient,
  type DomainRuleProjectionInput,
  type DomainRuleRecord,
} from "@loongboard/database";
import type {
  DomainRuleCreate,
  DomainRuleUpdate,
  JsonSource,
  JsonSourceVersion,
  JsonSourceVersionDetail,
} from "@loongboard/contracts";
import { domainColorSchema } from "@loongboard/contracts";
import { atomicWrite, isWithinRoot } from "@loongboard/knowledge";

import { InvalidRequestError } from "./route-helpers.js";
import type { DomainReclassification } from "./reclassification-service.js";

const DEFAULT_PROMPT = `# Update domains

Analyze the repository and update the Domain definitions in the JSON file for this repository.

Keep the definitions useful for deterministic changed-file classification. Edit the JSON file directly, preserve useful existing metadata, and explain the changes in this conversation.
`;

const COLOR_PALETTE = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#65a30d",
] as const;

export interface DomainFileServiceOptions {
  database: DatabaseClient;
  /** Directory containing system.yaml and durable domains/prompts files. */
  systemRoot: string;
  /** Runtime state directory for content-addressed file-version records. */
  statePath?: string;
  /** Number of source versions retained per file. */
  historyLimit?: number;
  reclassification: DomainReclassification;
  /** Injectable file watcher for deterministic lifecycle tests. */
  watch?: typeof watch;
}

export interface DomainFileRefreshResult {
  source: JsonSource;
  projected: boolean;
  rules: DomainRuleRecord[] | null;
}

interface DomainSourceObject {
  [key: string]: unknown;
  domains: unknown[];
}

interface ParsedDomainEntry {
  source: Record<string, unknown>;
  projection: DomainRuleProjectionInput;
}

interface ParsedDomainFile {
  root: DomainSourceObject;
  entries: ParsedDomainEntry[];
}

export class DomainSourceNotFoundError extends Error {
  readonly code = "DOMAIN_SOURCE_NOT_FOUND" as const;

  constructor(repositoryId: string) {
    super(`Domain source was not found for repository: ${repositoryId}`);
    this.name = "DomainSourceNotFoundError";
  }
}

/** Invalid JSON is a client repairable error for direct saves. */
export class DomainSourceInvalidError extends InvalidRequestError {
  readonly code = "INVALID_REQUEST" as const;

  constructor(message: string) {
    super(`Domain source is invalid: ${message}`);
    this.name = "DomainSourceInvalidError";
  }
}

export class DomainVersionNotFoundError extends Error {
  readonly code = "DOMAIN_VERSION_NOT_FOUND" as const;

  constructor(versionId: string) {
    super(`Domain source version was not found: ${versionId}`);
    this.name = "DomainVersionNotFoundError";
  }
}

type DomainVersionSource = "manual" | "agent" | "external" | "restore";

interface StoredDomainVersion {
  id: string;
  path: string;
  version: number;
  hash: string;
  source: DomainVersionSource;
  createdAt: string;
  content: string;
}

/**
 * File-backed Domain definitions. JSON is the source of truth; SQLite keeps
 * the read-optimized classifier projection. Reads also lazily absorb changes
 * made by an Agent or an external editor, while invalid source remains
 * available for repair and the last valid projection stays active.
 */
export class DomainFileService {
  private readonly database: DatabaseClient;
  private readonly systemRoot: string;
  private readonly domainsRoot: string;
  private readonly promptsRoot: string;
  private readonly versionsRoot: string;
  private readonly historyLimit: number;
  private readonly reclassification: DomainReclassification;
  private readonly watch: typeof watch;
  private readonly projectedHashes = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private closed = false;

  constructor(options: DomainFileServiceOptions) {
    if (options.systemRoot.trim().length === 0) {
      throw new Error("Domain file systemRoot must not be empty");
    }
    this.database = options.database;
    this.systemRoot = resolve(options.systemRoot);
    this.domainsRoot = resolve(this.systemRoot, "domains");
    this.promptsRoot = resolve(this.systemRoot, "prompts");
    const statePath = resolve(options.statePath ?? join(this.systemRoot, ".loong"));
    this.versionsRoot = resolve(statePath, "domain-file-versions");
    this.historyLimit = options.historyLimit ?? 20;
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 1) {
      throw new Error("Domain file historyLimit must be a positive integer");
    }
    this.reclassification = options.reclassification;
    this.watch = options.watch ?? watch;
    mkdirSync(this.systemRoot, { recursive: true });
    mkdirSync(this.domainsRoot, { recursive: true });
    mkdirSync(this.promptsRoot, { recursive: true });
    mkdirSync(this.versionsRoot, { recursive: true, mode: 0o700 });
    assertDirectoryBoundary(this.systemRoot, this.domainsRoot);
    assertDirectoryBoundary(this.systemRoot, this.promptsRoot);
    assertDirectoryBoundary(statePath, this.versionsRoot);
  }

  /** Safe human-readable path for ordinary keys, encoded otherwise. */
  filePath(repositoryId: string): string {
    const key = repositoryId.trim();
    if (key.length === 0) throw new DomainSourceInvalidError("repository key is empty");
    const fileName =
      /^[A-Za-z0-9._-]+$/.test(key) && key !== "." && key !== ".."
        ? `${key}.json`
        : `${encodeURIComponent(key)}.json`;
    const path = resolve(this.domainsRoot, fileName);
    if (!isWithinRoot(this.domainsRoot, path) || extname(path) !== ".json") {
      throw new DomainSourceInvalidError("repository key maps outside domains root");
    }
    return path;
  }

  promptPath(): string {
    return resolve(this.promptsRoot, "update-domains.md");
  }

  source(repositoryId: string): JsonSource {
    this.refresh(repositoryId);
    const path = this.filePath(repositoryId);
    const content = readUtf8(path);
    const hash = sha256(content);
    const parsed = tryParseSource(content, repositoryId);
    return this.toSource(
      "domain",
      repositoryId,
      path,
      content,
      hash,
      parsed.success ? null : parsed.error,
    );
  }

  prompt(): JsonSource {
    const path = this.promptPath();
    ensureRegularTarget(path);
    if (!existsSync(path)) atomicWrite(path, DEFAULT_PROMPT);
    const content = readUtf8(path);
    const hash = sha256(content);
    this.recordVersion("prompt", "prompt", path, content, "external");
    return this.toSource("prompt", "prompt", path, content, hash);
  }

  savePrompt(content: string): JsonSource {
    const path = this.promptPath();
    ensureRegularTarget(path);
    atomicWrite(path, content);
    this.recordVersion("prompt", "prompt", path, content, "manual");
    return this.toSource("prompt", "prompt", path, content, sha256(content));
  }

  saveSource(repositoryId: string, content: string): JsonSource {
    return this.saveSourceWithSource(repositoryId, content, "manual");
  }

  private saveSourceWithSource(
    repositoryId: string,
    content: string,
    source: DomainVersionSource,
  ): JsonSource {
    const path = this.filePath(repositoryId);
    const parsed = parseSource(content, repositoryId);
    const normalized = `${JSON.stringify(parsed.root, null, 2)}\n`;
    ensureRegularTarget(path);
    // Parse and validate before touching the existing file. A malformed save
    // therefore cannot destroy the last valid source or projection.
    atomicWrite(path, normalized);
    this.recordVersion("domain", repositoryId, path, normalized, source);
    this.project(repositoryId, normalized, parsed, sha256(normalized), source);
    return this.toSource("domain", repositoryId, path, normalized, sha256(normalized), null);
  }

  refresh(repositoryId: string): DomainFileRefreshResult {
    const path = this.filePath(repositoryId);
    this.ensureSource(repositoryId, path);
    const content = readUtf8(path);
    const hash = sha256(content);
    const parsed = tryParseSource(content, repositoryId);
    const source: JsonSource = this.toSource(
      "domain",
      repositoryId,
      path,
      content,
      hash,
      parsed.success ? null : parsed.error,
    );
    if (!parsed.success) return { source, projected: false, rules: null };
    const projected = this.project(repositoryId, content, parsed.value, hash, "external");
    return {
      source,
      projected,
      rules: listDomainRules(this.database, repositoryId),
    };
  }

  listVersions(
    kind: "domain" | "prompt",
    repositoryId: string,
  ): JsonSourceVersion[] {
    return this.readVersions(kind, kind === "prompt" ? "prompt" : repositoryId).map(
      (version) => this.toVersion(version),
    );
  }

  version(
    kind: "domain" | "prompt",
    repositoryId: string,
    versionId: string,
  ): JsonSourceVersionDetail {
    const key = kind === "prompt" ? "prompt" : repositoryId;
    const record = this.readVersions(kind, key).find((candidate) => candidate.id === versionId);
    if (record === undefined) throw new DomainVersionNotFoundError(versionId);
    return { ...this.toVersion(record), content: record.content };
  }

  restoreSource(
    repositoryId: string,
    versionId: string,
  ): JsonSource {
    const record = this.version("domain", repositoryId, versionId);
    return this.saveSourceWithSource(repositoryId, record.content, "restore");
  }

  restorePrompt(versionId: string): JsonSource {
    const record = this.version("prompt", "prompt", versionId);
    const path = this.promptPath();
    ensureRegularTarget(path);
    atomicWrite(path, record.content);
    this.recordVersion("prompt", "prompt", path, record.content, "restore");
    return this.toSource("prompt", "prompt", path, record.content, sha256(record.content));
  }

  create(repositoryId: string, input: DomainRuleCreate): DomainRuleRecord {
    const current = this.readParsed(repositoryId);
    const position = current.entries.length;
    const now = new Date().toISOString();
    const projection: DomainRuleProjectionInput = {
      id: `dom_${randomBytes(8).toString("hex")}`,
      name: input.name,
      color: input.color ?? COLOR_PALETTE[position % COLOR_PALETTE.length]!,
      position,
      enabled: input.enabled !== false,
      includePatterns: input.includePatterns,
      excludePatterns: input.excludePatterns ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.writeEntries(repositoryId, current.root, [
      ...current.entries.map((entry) => entry),
      { source: {}, projection },
    ]);
    const created = getDomainRule(this.database, repositoryId, projection.id);
    if (created === null) throw new Error("Failed to read back created Domain rule");
    return created;
  }

  update(
    repositoryId: string,
    domainId: string,
    input: DomainRuleUpdate,
  ): DomainRuleRecord {
    const current = this.readParsed(repositoryId);
    const index = current.entries.findIndex((entry) => entry.projection.id === domainId);
    if (index < 0) throw new Error(`Domain rule not found: ${domainId}`);
    const previous = current.entries[index]!;
    const projection: DomainRuleProjectionInput = {
      ...previous.projection,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.includePatterns === undefined
        ? {}
        : { includePatterns: input.includePatterns }),
      ...(input.excludePatterns === undefined
        ? {}
        : { excludePatterns: input.excludePatterns }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: new Date().toISOString(),
    };
    const entries = [...current.entries];
    entries[index] = { source: previous.source, projection };
    this.writeEntries(repositoryId, current.root, entries);
    const updated = getDomainRule(this.database, repositoryId, domainId);
    if (updated === null) throw new Error("Failed to read back updated Domain rule");
    return updated;
  }

  remove(repositoryId: string, domainId: string): void {
    const current = this.readParsed(repositoryId);
    const remaining = current.entries.filter((entry) => entry.projection.id !== domainId);
    if (remaining.length === current.entries.length) {
      throw new Error(`Domain rule not found: ${domainId}`);
    }
    remaining.forEach((entry, index) => {
      entry.projection.position = index;
    });
    this.writeEntries(repositoryId, current.root, remaining);
  }

  start(): void {
    if (this.watcher !== null || this.closed) return;
    let domainWatcher: FSWatcher | null = null;
    let promptWatcher: FSWatcher | null = null;
    let groupClosed = false;
    const closeGroup = (): void => {
      if (groupClosed) return;
      groupClosed = true;
      if (domainWatcher !== null) closeWatcher(domainWatcher);
      if (promptWatcher !== null) closeWatcher(promptWatcher);
    };
    const compositeWatcher = { close: closeGroup } as FSWatcher;
    const handleWatcherError = (): void => {
      if (this.watcher === compositeWatcher) this.watcher = null;
      closeGroup();
    };
    try {
      domainWatcher = this.watch(this.domainsRoot, { recursive: true }, (_event, fileName) => {
        if (typeof fileName !== "string" || !fileName.endsWith(".json")) return;
        const candidate = resolve(this.domainsRoot, fileName);
        if (!isWithinRoot(this.domainsRoot, candidate)) return;
        const repositoryId = decodeRepositoryFileName(fileName);
        if (repositoryId === null) return;
        try {
          this.refresh(repositoryId);
        } catch {
          // Source errors stay visible through source(); the watcher must not
          // terminate because an editor temporarily wrote partial JSON.
        }
      });
      domainWatcher.on("error", handleWatcherError);
      // The update prompt is a shared file. Watching it here gives the same
      // content-addressed history semantics as repository JSON edits.
      promptWatcher = this.watch(this.promptsRoot, (_event, fileName) => {
        if (typeof fileName !== "string" || fileName !== "update-domains.md") return;
        try {
          const path = this.promptPath();
          ensureRegularTarget(path);
          const content = readUtf8(path);
          this.recordVersion("prompt", "prompt", path, content, "external");
        } catch {
          // An editor can briefly remove or replace the file while saving.
        }
      });
      promptWatcher.on("error", handleWatcherError);
      if (!groupClosed) this.watcher = compositeWatcher;
    } catch {
      closeGroup();
      // Reads lazily refresh when recursive watching is unavailable.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher !== null) closeWatcher(watcher);
  }

  private ensureSource(repositoryId: string, path: string): void {
    if (existsSync(path)) {
      ensureRegularTarget(path);
      return;
    }
    const rules = listDomainRules(this.database, repositoryId);
    const root: DomainSourceObject = {
      version: 1,
      repositoryId,
      domains: rules.map((rule) => toSourceRule(rule)),
    };
    const content = `${JSON.stringify(root, null, 2)}\n`;
    ensureRegularTarget(path);
    atomicWrite(path, content);
    this.recordVersion("domain", repositoryId, path, content, "external");
  }

  private readParsed(repositoryId: string): ParsedDomainFile {
    const path = this.filePath(repositoryId);
    this.ensureSource(repositoryId, path);
    const content = readUtf8(path);
    const parsed = parseSource(content, repositoryId);
    return parsed;
  }

  private writeEntries(
    repositoryId: string,
    root: DomainSourceObject,
    entries: readonly ParsedDomainEntry[],
  ): void {
    const nextRoot: DomainSourceObject = {
      ...root,
      domains: entries.map((entry) => toSourceRule(entry.projection, entry.source)),
    };
    this.saveSource(repositoryId, `${JSON.stringify(nextRoot, null, 2)}\n`);
  }

  private project(
    repositoryId: string,
    content: string,
    parsed: ParsedDomainFile,
    contentHash = sha256(content),
    source: DomainVersionSource = "external",
  ): boolean {
    this.recordVersion("domain", repositoryId, this.filePath(repositoryId), content, source);
    if (this.projectedHashes.get(repositoryId) === contentHash) return false;
    replaceDomainRulesFromFile(
      this.database,
      repositoryId,
      parsed.entries.map((entry) => entry.projection),
    );
    this.projectedHashes.set(repositoryId, contentHash);
    this.reclassification.trigger(repositoryId);
    return true;
  }

  private toSource(
    kind: "domain" | "prompt",
    repositoryId: string,
    path: string,
    content: string,
    hash: string,
    parseError: string | null = null,
  ): JsonSource {
    const versions = this.readVersions(kind, kind === "prompt" ? "prompt" : repositoryId);
    const latest = versions.at(-1);
    return {
      path: toSystemRelative(this.systemRoot, path),
      content,
      version: latest?.version ?? null,
      versionId: latest?.id ?? null,
      hash,
      parseError,
    };
  }

  private recordVersion(
    kind: "domain" | "prompt",
    repositoryId: string,
    path: string,
    content: string,
    source: DomainVersionSource,
  ): StoredDomainVersion {
    const key = kind === "prompt" ? "prompt" : repositoryId;
    const versions = this.readVersions(kind, key);
    const hash = sha256(content);
    const existing = versions.at(-1);
    if (existing?.hash === hash) return existing;
    const version = (existing?.version ?? 0) + 1;
    const next: StoredDomainVersion = {
      id: `ver_${version}_${hash.slice(0, 16)}`,
      path: toSystemRelative(this.systemRoot, path),
      version,
      hash,
      source,
      createdAt: new Date().toISOString(),
      content,
    };
    const retained = [...versions, next].slice(-this.historyLimit);
    const historyPath = this.historyPath(kind, key);
    ensureRegularTarget(historyPath);
    atomicWrite(historyPath, `${JSON.stringify(retained, null, 2)}\n`);
    return next;
  }

  private readVersions(
    kind: "domain" | "prompt",
    repositoryId: string,
  ): StoredDomainVersion[] {
    const path = this.historyPath(kind, repositoryId);
    if (!existsSync(path)) return [];
    ensureRegularTarget(path);
    let decoded: unknown;
    try {
      decoded = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new Error("Domain file history is invalid");
    }
    if (!Array.isArray(decoded)) throw new Error("Domain file history is invalid");
    return decoded.filter(isStoredDomainVersion);
  }

  private historyPath(kind: "domain" | "prompt", repositoryId: string): string {
    const encoded = encodeURIComponent(repositoryId);
    const path = resolve(this.versionsRoot, `${kind}-${encoded}.json`);
    if (!isWithinRoot(this.versionsRoot, path)) {
      throw new DomainSourceInvalidError("version key maps outside state root");
    }
    return path;
  }

  private toVersion(version: StoredDomainVersion): JsonSourceVersion {
    return {
      id: version.id,
      path: version.path,
      version: version.version,
      hash: version.hash,
      source: version.source,
      createdAt: version.createdAt,
      sizeBytes: Buffer.byteLength(version.content, "utf8"),
    };
  }
}

function closeWatcher(watcher: FSWatcher): void {
  try {
    watcher.close();
  } catch {
    // A failed watcher is already outside the normal close path.
  }
}

function parseSource(content: string, repositoryId: string): ParsedDomainFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    throw new DomainSourceInvalidError("JSON syntax is invalid");
  }
  const root: DomainSourceObject =
    Array.isArray(decoded)
      ? { version: 1, repositoryId, domains: decoded }
      : isRecord(decoded) && Array.isArray(decoded.domains)
        ? { ...decoded, domains: decoded.domains }
        : (() => {
            throw new DomainSourceInvalidError("expected an object with a domains array");
          })();
  const entries: ParsedDomainEntry[] = [];
  for (const [index, value] of root.domains.entries()) {
    if (!isRecord(value)) {
      throw new DomainSourceInvalidError(`domains[${index}] must be an object`);
    }
    entries.push({
      source: value,
      projection: toProjection(value, repositoryId, index),
    });
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.projection.id)) {
      throw new DomainSourceInvalidError(`duplicate domain id: ${entry.projection.id}`);
    }
    if (names.has(entry.projection.name)) {
      throw new DomainSourceInvalidError(
        `duplicate domain name: ${entry.projection.name}`,
      );
    }
    ids.add(entry.projection.id);
    names.add(entry.projection.name);
  }
  return { root, entries };
}

function tryParseSource(
  content: string,
  repositoryId: string,
): { success: true; value: ParsedDomainFile } | { success: false; error: string } {
  try {
    return { success: true, value: parseSource(content, repositoryId) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toProjection(
  value: Record<string, unknown>,
  repositoryId: string,
  index: number,
): DomainRuleProjectionInput {
  const name = requiredString(value.name, `domains[${index}].name`);
  const includePatterns = stringArray(value.includePatterns, `domains[${index}].includePatterns`);
  const excludePatterns =
    value.excludePatterns === undefined
      ? []
      : stringArray(value.excludePatterns, `domains[${index}].excludePatterns`);
  const id =
    typeof value.id === "string" && value.id.trim().length > 0
      ? value.id.trim()
      : `dom_${sha256(`${repositoryId}:${name}:${index}`).slice(0, 16)}`;
  const color =
    typeof value.color === "string" && domainColorSchema.safeParse(value.color).success
      ? value.color
      : COLOR_PALETTE[index % COLOR_PALETTE.length]!;
  const position =
    Number.isInteger(value.position) && Number(value.position) >= 0
      ? Number(value.position)
      : index;
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") {
    throw new DomainSourceInvalidError(`domains[${index}].enabled must be boolean`);
  }
  return {
    id,
    name,
    color,
    position,
    enabled,
    includePatterns,
    excludePatterns,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function toSourceRule(
  rule: DomainRuleRecord | DomainRuleProjectionInput,
  source: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...source,
    id: rule.id,
    name: rule.name,
    color: rule.color,
    position: rule.position,
    enabled: rule.enabled,
    includePatterns: [...rule.includePatterns],
    excludePatterns: [...rule.excludePatterns],
    ...(rule.createdAt === undefined ? {} : { createdAt: rule.createdAt }),
    ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainSourceInvalidError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new DomainSourceInvalidError(`${field} must be an array`);
  const values = value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new DomainSourceInvalidError(`${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  return values;
}

function ensureRegularTarget(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new DomainSourceInvalidError("source target must not be a symlink");
    }
  } catch (error) {
    if (error instanceof DomainSourceInvalidError) throw error;
    throw new DomainSourceInvalidError("source target cannot be inspected");
  }
}

function assertDirectoryBoundary(root: string, directory: string): void {
  try {
    if (lstatSync(directory).isSymbolicLink()) {
      throw new Error("directory must not be a symlink");
    }
    const realRoot = realpathSync(root);
    const realDirectory = realpathSync(directory);
    if (!isWithinRoot(realRoot, realDirectory)) {
      throw new Error("directory escapes its root");
    }
  } catch (error) {
    throw new Error(
      `Domain file directory is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readUtf8(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new DomainSourceNotFoundError(path);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSystemRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function decodeRepositoryFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const encoded = fileName.slice(0, -5);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function isStoredDomainVersion(value: unknown): value is StoredDomainVersion {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    typeof value.hash === "string" &&
    (value.source === "manual" ||
      value.source === "agent" ||
      value.source === "external" ||
      value.source === "restore") &&
    typeof value.createdAt === "string" &&
    typeof value.content === "string"
  );
}
