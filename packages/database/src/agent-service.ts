import {
  randomUUID,
} from "node:crypto";

import type {
  AgentMessage,
  AgentScope,
  AgentSessionSummary,
} from "@loongboard/contracts";

import type { DatabaseClient } from "./types.js";

export interface AgentSessionRecord {
  id: string;
  scopeType: "pr" | "issue" | "knowledge" | "general";
  repositoryId: string | null;
  prNumber: number | null;
  issueNumber: number | null;
  targetSha: string | null;
  knowledgeDocumentId: string | null;
  dshSessionId: string | null;
  dshHomePath: string;
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  status: "idle" | "running" | "interrupted" | "error";
  createdAt: string;
  lastUsedAt: string;
}

export interface CreateAgentSessionInput {
  id: string;
  scope: AgentScope;
  dshHomePath: string;
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  now: string;
}

export interface AgentMessageRecord extends AgentMessage {}

export class AgentSessionNotFoundError extends Error {
  readonly code = "AGENT_SESSION_NOT_FOUND" as const;

  constructor(sessionId: string) {
    super(`Agent session ${sessionId} was not found`);
    this.name = "AgentSessionNotFoundError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapSession(row: Record<string, unknown>): AgentSessionSummary {
  return {
    id: row.id as string,
    scope: {
      kind: row.scope_type as AgentScope["kind"],
      ...(row.repository_id !== null ? { repositoryId: row.repository_id as string } : {}),
      ...(row.pr_number !== null ? { prNumber: row.pr_number as number } : {}),
      ...(row.issue_number !== null ? { issueNumber: row.issue_number as number } : {}),
      ...(row.target_sha !== null ? { targetSha: row.target_sha as string } : {}),
      ...(row.knowledge_document_id !== null ? { knowledgeDocumentId: row.knowledge_document_id as string } : {}),
    },
    workspacePath: row.workspace_path as string,
    dshHomePath: row.dsh_home_path as string,
    provider: row.provider as string,
    model: row.model as string,
    reasoningEffort: row.reasoning_effort as string,
    status: row.status as AgentSessionSummary["status"],
    dshSessionId: (row.dsh_session_id as string | null) ?? null,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string,
  };
}

/** Scope equality key used to find the default session for a chat. */
function scopeClause(scope: AgentScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope.kind];
  let sql = "scope_type = ?";
  const add = (column: string, value: unknown) => {
    if (value === undefined) {
      sql += ` AND ${column} IS NULL`;
      return;
    }
    sql += ` AND ${column} = ?`;
    params.push(value);
  };
  add("repository_id", scope.repositoryId);
  add("pr_number", scope.prNumber);
  add("issue_number", scope.issueNumber);
  add("target_sha", scope.targetSha);
  add("knowledge_document_id", scope.knowledgeDocumentId);
  return { sql, params };
}

export function requireAgentSession(
  database: DatabaseClient,
  sessionId: string,
): AgentSessionSummary {
  const row = database
    .prepare("SELECT * FROM agent_sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new AgentSessionNotFoundError(sessionId);
  return mapSession(row);
}

export function findAgentSession(
  database: DatabaseClient,
  scope: AgentScope,
): AgentSessionSummary | null {
  const { sql, params } = scopeClause(scope);
  const row = database
    .prepare(`SELECT * FROM agent_sessions WHERE ${sql} ORDER BY last_used_at DESC LIMIT 1`)
    .get(...params) as Record<string, unknown> | undefined;
  return row === undefined ? null : mapSession(row);
}

export function createAgentSession(
  database: DatabaseClient,
  input: CreateAgentSessionInput,
): AgentSessionSummary {
  const { scope } = input;
  database.prepare(
    `INSERT INTO agent_sessions (
      id, scope_type, repository_id, pr_number, issue_number, target_sha,
      knowledge_document_id, dsh_session_id, dsh_home_path, workspace_path,
      provider, model, reasoning_effort, status, created_at, last_used_at
    ) VALUES (
      @id, @scopeType, @repositoryId, @prNumber, @issueNumber, @targetSha,
      @knowledgeDocumentId, NULL, @dshHomePath, @workspacePath,
      @provider, @model, @reasoningEffort, 'idle', @createdAt, @lastUsedAt
    )`,
  ).run({
    id: input.id,
    scopeType: scope.kind,
    repositoryId: scope.repositoryId ?? null,
    prNumber: scope.prNumber ?? null,
    issueNumber: scope.issueNumber ?? null,
    targetSha: scope.targetSha ?? null,
    knowledgeDocumentId: scope.knowledgeDocumentId ?? null,
    dshHomePath: input.dshHomePath,
    workspacePath: input.workspacePath,
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    createdAt: input.now,
    lastUsedAt: input.now,
  });
  return requireAgentSession(database, input.id);
}

export function updateAgentSession(
  database: DatabaseClient,
  sessionId: string,
  patch: {
    status?: AgentSessionSummary["status"];
    dshSessionId?: string | null;
    workspacePath?: string;
  },
): AgentSessionSummary {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.dshSessionId !== undefined) {
    sets.push("dsh_session_id = ?");
    params.push(patch.dshSessionId);
  }
  if (patch.workspacePath !== undefined) {
    sets.push("workspace_path = ?");
    params.push(patch.workspacePath);
  }
  if (sets.length > 0) {
    database.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params, sessionId);
  }
  return requireAgentSession(database, sessionId);
}

