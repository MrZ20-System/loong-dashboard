import { execa } from "execa";

/**
 * Deterministic Git checkpoint (plan 15.6). Only the Knowledge Repository
 * gets this entry; failures are returned, never auto-merged/pulled/rebase-
 * resolved.
 */
export interface RunCheckpointInput {
  repositoryPath: string;
  message: string;
  /** Push after a successful commit (plan 15.6 autoPush). */
  push?: boolean;
  remote?: string;
  branch?: string;
}

export interface RunCheckpointResult {
  /** True when a commit was created for pending changes. */
  committed: boolean;
  /** True when a push followed the commit or pushed an existing HEAD. */
  pushed?: boolean;
  error?: string;
}

export async function runCheckpoint(
  input: RunCheckpointInput,
): Promise<RunCheckpointResult> {
  try {
    const status = await execa("git", ["status", "--porcelain"], {
      cwd: input.repositoryPath,
    });
    const dirty = status.stdout.trim().length > 0;
    if (dirty) {
      await execa("git", ["add", "-A"], { cwd: input.repositoryPath });
      await execa("git", ["commit", "-m", input.message], {
        cwd: input.repositoryPath,
      });
    }
    if (input.push !== true || input.remote === undefined || input.branch === undefined) {
      return { committed: dirty };
    }
    try {
      await execa("git", ["push", input.remote, input.branch], {
        cwd: input.repositoryPath,
      });
      return { committed: dirty, pushed: true };
    } catch (pushError) {
      return {
        committed: dirty,
        pushed: false,
        error: pushError instanceof Error ? pushError.message : String(pushError),
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { committed: false, error: reason };
  }
}
