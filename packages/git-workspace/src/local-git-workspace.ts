import {
  type ChangedFileEntry,
  type FileContent,
  type PreparePullInput,
  type PreparePullResult,
  type ReadFileInput,
  MAX_DIFF_FILE_BYTES,
} from "./diff-types.js";
import {
  runGitBuffer,
  runGitOptionalText,
  runGitText,
} from "./git-command.js";

export class GitObjectMissingError extends Error {
  constructor(repositoryPath: string, ref: string) {
    super(`Git object ${ref} is not available in ${repositoryPath} after fetch`);
    this.name = "GitObjectMissingError";
  }
}

export class GitPathUnsafeError extends Error {
  constructor(path: string) {
    super(`Unsafe git path: ${path}`);
    this.name = "GitPathUnsafeError";
  }
}

const STATUS_TO_CHANGE_TYPE: Record<string, ChangedFileEntry["changeType"]> = {
  A: "added",
  M: "modified",
  D: "removed",
  T: "typechange",
  R: "renamed",
  C: "copied",
};

function containsNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

export function assertSafeGitPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  ) {
    throw new GitPathUnsafeError(path);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Parses `git diff --name-status -z --find-renames <base> <head>` into the
 * raw status records before numstat merge.
 */
function parseNameStatus(output: string): Array<{
  status: string;
  path: string;
  previousPath: string | null;
}> {
  const tokens = output.split("\0");
  // The output ends with a trailing NUL; drop the final empty token only.
  if (tokens.at(-1) === "") tokens.pop();
  const records: Array<{ status: string; path: string; previousPath: string | null }> = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (status === undefined || status.length === 0) {
      index += 1;
      continue;
    }
    const path = tokens[index + 1];
    if (path === undefined) break;
    const family = status[0];
    if (family === "R" || family === "C") {
      const newPath = tokens[index + 2];
      if (newPath === undefined) break;
      records.push({ status: family, path: newPath, previousPath: path });
      index += 3;
      continue;
    }
    records.push({ status: family, path, previousPath: null });
    index += 2;
  }
  return records;
}

function parseNumstat(output: string): Map<string, {
  additions: number | null;
  deletions: number | null;
  previousPath: string | null;
}> {
  // `git diff --numstat -z` NUL-separates records; within a record the
  // fields are TAB-separated. A rename record has an EMPTY third field and
  // is followed by two NUL-separated path tokens: source then destination,
  // e.g. `2\t1\t\0alpha.txt\0alpha-renamed.txt\0`. (Verified against git
  // 2.54 with a real fixture rather than the man-page examples.)
  const tokens = output.split("\0");
  const byPath = new Map<string, { additions: number | null; deletions: number | null; previousPath: string | null }>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || token.length === 0) {
      index += 1;
      continue;
    }
    const parts = token.split("\t");
    if (parts.length < 3) {
      // Not a record (for example a lone empty rename destination).
      index += 1;
      continue;
    }
    const binary = parts[0] === "-" || parts[1] === "-";
    const stats = {
      additions: binary ? null : Number(parts[0]),
      deletions: binary ? null : Number(parts[1]),
      previousPath: null,
    };
    const path = parts[2];
    if (path.length > 0) {
      byPath.set(path, stats);
      index += 1;
      continue;
    }
    // Rename: destination token follows (source first, then destination).
    const source = tokens[index + 1];
    const destination = tokens[index + 2];
    if (source !== undefined && destination !== undefined && destination.length > 0) {
      byPath.set(destination, { ...stats, previousPath: source });
    }
    index += 3;
  }
  return byPath;
}

export interface LocalGitWorkspaceOptions {
  readonly commandTimeoutMs?: number;
}

/**
 * Local Git adapter for the PR diff workspace. Fetches are serialized per
 * repository (plan 11.1); read-only commands may run concurrently.
 */
export class LocalGitWorkspace {
  private readonly fetchQueues = new Map<string, Promise<unknown>>();
  private readonly commandTimeoutMs: number;

  constructor(options: LocalGitWorkspaceOptions = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
  }

  async objectExists(repositoryPath: string, ref: string): Promise<boolean> {
    const output = await runGitOptionalText(
      repositoryPath,
      ["cat-file", "-e", `${ref}^{commit}`],
      { timeoutMs: this.commandTimeoutMs },
    );
    return output !== null;
  }

