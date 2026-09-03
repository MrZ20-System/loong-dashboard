import { execa } from "execa";

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
/** Generous ceiling for `git show` of source files; per-file limits live in readFile. */
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(repositoryPath: string, args: readonly string[], exitCode: number | null, stderr: string, cause?: unknown) {
    super(`git ${args.join(" ")} failed in ${repositoryPath} (exit ${exitCode ?? "unknown"}): ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.cause = cause;
  }
}

export interface RunGitOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export async function runGitText(
  repositoryPath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  const result = await execGit(repositoryPath, args, options, "utf8");
  return result.stdout as string;
}

export async function runGitBuffer(
  repositoryPath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<Uint8Array> {
  const result = await execGit(repositoryPath, args, options, "buffer");
  return result.stdout as Uint8Array;
}

/**
 * Runs a git command that may legitimately fail (for example `cat-file -e`
 * probing a missing object). Returns null when the command exits non-zero.
 */
export async function runGitOptionalText(
  repositoryPath: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string | null> {
  try {
    return await runGitText(repositoryPath, args, options);
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

async function execGit(
  repositoryPath: string,
  args: readonly string[],
  options: RunGitOptions,
  encoding: "utf8" | "buffer",
): Promise<{ stdout: string | Uint8Array }> {
  const result = await execa("git", [...args], {
    cwd: repositoryPath,
    shell: false,
    reject: false,
    timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    encoding,
    // `git show` content is byte-exact: do not let execa trim the final
    // newline of blob output or binary captures.
    stripFinalNewline: false,
  });
  if (result.failed || result.exitCode !== 0) {
    throw new GitCommandError(
      repositoryPath,
      args,
      result.exitCode ?? null,
      typeof result.stderr === "string" ? result.stderr : "",
    );
  }
  return { stdout: result.stdout };
}
