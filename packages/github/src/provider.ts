import { execa } from "execa";
import { z } from "zod";

import {
  chunkIntoBatches,
  FILES_BATCH_SIZE,
  FILES_PAGE_SIZE,
  MAX_CONCURRENT_FILE_BATCHES,
  MAX_FILES_PER_PULL_REQUEST,
  normalizeChangeType,
  runWithConcurrency,
  type FetchedPullRequestFile,
  type PullRequestFilesInput,
  type PullRequestFilesResult,
  type PullRequestFileRef,
} from "./files.js";

const PAGE_SIZE = 100;
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_API_BASE_URL = "https://api.github.com";
const GRAPHQL_PATH = "graphql";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "loongboard-github-provider";

/** The repository coordinates accepted by the GitHub GraphQL API. */
export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export type SyncMode = "bootstrap" | "incremental";

export interface PullRequestSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  /** The previous successful watermark. Required for incremental sync. */
  readonly watermarkUpdatedAt?: Date | string | null;
  /** Captured sync-attempt time. Defaults to the first iterator turn. */
  readonly syncStartedAt?: Date | string;
  /** Bootstrap closed-item lookback. Defaults to 90 days. */
  readonly lookbackDays?: number;
}

export interface IssueSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  /** The previous successful watermark. Required for incremental sync. */
  readonly watermarkUpdatedAt?: Date | string | null;
  /** Captured sync-attempt time. Defaults to the first iterator turn. */
  readonly syncStartedAt?: Date | string;
  /** Bootstrap closed-item lookback. Defaults to 90 days. */
  readonly lookbackDays?: number;
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
  fetchPullRequestFiles(
    input: PullRequestFilesInput,
  ): Promise<PullRequestFilesResult[]>;
  fetchIssueDetail(input: IssueDetailInput): Promise<FetchedIssueDetail>;
}

export interface GhGitHubMetadataProviderOptions {
  /**
   * gh executable. Used only to resolve `gh auth token` when no other token
   * source is available; kept under the original name for compatibility.
   */
  readonly ghExecutable?: string;
  /**
   * Injectable token source used verbatim by this provider. When omitted,
   * the provider prefers `GITHUB_TOKEN` and then runs `gh auth token`
   * exactly once per successful resolution.
   */
  readonly tokenResolver?: GitHubTokenResolver;
  /** Injectable fetch implementation, mainly for deterministic tests. */
  readonly fetch?: GitHubFetch;
  /** GraphQL/REST API origin. Defaults to the public GitHub API. */
  readonly apiBaseUrl?: string;
  /** Timeout for token resolution and each HTTP request. */
  readonly commandTimeoutMs?: number;
  readonly lookbackDays?: number;
}

/** Signature compatible with Node's global fetch. */
export type GitHubFetch = typeof fetch;
/** Token resolution seam; the returned token is cached in memory only. */
export type GitHubTokenResolver = () => string | Promise<string>;

export class GitHubCommandError extends Error {
  readonly command = "gh auth token";
  readonly repository: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    repository: string,
    exitCode: number | null,
    stderr: string,
    cause?: unknown,
  ) {
    const detail = stderr.length > 0 ? `: ${truncate(stderr)}` : "";
    super(
      `GitHub auth token command failed for ${repository} (exit code ${exitCode ?? "unknown"})${detail}`,
      { cause },
    );
    this.name = "GitHubCommandError";
    this.repository = repository;
    this.exitCode = exitCode;
    this.stderr = truncate(stderr);
  }
}

/** GraphQL/REST operations surfaced in provider error types. */
export type GitHubOperation =
  | "PullRequests"
  | "Issues"
  | "PullRequestFiles"
  | "IssueDetail";

export class GitHubResponseError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;

  constructor(
    repository: string,
    operation: GitHubOperation,
    message: string,
    cause?: unknown,
  ) {
    super(`GitHub ${operation} response invalid for ${repository}: ${message}`, {
      cause,
    });
    this.name = "GitHubResponseError";
    this.repository = repository;
    this.operation = operation;
  }
}

