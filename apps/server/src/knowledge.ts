import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
} from "node:fs";
import { extname, resolve } from "node:path";

import type {
  AgentSessionResponse,
  KnowledgeDocument,
  KnowledgeTreeItem,
  KnowledgeVersionsResponse,
} from "@loongboard/contracts";
import {
  agentSessionResponseSchema,
  knowledgeAssetPathQuerySchema,
  knowledgeDocumentCreateSchema,
  knowledgeDocumentParamsSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentUpdateSchema,
  knowledgeMoveSchema,
  knowledgePathQuerySchema,
  knowledgeTreeResponseSchema,
  knowledgeVersionParamsSchema,
  knowledgeVersionsResponseSchema,
} from "@loongboard/contracts";
import {
  addDocumentVersion,
  deleteKnowledgeDocument,
  getDocumentVersion,
  getKnowledgeDocument,
  getKnowledgeDocumentByPath,
  listDocumentVersions,
  listKnowledgeDocuments,
  listRunningKnowledgeSessionIds,
  requireAgentSession,
  setKnowledgeDocumentDefaultSession,
  updateKnowledgeDocumentPath,
  upsertKnowledgeDocument,
  type DatabaseClient,
} from "@loongboard/database";
import {
  atomicWrite,
  createMarkdown,
  documentId,
  ensureDocumentId,
  isWithinRoot,
  parseMarkdown,
  scanKnowledgeFiles,
  withDocumentId,
  type KnowledgeFileSnapshot,
} from "@loongboard/knowledge";

import {
  pushBackupRef,
  runCheckpoint,
  type RunCheckpointResult,
} from "@loongboard/git-workspace";

import type { FastifyInstance } from "fastify";
import {
  InvalidRequestError,
  parseRequest,
  sendParsed,
} from "./route-helpers.js";
import type { AgentChatController } from "./agent-chat.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function deriveTitle(path: string, content: string): string {
  const parsed = parseMarkdown(content);
  if (parsed.title !== null) return parsed.title;
  return path.split("/").at(-1)?.replace(/\.md$/, "") ?? path;
}

export class KnowledgeDocumentNotFoundError extends Error {
  readonly code = "KNOWLEDGE_DOCUMENT_NOT_FOUND" as const;

  constructor(reference: string) {
    super(`Knowledge document was not found: ${reference}`);
    this.name = "KnowledgeDocumentNotFoundError";
  }
}

export class KnowledgeDocumentConflictError extends Error {
  readonly code = "KNOWLEDGE_DOCUMENT_CONFLICT" as const;

  constructor(path: string) {
    super(`A knowledge document already exists at: ${path}`);
    this.name = "KnowledgeDocumentConflictError";
  }
}

/** Image MIME types served for Markdown references (plan 17.6, image assets). */
const KNOWLEDGE_ASSET_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export class KnowledgeAssetNotFoundError extends Error {
  readonly code = "FILE_NOT_FOUND" as const;

  constructor(reference: string) {
    super(`Knowledge asset was not found: ${reference}`);
    this.name = "KnowledgeAssetNotFoundError";
  }
}

export interface KnowledgeCheckpointOptions {
  autoCommit?: boolean;
  autoPush?: boolean;
  remote?: string;
  sourceRef?: string;
  remoteBranch?: string;
  branch?: string;
  intervalMinutes?: number | null;
  checkpointIntervalMinutes?: number | null;
  pushIntervalMinutes?: number | null;
}

export interface KnowledgeControllerOptions {
  database: DatabaseClient;
  knowledgePath: string;
  /** Versions kept per document (plan 15.4). */
  historyLimit?: number;
  /** Chat controller used for the default document chat (plan 15.5). */
  chats: AgentChatController;
  /** Knowledge-only Git checkpoint (plan 15.6); off unless configured. */
  checkpoint?: KnowledgeCheckpointOptions;
}

