import { z } from "zod";

import {
  canonicalUtc,
  formatRepository,
  formatSchemaIssues,
  GitHubClient,
  githubRateLimitSchema,
  GitHubGraphQLError,
  responseError,
  unreachableRateLimit,
  GitHubResponseError,
} from "./github-client.js";
import type {
  FetchedIssueComment,
  FetchedIssueDetail,
  HistorySyncInput,
  IssueDetailInput,
  IssueMetadata,
  IssuePage,
  IssueSyncInput,
  RepositoryRef,
} from "./provider.js";

export const ISSUE_PAGE_SIZE = 100;

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
        rateLimit: githubRateLimitSchema,
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(
      z
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
        .strict(),
    ).optional(),
  })
  .strict();

const restIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  user: z.object({ login: z.string().min(1) }).nullable(),
  body: z.string().nullable(),
  comments: z.number().int().nonnegative(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  closed_at: nullableDateTimeSchema,
});

const restIssueCommentSchema = z.object({
  id: z.number().int().positive(),
  user: z.object({ login: z.string().min(1) }).nullable(),
  body: z.string(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  html_url: z.string().url(),
});

export const ISSUE_QUERY = `query Issues(
  $owner: String!
  $name: String!
  $cursor: String
  $states: [IssueState!]
) {
  repository(owner: $owner, name: $name) {
    issues(
      first: ${ISSUE_PAGE_SIZE}
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

type IssueResponse = z.infer<typeof issueResponseSchema>;

interface NormalizedIssueSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: IssueSyncInput["mode"];
  readonly watermarkUpdatedAt: string | null;
  readonly syncStartedAt: string;
  readonly lookbackDays: number;
  readonly cursor: string | null;
  readonly recoveryAnchorUpdatedAt: string | null;
}

export interface IssueProviderOptions {
  readonly client: GitHubClient;
  readonly lookbackDays: number;
}

/** Issue-specific query, mapping, detail, comments, cutoff, and pagination. */
export class IssueProvider {
  private readonly client: GitHubClient;
  private readonly lookbackDays: number;

  constructor(options: IssueProviderOptions) {
    this.client = options.client;
    this.lookbackDays = options.lookbackDays;
  }

  async *fetchUpdates(input: IssueSyncInput): AsyncIterable<IssuePage> {
    const normalized = normalizeSyncInput(input, this.lookbackDays);
    yield* this.iterate(
      normalized,
      ["OPEN", "CLOSED"],
      cutoffFor(normalized),
    );
  }

  async *fetchHistory(input: HistorySyncInput): AsyncIterable<IssuePage> {
    const normalized = normalizeHistoryInput(input);
    yield* this.iterate(
      normalized,
      ["OPEN", "CLOSED"],
      cutoffFor(normalized),
    );
  }

  async fetchDetail(input: IssueDetailInput): Promise<FetchedIssueDetail> {
    const repository = input.repository;
    validateRepository(
      repository,
      "GitHub issue detail input repository must include owner and name",
    );
    if (!Number.isInteger(input.number) || input.number <= 0) {
      throw new Error("GitHub issue detail input number must be a positive integer");
    }
    const repositoryLabel = formatRepository(repository);
    const issueEndpoint =
      `repos/${repository.owner}/${repository.name}/issues/${input.number}`;
    const decodedIssue = await this.client.requestJson(
      repository,
      "IssueDetail",
      "GET",
      issueEndpoint,
      null,
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
        `/comments?per_page=${ISSUE_PAGE_SIZE}&page=${page}`;
      const decoded = await this.client.requestJson(
        repository,
        "IssueDetail",
        "GET",
        endpoint,
        null,
      );
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
      if (parsed.data.length < ISSUE_PAGE_SIZE) {
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

  private async *iterate(
    input: NormalizedIssueSyncInput,
    states: readonly string[],
    cutoff: Date | null,
  ): AsyncIterable<IssuePage> {
    let cursor: string | null = input.cursor;
    let recoveredFromExpiredCursor = false;
    const seenCursors = new Set<string>();

    while (true) {
      let response: IssueResponse;
      try {
        response = await this.client.runGraphQL<IssueResponse>(
          input.repository,
          "Issues",
          ISSUE_QUERY,
          { ...input.repository, cursor, states },
          issueResponseSchema,
        );
      } catch (error: unknown) {
        if (
          input.mode === "history" &&
          cursor !== null &&
          !recoveredFromExpiredCursor &&
          input.recoveryAnchorUpdatedAt !== null &&
          isExpiredCursorError(error)
        ) {
          cursor = null;
          recoveredFromExpiredCursor = true;
          continue;
        }
        throw error;
      }
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
      const nextCursor = requireNextCursor(
        input.repository,
        connection.pageInfo.endCursor,
      );
      if (seenCursors.has(nextCursor)) {
        throw responseError(
          input.repository,
          "Issues",
          "pageInfo.endCursor repeated before pagination completed",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
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
  return left.createdAt.localeCompare(right.createdAt) || left.id - right.id;
}

function normalizeSyncInput(
  input: IssueSyncInput,
  defaultLookbackDays: number,
): NormalizedIssueSyncInput {
  if (input === null || typeof input !== "object") {
    throw new Error("GitHub sync input must be an object");
  }
  const repository = input.repository;
  validateRepository(repository, "GitHub sync input repository must include owner and name");
  if (input.mode !== "bootstrap" && input.mode !== "incremental") {
    if (input.mode !== "history") {
      throw new Error("GitHub sync input mode must be bootstrap, incremental, or history");
    }
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
    repository: { owner: repository.owner, name: repository.name },
    mode: input.mode,
    watermarkUpdatedAt,
    syncStartedAt,
    lookbackDays,
    cursor: input.cursor ?? null,
    recoveryAnchorUpdatedAt: null,
  };
}

function normalizeHistoryInput(input: HistorySyncInput): NormalizedIssueSyncInput {
  if (input === null || typeof input !== "object") {
    throw new Error("GitHub history input must be an object");
  }
  const repository = input.repository;
  validateRepository(repository, "GitHub history input repository must include owner and name");
  return {
    repository: { owner: repository.owner, name: repository.name },
    mode: "history",
    watermarkUpdatedAt: null,
    syncStartedAt: canonicalUtc(input.syncStartedAt ?? new Date().toISOString()),
    lookbackDays: 30,
    cursor: input.cursor ?? null,
    recoveryAnchorUpdatedAt:
      input.recoveryAnchorUpdatedAt === undefined || input.recoveryAnchorUpdatedAt === null
        ? null
        : canonicalUtc(input.recoveryAnchorUpdatedAt),
  };
}

function cutoffFor(input: NormalizedIssueSyncInput): Date | null {
  if (input.mode === "history") {
    if (input.cursor !== null || input.recoveryAnchorUpdatedAt === null) return null;
    return new Date(
      Date.parse(input.recoveryAnchorUpdatedAt) - 2 * 60 * 1000,
    );
  }
  if (input.mode === "incremental") {
    return new Date(Date.parse(input.watermarkUpdatedAt!) - 2 * 60 * 1000);
  }

  return new Date(
    Date.parse(input.syncStartedAt) - input.lookbackDays * 24 * 60 * 60 * 1000,
  );
}

function isExpiredCursorError(error: unknown): boolean {
  if (!(error instanceof GitHubGraphQLError)) return false;
  if (error.types.some((type) => /invalid[_ ]cursor|expired[_ ]cursor/i.test(type))) {
    return true;
  }
  const message = error.messages.join(" ").toLowerCase();
  return message.includes("cursor") &&
    /invalid|expired|unknown|not found/.test(message);
}

function requireNextCursor(
  repository: RepositoryRef,
  endCursor: string | null,
): string {
  if (endCursor === null) {
    throw responseError(
      repository,
      "Issues",
      "pageInfo.hasNextPage is true but endCursor is null",
    );
  }
  return endCursor;
}

function validateRepository(
  repository: RepositoryRef,
  message: string,
): void {
  if (
    repository === null ||
    typeof repository !== "object" ||
    typeof repository.owner !== "string" ||
    repository.owner.length === 0 ||
    typeof repository.name !== "string" ||
    repository.name.length === 0
  ) {
    throw new Error(message);
  }
}

function isDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}
