import {
  decodeListCursor,
  encodeListCursor,
  type ListCursorPayload,
} from "@loongboard/contracts";
import { listDomainTagsForPullRequests } from "./classification-service.js";
import { requireRepository } from "./repository-service.js";
import {
  calendarDateRangeToUtc,
  calendarDateToUtc,
  utcDateToCalendarDate,
} from "./timezone.js";
import {
  type ActivityDay,
  type DatabaseClient,
  type IssueComment,
  type IssueCommentInput,
  type IssueDetailCacheInput,
  type IssueDetail,
  type IssueListItem,
  type IssueMetadata,
  type IssueStatus,
  type IssueListOptions,
  type ListPage,
  type PageList,
  type MergedPullRequestListItem,
  type MergedPullRequestListOptions,
  type PullRequestDetail,
  type PullRequestListItem,
  type PullRequestMetadata,
  type PullRequestListOptions,
  type PullRequestStatus,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;

type ListDateRangeOptions = {
  from?: string | null;
  to?: string | null;
};

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
      detail_body = COALESCE(excluded.detail_body, pull_requests.detail_body),
      archived_at = CASE
        WHEN excluded.status IN ('open', 'draft')
          THEN NULL
        ELSE pull_requests.archived_at
      END,
      payload_pruned_at = CASE
        WHEN @detailBodyProvided = 1 THEN NULL
        ELSE pull_requests.payload_pruned_at
      END`,
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
        detailBodyProvided: item.detailBody === undefined ? 0 : 1,
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
      detail_body = COALESCE(excluded.detail_body, issues.detail_body),
      archived_at = CASE
        WHEN excluded.state = 'open' THEN NULL
        ELSE issues.archived_at
      END`,
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

/**
 * Replace the cached Issue body/comments and refresh the summary row in one
 * transaction (plan 7.9). The fetched `updatedAt` doubles as the cache
 * marker so a later list update with a newer timestamp forces one fetch.
 */
export function replaceIssueDetailCache(
  database: DatabaseClient,
  repositoryId: string,
  detail: IssueDetailCacheInput,
): void {
  requireRepository(database, repositoryId);
  const updateIssue = database.prepare(
    `UPDATE issues SET
       title = @title,
       url = @url,
       author_login = @authorLogin,
       state = @state,
       comments_count = @commentsCount,
       created_at = @createdAt,
       updated_at = @updatedAt,
       closed_at = @closedAt,
       detail_body = @body,
       detail_synced_updated_at = @updatedAt,
       payload_pruned_at = NULL,
       archived_at = CASE
         WHEN @state = 'open' THEN NULL
         ELSE archived_at
       END
     WHERE repository_id = @repositoryId AND number = @number`,
  );
  const deleteComments = database.prepare(
    `DELETE FROM issue_comments
     WHERE repository_id = ? AND issue_number = ?`,
  );
  const insertComment = database.prepare(
    `INSERT INTO issue_comments (
       repository_id, issue_number, github_comment_id, author_login, body,
       created_at, updated_at, url
     ) VALUES (
       @repositoryId, @issueNumber, @id, @authorLogin, @body,
       @createdAt, @updatedAt, @url
     )`,
  );
  const sortedComments = [...detail.comments].sort(compareComments);

  database.transaction(() => {
    const result = updateIssue.run({
      repositoryId,
      number: detail.number,
      title: detail.title,
      url: detail.url,
      authorLogin: detail.authorLogin,
      state: detail.state,
      commentsCount: detail.commentsCount,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      closedAt: detail.closedAt,
      body: detail.body,
    });
    if (result.changes !== 1) {
      throw new Error(
        `Cannot cache detail for missing issue #${detail.number} in repository ${repositoryId}`,
      );
    }
    deleteComments.run(repositoryId, detail.number);
    for (const comment of sortedComments) {
      insertComment.run({
        repositoryId,
        issueNumber: detail.number,
        id: comment.id,
        authorLogin: comment.authorLogin,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
      });
    }
  })();
}

/**
 * The issue.updatedAt value whose body/comments are currently cached.
 * The Issue detail route fetches only when this differs from the stored
 * issue row's updated_at.
 */
export function getIssueDetailSyncedUpdatedAt(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): string | null {
  requireRepository(database, repositoryId);
  const row = database
    .prepare(
      `SELECT detail_synced_updated_at
       FROM issues
       WHERE repository_id = ? AND number = ?`,
    )
    .get(repositoryId, number) as
    | { detail_synced_updated_at: string | null }
    | undefined;
  return row?.detail_synced_updated_at ?? null;
}

export interface IssueDetailCacheState {
  updatedAt: string;
  syncedUpdatedAt: string | null;
  payloadPrunedAt: string | null;
}

/** Lightweight cache check that does not load the Issue body or comments. */
export function getIssueDetailCacheState(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): IssueDetailCacheState | null {
  requireRepository(database, repositoryId);
  const row = database
    .prepare(
      `SELECT updated_at, detail_synced_updated_at, payload_pruned_at
       FROM issues
       WHERE repository_id = ? AND number = ?`,
    )
    .get(repositoryId, number) as
    | {
        updated_at: string;
        detail_synced_updated_at: string | null;
        payload_pruned_at: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    updatedAt: row.updated_at,
    syncedUpdatedAt: row.detail_synced_updated_at ?? null,
    payloadPrunedAt: row.payload_pruned_at ?? null,
  };
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
  if (!Number.isInteger(size) || size <= 0 || size > DEFAULT_PAGE_SIZE) {
    throw new Error(`List page size must be an integer between 1 and ${DEFAULT_PAGE_SIZE}`);
  }
  return size;
}

function pageNumber(value: number | undefined): number {
  const page = value ?? 1;
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new Error("List page number must be a positive safe integer");
  }
  return page;
}

