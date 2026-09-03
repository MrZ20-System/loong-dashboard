import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, watch } from "node:fs";
import { resolve } from "node:path";

import type {
  AgentSessionResponse,
  KnowledgeDocument,
  KnowledgeTreeItem,
  KnowledgeVersionsResponse,
} from "@loongboard/contracts";
import {
  agentSessionResponseSchema,
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
  serializeDocument,
  type KnowledgeFileInfo,
} from "@loongboard/knowledge";

import { runCheckpoint } from "@loongboard/git-workspace";

import type { FastifyInstance } from "fastify";
import { parseRequest, sendParsed } from "./route-helpers.js";
import type { AgentChatController } from "./agent-chat.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function deriveTitle(path: string, content: string): string {
  const parsed = parseMarkdown(content);
  if (parsed.title !== null) return parsed.title;
  return path.split("/").at(-1)?.replace(/\.md$/, "") ?? path;
}

/** Remove a leading `---` front matter block, if present. */
function stripFrontMatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
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

export interface KnowledgeCheckpointOptions {
  autoCommit?: boolean;
  autoPush?: boolean;
  remote?: string;
  branch?: string;
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
    branch: string;
  };
  private watcher: ReturnType<typeof watch> | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAgentVersions = new Map<string, string>();
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
      branch: options.checkpoint?.branch ?? "main",
    };
  }

  private fsPath(repositoryPath: string): string {
    const absolute = resolve(this.knowledgePath, repositoryPath);
    if (!isWithinRoot(this.knowledgePath, absolute)) {
      throw new Error(`Knowledge path escapes the repository root: ${repositoryPath}`);
    }
    return absolute;
  }
  /**
   * Deterministic Knowledge Git checkpoint (plan 15.6). Off by default;
   * failures are only logged, never auto-merged or retried.
   */
  private maybeCheckpoint(): void {
    if (!this.checkpoint.autoCommit) return;
    void runCheckpoint({
      repositoryPath: this.knowledgePath,
      message: `chore(knowledge): checkpoint ${new Date().toISOString()}`,
      push: this.checkpoint.autoPush,
      remote: this.checkpoint.remote,
      branch: this.checkpoint.branch,
    }).then((result) => {
      if (result.error !== undefined) {
        console.error(`Knowledge checkpoint failed: ${result.error}`);
      }
    });
  }


  tree(): KnowledgeTreeItem[] {
    this.indexExternalChanges();
    return scanKnowledgeFiles(this.knowledgePath).map((file) => ({
      path: file.path,
      documentId: file.documentId,
      title: file.title,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
    }));
  }

  /** Read by repository path; documents without an id stay unindexed. */
  readByPath(repositoryPath: string): KnowledgeDocument {
    this.indexExternalChanges();
    return this.readByPathUnchecked(repositoryPath);
  }

  readById(documentIdValue: string): KnowledgeDocument {
    this.requireIndexed(documentIdValue);
    return this.readByPath(this.indexedPath(documentIdValue));
  }

  create(input: { path: string; title: string; content: string }): KnowledgeDocument {
    const absolute = this.fsPath(input.path);
    if (existsSync(absolute)) throw new KnowledgeDocumentConflictError(input.path);
    const id = documentId();
    const content = createMarkdown(id, input.title, input.content);
    atomicWrite(absolute, content);
    const row = upsertKnowledgeDocument(this.database, {
      id,
      path: input.path,
      title: deriveTitle(input.path, content),
      contentHash: sha256(content),
    });
    addDocumentVersion(this.database, { documentId: id, content, source: "manual" });
    this.maybeCheckpoint();
    return this.toDocument(input.path, id, content, row.defaultSessionId);
  }

  /** Save content at a path; files without a front-matter id are adopted. */
  saveByPath(repositoryPath: string, content: string): KnowledgeDocument {
    const absolute = this.fsPath(repositoryPath);
    if (!existsSync(absolute)) throw new KnowledgeDocumentNotFoundError(repositoryPath);
    // A path keeps its document identity: an existing index row wins over any
    // id written into the incoming content (a stale copy must not fork).
    const existing = getKnowledgeDocumentByPath(this.database, repositoryPath);
    const parsed = parseMarkdown(content);
    const normalized =
      existing !== null && parsed.documentId !== existing.id
        ? serializeDocument(existing.id, stripFrontMatter(content))
        : content;
    const adopted = ensureDocumentId(normalized);
    atomicWrite(absolute, adopted.content);
    const row = upsertKnowledgeDocument(this.database, {
      id: adopted.documentId,
      path: repositoryPath,
      title: deriveTitle(repositoryPath, adopted.content),
      contentHash: sha256(adopted.content),
    });
    addDocumentVersion(this.database, {
      documentId: adopted.documentId,
      content: adopted.content,
      source: "manual",
    });
    this.maybeCheckpoint();
    return this.toDocument(repositoryPath, adopted.documentId, adopted.content, row.defaultSessionId);
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
    const updated = updateKnowledgeDocumentPath(this.database, documentIdValue, newPath);
    const content = readFileSync(target, "utf8");
    this.maybeCheckpoint();
    return this.toDocument(newPath, documentIdValue, content, updated.defaultSessionId);
  }

  remove(documentIdValue: string): void {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    const absolute = this.fsPath(row.path);
    if (existsSync(absolute)) unlinkSync(absolute);
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
    upsertKnowledgeDocument(this.database, {
      id: documentIdValue,
      path: row.path,
      title: deriveTitle(row.path, content),
      contentHash: sha256(content),
      defaultSessionId: row.defaultSessionId,
    });
    addDocumentVersion(this.database, { documentId: documentIdValue, content, source: "restore" });
    this.maybeCheckpoint();
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
    try {
      this.watcher = watch(this.knowledgePath, { recursive: true }, (_event, fileName) => {
        if (typeof fileName !== "string") return;
        if (!fileName.endsWith(".md") && !fileName.endsWith(".markdown")) return;
        this.scheduleRescan();
      });
    } catch {
      // Recursive watching is unavailable on some platforms; every read
      // re-runs indexExternalChanges so content stays fresh.
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

  /**
   * Create versions for changes that arrived outside LoongBoard (plan 15.4).
   * While a knowledge agent session runs, changes per document are aggregated
   * and flushed as one `agent` version when the agent becomes idle.
   */
  private indexExternalChanges(): void {
    const files = scanKnowledgeFiles(this.knowledgePath);
    const indexed = new Map(
      listKnowledgeDocuments(this.database).map((row) => [row.path, row] as const),
    );
    const agentRunning = listRunningKnowledgeSessionIds(this.database).length > 0;

    for (const file of files) {
      if (file.documentId === null) continue;
      const row = indexed.get(file.path);
      const hash = this.fileHash(file.path);
      if (row === undefined || row.contentHash === hash) continue;
      const content = readFileSync(this.fsPath(file.path), "utf8");
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
    this.maybeCheckpoint();
  }

  private fileHash(path: string): string {
    try {
      return sha256(readFileSync(this.fsPath(path), "utf8"));
    } catch {
      return "";
    }
  }

  private requireIndexed(documentIdValue: string) {
    const row = getKnowledgeDocument(this.database, documentIdValue);
    if (row === null) throw new KnowledgeDocumentNotFoundError(documentIdValue);
    return row;
  }

  private indexedPath(documentIdValue: string): string {
    return this.requireIndexed(documentIdValue).path;
  }

  private readByPathUnchecked(repositoryPath: string): KnowledgeDocument {
    const absolute = this.fsPath(repositoryPath);
    if (!existsSync(absolute)) throw new KnowledgeDocumentNotFoundError(repositoryPath);
    const parsed = parseMarkdown(readFileSync(absolute, "utf8"));
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
