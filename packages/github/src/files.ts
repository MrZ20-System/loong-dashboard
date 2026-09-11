import { z } from "zod";

import {
  formatRepository,
  formatSchemaIssues,
  GitHubClient,
  githubRateLimitSchema,
  responseError,
  GitHubResponseError,
} from "./github-client.js";
import type {
  RepositoryRef,
} from "./provider.js";

/**
 * Changed-file path enrichment helpers.
 *
 * Pure batching helpers remain available independently. The concrete
 * `PullRequestFilesProvider` below owns the GitHub GraphQL batch and REST
 * fallback boundary while keeping the provider facade free of file logic.
 */

/** GraphQL `nodes(ids:)` batch size for file enrichment. */
export const FILES_BATCH_SIZE = 20;
/** GraphQL `files(first:)` and REST `per_page` page size. */
export const FILES_PAGE_SIZE = 100;
/** GitHub REST caps one PR at 3000 files; enrichment stops there. */
export const MAX_FILES_PER_PULL_REQUEST = 3_000;
/** File enrichment is a medium-cost task: at most 2 batches concurrently. */
export const MAX_CONCURRENT_FILE_BATCHES = 2;

export interface PullRequestFilesRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

/** One pull request scheduled for changed-file enrichment. */
export interface PullRequestFileRef {
  readonly nodeId: string;
  readonly number: number;
}

export interface FetchedPullRequestFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PullRequestFilesResult {
  readonly number: number;
  readonly files: readonly FetchedPullRequestFile[];
  readonly truncated: boolean;
}

export interface PullRequestFilesInput {
  readonly repository: PullRequestFilesRepositoryRef;
  readonly pullRequests: readonly PullRequestFileRef[];
}

/**
 * Normalize GraphQL `PatchStatus` and REST `status` values into one
 * lowercase vocabulary. GraphQL `CHANGED` and REST `changed` collapse into
 * `modified`; GraphQL `DELETED` collapses into REST's `removed`. Unknown
 * future states are preserved (lowercased) instead of failing.
 */
export function normalizeChangeType(raw: string): string {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "added":
      return "added";
    case "changed":
    case "modified":
      return "modified";
    case "deleted":
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return value;
  }
}

/** Split enrichment targets into GraphQL batches of at most `size`. */
export function chunkIntoBatches<T>(
  items: readonly T[],
  size: number,
): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("Batch size must be a positive integer");
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Run `worker` over `items` with at most `concurrency` lanes, preserving
 * input order in the output. Lanes pull indexes synchronously, so the
 * single-threaded event loop keeps the shared cursor race-free.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive integer");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));

  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => run()));
  return results;
}

const pageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).nullable(),
  })
  .strict();

const pullRequestFileNodeSchema = z
  .object({
    path: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    // PatchStatus enum is intentionally open for future GitHub states.
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

// REST payloads grow over time; only fields consumed by LoongBoard are
// validated and unknown fields are stripped.
const restPullRequestFileSchema = z.object({
  filename: z.string().min(1),
  status: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previous_filename: z.string().min(1).optional(),
});

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

type PullRequestFilesResponse = z.infer<typeof pullRequestFilesResponseSchema>;

export interface PullRequestFilesProviderOptions {
  readonly client: GitHubClient;
}

/** GraphQL batch + REST fallback implementation for changed-file enrichment. */
export class PullRequestFilesProvider {
  private readonly client: GitHubClient;

  constructor(options: PullRequestFilesProviderOptions) {
    this.client = options.client;
  }

  async fetch(input: PullRequestFilesInput): Promise<PullRequestFilesResult[]> {
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
      (batch) => this.fetchBatch(repository, batch),
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

  private async fetchBatch(
    repository: RepositoryRef,
    batch: readonly PullRequestFileRef[],
  ): Promise<PullRequestFilesResult[]> {
    const response = await this.client.runGraphQL<PullRequestFilesResponse>(
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
        // Deleted or otherwise unresolvable PR: record an empty enrichment.
        results.push({ number: ref.number, files: [], truncated: false });
        continue;
      }
      if (node.number !== ref.number) {
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

  /** REST fallback stops at GitHub's 3000-file cap and marks truncation. */
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
      const decoded = await this.client.requestJson(
        repository,
        "PullRequestFiles",
        "GET",
        endpoint,
        null,
      );
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
      // A short page is final, including an exact 3000-file page.
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
}
