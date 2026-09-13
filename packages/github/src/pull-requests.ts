import { z } from "zod";

import {
  canonicalUtc,
  formatRepository,
  formatSchemaIssues,
  GitHubClient,
  githubRateLimitSchema,
  GitHubGraphQLError,
  GitHubResponseError,
  responseError,
  unreachableRateLimit,
} from "./github-client.js";
import type {
  HistorySyncInput,
  PullRequestFetchInput,
  PullRequestMetadata,
  PullRequestPage,
  PullRequestStatus,
  PullRequestSyncInput,
  RepositoryRef,
} from "./provider.js";

export const PULL_REQUEST_PAGE_SIZE = 100;
export const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;
export const DEFAULT_LOOKBACK_DAYS = 7;

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

// REST payloads grow over time (sha, blob_url, patch, ...); only the fields
// LoongBoard consumes are validated here, unknown fields are stripped.
const restPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable().optional(),
  user: z.object({ login: z.string().min(1) }).nullable(),
  body: z.string().nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  closed_at: nullableDateTimeSchema,
  merged_at: nullableDateTimeSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  base: z.object({ ref: z.string() }).strict(),
  head: z.object({ ref: z.string(), sha: z.string().min(1) }).strict(),
});

export const PULL_REQUEST_QUERY = `query PullRequests(
  $owner: String!
  $name: String!
  $cursor: String
  $states: [PullRequestState!]
) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: ${PULL_REQUEST_PAGE_SIZE}
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

type PullRequestResponse = z.infer<typeof pullRequestResponseSchema>;

interface NormalizedPullRequestSyncInput {
  readonly repository: RepositoryRef;
  readonly mode: PullRequestSyncInput["mode"];
  readonly watermarkUpdatedAt: string | null;
  readonly syncStartedAt: string;
  readonly lookbackDays: number;
  readonly cursor: string | null;
  readonly recoveryAnchorUpdatedAt: string | null;
}

export interface PullRequestProviderOptions {
  readonly client: GitHubClient;
  readonly lookbackDays: number;
}

/** Pull-request-specific query, mapping, cutoff, and cursor behavior. */
export class PullRequestProvider {
  private readonly client: GitHubClient;
  private readonly lookbackDays: number;

  constructor(options: PullRequestProviderOptions) {
    this.client = options.client;
    this.lookbackDays = options.lookbackDays;
  }

  async *fetchUpdates(
    input: PullRequestSyncInput,
  ): AsyncIterable<PullRequestPage> {
    const normalized = normalizeSyncInput(input, this.lookbackDays);
    const cutoff = cutoffFor(normalized);

    yield* this.iterate(
      normalized,
      ["OPEN", "CLOSED", "MERGED"],
      cutoff,
    );
  }

  async *fetchHistory(
    input: HistorySyncInput,
  ): AsyncIterable<PullRequestPage> {
    const normalized = normalizeHistoryInput(input);
    yield* this.iterate(
      normalized,
      ["OPEN", "CLOSED", "MERGED"],
      cutoffFor(normalized),
    );
  }

  async fetchByNumber(
    input: PullRequestFetchInput,
  ): Promise<PullRequestMetadata> {
    const repository = input.repository;
    validateRepository(repository, "GitHub pull request input repository must include owner and name");
    if (!Number.isInteger(input.number) || input.number <= 0) {
      throw new Error("GitHub pull request number must be a positive integer");
    }
    const decoded = await this.client.requestJson(
      repository,
      "PullRequests",
      "GET",
      `repos/${repository.owner}/${repository.name}/pulls/${input.number}`,
      null,
    );
    const parsed = restPullRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new GitHubResponseError(
        formatRepository(repository),
        "PullRequests",
        formatSchemaIssues(parsed.error),
      );
    }
    const pull = parsed.data;
    const stateRaw = pull.merged_at === null
      ? pull.state.toUpperCase() as "OPEN" | "CLOSED"
      : "MERGED";
    const isDraft = pull.draft ?? false;
    return {
      nodeId: `rest:${repository.owner}/${repository.name}#${pull.number}`,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      stateRaw,
      status: derivePullRequestStatus({ state: stateRaw, isDraft, mergedAt: pull.merged_at }),
      isDraft,
      authorLogin: pull.user?.login ?? null,
      createdAt: canonicalUtc(pull.created_at),
      updatedAt: canonicalUtc(pull.updated_at),
      closedAt: pull.closed_at === null ? null : canonicalUtc(pull.closed_at),
      mergedAt: pull.merged_at === null ? null : canonicalUtc(pull.merged_at),
      baseRefName: pull.base.ref,
      headRefName: pull.head.ref,
      headSha: pull.head.sha,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFilesCount: pull.changed_files,
      detailBody: pull.body,
    };
  }

  private async *iterate(
    input: NormalizedPullRequestSyncInput,
    states: readonly string[],
    cutoff: Date | null,
  ): AsyncIterable<PullRequestPage> {
    let cursor: string | null = input.cursor;
    let recoveredFromExpiredCursor = false;
    const seenCursors = new Set<string>();

    while (true) {
      let response: PullRequestResponse;
      try {
        response = await this.client.runGraphQL<PullRequestResponse>(
          input.repository,
          "PullRequests",
          PULL_REQUEST_QUERY,
          { ...input.repository, cursor, states },
          pullRequestResponseSchema,
        );
      } catch (error: unknown) {
        if (
          input.mode === "history" &&
          cursor !== null &&
          !recoveredFromExpiredCursor &&
          input.recoveryAnchorUpdatedAt !== null &&
          isExpiredCursorError(error)
        ) {
          // GitHub cursors are opaque and can expire after a long pause. A
          // timestamp anchor is the safe fallback with a small overlap.
          cursor = null;
          recoveredFromExpiredCursor = true;
          continue;
        }
        throw error;
      }
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
      const nextCursor = requireNextCursor(
        input.repository,
        "PullRequests",
        connection.pageInfo.endCursor,
      );
      if (seenCursors.has(nextCursor)) {
        throw responseError(
          input.repository,
          "PullRequests",
          "pageInfo.endCursor repeated before pagination completed",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
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

function normalizeSyncInput(
  input: PullRequestSyncInput,
  defaultLookbackDays: number,
): NormalizedPullRequestSyncInput {
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

function normalizeHistoryInput(input: HistorySyncInput): NormalizedPullRequestSyncInput {
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
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    cursor: input.cursor ?? null,
    recoveryAnchorUpdatedAt:
      input.recoveryAnchorUpdatedAt === undefined || input.recoveryAnchorUpdatedAt === null
        ? null
        : canonicalUtc(input.recoveryAnchorUpdatedAt),
  };
}

function cutoffFor(input: NormalizedPullRequestSyncInput): Date | null {
  if (input.mode === "history") {
    // A durable cursor is primary. The anchor only applies after recovery
    // restarts from the newest page.
    if (input.cursor !== null || input.recoveryAnchorUpdatedAt === null) return null;
    return new Date(
      Date.parse(input.recoveryAnchorUpdatedAt) - WATERMARK_OVERLAP_MS,
    );
  }
  if (input.mode === "incremental") {
    return new Date(Date.parse(input.watermarkUpdatedAt!) - WATERMARK_OVERLAP_MS);
  }

  return new Date(
    Date.parse(input.syncStartedAt) - input.lookbackDays * 24 * 60 * 60 * 1000,
  );
}

function isExpiredCursorError(error: unknown): boolean {
  // Only explicit invalid/expired cursor errors may reset pagination.
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
  operation: "PullRequests",
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