export function touchAgentSession(database: DatabaseClient, sessionId: string): void {
  database
    .prepare("UPDATE agent_sessions SET last_used_at = ? WHERE id = ?")
    .run(nowIso(), sessionId);
}

export interface AgentSessionListFilter {
  scopeType?: AgentSessionRecord["scopeType"];
  repositoryId?: string;
  prNumber?: number;
  issueNumber?: number;
  knowledgeDocumentId?: string;
}

/** Sessions matching an optional scope filter, newest activity first. */
export function listAgentSessions(
  database: DatabaseClient,
  filter: AgentSessionListFilter = {},
): AgentSessionSummary[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  const add = (column: string, value: unknown) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    parameters.push(value);
  };
  add("scope_type", filter.scopeType);
  add("repository_id", filter.repositoryId);
  add("pr_number", filter.prNumber);
  add("issue_number", filter.issueNumber);
  add("knowledge_document_id", filter.knowledgeDocumentId);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database
    .prepare(`SELECT * FROM agent_sessions ${where} ORDER BY last_used_at DESC`)
    .all(...parameters) as Array<Record<string, unknown>>;
  return rows.map(mapSession);
}

/**
 * Worktree paths owned by running sessions of a repository (plan 12.2:
 * `busy_session_id != null` slots are never recycled). The running status is
 * the durable busy marker because worktree_slots rows stay unmanaged in V1.
 */
export function listBusyWorkspacePaths(
  database: DatabaseClient,
  repositoryId: string,
): string[] {
  const rows = database
    .prepare(
      `SELECT workspace_path FROM agent_sessions
       WHERE repository_id = ? AND status = 'running' AND workspace_path IS NOT NULL`,
    )
    .all(repositoryId) as Array<{ workspace_path: string | null }>;
  return rows
    .map((row) => row.workspace_path)
    .filter((path): path is string => path !== null);
}

/** Update the markdown/metadata of one persisted message (tool completion). */
export function updateAgentMessage(
  database: DatabaseClient,
  messageId: string,
  patch: { contentMarkdown?: string; metadata?: Record<string, unknown> },
): AgentMessageRecord {
  const existing = database
    .prepare("SELECT * FROM agent_messages WHERE id = ?")
    .get(messageId) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    throw new Error(`Agent message was not found: ${messageId}`);
  }
  const metadata = patch.metadata ?? (JSON.parse(existing.metadata_json as string) as Record<string, unknown>);
  const contentMarkdown = patch.contentMarkdown ?? (existing.content_markdown as string);
  database
    .prepare("UPDATE agent_messages SET content_markdown = ?, metadata_json = ? WHERE id = ?")
    .run(contentMarkdown, JSON.stringify(metadata), messageId);
  return {
    id: existing.id as string,
    sessionId: existing.session_id as string,
    sequence: existing.sequence as number,
    role: existing.role as AgentMessage["role"],
    contentMarkdown,
    metadataJson: metadata,
    createdAt: existing.created_at as string,
  };
}

/** Append one normalized message with the next sequence for its session. */
export function appendAgentMessage(
  database: DatabaseClient,
  input: {
    sessionId: string;
    role: AgentMessage["role"];
    contentMarkdown: string;
    metadata?: Record<string, unknown>;
    now?: string;
  },
): AgentMessageRecord {
  const session = requireAgentSession(database, input.sessionId);
  const createdAt = input.now ?? nowIso();
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const next = database
    .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM agent_messages WHERE session_id = ?")
    .get(input.sessionId) as { next: number };
  const message: AgentMessageRecord = {
    id,
    sessionId: session.id,
    sequence: next.next,
    role: input.role,
    contentMarkdown: input.contentMarkdown,
    metadataJson: input.metadata ?? {},
    createdAt,
  };
  database.prepare(
    `INSERT INTO agent_messages (id, session_id, sequence, role, content_markdown, metadata_json, created_at)
     VALUES (@id, @sessionId, @sequence, @role, @contentMarkdown, @metadataJson, @createdAt)`,
  ).run({
    id: message.id,
    sessionId: message.sessionId,
    sequence: message.sequence,
    role: message.role,
    contentMarkdown: message.contentMarkdown,
    metadataJson: JSON.stringify(message.metadataJson),
    createdAt: message.createdAt,
  });
  return message;
}

export function listAgentMessages(
  database: DatabaseClient,
  sessionId: string,
): AgentMessageRecord[] {
  requireAgentSession(database, sessionId);
  const rows = database
    .prepare(
      `SELECT id, session_id, sequence, role, content_markdown, metadata_json, created_at
       FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    sequence: row.sequence as number,
    role: row.role as AgentMessage["role"],
    contentMarkdown: row.content_markdown as string,
    metadataJson: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string,
  }));
}