  /**
   * Guarantees the PR head commit and the base ref exist locally (plan 11.1).
   * When either is missing, one fetch adds both refs; concurrent prepare
   * calls for the same repository run their fetches serially, and repeated
   * probes inside the queue prevent duplicate fetches.
   */
  async preparePull(input: PreparePullInput): Promise<PreparePullResult> {
    const baseRef = `refs/remotes/${input.remote}/${input.baseBranch}`;
    const headProbe = `${input.headSha}^{commit}`;
    let fetched = false;

    const headMissing = !(await this.objectExists(input.repositoryPath, headProbe));
    const baseMissing = !(await this.objectExists(input.repositoryPath, baseRef));
    if (headMissing || baseMissing) {
      const previous = this.fetchQueues.get(input.repositoryPath) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(async () => {
        const stillMissingHead = !(await this.objectExists(input.repositoryPath, headProbe));
        const stillMissingBase = !(await this.objectExists(input.repositoryPath, baseRef));
        if (!stillMissingHead && !stillMissingBase) return;
        await runGitText(
          input.repositoryPath,
          [
            "fetch",
            "--no-tags",
            input.remote,
            `+refs/pull/${input.prNumber}/head:refs/loong/pull/${input.prNumber}/head`,
            `+refs/heads/${input.baseBranch}:${baseRef}`,
          ],
          { timeoutMs: this.commandTimeoutMs },
        );
        fetched = true;
      });
      this.fetchQueues.set(input.repositoryPath, task);
      try {
        await task;
      } finally {
        if (this.fetchQueues.get(input.repositoryPath) === task) {
          this.fetchQueues.delete(input.repositoryPath);
        }
      }
    }

    if (!(await this.objectExists(input.repositoryPath, headProbe))) {
      throw new GitObjectMissingError(input.repositoryPath, input.headSha);
    }
    if (!(await this.objectExists(input.repositoryPath, baseRef))) {
      throw new GitObjectMissingError(input.repositoryPath, baseRef);
    }

    const mergeBase = (
      await runGitText(
        input.repositoryPath,
        ["merge-base", baseRef, input.headSha],
        { timeoutMs: this.commandTimeoutMs },
      )
    ).trim();
    return { headSha: input.headSha, mergeBase, fetched };
  }

  /** Changed files between merge base and head (plan 11.2). */
  async listChangedFiles(input: {
    repositoryPath: string;
    mergeBase: string;
    headSha: string;
  }): Promise<ChangedFileEntry[]> {
    const diffArgs = ["diff", "--name-status", "-z", "--find-renames", input.mergeBase, input.headSha];
    const nameStatusOutput = await runGitText(input.repositoryPath, diffArgs, {
      timeoutMs: this.commandTimeoutMs,
    });
    const numstatOutput = await runGitText(
      input.repositoryPath,
      ["diff", "--numstat", "-z", input.mergeBase, input.headSha],
      { timeoutMs: this.commandTimeoutMs },
    );

    const records = parseNameStatus(nameStatusOutput);
    const stats = parseNumstat(numstatOutput);
    return records.map((record) => {
      const entryStats = stats.get(record.path);
      const changeType = STATUS_TO_CHANGE_TYPE[record.status];
      if (changeType === undefined) {
        throw new Error(`Unsupported git status: ${record.status}`);
      }
      const previousPath = record.previousPath ?? entryStats?.previousPath ?? null;
      return {
        path: record.path,
        previousPath,
        changeType,
        additions: entryStats?.additions ?? null,
        deletions: entryStats?.deletions ?? null,
        binary: entryStats ? entryStats.additions === null : false,
      };
    });
  }

  /** Full file content at one revision (plan 11.2). */
  async readFile(input: ReadFileInput): Promise<FileContent> {
    assertSafeGitPath(input.path);
    const bytes = await runGitBuffer(
      input.repositoryPath,
      ["show", `${input.ref}:${input.path}`],
      { timeoutMs: this.commandTimeoutMs },
    );
    const sizeBytes = bytes.byteLength;
    const binary = containsNul(bytes);
    const tooLarge = sizeBytes > MAX_DIFF_FILE_BYTES;
    return {
      path: input.path,
      ref: input.ref,
      binary,
      sizeBytes,
      content: binary || tooLarge ? null : decodeUtf8(bytes),
      tooLarge,
    };
  }
}
