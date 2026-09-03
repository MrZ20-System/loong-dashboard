import {
  decodeListCursor,
  encodeListCursor,
  type ListCursorPayload,
} from "@loongboard/contracts";
import { requireRepository } from "./repository-service.js";
import {
  calendarDateRangeToUtc,
  calendarDateToUtc,
  utcDateToCalendarDate,
} from "./timezone.js";
import {
  type ActivityDay,
  type DatabaseClient,
  type IssueListItem,
  type IssueMetadata,
  type IssueStatus,
  type IssueListOptions,
  type ListPage,
  type PullRequestListItem,
  type PullRequestMetadata,
  type PullRequestListOptions,
  type PullRequestStatus,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
export class InvalidCursorError extends Error {
  readonly code = "INVALID_CURSOR" as const;

  constructor() {
    super("Invalid list cursor");
    this.name = "InvalidCursorError";
  }
}

/** Upsert one complete provider page in one SQLite transaction. */
export function upsertPullRequestPage(
  database: DatabaseClient,
  repositoryId: string,
  items: readonly PullRequestMetadata[],
): number {
  const statement = database.prepare(
    `INSERT INTO pull_requests (
      repository_id, node_id, number, title, url, author_login, state_raw,
      status, is_draft, created_at, updated_at, closed_at, merged_at,
      base_ref_name, head_ref_name, head_sha, additions, deletions,
      changed_files_count, detail_body
    ) VALUES (
      @repositoryId, @nodeId, @number, @title, @url, @authorLogin, @stateRaw,
      @status, @isDraft, @createdAt, @updatedAt, @closedAt, @mergedAt,
      @baseRefName, @headRefName, @headSha, @additions, @deletions,
      @changedFilesCount, @detailBody
    ) ON CONFLICT(repository_id, number) DO UPDATE SET
      node_id = excluded.node_id,
      title = excluded.title,
      url = excluded.url,
      author_login = excluded.author_login,
      state_raw = excluded.state_raw,
      status = excluded.status,
      is_draft = excluded.is_draft,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at,
      merged_at = excluded.merged_at,
      base_ref_name = excluded.base_ref_name,
      head_ref_name = excluded.head_ref_name,
      head_sha = excluded.head_sha,
      additions = excluded.additions,
      deletions = excluded.deletions,
      changed_files_count = excluded.changed_files_count,
      detail_body = COALESCE(excluded.detail_body, pull_requests.detail_body)`,
  );

  let changes = 0;
  database.transaction(() => {
    for (const item of items) {
      changes += statement.run({
        repositoryId,
        nodeId: item.nodeId,
        number: item.number,
        title: item.title,
        url: item.url,
        authorLogin: item.authorLogin,
        stateRaw: item.stateRaw,
        status: item.status,
        isDraft: item.isDraft ? 1 : 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        closedAt: item.closedAt,
        mergedAt: item.mergedAt,
        baseRefName: item.baseRefName,
        headRefName: item.headRefName,
        headSha: item.headSha,
        additions: item.additions,
        deletions: item.deletions,
        changedFilesCount: item.changedFilesCount,
        detailBody: item.detailBody ?? null,
      }).changes;
    }
  })();
  return changes;
}

/** Upsert one complete provider Issue page in one SQLite transaction. */
export function upsertIssuePage(
  database: DatabaseClient,
  repositoryId: string,
  items: readonly IssueMetadata[],
): number {
  const statement = database.prepare(
    `INSERT INTO issues (
      repository_id, node_id, number, title, url, author_login, state,
      comments_count, created_at, updated_at, closed_at, detail_body
    ) VALUES (
      @repositoryId, @nodeId, @number, @title, @url, @authorLogin, @state,
      @commentsCount, @createdAt, @updatedAt, @closedAt, @detailBody
    ) ON CONFLICT(repository_id, number) DO UPDATE SET
      node_id = excluded.node_id,
      title = excluded.title,
      url = excluded.url,
      author_login = excluded.author_login,
      state = excluded.state,
      comments_count = excluded.comments_count,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at,
      detail_body = COALESCE(excluded.detail_body, issues.detail_body)`,
  );

  let changes = 0;
  database.transaction(() => {
    for (const item of items) {
      changes += statement.run({
        repositoryId,
        nodeId: item.nodeId,
        number: item.number,
        title: item.title,
        url: item.url,
        authorLogin: item.authorLogin,
        state: item.status,
        commentsCount: item.commentsCount,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        closedAt: item.closedAt,
        detailBody: item.detailBody ?? null,
      }).changes;
    }
  })();
  return changes;
}

function resolveTimeZone(options: { calendarTimeZone: string }): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: options.calendarTimeZone }).format();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid calendar timezone ${options.calendarTimeZone}: ${reason}`);
  }
  return options.calendarTimeZone;
}

function pageSize(value: number | undefined): number {
  const size = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size <= 0 || size > 1_000) {
    throw new Error("List page size must be an integer between 1 and 1000");
  }
  return size;
}

function cursorValues(value: string | null | undefined): ListCursorPayload | null {
  if (!value) return null;
  try {
    return decodeListCursor(value);
  } catch {
    throw new InvalidCursorError();
  }
}

function datePredicate(
  clauses: string[],
  parameters: unknown[],
  date: string | null | undefined,
  timeZone: string,
): void {
  if (!date) return;
  const range = calendarDateToUtc(date, timeZone);
  clauses.push("updated_at >= ?", "updated_at < ?");
  parameters.push(range.from, range.to);
}

function cursorPredicate(
  clauses: string[],
  parameters: unknown[],
  cursor: Pick<ListCursorPayload, "updatedAt" | "number"> | null,
): void {
  if (!cursor) return;
  clauses.push("(updated_at < ? OR (updated_at = ? AND number < ?))");
  parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.number);
}

function mapPullRequest(row: Record<string, unknown>): PullRequestListItem {
  return {
    repositoryId: row.repository_id as string,
    number: row.number as number,
    title: row.title as string,
    url: row.url as string,
    authorLogin: (row.author_login as string | null) ?? null,
    status: row.status as PullRequestStatus,
    updatedAt: row.updated_at as string,
    changedFilesCount: row.changed_files_count as number,
    additions: row.additions as number,
    deletions: row.deletions as number,
  };
}

function mapIssue(row: Record<string, unknown>): IssueListItem {
  return {
    repositoryId: row.repository_id as string,
    number: row.number as number,
    title: row.title as string,
    url: row.url as string,
    authorLogin: (row.author_login as string | null) ?? null,
    status: row.state as IssueStatus,
    commentsCount: row.comments_count as number,
    updatedAt: row.updated_at as string,
  };
}

export function listPullRequests(
  database: DatabaseClient,
  repositoryId: string,
  options: PullRequestListOptions,
): ListPage<PullRequestListItem> {
  requireRepository(database, repositoryId);
  const calendarTimeZone = resolveTimeZone(options);
  const limit = pageSize(options.limit);
  const cursor = cursorValues(options.cursor);
  const clauses = ["repository_id = ?"];
  const parameters: unknown[] = [repositoryId];
  datePredicate(clauses, parameters, options.date, calendarTimeZone);
  if (options.status) {
    clauses.push("status = ?");
    parameters.push(options.status);
  }
  cursorPredicate(clauses, parameters, cursor);
  parameters.push(limit + 1);

  const rows = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, status,
              updated_at, changed_files_count, additions, deletions
       FROM pull_requests
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, number DESC
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapPullRequest);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeListCursor({ updatedAt: last.updatedAt, number: last.number })
        : null,
    calendarTimeZone,
  };
}

export function listIssues(
  database: DatabaseClient,
  repositoryId: string,
  options: IssueListOptions,
): ListPage<IssueListItem> {
  requireRepository(database, repositoryId);
  const calendarTimeZone = resolveTimeZone(options);
  const limit = pageSize(options.limit);
  const cursor = cursorValues(options.cursor);
  const clauses = ["repository_id = ?"];
  const parameters: unknown[] = [repositoryId];
  datePredicate(clauses, parameters, options.date, calendarTimeZone);
  if (options.status) {
    clauses.push("state = ?");
    parameters.push(options.status);
  }
  cursorPredicate(clauses, parameters, cursor);
  parameters.push(limit + 1);

  const rows = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, state,
              comments_count, updated_at
       FROM issues
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, number DESC
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapIssue);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeListCursor({ updatedAt: last.updatedAt, number: last.number })
        : null,
    calendarTimeZone,
  };
}

function activityDays(
  database: DatabaseClient,
  repositoryId: string,
  from: string,
  to: string,
  timeZone: string,
  table: "pull_requests" | "issues",
): ActivityDay[] {
  requireRepository(database, repositoryId);
  const range = calendarDateRangeToUtc(from, to, timeZone);
  const rows = database
    .prepare(
      `SELECT updated_at FROM ${table}
       WHERE repository_id = ? AND updated_at >= ? AND updated_at < ?
       ORDER BY updated_at ASC`,
    )
    .all(repositoryId, range.from, range.to) as Array<{ updated_at: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const date = utcDateToCalendarDate(row.updated_at, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, count]) => ({ date, count }));
}

export function getPullRequestActivityDays(
  database: DatabaseClient,
  repositoryId: string,
    options: { from: string; to: string; calendarTimeZone: string },
): ActivityDay[] {
  return activityDays(
    database,
    repositoryId,
    options.from,
    options.to,
    resolveTimeZone(options),
    "pull_requests",
  );
}

export function getIssueActivityDays(
  database: DatabaseClient,
  repositoryId: string,
    options: { from: string; to: string; calendarTimeZone: string },
): ActivityDay[] {
  return activityDays(
    database,
    repositoryId,
    options.from,
    options.to,
    resolveTimeZone(options),
    "issues",
  );
}
