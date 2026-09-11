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
  originKind: AgentScope["kind"];
  repositoryId: string | null;
  prNumber: number | null;
  issueNumber: number | null;
  targetSha: string | null;
  knowledgeDocumentId: string | null;
  domainId: string | null;
  originRoute: string | null;
  title: string | null;
  titleSource: AgentSessionTitleSource;
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

export type AgentSessionTitleSource = "provisional" | "generated" | "manual";

/** The contract summary plus the database-owned title provenance. */
export type AgentSessionSummaryWithTitleSource = AgentSessionSummary & {
  titleSource: AgentSessionTitleSource;
};

export class InvalidAgentSessionTitleError extends Error {
  readonly code = "INVALID_AGENT_SESSION_TITLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentSessionTitleError";
  }
}

export interface CreateAgentSessionInput {
  id: string;
  scope: AgentScope;
  dshHomePath: string;
  workspacePath: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  title?: string | null;
  /** New sessions default to provisional when no title is supplied. */
  titleSource?: AgentSessionTitleSource;
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

function mapSession(row: Record<string, unknown>): AgentSessionSummaryWithTitleSource {
  const kind = row.origin_kind as AgentScope["kind"];
  const scope: AgentScope = {
    kind,
    ...(row.repository_id !== null && row.repository_id !== undefined ? { repositoryId: row.repository_id as string } : {}),
    ...(row.pr_number !== null && row.pr_number !== undefined ? { prNumber: row.pr_number as number } : {}),
    ...(row.issue_number !== null && row.issue_number !== undefined ? { issueNumber: row.issue_number as number } : {}),
    ...(row.target_sha !== null && row.target_sha !== undefined ? { targetSha: row.target_sha as string } : {}),
    ...(row.knowledge_document_id !== null && row.knowledge_document_id !== undefined ? { knowledgeDocumentId: row.knowledge_document_id as string } : {}),
    ...(row.domain_id !== null && row.domain_id !== undefined ? { domainId: row.domain_id as string } : {}),
    ...(row.origin_route !== null && row.origin_route !== undefined ? { route: row.origin_route as string } : {}),
  };
  return {
    id: row.id as string,
    scope,
    workspacePath: row.workspace_path as string,
    dshHomePath: row.dsh_home_path as string,
    provider: row.provider as string,
    model: row.model as string,
    reasoningEffort: row.reasoning_effort as string,
    status: row.status as AgentSessionSummary["status"],
    dshSessionId: (row.dsh_session_id as string | null) ?? null,
    origin: scope,
    workspace: {
      path: row.workspace_path as string,
      kind: workspaceKind(kind),
    },
    title: (row.title as string | null) ?? null,
    titleSource: row.title_source as AgentSessionTitleSource,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string,
  };
}

/** Normalize one user/runtime title without silently changing its content. */
function normalizeTitle(title: string): string {
  if (typeof title !== "string") {
    throw new InvalidAgentSessionTitleError("Agent session title must be a string");
  }
  if (/\r|\n|\u2028|\u2029/u.test(title)) {
    throw new InvalidAgentSessionTitleError("Agent session title must be one line");
  }
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new InvalidAgentSessionTitleError("Agent session title must not be empty");
  }
  if (Array.from(normalized).length > 80) {
    throw new InvalidAgentSessionTitleError(
      "Agent session title must be at most 80 Unicode code points",
    );
  }
  return normalized;
}

/** Scope equality key used to find the default session for a chat. */
function scopeClause(scope: AgentScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [scope.kind];
  let sql = "origin_kind = ?";
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
  add("domain_id", scope.domainId);
  add("origin_route", scope.route);
  return { sql, params };
}

export function requireAgentSession(
  database: DatabaseClient,
  sessionId: string,
): AgentSessionSummaryWithTitleSource {
  const row = database
    .prepare("SELECT * FROM agent_sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new AgentSessionNotFoundError(sessionId);
  return mapSession(row);
}

export function findAgentSession(
  database: DatabaseClient,
  scope: AgentScope,
): AgentSessionSummaryWithTitleSource | null {
  const { sql, params } = scopeClause(scope);
  const row = database
    .prepare(`SELECT * FROM agent_sessions WHERE ${sql} ORDER BY last_used_at DESC LIMIT 1`)
    .get(...params) as Record<string, unknown> | undefined;
  return row === undefined ? null : mapSession(row);
}

export function createAgentSession(
  database: DatabaseClient,
  input: CreateAgentSessionInput,
): AgentSessionSummaryWithTitleSource {
  const { scope } = input;
  const title = input.title === null || input.title === undefined
    ? null
    : normalizeTitle(input.title);
  const titleSource = input.titleSource ?? (title === null ? "provisional" : "manual");
  database.prepare(
    `INSERT INTO agent_sessions (
      id, origin_kind, repository_id, pr_number, issue_number, target_sha,
      knowledge_document_id, domain_id, origin_route, title, title_source, dsh_session_id,
      dsh_home_path, workspace_path, provider, model, reasoning_effort, status,
      created_at, last_used_at
    ) VALUES (
      @id, @originKind, @repositoryId, @prNumber, @issueNumber, @targetSha,
      @knowledgeDocumentId, @domainId, @originRoute, @title, @titleSource, NULL, @dshHomePath,
      @workspacePath, @provider, @model, @reasoningEffort, 'idle', @createdAt,
      @lastUsedAt
    )`,
  ).run({
    id: input.id,
    originKind: scope.kind,
    repositoryId: scope.repositoryId ?? null,
    prNumber: scope.prNumber ?? null,
    issueNumber: scope.issueNumber ?? null,
    targetSha: scope.targetSha ?? null,
    knowledgeDocumentId: scope.knowledgeDocumentId ?? null,
    domainId: scope.domainId ?? null,
    originRoute: scope.route ?? null,
    title,
    titleSource,
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
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    title?: string | null;
  },
): AgentSessionSummaryWithTitleSource {
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
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    params.push(patch.provider);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    params.push(patch.model);
  }
  if (patch.reasoningEffort !== undefined) {
    sets.push("reasoning_effort = ?");
    params.push(patch.reasoningEffort);
  }
  if (patch.title !== undefined) {
    if (patch.title === null) {
      sets.push("title = NULL", "title_source = 'manual'");
    } else {
      sets.push("title = ?", "title_source = 'manual'");
      params.push(normalizeTitle(patch.title));
    }
  }
  if (sets.length > 0) {
    database.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params, sessionId);
  }
  return requireAgentSession(database, sessionId);
}

