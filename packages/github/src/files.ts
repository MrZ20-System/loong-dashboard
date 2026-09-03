/**
 * Stage 2 changed-file path enrichment helpers (plan 9.6).
 *
 * This module is intentionally free of imports from `provider.ts` so the
 * provider can build on it without an import cycle. Types are structural:
 * `PullRequestFilesRepositoryRef` is satisfied by the provider's
 * `RepositoryRef`.
 */

/** GraphQL `nodes(ids:)` batch size for file enrichment (plan 9.6). */
export const FILES_BATCH_SIZE = 20;
/** GraphQL `files(first:)` and REST `per_page` page size. */
export const FILES_PAGE_SIZE = 100;
/** GitHub REST caps one PR at 3000 files; V1 stops there (plan 9.6). */
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