/**
 * Knowledge repository controller (plan 15, 17.6). Markdown files on disk are
 * the source of truth; SQLite only indexes documents and their short-term
 * history. Writes are atomic temp+rename. Versions cover manual saves,
 * external edits (debounced recursive watcher), restores, and one aggregated
 * version per running knowledge agent turn.
 */
export class KnowledgeController {
  readonly database: DatabaseClient;
  private readonly knowledgePath: string;
  private readonly historyLimit: number;
  private readonly chats: AgentChatController;
  private readonly checkpoint: {
    autoCommit: boolean;
    autoPush: boolean;
    remote: string;
    sourceRef: string;
    remoteBranch: string;
    branch: string;
    intervalMinutes: number | null;
    checkpointIntervalMinutes: number | null;
    pushIntervalMinutes: number | null;
  };
  private watcher: ReturnType<typeof watch> | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAgentVersions = new Map<string, string>();
  private snapshots = new Map<string, KnowledgeFileSnapshot>();
  private indexDirty = true;
  private closed = false;

  constructor(options: KnowledgeControllerOptions) {
    this.database = options.database;
    this.knowledgePath = options.knowledgePath;
    this.historyLimit = options.historyLimit ?? 10;
    this.chats = options.chats;
    this.checkpoint = {
      autoCommit: options.checkpoint?.autoCommit ?? false,
      autoPush: options.checkpoint?.autoPush ?? false,
      remote: options.checkpoint?.remote ?? "origin",
      sourceRef: options.checkpoint?.sourceRef ?? options.checkpoint?.branch ?? "main",
      remoteBranch: options.checkpoint?.remoteBranch ?? "loongboard-knowledge-backup",
      branch: options.checkpoint?.branch ?? "main",
      intervalMinutes: options.checkpoint?.intervalMinutes ?? null,
      checkpointIntervalMinutes: options.checkpoint?.checkpointIntervalMinutes ?? options.checkpoint?.intervalMinutes ?? null,
      pushIntervalMinutes: options.checkpoint?.pushIntervalMinutes ?? null,
    };
  }

  private fsPath(repositoryPath: string): string {
    const absolute = resolve(this.knowledgePath, repositoryPath);
    if (!isWithinRoot(this.knowledgePath, absolute)) {
      throw new Error(`Knowledge path escapes the repository root: ${repositoryPath}`);
    }
    return absolute;
  }
  /** Current Knowledge checkpoint settings, excluding runtime status fields. */
  checkpointSettings(): KnowledgeCheckpointOptions {
    return { ...this.checkpoint };
  }

  /** Apply Settings changes to future manual and scheduled checkpoints. */
  updateCheckpoint(settings: KnowledgeCheckpointOptions): void {
    if (settings.autoCommit !== undefined) this.checkpoint.autoCommit = settings.autoCommit;
    if (settings.autoPush !== undefined) this.checkpoint.autoPush = settings.autoPush;
    if (settings.remote !== undefined) this.checkpoint.remote = settings.remote;
    if (settings.sourceRef !== undefined) this.checkpoint.sourceRef = settings.sourceRef;
    else if (settings.branch !== undefined) this.checkpoint.sourceRef = settings.branch;
    if (settings.remoteBranch !== undefined) this.checkpoint.remoteBranch = settings.remoteBranch;
    if (settings.branch !== undefined) this.checkpoint.branch = settings.branch;
    if (settings.intervalMinutes !== undefined) {
      this.checkpoint.intervalMinutes = settings.intervalMinutes;
    }
    if (settings.checkpointIntervalMinutes !== undefined) this.checkpoint.checkpointIntervalMinutes = settings.checkpointIntervalMinutes;
    if (settings.pushIntervalMinutes !== undefined) this.checkpoint.pushIntervalMinutes = settings.pushIntervalMinutes;
  }