function pageOffset(page: number, limit: number): number {
  const zeroBasedPage = page - 1;
  // SQLite receives JavaScript numbers here; clamp before multiplication so
  // an accepted safe page can never create an unsafe integer offset.
  if (zeroBasedPage > Math.floor(Number.MAX_SAFE_INTEGER / limit)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return zeroBasedPage * limit;
}

function cursorValues(value: string | null | undefined): ListCursorPayload | null {
  if (!value) return null;
  try {
    return decodeListCursor(value);
  } catch {
    throw new InvalidCursorError();
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Add the shared full-dataset search predicate before any list pagination. */
function searchPredicate(
  clauses: string[],
  parameters: unknown[],
  value: string | null | undefined,
  numberColumn: string,
  titleColumn: string,
  authorColumn: string,
): void {
  const needle = value?.trim().toLowerCase();
  if (!needle) return;
  const numberNeedle = needle.startsWith("#") ? needle.slice(1) : needle;
  const pattern = `%${escapeLike(numberNeedle)}%`;
  clauses.push(
    `(CAST(${numberColumn} AS TEXT) LIKE ? ESCAPE '\\'
      OR LOWER(${titleColumn}) LIKE ? ESCAPE '\\'
      OR LOWER(${authorColumn}) LIKE ? ESCAPE '\\')`,
  );
  parameters.push(pattern, pattern, pattern);
}

function datePredicate(
  clauses: string[],
  parameters: unknown[],
  from: string | null | undefined,
  to: string | null | undefined,
  timeZone: string,
): void {
  if (from && to && from > to) {
    throw new Error("Date range from must be on or before to");
  }
  if (from) {
    clauses.push("updated_at >= ?");
    parameters.push(calendarDateToUtc(from, timeZone).from);
  }
  if (to) {
    clauses.push("updated_at < ?");
    parameters.push(calendarDateToUtc(to, timeZone).to);
  }
}

function updatedCursorPredicate(
  clauses: string[],
  parameters: unknown[],
  cursor: ListCursorPayload | null,
): void {
  if (!cursor) return;
  if (cursor.sort !== "updated" || cursor.updatedAt === undefined) {
    throw new InvalidCursorError();
  }
  clauses.push("(updated_at < ? OR (updated_at = ? AND number < ?))");
  parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.number);
}

function mapPullRequest(
  row: Record<string, unknown>,
): Omit<PullRequestListItem, "domains"> {
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
    archivedAt: (row.archived_at as string | null) ?? null,
    payloadPrunedAt: (row.payload_pruned_at as string | null) ?? null,
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
    archivedAt: (row.archived_at as string | null) ?? null,
    payloadPrunedAt: (row.payload_pruned_at as string | null) ?? null,
  };
}

function mapIssueComment(row: Record<string, unknown>): IssueComment {
  return {
    id: row.github_comment_id as number,
    authorLogin: (row.author_login as string | null) ?? null,
    body: row.body as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    url: row.url as string,
  };
}

function compareComments(
  left: IssueCommentInput,
  right: IssueCommentInput,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id - right.id
  );
}

