import { execa } from "execa";
import { z } from "zod";

const PAGE_SIZE = 100;
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

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
}

export interface GhGitHubMetadataProviderOptions {
  /** Override only for tests or an explicitly configured gh installation. */
  readonly ghExecutable?: string;
  readonly commandTimeoutMs?: number;
  readonly lookbackDays?: number;
}

export class GitHubCommandError extends Error {
  readonly command = "gh api graphql";
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
      `GitHub GraphQL command failed for ${repository} (exit code ${exitCode ?? "unknown"})${detail}`,
      { cause },
    );
    this.name = "GitHubCommandError";
    this.repository = repository;
    this.exitCode = exitCode;
    this.stderr = truncate(stderr);
  }
}

export class GitHubResponseError extends Error {
  readonly repository: string;
  readonly operation: "PullRequests" | "Issues";

  constructor(
    repository: string,
    operation: "PullRequests" | "Issues",
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
  readonly operation: "PullRequests" | "Issues";
  readonly messages: readonly string[];

  constructor(
    repository: string,
    operation: "PullRequests" | "Issues",
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

interface NormalizedSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: SyncMode;
  readonly watermarkUpdatedAt: string | null;
  readonly syncStartedAt: string;
  readonly lookbackDays: number;
}

interface GraphQLVariables {
  readonly owner: string;
  readonly name: string;
  readonly cursor: string | null;
  readonly states: readonly string[];
}

interface GhGitHubMetadataProviderOptionsInternal {
  readonly ghExecutable: string;
  readonly commandTimeoutMs: number;
  readonly lookbackDays: number;
}

export class GhGitHubMetadataProvider implements GitHubMetadataProvider {
  private readonly options: GhGitHubMetadataProviderOptionsInternal;

  constructor(options: GhGitHubMetadataProviderOptions = {}) {
    const ghExecutable = options.ghExecutable ?? "gh";
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

    if (ghExecutable.length === 0) {
      throw new Error("ghExecutable must not be empty");
    }
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error("commandTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
      throw new Error("lookbackDays must be a positive integer");
    }

    this.options = { ghExecutable, commandTimeoutMs, lookbackDays };
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

  private async runGraphQL<TResponse extends PullRequestResponse | IssueResponse>(
    repository: RepositoryRef,
    operation: "PullRequests" | "Issues",
    query: string,
    variables: GraphQLVariables,
    schema: z.ZodType<TResponse>,
  ): Promise<TResponse> {
    const repositoryLabel = formatRepository(repository);
    const requestBody = JSON.stringify({ query, variables });
    let result: Awaited<ReturnType<typeof execa>>;

    try {
      result = await execa(
        this.options.ghExecutable,
        ["api", "graphql", "--input", "-"],
        {
          input: requestBody,
          shell: false,
          reject: false,
          timeout: this.options.commandTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
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

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout) as unknown;
    } catch (error) {
      throw new GitHubResponseError(
        repositoryLabel,
        operation,
        "stdout is not valid JSON",
        error,
      );
    }

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
  operation: "PullRequests" | "Issues",
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
  operation: "PullRequests" | "Issues",
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