  /** Run the existing Knowledge checkpoint immediately; push is opt-in. */
  async runCheckpointNow(options: { push?: boolean } = {}): Promise<RunCheckpointResult> {
    return runCheckpoint({
      repositoryPath: this.knowledgePath,
      message: `chore(knowledge): checkpoint ${new Date().toISOString()}`,
      push: options.push ?? false,
      remote: this.checkpoint.remote,
      sourceRef: this.checkpoint.sourceRef,
      remoteBranch: this.checkpoint.remoteBranch,
    });
  }

  /** Push the configured source ref without creating a checkpoint commit. */
  async runPushNow(): Promise<RunCheckpointResult> {
    const result = await pushBackupRef({
      repositoryPath: this.knowledgePath,
      remote: this.checkpoint.remote,
      sourceRef: this.checkpoint.sourceRef,
      remoteBranch: this.checkpoint.remoteBranch,
    });
    return {
      committed: false,
      pushed: result.pushed,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
  tree(): KnowledgeTreeItem[] {
    return this.currentFiles().map((file) => ({
      path: file.path,
      documentId: file.documentId,
      title: file.title,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
    }));
  }

  /** Read by repository path; documents without an id stay unindexed. */
  readByPath(repositoryPath: string): KnowledgeDocument {
    const file = this.currentFiles().find(
      (candidate) => candidate.path === repositoryPath,
    );
    if (file === undefined) {
      throw new KnowledgeDocumentNotFoundError(repositoryPath);
    }
    return this.toReadDocument(file.path, file.content);
  }

  readById(documentIdValue: string): KnowledgeDocument {
    this.requireIndexed(documentIdValue);
    return this.readByPath(this.indexedPath(documentIdValue));
  }

  /**
   * Serve a Markdown-referenced image from the knowledge root (plan 17.6).
   * The repository-relative path must stay inside the root after symlink
   * resolution and name a regular file with a supported image extension.
   */
  readAsset(repositoryPath: string): { bytes: Buffer; mimeType: string } {
    const absolute = resolve(this.knowledgePath, repositoryPath);
    if (!isWithinRoot(this.knowledgePath, absolute)) {
      throw new InvalidRequestError(
        `Knowledge asset path escapes the knowledge root: ${repositoryPath}`,
      );
    }
    const mimeType =
      KNOWLEDGE_ASSET_MIME_TYPES[extname(repositoryPath).toLowerCase()];
    if (mimeType === undefined) {
      throw new InvalidRequestError(
        `Unsupported knowledge asset type: ${repositoryPath}`,
      );
    }
    let realPath: string;
    try {
      realPath = realpathSync(absolute);
    } catch {
      throw new KnowledgeAssetNotFoundError(repositoryPath);
    }
    if (!isWithinRoot(realpathSync(this.knowledgePath), realPath)) {
      throw new InvalidRequestError(
        `Knowledge asset path escapes the knowledge root: ${repositoryPath}`,
      );
    }
    const stats = statSync(realPath);
    if (!stats.isFile()) throw new KnowledgeAssetNotFoundError(repositoryPath);
    return { bytes: readFileSync(realPath), mimeType };
  }

  create(input: { path: string; title: string; content: string }): KnowledgeDocument {
    const absolute = this.fsPath(input.path);
    if (existsSync(absolute)) throw new KnowledgeDocumentConflictError(input.path);
    const id = documentId();
    const content = createMarkdown(id, input.title, input.content);
    atomicWrite(absolute, content);
    this.indexDirty = true;
    const row = upsertKnowledgeDocument(this.database, {
      id,
      path: input.path,
      title: deriveTitle(input.path, content),
      contentHash: sha256(content),
    });
    addDocumentVersion(this.database, { documentId: id, content, source: "manual" });
    return this.toDocument(input.path, id, content, row.defaultSessionId);
  }

  /** Save content at a path; files without a front-matter id are adopted. */
  saveByPath(repositoryPath: string, content: string): KnowledgeDocument {
    const absolute = this.fsPath(repositoryPath);
    if (!existsSync(absolute)) throw new KnowledgeDocumentNotFoundError(repositoryPath);
    // A path keeps its document identity: an existing index row wins over any
    // id written into the incoming content (a stale copy must not fork). Only
    // the `loongboard_id` line is ever rewritten; other front matter bytes
    // stay untouched.
    const existing = getKnowledgeDocumentByPath(this.database, repositoryPath);
    const parsed = parseMarkdown(content);
    let normalized: string;
    let documentIdValue: string;
    if (existing !== null && parsed.documentId !== existing.id) {
      normalized = withDocumentId(content, existing.id);
      documentIdValue = existing.id;
    } else if (parsed.documentId !== null) {
      normalized = content;
      documentIdValue = parsed.documentId;
    } else {
      const adopted = ensureDocumentId(content);
      normalized = adopted.content;
      documentIdValue = adopted.documentId;
    }
    atomicWrite(absolute, normalized);
    this.indexDirty = true;
    const row = upsertKnowledgeDocument(this.database, {
      id: documentIdValue,
      path: repositoryPath,
      title: deriveTitle(repositoryPath, normalized),
      contentHash: sha256(normalized),
    });
    addDocumentVersion(this.database, {
      documentId: documentIdValue,
      content: normalized,
      source: "manual",
    });
    return this.toDocument(repositoryPath, documentIdValue, normalized, row.defaultSessionId);
  }

  saveById(documentIdValue: string, content: string): KnowledgeDocument {
    return this.saveByPath(this.indexedPath(documentIdValue), content);
  }

  move(documentIdValue: string, newPath: string): KnowledgeDocument {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    const source = this.fsPath(row.path);
    const target = this.fsPath(newPath);
    if (!existsSync(source)) throw new KnowledgeDocumentNotFoundError(row.path);
    if (existsSync(target)) throw new KnowledgeDocumentConflictError(newPath);
    renameSync(source, target);
    this.indexDirty = true;
    const updated = updateKnowledgeDocumentPath(this.database, documentIdValue, newPath);
    const content = readFileSync(target, "utf8");
    return this.toDocument(newPath, documentIdValue, content, updated.defaultSessionId);
  }

  remove(documentIdValue: string): void {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    const absolute = this.fsPath(row.path);
    if (existsSync(absolute)) unlinkSync(absolute);
    this.indexDirty = true;
    deleteKnowledgeDocument(this.database, documentIdValue);
  }

  versions(documentIdValue: string): KnowledgeVersionsResponse {
    this.requireIndexed(documentIdValue);
    return { items: listDocumentVersions(this.database, documentIdValue, this.historyLimit) };
  }

  restore(documentIdValue: string, versionId: string): KnowledgeDocument {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    const { content } = getDocumentVersion(this.database, documentIdValue, versionId);
    const absolute = this.fsPath(row.path);
    atomicWrite(absolute, content);
    this.indexDirty = true;
    upsertKnowledgeDocument(this.database, {
      id: documentIdValue,
      path: row.path,
      title: deriveTitle(row.path, content),
      contentHash: sha256(content),
      defaultSessionId: row.defaultSessionId,
    });
    addDocumentVersion(this.database, { documentId: documentIdValue, content, source: "restore" });
    return this.toDocument(row.path, documentIdValue, content, row.defaultSessionId);
  }

  /** Ensure the default chat session of a document exists (plan 15.5). */
  async defaultChat(documentIdValue: string): Promise<AgentSessionResponse> {
    this.requireIndexed(documentIdValue);
    const row = this.requireIndexed(documentIdValue);
    if (row.defaultSessionId !== null) {
      try {
        const session = requireAgentSession(this.database, row.defaultSessionId);
        return await this.chats.view(session.id);
      } catch {
        // Stored default no longer exists; create a fresh one below.
      }
    }
    const view = await this.chats.ensureSession({
      scope: { kind: "knowledge", knowledgeDocumentId: documentIdValue },
    });
    setKnowledgeDocumentDefaultSession(this.database, documentIdValue, view.session.id);
    return view;
  }

  start(): void {
    if (this.watcher !== null) return;
    // Register the watcher before the synchronous initial scan. Any event
    // raised during that scan is delivered on the next event-loop turn and
    // marks the completed snapshot dirty, closing the scan/watch race.
    try {
      this.watcher = watch(this.knowledgePath, { recursive: true }, (_event, fileName) => {
        if (typeof fileName !== "string") return;
        if (!fileName.endsWith(".md") && !fileName.endsWith(".markdown")) return;
        this.indexDirty = true;
        this.scheduleRescan();
      });
    } catch {
      // Recursive watching is unavailable on some platforms; every read
      // re-runs indexExternalChanges so content stays fresh.
    }
    // Markdown may already exist when the state DB is new; index it before
    // start returns so id-based routes resolve immediately.
    try {
      this.indexExternalChanges();
    } catch {
      // Best-effort startup scan; every read re-runs it.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.rescanTimer !== null) clearTimeout(this.rescanTimer);
    this.rescanTimer = null;
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    this.indexExternalChanges();
  }

  private scheduleRescan(): void {
    if (this.closed) return;
    if (this.rescanTimer !== null) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      try {
        this.indexExternalChanges();
      } catch {
        // Best-effort; the next read re-runs it.
      }
    }, 1_000);
  }

  private currentFiles(): KnowledgeFileSnapshot[] {
    if (this.watcher !== null && !this.indexDirty) {
      return [...this.snapshots.values()];
    }
    return this.indexExternalChanges();
  }

  /**
   * Index Markdown found before/outside LoongBoard and create versions for
   * changes that arrived outside LoongBoard (plan 15.4). While a knowledge
   * agent session runs, changes per document are aggregated and flushed as
   * one `agent` version when the agent becomes idle.
   */
  private indexExternalChanges(): KnowledgeFileSnapshot[] {
    const files = scanKnowledgeFiles(this.knowledgePath);
    const indexed = new Map(
      listKnowledgeDocuments(this.database).map((row) => [row.path, row] as const),
    );
    const agentRunning = listRunningKnowledgeSessionIds(this.database).length > 0;

    for (const file of files) {
      if (file.documentId === null) continue;
      const row = indexed.get(file.path);
      if (row !== undefined && row.contentHash === file.contentHash) continue;
      const content = file.content;
      if (row === undefined) {
        // Fresh state DB or a file added outside LoongBoard: the durable
        // index row is needed immediately; its baseline version follows the
        // same aggregation rules as any other external arrival.
        const inserted = upsertKnowledgeDocument(this.database, {
          id: file.documentId,
          path: file.path,
          title: file.title,
          contentHash: sha256(content),
        });
        if (agentRunning) {
          this.pendingAgentVersions.set(file.path, content);
          continue;
        }
        addDocumentVersion(this.database, {
          documentId: inserted.id,
          content,
          source: "external",
        });
        continue;
      }
      if (agentRunning) {
        this.pendingAgentVersions.set(file.path, content);
        continue;
      }
      this.flushVersion(row.id, row.path, content, "external");
    }

    if (!agentRunning && this.pendingAgentVersions.size > 0) {
      const pending = [...this.pendingAgentVersions.entries()];
      this.pendingAgentVersions.clear();
      for (const [path, content] of pending) {
        const row = indexed.get(path);
        if (row !== undefined) this.flushVersion(row.id, row.path, content, "agent");
      }
    }
    this.snapshots = new Map(files.map((file) => [file.path, file] as const));
    this.indexDirty = false;
    return files;
  }

  private flushVersion(
    documentIdValue: string,
    path: string,
    content: string,
    source: "external" | "agent",
  ): void {
    upsertKnowledgeDocument(this.database, {
      id: documentIdValue,
      path,
      title: deriveTitle(path, content),
      contentHash: sha256(content),
    });
    addDocumentVersion(this.database, { documentId: documentIdValue, content, source });
  }

  private requireIndexed(documentIdValue: string) {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    return row;
  }

  private indexedPath(documentIdValue: string): string {
    return this.requireIndexed(documentIdValue).path;
  }

  private toReadDocument(repositoryPath: string, content: string): KnowledgeDocument {
    const parsed = parseMarkdown(content);
    const row =
      parsed.documentId === null ? null : getKnowledgeDocument(this.database, parsed.documentId);
    return {
      id: parsed.documentId,
      path: repositoryPath,
      title: row?.title ?? deriveTitle(repositoryPath, parsed.raw),
      content: parsed.raw,
      contentHash: sha256(parsed.raw),
      defaultSessionId: row?.defaultSessionId ?? null,
      createdAt: row?.createdAt ?? new Date(0).toISOString(),
      updatedAt: row?.updatedAt ?? new Date(0).toISOString(),
    };
  }

  private toDocument(
    path: string,
    id: string,
    content: string,
    defaultSessionId: string | null,
  ): KnowledgeDocument {
    const row = getKnowledgeDocumentByPath(this.database, path);
    return {
      id,
      path,
      title: row?.title ?? deriveTitle(path, content),
      content,
      contentHash: sha256(content),
      defaultSessionId,
      createdAt: row?.createdAt ?? new Date().toISOString(),
      updatedAt: row?.updatedAt ?? new Date().toISOString(),
    };
  }
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  controller: KnowledgeController,
): void {
  app.get("/api/knowledge/tree", async (_request, reply) => {
    const items = controller.tree();
    return sendParsed(reply, 200, knowledgeTreeResponseSchema, { items });
  });

  app.get("/api/knowledge/assets", async (request, reply) => {
    const { path } = parseRequest(knowledgeAssetPathQuerySchema, request.query);
    const asset = controller.readAsset(path);
    return reply
      .header("content-type", asset.mimeType)
      .header("x-content-type-options", "nosniff")
      .send(asset.bytes);
  });

  app.get("/api/knowledge/documents", async (request, reply) => {
    const { path } = parseRequest(knowledgePathQuerySchema, request.query);
    const document = controller.readByPath(path);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.post("/api/knowledge/documents", async (request, reply) => {
    const body = parseRequest(knowledgeDocumentCreateSchema, request.body);
    const document = controller.create(body);
    return sendParsed(reply, 201, knowledgeDocumentSchema, document);
  });

  app.put("/api/knowledge/documents", async (request, reply) => {
    const { path } = parseRequest(knowledgePathQuerySchema, request.query);
    const body = parseRequest(knowledgeDocumentUpdateSchema, request.body);
    const document = controller.saveByPath(path, body.content);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.get("/api/knowledge/documents/:id", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    const document = controller.readById(id);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.put("/api/knowledge/documents/:id", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    const body = parseRequest(knowledgeDocumentUpdateSchema, request.body);
    const document = controller.saveById(id, body.content);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.post("/api/knowledge/documents/:id/move", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    const body = parseRequest(knowledgeMoveSchema, request.body);
    const document = controller.move(id, body.path);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.delete("/api/knowledge/documents/:id", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    controller.remove(id);
    return reply.code(200).send({ deleted: true });
  });

  app.get("/api/knowledge/documents/:id/versions", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    const result = controller.versions(id);
    return sendParsed(reply, 200, knowledgeVersionsResponseSchema, result);
  });

  app.post("/api/knowledge/documents/:id/versions/:versionId/restore", async (request, reply) => {
    const { id, versionId } = parseRequest(knowledgeVersionParamsSchema, request.params);
    const document = controller.restore(id, versionId);
    return sendParsed(reply, 200, knowledgeDocumentSchema, document);
  });

  app.post("/api/knowledge/documents/:id/chat", async (request, reply) => {
    const { id } = parseRequest(knowledgeDocumentParamsSchema, request.params);
    const result = await controller.defaultChat(id);
    return sendParsed(reply, 200, agentSessionResponseSchema, result);
  });
}
