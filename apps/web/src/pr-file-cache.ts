import {
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ChangedFileEntry,
  FileContentResponse,
} from "@loongboard/contracts";

import { fetchFileContent } from "./diff-client";

export const PR_FILE_CACHE_TIME_MS = 30 * 60 * 1_000;
export const PR_FILE_PREFETCH_CONCURRENCY = 6;
export const PR_FILE_PREFETCH_BUDGET_BYTES = 96 * 1024 * 1024;

interface FileTarget {
  readonly path: string;
  readonly ref: string;
}

export interface PrefetchChangedFilesInput {
  readonly repositoryId: string;
  readonly number: number;
  readonly files: readonly ChangedFileEntry[];
  readonly mergeBase: string;
  readonly headSha: string;
  readonly shouldContinue?: () => boolean;
  readonly concurrency?: number;
  readonly budgetBytes?: number;
}

export function prFileQueryOptions(
  repositoryId: string,
  number: number,
  path: string,
  ref: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: ["pr-file", repositoryId, number, ref, path] as const,
    enabled,
    queryFn: ({ signal }) =>
      fetchFileContent(repositoryId, number, path, ref, signal),
    // A full SHA identifies immutable content. Revalidation cannot improve it.
    staleTime: Infinity,
    gcTime: PR_FILE_CACHE_TIME_MS,
    retry: false,
  });
}

/**
 * Warms immutable base/head file content after PR preparation. The bounded
 * worker pool protects the local Git service, while the aggregate memory
 * budget leaves unusually large PRs to finish on demand.
 */
export async function prefetchChangedFileContents(
  queryClient: QueryClient,
  input: PrefetchChangedFilesInput,
): Promise<{ loaded: number; failed: number; budgetReached: boolean }> {
  const targets = collectTargets(input.files, input.mergeBase, input.headSha);
  const concurrency = Math.max(
    1,
    Math.min(input.concurrency ?? PR_FILE_PREFETCH_CONCURRENCY, targets.length),
  );
  const budgetBytes = input.budgetBytes ?? PR_FILE_PREFETCH_BUDGET_BYTES;
  let cursor = 0;
  let retainedBytes = 0;
  let loaded = 0;
  let failed = 0;
  let budgetReached = false;

  async function worker(): Promise<void> {
    while (
      cursor < targets.length &&
      !budgetReached &&
      (input.shouldContinue?.() ?? true)
    ) {
      const target = targets[cursor];
      cursor += 1;
      if (target === undefined) return;
      try {
        const value = await queryClient.fetchQuery(
          prFileQueryOptions(
            input.repositoryId,
            input.number,
            target.path,
            target.ref,
          ),
        );
        loaded += 1;
        retainedBytes += retainedWeight(value);
        if (retainedBytes >= budgetBytes) budgetReached = cursor < targets.length;
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { loaded, failed, budgetReached };
}

function collectTargets(
  files: readonly ChangedFileEntry[],
  mergeBase: string,
  headSha: string,
): FileTarget[] {
  const targets = new Map<string, FileTarget>();
  for (const file of files) {
    if (file.binary) continue;
    if (file.changeType !== "added") {
      const target = { path: file.previousPath ?? file.path, ref: mergeBase };
      targets.set(`${target.ref}\0${target.path}`, target);
    }
    if (file.changeType !== "removed") {
      const target = { path: file.path, ref: headSha };
      targets.set(`${target.ref}\0${target.path}`, target);
    }
  }
  return [...targets.values()];
}

function retainedWeight(value: FileContentResponse): number {
  return value.content === null
    ? 256
    : Math.max(value.sizeBytes, value.content.length * 2) + 256;
}