function appendArchiveFilter(
  clauses: string[],
  filter: PullRequestListOptions["archive"] | IssueListOptions["archive"],
  column: string,
): void {
  switch (filter ?? "current") {
    case "current":
      clauses.push(`${column} IS NULL`);
      return;
    case "archived":
      clauses.push(`${column} IS NOT NULL`);
      return;
    case "all":
      return;
    default:
      throw new Error(`Unknown archive filter: ${String(filter)}`);
  }
}

export function listPullRequests(
  database: DatabaseClient,
  repositoryId: string,
  options: PullRequestListOptions & ListDateRangeOptions,
): PageList<PullRequestListItem> {
  requireRepository(database, repositoryId);
  const calendarTimeZone = resolveTimeZone(options);
  const page = pageNumber(options.page);
  const limit = pageSize(options.limit);
  const sort = options.sort ?? "updated";
  const clauses = ["repository_id = ?"];
  const parameters: unknown[] = [repositoryId];
  appendArchiveFilter(clauses, options.archive, "archived_at");
  datePredicate(
    clauses,
    parameters,
    options.from ?? options.date,
    options.to ?? options.date,
    calendarTimeZone,
  );
  if (options.status) {
    clauses.push("status = ?");
    parameters.push(options.status);
  }
  searchPredicate(
    clauses,
    parameters,
    options.search,
    "pull_requests.number",
    "pull_requests.title",
    "pull_requests.author_login",
  );
  const domainIds = options.domainIds?.filter((id) => id.length > 0) ?? [];
  if (domainIds.length > 0) {
    // ANY-match semantics: the pull request carries at least one selected
    // domain rule (plan 10.3). The rule ids are validated at the HTTP edge.
    const placeholders = domainIds.map(() => "?").join(", ");
    clauses.push(
      `EXISTS (
        SELECT 1 FROM pull_request_domains pd
        WHERE pd.repository_id = pull_requests.repository_id
          AND pd.pr_number = pull_requests.number
          AND pd.domain_rule_id IN (${placeholders})
      )`,
    );
    parameters.push(...domainIds);
  }
  const orderBy = sort === "number"
    ? "number DESC"
    : "updated_at DESC, number DESC";

  const totalRow = database
    .prepare(
      `SELECT COUNT(*) AS total_count
       FROM pull_requests
       WHERE ${clauses.join(" AND ")}`,
    )
    .get(...parameters) as { total_count: number };
  const totalCount = Number(totalRow.total_count);
  const totalPages = Math.ceil(totalCount / limit);
  const effectivePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const offset = pageOffset(effectivePage, limit);

  const rows = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, status,
              updated_at, changed_files_count, additions, deletions,
              archived_at, payload_pruned_at
       FROM pull_requests
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as Array<Record<string, unknown>>;
  const pageRows = rows;
  const domainTags = listDomainTagsForPullRequests(
    database,
    repositoryId,
    pageRows.map((row) => row.number as number),
  );
  const items: PullRequestListItem[] = pageRows.map((row) => ({
    ...mapPullRequest(row),
    domains: domainTags.get(row.number as number) ?? [],
  }));
  return {
    items,
    page: effectivePage,
    pageSize: limit,
    totalCount,
    totalPages,
    calendarTimeZone,
  };
}

function mapMergedPullRequest(
  row: Record<string, unknown>,
): MergedPullRequestListItem {
  return {
    ...mapPullRequest(row),
    domains: [],
    mergedAt: row.merged_at as string,
  };
}

