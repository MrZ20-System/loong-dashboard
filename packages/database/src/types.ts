import type Database from "better-sqlite3";

import type {
  ActivityDay,
  DomainRule,
  EntityKind,
  IssueComment,
  IssueDetail as ContractIssueDetail,
  IssueListItem as ContractIssueListItem,
  IssueStatus,
  MergedPullRequestListItem as ContractMergedPullRequestListItem,
  PullRequestDetail as ContractPullRequestDetail,
  PullRequestFileItem,
  PullRequestListItem as ContractPullRequestListItem,
  PullRequestListSort,
  PullRequestStatus,
  SyncStatus,
} from "@loongboard/contracts";

export type {
  ActivityDay,
  DomainRule,
  DomainTag,
  EntityKind,
  IssueComment,
  IssueStatus,
  PullRequestFileItem,
  PullRequestListSort,
  PullRequestStatus,
  SyncStatus,
} from "@loongboard/contracts";

/** Fields retained on a metadata row after it is archived or payload-pruned. */
export interface ArchiveMetadataFields {
  archivedAt: string | null;
  payloadPrunedAt: string | null;
}

/** Database projections include retention markers in addition to the public contract. */
export type PullRequestListItem = ContractPullRequestListItem & ArchiveMetadataFields;
export type MergedPullRequestListItem =
  ContractMergedPullRequestListItem & ArchiveMetadataFields;
export type PullRequestDetail = ContractPullRequestDetail & ArchiveMetadataFields;
export type IssueListItem = ContractIssueListItem & ArchiveMetadataFields;
export type IssueDetail = ContractIssueDetail & ArchiveMetadataFields;

/** The repository shape read from system.yaml by the Server boundary. */
export interface ConfiguredRepository {
  key: string;
  name: string;
  github: string;
  path: string;
  remote: string;
  defaultBranch: string;
  worktreeSlots: number;
}