export interface GeneratedAgentSessionTitleResult {
  readonly updated: boolean;
  readonly session: AgentSessionSummaryWithTitleSource;
}

/**
 * Atomically promote a provisional title to a generated title. The source
 * predicate makes a concurrent/manual rename win without application locks.
 */
export function setGeneratedAgentSessionTitleIfProvisional(
  database: DatabaseClient,
  sessionId: string,
  title: string,
): GeneratedAgentSessionTitleResult {
  const normalized = normalizeTitle(title);
  const result = database
    .prepare(
      `UPDATE agent_sessions
       SET title = ?, title_source = 'generated'
       WHERE id = ? AND title_source = 'provisional'`,
    )
    .run(normalized, sessionId);
  return {
    updated: result.changes === 1,
    session: requireAgentSession(database, sessionId),
  };
}

export function touchAgentSession(database: DatabaseClient, sessionId: string): void {
  database
    .prepare("UPDATE agent_sessions SET last_used_at = ? WHERE id = ?")
    .run(nowIso(), sessionId);
}

export interface AgentSessionListFilter {
  originKind?: AgentScope["kind"];
  repositoryId?: string;
  prNumber?: number;
  issueNumber?: number;
  knowledgeDocumentId?: string;
  status?: AgentSessionRecord["status"];
  search?: string;
  limit?: number;
}

/** Sessions matching an optional scope filter, newest activity first. */
export function listAgentSessions(
  database: DatabaseClient,
  filter: AgentSessionListFilter = {},
): AgentSessionSummaryWithTitleSource[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  const add = (column: string, value: unknown) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    parameters.push(value);
  };
  if (filter.originKind !== undefined) {
    add("origin_kind", filter.originKind);
  }
  add("repository_id", filter.repositoryId);
  add("pr_number", filter.prNumber);
  add("issue_number", filter.issueNumber);
  add("knowledge_document_id", filter.knowledgeDocumentId);
  add("status", filter.status);
  if (filter.search !== undefined && filter.search.trim().length > 0) {
    const term = `%${filter.search.trim()}%`;
    clauses.push(`(
      title LIKE ? COLLATE NOCASE OR
      workspace_path LIKE ? COLLATE NOCASE OR
      provider LIKE ? COLLATE NOCASE OR
      model LIKE ? COLLATE NOCASE OR
      EXISTS (
        SELECT 1 FROM agent_messages
        WHERE agent_messages.session_id = agent_sessions.id
          AND agent_messages.content_markdown LIKE ? COLLATE NOCASE
      )
    )`);
    parameters.push(term, term, term, term, term);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit === undefined ? "" : " LIMIT ?";
  if (filter.limit !== undefined) parameters.push(filter.limit);
  const rows = database
    .prepare(`SELECT * FROM agent_sessions ${where} ORDER BY last_used_at DESC${limit}`)
    .all(...parameters) as Array<Record<string, unknown>>;
  return rows.map(mapSession);
}

/** Delete one normalized session and its transcript. */
export function deleteAgentSession(
  database: DatabaseClient,
  sessionId: string,
): void {
  const result = database
    .prepare("DELETE FROM agent_sessions WHERE id = ?")
    .run(sessionId);
  if (result.changes === 0) throw new AgentSessionNotFoundError(sessionId);
}

/**
 * Worktree paths owned by running sessions of a repository. The running
 * session rows are the durable ownership projection; slot rows only retain
 * affinity and LRU metadata.
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

/** Ids of running knowledge-scope sessions (agent-version attribution). */
export function listRunningKnowledgeSessionIds(database: DatabaseClient): string[] {
  const rows = database
    .prepare(
      `SELECT id FROM agent_sessions
       WHERE origin_kind = 'knowledge' AND status = 'running'`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function workspaceKind(
  kind: AgentScope["kind"],
): "repository" | "pr-worktree" | "knowledge" | "custom" {
  if (kind === "pr") return "pr-worktree";
  if (kind === "knowledge") return "knowledge";
  if (kind === "issue" || kind === "repository" || kind === "domain") {
    return "repository";
  }
  return "custom";
}

/**
 * Startup recovery (plan 12.2/13 lifecycle): sessions a previous process left
 * `running` would otherwise keep their worktree slot busy forever and hold
 * knowledge agent-version aggregation open. Mark them interrupted so the next
 * turn starts fresh; messages already persisted stay untouched.
 */
export function recoverInterruptedAgentSessions(database: DatabaseClient): number {
  const result = database
    .prepare(
      `UPDATE agent_sessions SET status = 'interrupted'
       WHERE status = 'running'`,
    )
    .run();
  return result.changes;
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
