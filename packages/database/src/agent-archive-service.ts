import type {
  AgentMessage,
  AgentScope,
} from "@loongboard/contracts";

import type { AgentSessionTitleSource } from "./agent-service.js";
import type { DatabaseClient } from "./types.js";

/** Explicit allowlist of normalized session fields safe for archive export. */
export interface AgentArchiveSessionMetadata {
  readonly id: string;
  readonly scope: AgentScope;
  readonly workspacePath: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly status: "idle" | "running" | "interrupted" | "error";
  readonly dshSessionId: string | null;
  readonly title: string | null;
  readonly titleSource: AgentSessionTitleSource;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

/** Explicit allowlist of normalized transcript fields safe for archive export. */
export interface AgentArchiveMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly role: AgentMessage["role"];
  readonly contentMarkdown: string;
  readonly metadataJson: Record<string, unknown>;
  readonly createdAt: string;
}

export interface AgentArchiveProjection {
  readonly session: AgentArchiveSessionMetadata;
  readonly messages: readonly AgentArchiveMessage[];
}

export interface ListAgentArchiveProjectionOptions {
  /** Optional allowlist for incremental callers; omitted means every session. */
  readonly sessionIds?: readonly string[];
}

const MAX_FILTERED_ARCHIVE_SESSIONS = 900;

function scopeFromRow(row: Record<string, unknown>): AgentScope {
  return {
    kind: (row.origin_kind ?? row.scope_type) as AgentScope["kind"],
    ...(row.repository_id !== null && row.repository_id !== undefined
      ? { repositoryId: row.repository_id as string }
      : {}),
    ...(row.pr_number !== null && row.pr_number !== undefined
      ? { prNumber: row.pr_number as number }
      : {}),
    ...(row.issue_number !== null && row.issue_number !== undefined
      ? { issueNumber: row.issue_number as number }
      : {}),
    ...(row.target_sha !== null && row.target_sha !== undefined
      ? { targetSha: row.target_sha as string }
      : {}),
    ...(row.knowledge_document_id !== null && row.knowledge_document_id !== undefined
      ? { knowledgeDocumentId: row.knowledge_document_id as string }
      : {}),
    ...(row.domain_id !== null && row.domain_id !== undefined
      ? { domainId: row.domain_id as string }
      : {}),
    ...(row.origin_route !== null && row.origin_route !== undefined
      ? { route: row.origin_route as string }
      : {}),
  };
}

function mapSession(row: Record<string, unknown>): AgentArchiveSessionMetadata {
  return {
    id: row.id as string,
    scope: scopeFromRow(row),
    workspacePath: row.workspace_path as string,
    provider: row.provider as string,
    model: row.model as string,
    reasoningEffort: row.reasoning_effort as string,
    status: row.status as AgentArchiveSessionMetadata["status"],
    dshSessionId: (row.dsh_session_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    titleSource: row.title_source as AgentSessionTitleSource,
    createdAt: row.created_at as string,
    lastUsedAt: row.last_used_at as string,
  };
}

function mapMessage(row: Record<string, unknown>): AgentArchiveMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    sequence: row.sequence as number,
    role: row.role as AgentMessage["role"],
    contentMarkdown: row.content_markdown as string,
    metadataJson: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string,
  };
}

/**
 * Read the normalized archive projection with exactly two SQL queries: one
 * for session metadata and one indexed session_id/sequence message query.
 * DSH homes, provider secrets, credentials, and runtime files are never read.
 */
export function listAgentArchiveProjection(
  database: DatabaseClient,
  options: ListAgentArchiveProjectionOptions = {},
): AgentArchiveProjection[] {
  const sessionIds = options.sessionIds === undefined
    ? null
    : [...new Set(options.sessionIds)];
  if (sessionIds !== null && sessionIds.length === 0) return [];
  if (sessionIds !== null && sessionIds.length > MAX_FILTERED_ARCHIVE_SESSIONS) {
    throw new Error(
      `Too many agent archive session ids (${sessionIds.length}); ` +
        `request at most ${MAX_FILTERED_ARCHIVE_SESSIONS} per projection`,
    );
  }

  const sessionWhere = sessionIds === null
    ? ""
    : ` WHERE id IN (${sessionIds.map(() => "?").join(", ")})`;
  const sessionRows = database
    .prepare(
      `SELECT id, origin_kind, scope_type, repository_id, pr_number,
              issue_number, target_sha, knowledge_document_id, domain_id,
              origin_route, workspace_path, provider, model, reasoning_effort,
              status, dsh_session_id, title, title_source, created_at, last_used_at
       FROM agent_sessions${sessionWhere}
       ORDER BY id ASC`,
    )
    .all(...(sessionIds ?? [])) as Array<Record<string, unknown>>;
  if (sessionRows.length === 0) return [];

  const ids = sessionRows.map((row) => row.id as string);
  const messageFilter = sessionIds === null
    ? ""
    : `WHERE session_id IN (${ids.map(() => "?").join(", ")})`;
  const messageRows = database
    .prepare(
      `SELECT id, session_id, sequence, role, content_markdown,
              metadata_json, created_at
       FROM agent_messages
       ${messageFilter}
       ORDER BY session_id ASC, sequence ASC, id ASC`,
    )
    .all(...(sessionIds === null ? [] : ids)) as Array<Record<string, unknown>>;
  const messagesBySession = new Map<string, AgentArchiveMessage[]>();
  for (const row of messageRows) {
    const message = mapMessage(row);
    const messages = messagesBySession.get(message.sessionId);
    if (messages === undefined) {
      messagesBySession.set(message.sessionId, [message]);
    } else {
      messages.push(message);
    }
  }

  return sessionRows.map((row) => {
    const session = mapSession(row);
    return {
      session,
      messages: messagesBySession.get(session.id) ?? [],
    };
  });
}
