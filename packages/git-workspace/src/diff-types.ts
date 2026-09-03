import type { ChangedFileEntry } from "@loongboard/contracts";

export type { ChangedFileEntry } from "@loongboard/contracts";

export interface PreparePullInput {
  readonly repositoryPath: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly prNumber: number;
  readonly headSha: string;
}

export interface PreparePullResult {
  readonly headSha: string;
  readonly mergeBase: string;
  /** True when this prepare call performed the one allowed fetch. */
  readonly fetched: boolean;
}

export interface ReadFileInput {
  readonly repositoryPath: string;
  readonly ref: string;
  readonly path: string;
}

/** Result of `git show <ref>:<path>` with the two V1 degradation branches. */
export interface FileContent {
  readonly path: string;
  readonly ref: string;
  readonly binary: boolean;
  readonly sizeBytes: number;
  /** Null when the file is binary or exceeds MAX_DIFF_FILE_BYTES. */
  readonly content: string | null;
  readonly tooLarge: boolean;
}

/** Files above this size render the "too large" notice instead of Monaco. */
export const MAX_DIFF_FILE_BYTES = 5 * 1024 * 1024;
