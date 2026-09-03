import { randomBytes } from "node:crypto";

import type { KnowledgeVersion } from "@loongboard/contracts";

import type { DatabaseClient } from "./types.js";

export class KnowledgeDocumentNotFoundError extends Error {
  readonly code = "KNOWLEDGE_DOCUMENT_NOT_FOUND" as const;

  constructor(documentId: string) {
    super(`Knowledge document was not found: ${documentId}`);
    this.name = "KnowledgeDocumentNotFoundError";
  }
}

export class KnowledgeVersionNotFoundError extends Error {
  readonly code = "KNOWLEDGE_VERSION_NOT_FOUND" as const;

  constructor(versionId: string) {
    super(`Knowledge document version was not found: ${versionId}`);
    this.name = "KnowledgeVersionNotFoundError";
  }
}

export interface KnowledgeDocumentRow {
  id: string;
  path: string;
  title: string;
  contentHash: string;
  defaultSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionRecord extends KnowledgeVersion {}

interface KnowledgeDocumentRowSql {
  id: string;
  path: string;
  title: string;
  content_hash: string;
  default_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapDocument(row: KnowledgeDocumentRowSql): KnowledgeDocumentRow {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    contentHash: row.content_hash,
    defaultSessionId: row.default_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DOCUMENT_COLUMNS =
  "id, path, title, content_hash, default_session_id, created_at, updated_at";

export function listKnowledgeDocuments(database: DatabaseClient): KnowledgeDocumentRow[] {
  const rows = database
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents ORDER BY path ASC`)
    .all() as KnowledgeDocumentRowSql[];
  return rows.map(mapDocument);
}

export function getKnowledgeDocument(
  database: DatabaseClient,
  documentId: string,
): KnowledgeDocumentRow | null {
  const row = database
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE id = ?`)
    .get(documentId) as KnowledgeDocumentRowSql | undefined;
  return row === undefined ? null : mapDocument(row);
}

export function getKnowledgeDocumentByPath(
  database: DatabaseClient,
  path: string,
): KnowledgeDocumentRow | null {
  const row = database
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE path = ?`)
    .get(path) as KnowledgeDocumentRowSql | undefined;
  return row === undefined ? null : mapDocument(row);
}

export function upsertKnowledgeDocument(
  database: DatabaseClient,
  input: {
    id: string;
    path: string;
    title: string;
    contentHash: string;
    defaultSessionId?: string | null;
    now?: string;
  },
): KnowledgeDocumentRow {
  const now = input.now ?? new Date().toISOString();
  database
    .prepare(
      `INSERT INTO knowledge_documents (
        id, path, title, content_hash, default_session_id, created_at, updated_at
      ) VALUES (@id, @path, @title, @contentHash, @defaultSessionId, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        title = excluded.title,
        content_hash = excluded.content_hash,
        default_session_id = COALESCE(excluded.default_session_id, knowledge_documents.default_session_id),
        updated_at = excluded.updated_at`,
    )
    .run({
      id: input.id,
      path: input.path,
      title: input.title,
      contentHash: input.contentHash,
      defaultSessionId: input.defaultSessionId ?? null,
      now,
    });
  const created = getKnowledgeDocument(database, input.id);
  if (created === null) {
    throw new Error("Failed to read back the knowledge document row");
  }
  return created;
}

export function updateKnowledgeDocumentPath(
  database: DatabaseClient,
  documentId: string,
  path: string,
  now: string = new Date().toISOString(),
): KnowledgeDocumentRow {
  database
    .prepare("UPDATE knowledge_documents SET path = ?, updated_at = ? WHERE id = ?")
    .run(path, now, documentId);
  return requireKnowledgeDocument(database, documentId);
}

export function setKnowledgeDocumentDefaultSession(
  database: DatabaseClient,
  documentId: string,
  sessionId: string | null,
): void {
  database
    .prepare("UPDATE knowledge_documents SET default_session_id = ? WHERE id = ?")
    .run(sessionId, documentId);
}

export function deleteKnowledgeDocument(database: DatabaseClient, documentId: string): void {
  const result = database
    .prepare("DELETE FROM knowledge_documents WHERE id = ?")
    .run(documentId);
  if (result.changes === 0) throw new KnowledgeDocumentNotFoundError(documentId);
}

export function requireKnowledgeDocument(
  database: DatabaseClient,
  documentId: string,
): KnowledgeDocumentRow {
  const row = getKnowledgeDocument(database, documentId);
  if (row === null) throw new KnowledgeDocumentNotFoundError(documentId);
  return row;
}

function mapVersion(row: {
  id: string;
  document_id: string;
  version_number: number;
  source: KnowledgeVersion["source"];
  created_at: string;
  content?: string;
}): KnowledgeVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    source: row.source,
    createdAt: row.created_at,
  };
}

export interface AddDocumentVersionInput {
  documentId: string;
  content: string;
  source: KnowledgeVersion["source"];
  now?: string;
}

/** Append one full-content version and prune to the newest history window. */
export function addDocumentVersion(
  database: DatabaseClient,
  input: AddDocumentVersionInput,
  historyLimit = 10,
): KnowledgeVersion {
  requireKnowledgeDocument(database, input.documentId);
  const now = input.now ?? new Date().toISOString();
  const id = `ver_${randomBytes(10).toString("hex")}`;
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions
       WHERE document_id = ?`,
    )
    .get(input.documentId) as { next: number };
  const versionNumber = row.next;
  database
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, content, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.documentId, versionNumber, input.content, input.source, now);
  database
    .prepare(
      `DELETE FROM document_versions
       WHERE document_id = ?
         AND version_number NOT IN (
           SELECT version_number FROM document_versions
           WHERE document_id = ?
           ORDER BY version_number DESC
           LIMIT ?
         )`,
    )
    .run(input.documentId, input.documentId, historyLimit);
  return {
    id,
    documentId: input.documentId,
    versionNumber,
    source: input.source,
    createdAt: now,
  };
}

export function listDocumentVersions(
  database: DatabaseClient,
  documentId: string,
  limit = 10,
): KnowledgeVersion[] {
  requireKnowledgeDocument(database, documentId);
  const rows = database
    .prepare(
      `SELECT id, document_id, version_number, source, created_at
       FROM document_versions
       WHERE document_id = ?
       ORDER BY version_number DESC
       LIMIT ?`,
    )
    .all(documentId, limit) as Array<{
    id: string;
    document_id: string;
    version_number: number;
    source: KnowledgeVersion["source"];
    created_at: string;
  }>;
  return rows.map(mapVersion);
}

export function getDocumentVersion(
  database: DatabaseClient,
  documentId: string,
  versionId: string,
): { version: KnowledgeVersion; content: string } {
  requireKnowledgeDocument(database, documentId);
  const row = database
    .prepare(
      `SELECT id, document_id, version_number, source, created_at, content
       FROM document_versions WHERE id = ? AND document_id = ?`,
    )
    .get(versionId, documentId) as
    | {
        id: string;
        document_id: string;
        version_number: number;
        source: KnowledgeVersion["source"];
        created_at: string;
        content: string;
      }
    | undefined;
  if (row === undefined) throw new KnowledgeVersionNotFoundError(versionId);
  return { version: mapVersion(row), content: row.content };
}
