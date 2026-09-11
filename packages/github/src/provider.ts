import {
  DEFAULT_API_BASE_URL,
  DEFAULT_COMMAND_TIMEOUT_MS,
  GitHubClient,
} from "./github-client.js";
import {
  GitHubCommandError,
  GitHubGraphQLError,
  GitHubHttpError,
  GitHubResponseError,
} from "./github-client.js";
import {
  IssueProvider,
  ISSUE_QUERY,
} from "./issues.js";
import {
  PullRequestFilesProvider,
} from "./files.js";
import {
  DEFAULT_LOOKBACK_DAYS,
  PULL_REQUEST_PAGE_SIZE,
  PULL_REQUEST_QUERY,
  PullRequestProvider,
  derivePullRequestStatus,
  WATERMARK_OVERLAP_MS,
} from "./pull-requests.js";

export {
  GitHubCommandError,
  GitHubGraphQLError,
  GitHubHttpError,
  GitHubResponseError,
};
export { derivePullRequestStatus } from "./pull-requests.js";

/** The repository coordinates accepted by the GitHub GraphQL API. */
export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export type SyncMode = "bootstrap" | "incremental" | "history";

/** GraphQL/REST operations surfaced in provider error types. */
export type GitHubOperation =
  | "PullRequests"
  | "Issues"
  | "PullRequestFiles"
  | "IssueDetail"
  | "Connection";

export interface PullRequestSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  /** The previous successful watermark. Required for incremental sync. */
  readonly watermarkUpdatedAt?: Date | string | null;
  /** Captured sync-attempt time. Defaults to the first iterator turn. */
  readonly syncStartedAt?: Date | string;
  /** Initial/bootstrap sync window measured by updatedAt. Defaults to 30 days. */
  readonly lookbackDays?: number;
  readonly cursor?: string | null;
}

export interface IssueSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  /** The previous successful watermark. Required for incremental sync. */
  readonly watermarkUpdatedAt?: Date | string | null;
  /** Captured sync-attempt time. Defaults to the first iterator turn. */
  readonly syncStartedAt?: Date | string;
  /** Initial/bootstrap sync window measured by updatedAt. Defaults to 30 days. */
  readonly lookbackDays?: number;
  readonly cursor?: string | null;
}

export interface HistorySyncInput {
  readonly repository: RepositoryRef;
  /** Cursor from the last successfully consumed descending page, if any. */
  readonly cursor?: string | null;
  /** Safe timestamp anchor used when a remote cursor is no longer usable. */
  readonly recoveryAnchorUpdatedAt?: Date | string | null;
  readonly syncStartedAt?: Date | string;
}

export interface PullRequestFetchInput {
  readonly repository: RepositoryRef;
  readonly number: number;
}

export type PullRequestStatus = "draft" | "open" | "closed" | "merged";
export type IssueStatus = "open" | "closed";

export interface GitHubPageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface GitHubRateLimit {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly limit?: number;
}

export interface GitHubQuota {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: string | null;
}

export interface GitHubAccount {
  readonly login: string;
  readonly name: string | null;
}

/** Safe connection result for the Settings integration surface. */
export interface GitHubConnectionStatus {
  readonly account: GitHubAccount;
  readonly rest: GitHubQuota;
  readonly graphql: GitHubQuota;
}

export interface PullRequestMetadata {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly stateRaw: "OPEN" | "CLOSED" | "MERGED";
  readonly status: PullRequestStatus;
  readonly isDraft: boolean;
  readonly authorLogin: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFilesCount: number;
  readonly detailBody?: string | null;
}

