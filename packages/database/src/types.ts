import type Database from "better-sqlite3";

import type {
  ActivityDay,
  EntityKind,
  IssueListItem,
  IssueStatus,
  PullRequestListItem,
  PullRequestStatus,
  SyncStatus,
} from "@loongboard/contracts";

export type {
  ActivityDay,
  EntityKind,
  IssueListItem,
  IssueStatus,
  PullRequestListItem,
  PullRequestStatus,
  SyncStatus,
} from "@loongboard/contracts";

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

export interface ListQueryOptions {
  /** IANA zone used for date filtering and returned by HTTP. */
  calendarTimeZone: string;
  date?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface PullRequestListOptions extends ListQueryOptions {
  status?: PullRequestStatus | null;
}

export interface IssueListOptions extends ListQueryOptions {
  status?: IssueStatus | null;
}

export interface ListPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  calendarTimeZone: string;
}

export interface ActivityDaysOptions {
  from: string;
  to: string;
  calendarTimeZone: string;
}

export type DatabaseClient = Database.Database;