export function listMergedPullRequests(
  database: DatabaseClient,
  repositoryId: string,
  options: MergedPullRequestListOptions,
): PageList<MergedPullRequestListItem> {
  requireRepository(database, repositoryId);
  const calendarTimeZone = resolveTimeZone(options);
  const page = pageNumber(options.page);
  const limit = pageSize(options.limit);
  const clauses = ["repository_id = ?", "merged_at IS NOT NULL"];
  const parameters: unknown[] = [repositoryId];
  searchPredicate(
    clauses,
    parameters,
    options.search,
    "pull_requests.number",
    "pull_requests.title",
    "pull_requests.author_login",
  );
  const domainIds = options.domainIds?.filter((id) => id.length > 0) ?? [];
  if (domainIds.length > 0) {
    const placeholders = domainIds.map(() => "?").join(", ");
    clauses.push(
      `EXISTS (
        SELECT 1 FROM pull_request_domains pd
        WHERE pd.repository_id = pull_requests.repository_id
          AND pd.pr_number = pull_requests.number
          AND pd.domain_rule_id IN (${placeholders})
      )`,
    );
    parameters.push(...domainIds);
  }
  const totalRow = database
    .prepare(
      `SELECT COUNT(*) AS total_count
       FROM pull_requests
       WHERE ${clauses.join(" AND ")}`,
    )
    .get(...parameters) as { total_count: number };
  const totalCount = Number(totalRow.total_count);
  const totalPages = Math.ceil(totalCount / limit);
  const effectivePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const offset = pageOffset(effectivePage, limit);
  const rows = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, status,
              updated_at, changed_files_count, additions, deletions, merged_at,
              archived_at, payload_pruned_at
       FROM pull_requests
       WHERE ${clauses.join(" AND ")}
       ORDER BY merged_at DESC, number DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as Array<Record<string, unknown>>;
  const pageRows = rows;
  const domainTags = listDomainTagsForPullRequests(
    database,
    repositoryId,
    pageRows.map((row) => row.number as number),
  );
  const items = pageRows.map((row) => ({
    ...mapMergedPullRequest(row),
    domains: domainTags.get(row.number as number) ?? [],
  }));
  return {
    items,
    page: effectivePage,
    pageSize: limit,
    totalCount,
    totalPages,
    calendarTimeZone,
  };
}

export function getPullRequestDetail(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): PullRequestDetail | null {
  requireRepository(database, repositoryId);
  const row = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, status,
              updated_at, changed_files_count, additions, deletions,
              created_at, closed_at, merged_at, base_ref_name,
              head_ref_name, head_sha, detail_body,
              archived_at, payload_pruned_at
       FROM pull_requests
       WHERE repository_id = ? AND number = ?`,
    )
    .get(repositoryId, number) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const domains = listDomainTagsForPullRequests(database, repositoryId, [number]).get(number) ?? [];
  return {
    ...mapPullRequest(row),
    domains,
    createdAt: row.created_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    mergedAt: (row.merged_at as string | null) ?? null,
    baseRefName: row.base_ref_name as string,
    headRefName: row.head_ref_name as string,
    headSha: row.head_sha as string,
    detailBody: (row.detail_body as string | null) ?? null,
  };
}

export function listIssues(
  database: DatabaseClient,
  repositoryId: string,
  options: IssueListOptions & ListDateRangeOptions,
): ListPage<IssueListItem> {
  requireRepository(database, repositoryId);
  const calendarTimeZone = resolveTimeZone(options);
  const limit = pageSize(options.limit);
  const cursor = cursorValues(options.cursor);
  const clauses = ["repository_id = ?"];
  const parameters: unknown[] = [repositoryId];
  appendArchiveFilter(clauses, options.archive, "archived_at");
  datePredicate(
    clauses,
    parameters,
    options.from ?? options.date,
    options.to ?? options.date,
    calendarTimeZone,
  );
  if (options.status) {
    clauses.push("state = ?");
    parameters.push(options.status);
  }
  searchPredicate(
    clauses,
    parameters,
    options.search,
    "issues.number",
    "issues.title",
    "issues.author_login",
  );
  updatedCursorPredicate(clauses, parameters, cursor);
  parameters.push(limit + 1);

  const rows = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, state,
              comments_count, updated_at, archived_at, payload_pruned_at
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
        ? encodeListCursor({ sort: "updated", updatedAt: last.updatedAt, number: last.number })
        : null,
    calendarTimeZone,
  };
}

/** Stored full Issue row for the detail page (plan 1.3, 18.3). */
export function getIssueDetail(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): IssueDetail | null {
  requireRepository(database, repositoryId);
  const row = database
    .prepare(
      `SELECT repository_id, number, title, url, author_login, state,
              comments_count, updated_at, created_at, closed_at, detail_body,
              archived_at, payload_pruned_at
       FROM issues
       WHERE repository_id = ? AND number = ?`,
    )
    .get(repositoryId, number) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const commentRows = database
    .prepare(
      `SELECT github_comment_id, author_login, body, created_at, updated_at, url
       FROM issue_comments
       WHERE repository_id = ? AND issue_number = ?
       ORDER BY created_at ASC, github_comment_id ASC`,
    )
    .all(repositoryId, number) as Array<Record<string, unknown>>;
  return {
    ...mapIssue(row),
    createdAt: row.created_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    detailBody: (row.detail_body as string | null) ?? null,
    comments: commentRows.map(mapIssueComment),
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