export interface IssueMetadata {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED";
  readonly status: IssueStatus;
  readonly authorLogin: string | null;
  readonly commentsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface IssueDetailInput {
  readonly repository: RepositoryRef;
  readonly number: number;
}

export interface FetchedIssueComment {
  readonly id: number;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

/** Lazily fetched Issue body and comments, normalized to LoongBoard fields. */
export interface FetchedIssueDetail {
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
  readonly comments: readonly FetchedIssueComment[];
}

export interface PullRequestPage {
  readonly items: readonly PullRequestMetadata[];
  readonly pageInfo: GitHubPageInfo;
  readonly rateLimit: GitHubRateLimit;
}

export interface IssuePage {
  readonly items: readonly IssueMetadata[];
  readonly pageInfo: GitHubPageInfo;
  readonly rateLimit: GitHubRateLimit;
}

export interface GitHubMetadataProvider {
  fetchPullRequestUpdates(
    input: PullRequestSyncInput,
  ): AsyncIterable<PullRequestPage>;
  fetchIssueUpdates(input: IssueSyncInput): AsyncIterable<IssuePage>;
  /** Descending history stream; implementations should resume from cursor. */
  fetchPullRequestHistory?(input: HistorySyncInput): AsyncIterable<PullRequestPage>;
  fetchIssueHistory?(input: HistorySyncInput): AsyncIterable<IssuePage>;
  /** Fetch one PR by number without touching either sync watermark. */
  fetchPullRequest?(input: PullRequestFetchInput): Promise<PullRequestMetadata>;
  fetchPullRequestFiles(
    input: import("./files.js").PullRequestFilesInput,
  ): Promise<import("./files.js").PullRequestFilesResult[]>;
  fetchIssueDetail(input: IssueDetailInput): Promise<FetchedIssueDetail>;
  /** Optional capability used by the Settings integration route. */
  checkConnection?(): Promise<GitHubConnectionStatus>;
  /** Drop a cached bearer token after Settings replaces/removes credentials. */
  clearTokenCache?(): void;
}

export interface GhGitHubMetadataProviderOptions {
  /**
   * gh executable. Used only to resolve `gh auth token` when no other token
   * source is available.
   */
  readonly ghExecutable?: string;
  /** Injectable token source used verbatim by this provider. */
  readonly tokenResolver?: GitHubTokenResolver;
  /** Injectable fetch implementation, mainly for deterministic tests. */
  readonly fetch?: GitHubFetch;
  /** GraphQL/REST API origin. Defaults to the public GitHub API. */
  readonly apiBaseUrl?: string;
  /** Timeout for token resolution and each HTTP request. */
  readonly commandTimeoutMs?: number;
  readonly lookbackDays?: number;
  /** Snapshot environment for deterministic credential resolution and tests. */
  readonly environment?: NodeJS.ProcessEnv;
}

/** Matches Node's global fetch signature. */
export type GitHubFetch = typeof fetch;
/** Token resolution seam; the returned token is cached in memory only. */
export type GitHubTokenResolver = () => string | null | Promise<string | null>;

/**
 * Stable public facade. Concrete GitHub concerns live in small feature and
 * transport modules; callers continue using the original provider contract.
 */
export class GhGitHubMetadataProvider implements GitHubMetadataProvider {
  private readonly client: GitHubClient;
  private readonly pullRequests: PullRequestProvider;
  private readonly issues: IssueProvider;
  private readonly files: PullRequestFilesProvider;

  constructor(options: GhGitHubMetadataProviderOptions = {}) {
    const ghExecutable = options.ghExecutable ?? "gh";
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const fetchImplementation = options.fetch ?? fetch;
    const tokenResolver = options.tokenResolver ?? null;
    const environment = options.environment ?? process.env;

    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new Error("lookbackDays must be a positive integer");
    }

    this.client = new GitHubClient({
      ghExecutable,
      apiBaseUrl,
      fetch: fetchImplementation,
      tokenResolver,
      commandTimeoutMs,
      environment,
    });
    this.pullRequests = new PullRequestProvider({
      client: this.client,
      lookbackDays,
    });
    this.issues = new IssueProvider({
      client: this.client,
      lookbackDays,
    });
    this.files = new PullRequestFilesProvider({ client: this.client });
  }

  /** Allow the Settings boundary to apply a replaced credential immediately. */
  clearTokenCache(): void {
    this.client.clearTokenCache();
  }

  fetchPullRequestUpdates(input: PullRequestSyncInput): AsyncIterable<PullRequestPage> {
    return this.pullRequests.fetchUpdates(input);
  }

  fetchIssueUpdates(input: IssueSyncInput): AsyncIterable<IssuePage> {
    return this.issues.fetchUpdates(input);
  }

  fetchPullRequestHistory(input: HistorySyncInput): AsyncIterable<PullRequestPage> {
    return this.pullRequests.fetchHistory(input);
  }

  fetchIssueHistory(input: HistorySyncInput): AsyncIterable<IssuePage> {
    return this.issues.fetchHistory(input);
  }

  fetchPullRequest(input: PullRequestFetchInput): Promise<PullRequestMetadata> {
    return this.pullRequests.fetchByNumber(input);
  }

  fetchPullRequestFiles(
    input: import("./files.js").PullRequestFilesInput,
  ): Promise<import("./files.js").PullRequestFilesResult[]> {
    return this.files.fetch(input);
  }

  fetchIssueDetail(input: IssueDetailInput): Promise<FetchedIssueDetail> {
    return this.issues.fetchDetail(input);
  }

  checkConnection(): Promise<GitHubConnectionStatus> {
    return this.client.checkConnection();
  }
}

export const githubGraphqlQueries = {
  pullRequests: PULL_REQUEST_QUERY,
  issues: ISSUE_QUERY,
} as const;

export const githubProviderConstants = {
  pageSize: PULL_REQUEST_PAGE_SIZE,
  defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
  watermarkOverlapMs: WATERMARK_OVERLAP_MS,
} as const;