export class GitHubGraphQLError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;
  readonly messages: readonly string[];

  constructor(
    repository: string,
    operation: GitHubOperation,
    messages: readonly string[],
  ) {
    super(
      `GitHub ${operation} GraphQL errors for ${repository}: ${messages
        .map(truncate)
        .join("; ")}`,
    );
    this.name = "GitHubGraphQLError";
    this.repository = repository;
    this.operation = operation;
    this.messages = messages.map(truncate);
  }
}

/** An HTTP request to GitHub failed at the transport or status layer. */
export class GitHubHttpError extends Error {
  readonly repository: string;
  readonly operation: GitHubOperation;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;

  constructor(
    repository: string,
    operation: GitHubOperation,
    method: string,
    url: string,
    status: number | null,
    detail: string,
    cause?: unknown,
  ) {
    const statusLabel = status === null ? "without an HTTP response" : `HTTP ${status}`;
    const suffix = detail.length > 0 ? `: ${truncate(detail)}` : "";
    super(
      `GitHub ${operation} request ${statusLabel} failed for ${repository} (${method} ${url})${suffix}`,
      { cause },
    );
    this.name = "GitHubHttpError";
    this.repository = repository;
    this.operation = operation;
    this.method = method;
    this.url = url;
    this.status = status;
  }
}

const dateTimeSchema = z.string().refine(isDateTime, {
  message: "must be a valid ISO date-time",
});
const nullableDateTimeSchema = dateTimeSchema.nullable();
const authorSchema = z
  .object({
    login: z.string().min(1),
  })
  .strict()
  .nullable();
const pageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).nullable(),
  })
  .strict();
const rateLimitSchema = z
  .object({
    cost: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: dateTimeSchema,
  })
  .strict();
const graphqlErrorSchema = z
  .object({
    message: z.string().min(1),
    type: z.string().optional(),
    path: z.array(z.union([z.string(), z.number().int()])).optional(),
    locations: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            column: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const pullRequestNodeSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    author: authorSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    closedAt: nullableDateTimeSchema,
    mergedAt: nullableDateTimeSchema,
    baseRefName: z.string(),
    headRefName: z.string(),
    headRefOid: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
  })
  .strict();

const issueNodeSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    state: z.enum(["OPEN", "CLOSED"]),
    author: authorSchema,
    comments: z
      .object({
        totalCount: z.number().int().nonnegative(),
      })
      .strict(),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    closedAt: nullableDateTimeSchema,
  })
  .strict();

const pullRequestResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            pullRequests: z
              .object({
                nodes: z.array(pullRequestNodeSchema),
                pageInfo: pageInfoSchema,
              })
              .strict(),
          })
          .strict(),
        rateLimit: rateLimitSchema,
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(graphqlErrorSchema).optional(),
  })
  .strict();

const issueResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            issues: z
              .object({
                nodes: z.array(issueNodeSchema),
                pageInfo: pageInfoSchema,
              })
              .strict(),
          })
          .strict(),
        rateLimit: rateLimitSchema,
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(graphqlErrorSchema).optional(),
  })
  .strict();

const pullRequestFileNodeSchema = z
  .object({
    path: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    // PatchStatus enum (ADDED/CHANGED/COPIED/DELETED/MODIFIED/RENAMED); kept
    // as an open string so a new GitHub state never breaks sync — it is
    // normalized by `normalizeChangeType` instead.
    changeType: z.string().min(1),
  })
  .strict();

