import { runGitText } from "./git-command.js";

/**
 * Deterministic Git checkpoint. The caller chooses the repository and owns the
 * scheduling policy; this adapter never pulls, merges, rebases, or changes the
 * checked-out branch.
 */
export interface RunCheckpointInput {
  repositoryPath: string;
  message: string;
  /** Push after a successful commit (plan 15.6 autoPush). */
  push?: boolean;
  remote?: string;
  /** Legacy shorthand used as both sourceRef and remoteBranch. */
  branch?: string;
  sourceRef?: string;
  remoteBranch?: string;
}

export interface RunCheckpointResult {
  /** True when a commit was created for pending changes. */
  committed: boolean;
  /** True when a push followed the commit or pushed an existing HEAD. */
  pushed?: boolean;
  error?: string;
}

export interface PushBackupRefInput {
  repositoryPath: string;
  remote: string;
  /** Local branch, tag, or commit-ish to resolve without checking it out. */
  sourceRef: string;
  /** Remote branch name without the refs/heads prefix. */
  remoteBranch: string;
}

export interface PushBackupRefResult {
  pushed: boolean;
  sourceCommit?: string;
  error?: string;
}

/**
 * Push one resolved local commit to a remote backup branch using an explicit
 * refspec. A missing remote branch is created by normal Git push semantics;
 * divergence is reported by Git because this function never force-pushes.
 */
export async function pushBackupRef(
  input: PushBackupRefInput,
): Promise<PushBackupRefResult> {
  try {
    const remote = input.remote.trim();
    const sourceRef = input.sourceRef.trim();
    const remoteBranch = input.remoteBranch.trim();
    if (remote.length === 0) throw new Error("Git backup remote must not be empty");
    if (sourceRef.length === 0) throw new Error("Git backup source ref must not be empty");
    if (remoteBranch.length === 0) throw new Error("Git backup remote branch must not be empty");

    await runGitText(input.repositoryPath, [
      "check-ref-format",
      `refs/heads/${remoteBranch}`,
    ]);
    const sourceCommit = (
      await runGitText(input.repositoryPath, [
        "rev-parse",
        "--verify",
        `${sourceRef}^{commit}`,
      ])
    ).trim();
    await runGitText(input.repositoryPath, [
      "push",
      remote,
      `${sourceCommit}:refs/heads/${remoteBranch}`,
    ]);
    return { pushed: true, sourceCommit };
  } catch (error) {
    return {
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runCheckpoint(
  input: RunCheckpointInput,
): Promise<RunCheckpointResult> {
  try {
    if (input.sourceRef !== undefined) {
      const expectedBranch = input.sourceRef.replace(/^refs\/heads\//, "");
      const currentBranch = (
        await runGitText(input.repositoryPath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      ).trim();
      if (currentBranch !== expectedBranch) {
        throw new Error(
          `Git checkpoint source branch mismatch: expected ${expectedBranch}, current ${currentBranch}`,
        );
      }
    }
    const status = await runGitText(input.repositoryPath, ["status", "--porcelain"]);
    const dirty = status.trim().length > 0;
    if (dirty) {
      await runGitText(input.repositoryPath, ["add", "-A"]);
      await runGitText(input.repositoryPath, ["commit", "-m", input.message]);
    }
    if (input.push !== true) {
      return { committed: dirty };
    }
    const remote = input.remote;
    const sourceRef = input.sourceRef ?? input.branch;
    const remoteBranch = input.remoteBranch ?? input.branch;
    if (remote === undefined || sourceRef === undefined || remoteBranch === undefined) {
      return {
        committed: dirty,
        pushed: false,
        error: "Git backup push requires remote, sourceRef, and remoteBranch",
      };
    }
    const pushed = await pushBackupRef({
      repositoryPath: input.repositoryPath,
      remote,
      sourceRef,
      remoteBranch,
    });
    return {
      committed: dirty,
      pushed: pushed.pushed,
      ...(pushed.error === undefined ? {} : { error: pushed.error }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { committed: false, error: reason };
  }
}