export interface RepositoryRecord {
  id: string;
  key: string;
  displayName: string;
  githubOwner: string;
  githubName: string;
  localPath: string;
  remoteName: string;
  defaultBranch: string;
  worktreeSlots: number;
  enabled: boolean;
  /** Current locally indexed totals used by navigation/settings projections. */
  pullRequestCount?: number;
  mergedPullRequestCount?: number;
  issueCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepositorySyncState {
  repositoryId: string;
  entityKind: EntityKind;
  watermarkUpdatedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  status: SyncStatus;
  lastError: string | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export interface RepositorySyncStatus {
  repositoryId: string;
  status: SyncStatus;
  pullRequests: RepositorySyncState;
  issues: RepositorySyncState;
}

export interface SyncRun {
  repositoryId: string;
  syncRunId: string;
  startedAt: string;
  kind: SyncRunKind;
  trigger: SyncRunTrigger;
  /** Completion is attached after the queued run is admitted by the coordinator. */
  completion?: Promise<SyncRunRecord>;
}

export type SyncRunKind = "forward" | "history" | "fetch_pr";
export type SyncRunTrigger = "automatic" | "manual" | "api" | "system";
export type SyncRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "interrupted";

export interface SyncRunStreamRecord {
  runId: string;
  entityKind: EntityKind;
  status: SyncRunStatus;
  pagesFetched: number;
  itemsSeen: number;
  itemsWritten: number;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
  rateLimitRemaining: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface SyncRunRecord {
  syncRunId: string;
  repositoryId: string;
  kind: SyncRunKind;
  trigger: SyncRunTrigger;
  status: SyncRunStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  selector: Record<string, unknown>;
  itemsSeen: number;
  itemsWritten: number;
  error: string | null;
  streams: readonly SyncRunStreamRecord[];
}

export type HistoryStatus = "idle" | "running" | "paused" | "failed" | "completed";

export interface RepositoryHistoryState {
  repositoryId: string;
  entityKind: EntityKind;
  enabled: boolean;
  status: HistoryStatus;
  targetDate: string | null;
  oldestCoveredDay: string | null;
  cursor: string | null;
  recoveryAnchorUpdatedAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  resumeAfter: string | null;
  updatedAt: string;
}

export interface SyncStreamUpdate {
  completedAt?: Date | string;
  rateLimitRemaining?: number | null;
  rateLimitResetAt?: Date | string | null;
}

export interface PullRequestMetadata {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  authorLogin?: string | null;
  stateRaw: string;
  status: PullRequestStatus;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  /** Metadata pages do not carry detail bodies; omitted values preserve one. */
  detailBody?: string | null;
}

export interface IssueMetadata {
  nodeId: string;
  number: number;
  title: string;
  url: string;
  authorLogin?: string | null;
  status: IssueStatus;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  detailBody?: string | null;
}

/** One GitHub Issue comment row, as consumed by the detail cache writer. */
export interface IssueCommentInput {
  readonly id: number;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

/**
 * Complete body/comments cache payload. `updatedAt` becomes the
 * `detail_synced_updated_at` marker and also refreshes the summary row so
 * the marker comparison never uses a stale list-side timestamp.
 */
export interface IssueDetailCacheInput {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: IssueStatus;
  readonly authorLogin: string | null;
  readonly commentsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly comments: readonly IssueCommentInput[];
}

export interface ListQueryOptions {
  /** IANA zone used for date filtering and returned by HTTP. */
  calendarTimeZone: string;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export interface PullRequestListOptions extends ListQueryOptions {
  page?: number;
  status?: PullRequestStatus | null;
  sort?: PullRequestListSort | null;
  /** Case-insensitive contiguous title/author or PR-number search. */
  search?: string | null;
  /** Match pull requests carrying ANY of these domain rules. */
  domainIds?: readonly string[] | null;
  /** Retention projection to read; current is the safe default. */
  archive?: ArchiveFilter | null;
}

/** Stored domain rule row; identical in shape to the shared contract. */
export type DomainRuleRecord = DomainRule;

/** Stored current-head file row; identical in shape to the shared contract. */
export type PullRequestFileRecord = PullRequestFileItem;

/** Current-head file paths of one pull request, used by the classifier. */
export interface PullRequestFileSet {
  prNumber: number;
  headSha: string;
  paths: string[];
}

export interface IssueListOptions extends ListQueryOptions {
  cursor?: string | null;
  status?: IssueStatus | null;
  /** Case-insensitive contiguous title/author or issue-number search. */
  search?: string | null;
  /** Retention projection to read; current is the safe default. */
  archive?: ArchiveFilter | null;
}

export interface MergedPullRequestListOptions {
  calendarTimeZone: string;
  page?: number;
  limit?: number;
  search?: string | null;
  domainIds?: readonly string[] | null;
}

export interface ListPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  calendarTimeZone: string;
}

export interface PageList<T> {
  items: readonly T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  calendarTimeZone: string;
}

export interface ActivityDaysOptions {
  from: string;
  to: string;
  calendarTimeZone: string;
}

export type DatabaseClient = Database.Database;

export type ArchiveFilter = "current" | "archived" | "all";
export type ArchiveScope = "merged_prs" | "closed_prs" | "closed_issues";
export type MaintenanceRunKind =
  | "archive"
  | "purge_runtime_history";
export type MaintenanceRunTrigger = "manual" | "automatic";
export type MaintenanceRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface ArchivePreviewInput {
  repositoryId: string;
  /** Canonical UTC timestamp, including the trailing Z. */
  cutoff: string;
  includeMergedPrs: boolean;
  includeClosedPrs: boolean;
  includeClosedIssues: boolean;
}

export interface ArchivePreview extends ArchivePreviewInput {
  scopes: readonly ArchiveScope[];
  mergedPrCount: number;
  closedPrCount: number;
  closedIssueCount: number;
  prFileRows: number;
  issueCommentRows: number;
  prPayloadCount: number;
  issuePayloadCount: number;
}

export interface ArchiveBatchInput extends ArchivePreviewInput {
  archiveAt: string;
  prune?: boolean;
  /** A batch is intentionally bounded to keep SQLite write locks short. */
  batchSize?: number;
}

export interface ArchiveBatchResult {
  repositoryId: string;
  cutoff: string;
  archiveAt: string;
  batchSize: number;
  prCount: number;
  issueCount: number;
  filesDeleted: number;
  commentsDeleted: number;
  prPayloadPruned: number;
  issuePayloadPruned: number;
  hasMore: boolean;
}

export interface RestoreResult {
  repositoryId: string;
  entityKind: "pull_request" | "issue";
  number: number;
  archivedAt: null;
  payloadPrunedAt: string | null;
}

export interface MaintenanceRunRecord {
  id: string;
  repositoryId: string;
  kind: MaintenanceRunKind;
  trigger: MaintenanceRunTrigger;
  status: MaintenanceRunStatus;
  cutoff: string | null;
  selector: Record<string, unknown>;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  prCount: number;
  issueCount: number;
  filesDeleted: number;
  commentsDeleted: number;
  error: string | null;
}

export interface CreateMaintenanceRunInput {
  id?: string;
  repositoryId: string;
  kind: MaintenanceRunKind;
  trigger: MaintenanceRunTrigger;
  cutoff?: string | null;
  selector?: Record<string, unknown>;
  requestedAt?: string;
}

export interface UpdateMaintenanceRunInput {
  status?: MaintenanceRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  prCount?: number;
  issueCount?: number;
  filesDeleted?: number;
  commentsDeleted?: number;
  error?: string | null;
}

export interface PurgeRuntimeHistoryInput {
  repositoryId: string;
  /** Explicit UTC cutoff; when omitted it is derived from asOf - retentionDays. */
  cutoff?: string;
  asOf?: string;
  retentionDays?: number;
  /** Number of newest runs that are always retained, regardless of age. */
  keepLatest?: number;
  /** Bounded parent-run deletes per transaction. Defaults to 250. */
  batchSize?: number;
  /** Existing purge_runtime_history maintenance run to receive runsDeleted. */
  maintenanceRunId?: string;
}

export interface PurgeRuntimeHistoryScope {
  repositoryId: string;
  cutoff: string;
  retentionDays: number;
  keepLatest: number;
}

export interface PurgeRuntimeHistoryPreview extends PurgeRuntimeHistoryScope {
  runCount: number;
  protectedRunCount: number;
  queuedOrRunningCount: number;
  streamCount: number;
  targetCount: number;
}

export interface PurgeRuntimeHistoryBatchResult extends PurgeRuntimeHistoryScope {
  batchSize: number;
  runsDeleted: number;
  streamsDeleted: number;
  targetsDeleted: number;
  hasMore: boolean;
  maintenanceRunId: string | null;
}