const pullRequestFilesNodeSchema = z
  .object({
    number: z.number().int().positive(),
    files: z
      .object({
        nodes: z.array(pullRequestFileNodeSchema),
        pageInfo: pageInfoSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .nullable();

const pullRequestFilesResponseSchema = z
  .object({
    data: z
      .object({
        nodes: z.array(pullRequestFilesNodeSchema),
        rateLimit: rateLimitSchema,
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(graphqlErrorSchema).optional(),
  })
  .strict();

// REST payloads grow over time (sha, blob_url, patch, ...); only the fields
// LoongBoard consumes are validated here, unknown fields are stripped.
const restPullRequestFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previous_filename: z.string().min(1).optional(),
});

const restUserSchema = z
  .object({
    login: z.string().min(1),
  })
  .nullable();

const restIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  user: restUserSchema,
  body: z.string().nullable(),
  comments: z.number().int().nonnegative(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  closed_at: nullableDateTimeSchema,
});

const restIssueCommentSchema = z.object({
  id: z.number().int().positive(),
  user: restUserSchema,
  body: z.string(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  html_url: z.string().url(),
});

const PULL_REQUEST_QUERY = `query PullRequests(
  $owner: String!
  $name: String!
  $cursor: String
  $states: [PullRequestState!]
) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: ${PAGE_SIZE}
      after: $cursor
      states: $states
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        id
        number
        title
        url
        state
        isDraft
        createdAt
        updatedAt
        closedAt
        mergedAt
        baseRefName
        headRefName
        headRefOid
        additions
        deletions
        changedFiles
        author { login }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

const ISSUE_QUERY = `query Issues(
  $owner: String!
  $name: String!
  $cursor: String
  $states: [IssueState!]
) {
  repository(owner: $owner, name: $name) {
    issues(
      first: ${PAGE_SIZE}
      after: $cursor
      states: $states
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        id
        number
        title
        url
        state
        author { login }
        comments { totalCount }
        createdAt
        updatedAt
        closedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

type PullRequestResponse = z.infer<typeof pullRequestResponseSchema>;
type IssueResponse = z.infer<typeof issueResponseSchema>;
type PullRequestFilesResponse = z.infer<typeof pullRequestFilesResponseSchema>;
type GraphQLResponseEnvelope =
  | PullRequestResponse
  | IssueResponse
  | PullRequestFilesResponse;

const PULL_REQUEST_FILES_QUERY = `query PullRequestFiles($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      number
      files(first: ${FILES_PAGE_SIZE}) {
        nodes { path additions deletions changeType }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

interface NormalizedSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  readonly watermarkUpdatedAt: string | null;
  readonly syncStartedAt: string;
  readonly lookbackDays: number;
}

type GraphQLVariables = Readonly<Record<string, unknown>>;

interface GhGitHubMetadataProviderOptionsInternal {
  readonly ghExecutable: string;
  readonly apiBaseUrl: string;
  readonly fetch: GitHubFetch;
  readonly tokenResolver: GitHubTokenResolver | null;
  readonly commandTimeoutMs: number;
  readonly lookbackDays: number;
}

export class GhGitHubMetadataProvider implements GitHubMetadataProvider {
  private readonly options: GhGitHubMetadataProviderOptionsInternal;
  private tokenPromise: Promise<string> | null = null;

  constructor(options: GhGitHubMetadataProviderOptions = {}) {
    const ghExecutable = options.ghExecutable ?? "gh";
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const fetchImplementation = options.fetch ?? fetch;
    const tokenResolver = options.tokenResolver ?? null;

    if (ghExecutable.length === 0) {
      throw new Error("ghExecutable must not be empty");
    }
    if (apiBaseUrl.length === 0) {
      throw new Error("apiBaseUrl must not be empty");
    }
    if (typeof fetchImplementation !== "function") {
      throw new Error("fetch must be a function");
    }
    if (tokenResolver !== null && typeof tokenResolver !== "function") {
      throw new Error("tokenResolver must be a function");
    }
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error("commandTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new Error("lookbackDays must be a positive integer");
    }

    this.options = {
      ghExecutable,
      apiBaseUrl,
      fetch: fetchImplementation,
      tokenResolver,
      commandTimeoutMs,
      lookbackDays,
    };
  }

  async *fetchPullRequestUpdates(
    input: PullRequestSyncInput,
  ): AsyncIterable<PullRequestPage> {
    const normalized = normalizeSyncInput(input, this.options.lookbackDays);
    const cutoff = cutoffFor(normalized);

    if (normalized.mode === "bootstrap") {
      yield* this.iteratePullRequests(normalized, ["OPEN"], null);
      yield* this.iteratePullRequests(normalized, ["CLOSED", "MERGED"], cutoff);
      return;
    }

    yield* this.iteratePullRequests(
      normalized,
      ["OPEN", "CLOSED", "MERGED"],
      cutoff,
    );
  }

  async *fetchIssueUpdates(input: IssueSyncInput): AsyncIterable<IssuePage> {
    const normalized = normalizeSyncInput(input, this.options.lookbackDays);
    const cutoff = cutoffFor(normalized);

    if (normalized.mode === "bootstrap") {
      yield* this.iterateIssues(normalized, ["OPEN"], null);
      yield* this.iterateIssues(normalized, ["CLOSED"], cutoff);
      return;
    }

    yield* this.iterateIssues(normalized, ["OPEN", "CLOSED"], cutoff);
  }

  /**
   * Fetch the changed-file set for the given pull request heads (plan 9.6).
   * Batches of up to 20 node ids go through one GraphQL `nodes(ids:)` call;
   * PRs whose file connection reports `hasNextPage` fall back to the REST
   * files endpoint. At most 2 batches run concurrently. Results preserve the
   * input order; PRs the API no longer resolves return an empty file set.
   */
  async fetchPullRequestFiles(
    input: PullRequestFilesInput,
  ): Promise<PullRequestFilesResult[]> {
    if (input === null || typeof input !== "object") {
      throw new Error("GitHub files input must be an object");
    }
    const repository = input.repository;
    if (
      repository === null ||
      typeof repository !== "object" ||
      typeof repository.owner !== "string" ||
      repository.owner.length === 0 ||
      typeof repository.name !== "string" ||
      repository.name.length === 0
    ) {
      throw new Error("GitHub files input repository must include owner and name");
    }
    if (!Array.isArray(input.pullRequests)) {
      throw new Error("GitHub files input pullRequests must be an array");
    }
    const refs: PullRequestFileRef[] = input.pullRequests.map((ref) => {
      if (
        ref === null ||
        typeof ref !== "object" ||
        typeof ref.nodeId !== "string" ||
        ref.nodeId.length === 0 ||
        !Number.isInteger(ref.number) ||
        ref.number <= 0
      ) {
        throw new Error(
          "GitHub files input pullRequests must include nodeId and a positive number",
        );
      }
      return { nodeId: ref.nodeId, number: ref.number };
    });
    if (refs.length === 0) {
      return [];
    }

    const batches = chunkIntoBatches(refs, FILES_BATCH_SIZE);
    const batchResults = await runWithConcurrency(
      batches,
      MAX_CONCURRENT_FILE_BATCHES,
      (batch) => this.fetchFilesBatch(repository, batch),
    );
    const byNumber = new Map<number, PullRequestFilesResult>();
    for (const results of batchResults) {
      for (const result of results) {
        byNumber.set(result.number, result);
      }
    }
    return refs.map(
      (ref) =>
        byNumber.get(ref.number) ?? {
          number: ref.number,
          files: [],
          truncated: false,
        },
    );
  }

  /**
   * Lazy Issue detail fetch (plan 7.9): one REST issue request for the body
   * plus every REST comments page at 100 items/page. Results are canonical
   * UTC strings with comments sorted by creation time, then comment id.
   */
  async fetchIssueDetail(
    input: IssueDetailInput,
  ): Promise<FetchedIssueDetail> {
    const repository = input.repository;
    if (
      repository === null ||
      typeof repository !== "object" ||
      typeof repository.owner !== "string" ||
      repository.owner.length === 0 ||
      typeof repository.name !== "string" ||
      repository.name.length === 0
    ) {
      throw new Error("GitHub issue detail input repository must include owner and name");
    }
    if (!Number.isInteger(input.number) || input.number <= 0) {
      throw new Error("GitHub issue detail input number must be a positive integer");
    }
    const repositoryLabel = formatRepository(repository);
    const issueEndpoint =
      `repos/${repository.owner}/${repository.name}/issues/${input.number}`;
    const decodedIssue = await this.runRest(
      repository,
      issueEndpoint,
      "IssueDetail",
    );
    const parsedIssue = restIssueSchema.safeParse(decodedIssue);
    if (!parsedIssue.success) {
      throw new GitHubResponseError(
        repositoryLabel,
        "IssueDetail",
        formatSchemaIssues(parsedIssue.error),
      );
    }
    const issue = parsedIssue.data;

    const comments: FetchedIssueComment[] = [];
    for (let page = 1; ; page += 1) {
      const endpoint =
        `repos/${repository.owner}/${repository.name}/issues/${input.number}` +
        `/comments?per_page=${PAGE_SIZE}&page=${page}`;
      const decoded = await this.runRest(repository, endpoint, "IssueDetail");
      const parsed = z.array(restIssueCommentSchema).safeParse(decoded);
      if (!parsed.success) {
        throw new GitHubResponseError(
          repositoryLabel,
          "IssueDetail",
          formatSchemaIssues(parsed.error),
        );
      }
      comments.push(...parsed.data.map(mapRestIssueComment));
      // A short page is always the final page for the comments endpoint.
      if (parsed.data.length < PAGE_SIZE) {
        break;
      }
    }
    comments.sort(compareFetchedComments);

    return {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      authorLogin: issue.user?.login ?? null,
      commentsCount: issue.comments,
      createdAt: canonicalUtc(issue.created_at),
      updatedAt: canonicalUtc(issue.updated_at),
      closedAt: issue.closed_at === null ? null : canonicalUtc(issue.closed_at),
      body: issue.body ?? "",
      comments,
    };
  }

  private async fetchFilesBatch(
    repository: RepositoryRef,
    batch: readonly PullRequestFileRef[],
  ): Promise<PullRequestFilesResult[]> {
    const response = await this.runGraphQL<PullRequestFilesResponse>(
      repository,
      "PullRequestFiles",
      PULL_REQUEST_FILES_QUERY,
      { ids: batch.map((ref) => ref.nodeId) },
      pullRequestFilesResponseSchema,
    );
    const nodes = response.data?.nodes;
    if (nodes === undefined) {
      throw responseError(repository, "PullRequestFiles", "nodes is missing");
    }
    if (nodes.length !== batch.length) {
      throw responseError(
        repository,
        "PullRequestFiles",
        `nodes length ${nodes.length} does not match requested ids ${batch.length}`,
      );
    }

    const results: PullRequestFilesResult[] = [];
    for (const [index, node] of nodes.entries()) {
      const ref = batch[index]!;
      if (node === null) {
        // Deleted or otherwise unresolvable pull request: keep an empty set
        // so the head is recorded as enriched instead of retried forever.
        results.push({ number: ref.number, files: [], truncated: false });
        continue;
      }
      if (node.number !== ref.number) {
        // File sets are keyed by number; never risk misattribution.
        throw responseError(
          repository,
          "PullRequestFiles",
          `nodes order mismatch: expected #${ref.number}, received #${node.number}`,
        );
      }
      if (node.files === null) {
        results.push({ number: ref.number, files: [], truncated: false });
        continue;
      }
      if (node.files.pageInfo.hasNextPage) {
        results.push(await this.fetchRestFiles(repository, ref.number));
        continue;
      }
      results.push({
        number: ref.number,
        files: node.files.nodes.map((file) => ({
          path: file.path,
          previousPath: null,
          changeType: normalizeChangeType(file.changeType),
          additions: file.additions,
          deletions: file.deletions,
        })),
        truncated: false,
      });
    }
    return results;
  }

  /**
   * REST fallback for PRs with more than 100 files. Pages through
   * `per_page=100`; stops at the GitHub cap of 3000 files and marks the
   * result truncated (plan 9.6 — V1 does not resolve further).
   */
  private async fetchRestFiles(
    repository: RepositoryRef,
    prNumber: number,
  ): Promise<PullRequestFilesResult> {
    const files: FetchedPullRequestFile[] = [];
    let truncated = false;

    for (let page = 1; ; page += 1) {
      const endpoint =
        `repos/${repository.owner}/${repository.name}` +
        `/pulls/${prNumber}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`;
      const decoded = await this.runRest(repository, endpoint);
      const parsed = z.array(restPullRequestFileSchema).safeParse(decoded);
      if (!parsed.success) {
        throw new GitHubResponseError(
          formatRepository(repository),
          "PullRequestFiles",
          formatSchemaIssues(parsed.error),
        );
      }
      for (const item of parsed.data) {
        files.push({
          path: item.filename,
          previousPath: item.previous_filename ?? null,
          changeType: normalizeChangeType(item.status),
          additions: item.additions,
          deletions: item.deletions,
        });
      }
      // A short page is always the last one, so the set is complete even
      // when it lands exactly on the 3000-file cap.
      if (parsed.data.length < FILES_PAGE_SIZE) {
        break;
      }
      if (files.length >= MAX_FILES_PER_PULL_REQUEST) {
        files.length = MAX_FILES_PER_PULL_REQUEST;
        truncated = true;
        break;
      }
    }

    return { number: prNumber, files, truncated };
  }

  private async runRest(
    repository: RepositoryRef,
    endpoint: string,
    operation: GitHubOperation = "PullRequestFiles",
  ): Promise<unknown> {
    return this.requestJson(repository, operation, "GET", endpoint, null);
  }

  /**
   * Resolve the bearer token once and keep only the in-memory result. A
   * failed resolution is cleared so a later runtime attempt can retry.
   */
  private async getToken(repositoryLabel: string): Promise<string> {
    if (this.tokenPromise !== null) {
      return this.tokenPromise;
    }
    const promise = this.resolveToken(repositoryLabel);
    this.tokenPromise = promise;
    promise.catch(() => {
      if (this.tokenPromise === promise) {
        this.tokenPromise = null;
      }
    });
    return promise;
  }

  private async resolveToken(repositoryLabel: string): Promise<string> {
    if (this.options.tokenResolver !== null) {
      return requireToken(await this.options.tokenResolver());
    }

    const environmentToken = process.env.GITHUB_TOKEN;
    if (environmentToken !== undefined && environmentToken.trim().length > 0) {
      return environmentToken.trim();
    }
    return this.resolveGhAuthToken(repositoryLabel);
  }

  private async resolveGhAuthToken(repositoryLabel: string): Promise<string> {
    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa(
        this.options.ghExecutable,
        ["auth", "token"],
        {
          shell: false,
          reject: false,
          timeout: this.options.commandTimeoutMs,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      throw new GitHubCommandError(
        repositoryLabel,
        null,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    if (result.failed || result.exitCode !== 0) {
      throw new GitHubCommandError(
        repositoryLabel,
        result.exitCode ?? null,
        typeof result.stderr === "string" ? result.stderr : "",
      );
    }

    return requireToken(
      typeof result.stdout === "string" ? result.stdout : "",
    );
  }

  private async requestJson(
    repository: RepositoryRef,
    operation: GitHubOperation,
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<unknown> {
    const repositoryLabel = formatRepository(repository);
    const url = githubUrl(this.options.apiBaseUrl, path);
    const token = await this.getToken(repositoryLabel);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (body !== null) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.commandTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        null,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      clearTimeout(timer);
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        responseText,
      );
    }

    try {
      return JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new GitHubHttpError(
        repositoryLabel,
        operation,
        method,
        url,
        response.status,
        "response body is not valid JSON",
        error,
      );
    }
  }

  private async *iteratePullRequests(
    input: NormalizedSyncInput,
    states: readonly string[],
    cutoff: Date | null,
  ): AsyncIterable<PullRequestPage> {
    let cursor: string | null = null;

    while (true) {
      const response = await this.runGraphQL<PullRequestResponse>(
        input.repository,
        "PullRequests",
        PULL_REQUEST_QUERY,
        { ...input.repository, cursor, states },
        pullRequestResponseSchema,
      );
      const connection = response.data?.repository.pullRequests;
      if (connection === undefined) {
        throw responseError(
          input.repository,
          "PullRequests",
          "repository.pullRequests is missing",
        );
      }

      const items: PullRequestMetadata[] = [];
      let reachedCutoff = false;
      for (const node of connection.nodes) {
        if (cutoff !== null && Date.parse(node.updatedAt) < cutoff.getTime()) {
          reachedCutoff = true;
          break;
        }
        items.push(mapPullRequest(node));
      }

      yield {
        items,
        pageInfo: connection.pageInfo,
        rateLimit: response.data?.rateLimit ?? unreachableRateLimit(),
      };

      if (reachedCutoff || !connection.pageInfo.hasNextPage) {
        return;
      }
      cursor = requireNextCursor(
        input.repository,
        "PullRequests",
        connection.pageInfo.endCursor,
      );
    }
  }

  private async *iterateIssues(
    input: NormalizedSyncInput,
    states: readonly string[],
    cutoff: Date | null,
  ): AsyncIterable<IssuePage> {
    let cursor: string | null = null;

    while (true) {
      const response = await this.runGraphQL<IssueResponse>(
        input.repository,
        "Issues",
        ISSUE_QUERY,
        { ...input.repository, cursor, states },
        issueResponseSchema,
      );
      const connection = response.data?.repository.issues;
      if (connection === undefined) {
        throw responseError(
          input.repository,
          "Issues",
          "repository.issues is missing",
        );
      }

      const items: IssueMetadata[] = [];
      let reachedCutoff = false;
      for (const node of connection.nodes) {
        if (cutoff !== null && Date.parse(node.updatedAt) < cutoff.getTime()) {
          reachedCutoff = true;
          break;
        }
        items.push(mapIssue(node));
      }

      yield {
        items,
        pageInfo: connection.pageInfo,
        rateLimit: response.data?.rateLimit ?? unreachableRateLimit(),
      };

      if (reachedCutoff || !connection.pageInfo.hasNextPage) {
        return;
      }
      cursor = requireNextCursor(
        input.repository,
        "Issues",
        connection.pageInfo.endCursor,
      );
    }
  }

  private async runGraphQL<TResponse extends GraphQLResponseEnvelope>(
    repository: RepositoryRef,
    operation: GitHubOperation,
    query: string,
    variables: GraphQLVariables,
    schema: z.ZodType<TResponse>,
  ): Promise<TResponse> {
    const repositoryLabel = formatRepository(repository);
    const decoded = await this.requestJson(
      repository,
      operation,
      "POST",
      GRAPHQL_PATH,
      { query, variables },
    );

    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new GitHubResponseError(
        repositoryLabel,
        operation,
        formatSchemaIssues(parsed.error),
      );
    }

    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      throw new GitHubGraphQLError(
        repositoryLabel,
        operation,
        parsed.data.errors.map((error) => error.message),
      );
    }

    if (parsed.data.data === undefined || parsed.data.data === null) {
      throw new GitHubResponseError(
        repositoryLabel,
        operation,
        "data is missing",
      );
    }

    return parsed.data;
  }
}

/** Derive the persisted PR status exactly once at the GitHub boundary. */
export function derivePullRequestStatus(input: {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly mergedAt: string | null;
}): PullRequestStatus {
  if (input.state === "MERGED" || input.mergedAt !== null) {
    return "merged";
  }
  if (input.isDraft) {
    return "draft";
  }
  if (input.state === "CLOSED") {
    return "closed";
  }
  return "open";
}

function mapPullRequest(
  node: z.infer<typeof pullRequestNodeSchema>,
): PullRequestMetadata {
  return {
    nodeId: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    stateRaw: node.state,
    status: derivePullRequestStatus(node),
    isDraft: node.isDraft,
    authorLogin: node.author?.login ?? null,
    createdAt: canonicalUtc(node.createdAt),
    updatedAt: canonicalUtc(node.updatedAt),
    closedAt: node.closedAt === null ? null : canonicalUtc(node.closedAt),
    mergedAt: node.mergedAt === null ? null : canonicalUtc(node.mergedAt),
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    headSha: node.headRefOid,
    additions: node.additions,
    deletions: node.deletions,
    changedFilesCount: node.changedFiles,
  };
}

function mapIssue(node: z.infer<typeof issueNodeSchema>): IssueMetadata {
  return {
    nodeId: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    status: node.state === "OPEN" ? "open" : "closed",
    authorLogin: node.author?.login ?? null,
    commentsCount: node.comments.totalCount,
    createdAt: canonicalUtc(node.createdAt),
    updatedAt: canonicalUtc(node.updatedAt),
    closedAt: node.closedAt === null ? null : canonicalUtc(node.closedAt),
  };
}

function mapRestIssueComment(
  comment: z.infer<typeof restIssueCommentSchema>,
): FetchedIssueComment {
  return {
    id: comment.id,
    authorLogin: comment.user?.login ?? null,
    body: comment.body,
    createdAt: canonicalUtc(comment.created_at),
    updatedAt: canonicalUtc(comment.updated_at),
    url: comment.html_url,
  };
}

function compareFetchedComments(
  left: FetchedIssueComment,
  right: FetchedIssueComment,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.id - right.id
  );
}

function normalizeSyncInput(
  input: PullRequestSyncInput | IssueSyncInput,
  defaultLookbackDays: number,
): NormalizedSyncInput {
  if (input === null || typeof input !== "object") {
    throw new Error("GitHub sync input must be an object");
  }
  const repository = input.repository;
  if (
    repository === null ||
    typeof repository !== "object" ||
    typeof repository.owner !== "string" ||
    repository.owner.length === 0 ||
    typeof repository.name !== "string" ||
    repository.name.length === 0
  ) {
    throw new Error("GitHub sync input repository must include owner and name");
  }
  if (input.mode !== "bootstrap" && input.mode !== "incremental") {
    throw new Error("GitHub sync input mode must be bootstrap or incremental");
  }

  const lookbackDays = input.lookbackDays ?? defaultLookbackDays;
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
    throw new Error("lookbackDays must be a positive integer");
  }

  const syncStartedAt = canonicalUtc(
    input.syncStartedAt === undefined
      ? new Date().toISOString()
      : input.syncStartedAt,
  );
  const watermarkUpdatedAt =
    input.watermarkUpdatedAt === undefined || input.watermarkUpdatedAt === null
      ? null
      : canonicalUtc(input.watermarkUpdatedAt);

  if (input.mode === "incremental" && watermarkUpdatedAt === null) {
    throw new Error(
      `Incremental GitHub sync for ${formatRepository(repository)} requires watermarkUpdatedAt`,
    );
  }

  return {
    repository: {
      owner: repository.owner,
      name: repository.name,
    },
    mode: input.mode,
    watermarkUpdatedAt,
    syncStartedAt,
    lookbackDays,
  };
}

