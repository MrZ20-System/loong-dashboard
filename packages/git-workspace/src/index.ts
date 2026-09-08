import type {
  ChangedFileEntry,
  FileContent,
  ListFilesAtRefInput,
  PreparePullInput,
  PreparePullResult,
  ReadFileInput,
} from "./diff-types.js";
import {
  GitCommandError,
  runGitBuffer,
  runGitOptionalText,
  runGitText,
  type RunGitOptions,
} from "./git-command.js";
import {
  GitObjectMissingError,
  GitPathUnsafeError,
  LocalGitWorkspace,
  type LocalGitWorkspaceOptions,
} from "./local-git-workspace.js";

export type {
  ChangedFileEntry,
  FileContent,
  ListFilesAtRefInput,
  PreparePullInput,
  PreparePullResult,
  ReadFileInput,
} from "./diff-types.js";
export { MAX_DIFF_FILE_BYTES } from "./diff-types.js";
export { GitCommandError, runGitBuffer, runGitOptionalText, runGitText, type RunGitOptions } from "./git-command.js";
export { GitObjectMissingError, GitPathUnsafeError, LocalGitWorkspace, type LocalGitWorkspaceOptions } from "./local-git-workspace.js";
export { runCheckpoint } from "./checkpoint.js";
export type { RunCheckpointInput, RunCheckpointResult } from "./checkpoint.js";
export {
  WorktreePool,
  WorktreePoolError,
  type AllocatedSlot,
  type AllocateSlotInput,
  type WorktreeSlotMetadata,
  type WorktreeSlotUsage,
} from "./worktree-pool.js";

/**
 * Public service shape used by the server routes. Keeping the interface in
 * the package lets the server app inject a real or fake workspace without
 * reaching into git internals.
 */
export interface GitWorkspace {
  preparePull(input: PreparePullInput): Promise<PreparePullResult>;
  listChangedFiles(input: {
    repositoryPath: string;
    mergeBase: string;
    headSha: string;
  }): Promise<ChangedFileEntry[]>;
  /** Every file path present at one validated repository ref. */
  listFilesAtRef(input: ListFilesAtRefInput): Promise<string[]>;
  readFile(input: ReadFileInput): Promise<FileContent>;
}

export const isGitWorkspace = (
  value: unknown,
): value is GitWorkspace =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as GitWorkspace).preparePull === "function" &&
  typeof (value as GitWorkspace).listChangedFiles === "function" &&
  typeof (value as GitWorkspace).listFilesAtRef === "function" &&
  typeof (value as GitWorkspace).readFile === "function";