function cutoffFor(input: NormalizedSyncInput): Date | null {
  if (input.mode === "incremental") {
    return new Date(Date.parse(input.watermarkUpdatedAt!) - WATERMARK_OVERLAP_MS);
  }

  return new Date(
    Date.parse(input.syncStartedAt) - input.lookbackDays * 24 * 60 * 60 * 1000,
  );
}

function requireNextCursor(
  repository: RepositoryRef,
  operation: GitHubOperation,
  endCursor: string | null,
): string {
  if (endCursor === null) {
    throw responseError(
      repository,
      operation,
      "pageInfo.hasNextPage is true but endCursor is null",
    );
  }
  return endCursor;
}

function responseError(
  repository: RepositoryRef,
  operation: GitHubOperation,
  message: string,
): GitHubResponseError {
  return new GitHubResponseError(formatRepository(repository), operation, message);
}

function canonicalUtc(value: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("GitHub timestamp must be a valid date");
    }
    return value.toISOString();
  }
  if (typeof value !== "string" || !isDateTime(value)) {
    throw new Error("GitHub timestamp must be a valid ISO date-time");
  }
  return new Date(value).toISOString();
}

function isDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function formatRepository(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

function githubUrl(apiBaseUrl: string, path: string): string {
  const base =
    apiBaseUrl.length > 0 && apiBaseUrl.endsWith("/")
      ? apiBaseUrl.slice(0, -1)
      : apiBaseUrl;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${base}/${normalizedPath}`;
}

function requireToken(token: string): string {
  const value = token.trim();
  if (value.length === 0) {
    throw new Error("GitHub token resolution returned an empty token");
  }
  return value;
}

function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "response" : issue.path.join(".");
      return `${path} ${issue.message}`;
    })
    .join("; ");
}

function truncate(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function unreachableRateLimit(): never {
  throw new Error("GitHub response data is missing rateLimit");
}

export const githubGraphqlQueries = {
  pullRequests: PULL_REQUEST_QUERY,
  issues: ISSUE_QUERY,
} as const;

export const githubProviderConstants = {
  pageSize: PAGE_SIZE,
  defaultLookbackDays: DEFAULT_LOOKBACK_DAYS,
  watermarkOverlapMs: WATERMARK_OVERLAP_MS,
} as const;
